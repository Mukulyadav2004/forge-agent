import { TrueForge } from '@truefoundry/trueforge-sdk';
import type { TrueForgeApi } from '@truefoundry/trueforge-sdk';
import { agentInstructions } from './instructions';
import { compactionTriggerTokens, environmentInstructions, findGitRoot, modelIdentity } from '../context/projectContext';
import { existsSync } from 'node:fs';
import definition from './forge-agent.json';
import { SessionTrace } from '../observability/events';
import type { SessionEvent } from '../observability/events';

/** Model failures arrive as turn.done with status "error" and a message such as "[Model Error] Request failed (429): …". */
export function classifyModelError(message: string): { transient: boolean; summary: string; stepLimit: boolean; retryAfterSeconds?: number } {
  const summary = message.replace(/^\[Model Error\]\s*/u, '').split('\n')[0]?.trim().slice(0, 240) || 'The model request failed.';
  // Rate limits, timeouts, server errors and network failures can pass; bad keys, missing models and bad requests will not.
  const transient = /\((?:408|409|425|429|5\d\d)\)/u.test(message) || /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed|cannot connect|timed? ?out|unreachable|overloaded|temporarily/iu.test(message);
  // TrueForge ends a turn this way when the agent used every allowed step; another model would not help.
  const stepLimit = /iteration limit/iu.test(message);
  // Providers often say how long to wait, e.g. Google's "Please retry in 42.09s" for a per-minute limit.
  const hint = /retry (?:in|after) (\d+(?:\.\d+)?) ?s/iu.exec(message);
  return { transient: transient && !stepLimit, summary, stepLimit, ...(hint ? { retryAfterSeconds: Math.ceil(Number(hint[1])) } : {}) };
}

/** The full spec TrueForge receives: src/agent/forge-agent.json plus the model, the window's editor MCP server and the instructions.
 * Instructions follow OpenCode's order, most shared first so the prefix stays cacheable: the system prompt, the model identity,
 * instruction files, then the date and environment.
 * When the model's context length is known, compaction uses OpenCode's reserve: the larger of 15% of the window and 16,000 tokens.
 * Without that length, the trigger is omitted and TrueForge uses 80% of the window, or 50,000 tokens if the window is unknown. */
export function agentSpec(options: { model: string; connector?: string; reasoningEffort?: string; contextLength?: number; projectInstructions?: string; environment?: string }): TrueForgeApi.AgentSpec {
  const base = definition.config as TrueForgeApi.RuntimeConfig;
  const trigger = compactionTriggerTokens(options.contextLength);
  const compaction: TrueForgeApi.CompactionConfig = { enabled: true, ...base.contextManagement?.compaction, ...(trigger !== undefined ? { trigger: { type: 'input_tokens', value: trigger } } : {}) };
  const parts = [agentInstructions, modelIdentity(options.model), options.projectInstructions?.trim(), options.environment?.trim()].filter((part): part is string => Boolean(part));
  return {
    model: { name: options.model, ...(options.reasoningEffort ? { params: { reasoningEffort: options.reasoningEffort } } : {}) },
    instructions: parts.join('\n\n'),
    config: { ...base, contextManagement: { ...base.contextManagement, compaction } },
    mcpServers: options.connector ? [{ name: options.connector, ...definition.editorServer }] : [],
  };
}

function createClient(baseUrl: string): TrueForge {
  const url = new URL(baseUrl);
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Use the local TrueForge HTTP URL.');
  return new TrueForge({ baseUrl, maxRetries: 0, timeoutInSeconds: 600 });
}

/** Deletes a saved session on the server when its task is removed from history. A session that is already gone is fine. */
export async function deleteRemoteSession(options: { baseUrl: string; sessionId: string }): Promise<void> {
  try { await createClient(options.baseUrl).sessions.delete(options.sessionId, { timeoutInSeconds: 10 }); } catch { /* best effort */ }
}

export async function listModelNames(options: { baseUrl: string }): Promise<string[]> {
  const response = await createClient(options.baseUrl).models.list({ timeoutInSeconds: 15 });
  return response.data.map(model => model.name);
}
export class ForgeSession {
  static observe: (event: SessionEvent) => void = () => undefined;
  private readonly trace: SessionTrace;
  private readonly client: TrueForge;
  private sessionId: string | undefined;
  private turnId: string | undefined;
  private lastEventId: string | undefined;
  private paused = false;
  private cancelled = false;
  /**
   * `resume` reattaches a saved TrueForge session. If the server no longer has it, the first turn starts a new session
   * and is prefixed with `restoredTranscript`, so the model still sees the visible conversation.
   */
  constructor(private readonly options: { baseUrl: string; model: string; connector: string; reasoningEffort?: string; projectInstructions?: string; editorManifest?: TrueForgeApi.RemoteMcpServerManifest; workspaceRoot?: string; resume?: { sessionId: string; lastGoodTurnId?: string }; restoredTranscript?: string; onEvent: (event: TrueForgeApi.TurnStreamingEvent) => void }) {
    this.trace = new SessionTrace({ model: options.model, sink: event => ForgeSession.observe(event) });
    this.client = createClient(options.baseUrl);
    if (!/^[^/\s]+\/\S+$/u.test(options.model)) {
      throw new Error('Use the full provider/model name. Click Select model or run Forge: Select Model to choose a configured model.');
    }
    if (options.resume) this.resumeState = 'pending';
  }
  private lastGoodTurnId: string | undefined;
  private contextLength: number | undefined;
  private contextResolved = false;
  private resumeState: 'pending' | 'attached' | 'lost' | undefined;
  private pendingTranscript: string | undefined;
  get id(): string | undefined { return this.sessionId; }
  /** The last turn that finished without error, saved with the task so a reattached session can still branch a retry from it. */
  get lastTurnId(): string | undefined { return this.lastGoodTurnId; }
  /** 'attached' when a saved session was found on the server, 'lost' when a new one replaced it. */
  get resumed(): 'attached' | 'lost' | undefined { return this.resumeState === 'pending' ? undefined : this.resumeState; }
  /** Model context window in tokens, once the model list has been read. The sidebar meter uses this as the limit. */
  get contextWindow(): number | undefined { return this.contextLength; }
  get model(): string { return this.options.model; }
  get awaitingApproval(): boolean { return this.paused; }
  /** retry: branch from the last successful turn so a failed attempt is not part of the history. */
  async send(input: TrueForgeApi.CreateTurnSessionsStreamRequest['input'], options: { retry?: boolean } = {}): Promise<void> {
    if (this.paused) throw new Error('Approve, deny or cancel the pending tool request before sending another message.');
    this.turnId = undefined; this.lastEventId = undefined;
    this.trace.begin();
    try { await this.sendTurn(input, options.retry ? this.lastGoodTurnId ?? 'none' : undefined); }
    catch (error) { this.trace.fail(); throw error; }
    finally { if (!this.paused) this.trace.finish(); }
  }
  /** Resumes a turn paused on ask_user_question. Each event is the option the user picked. */
  async respond(events: TrueForgeApi.UserToolResponseInputEvent[]): Promise<void> {
    if (!this.sessionId || !this.turnId || !this.paused || !events.length) throw new Error('No paused TrueForge turn is waiting for an answer.');
    this.cancelled = false;
    try {
      await this.client.sessions.createTurnEvents(this.sessionId, this.turnId, { events });
      if (this.cancelled) { if (this.paused) { this.paused = false; this.trace.abandoned(); } return; }
      this.paused = false;
      const stream = await this.client.sessions.subscribeToTurn(this.sessionId, this.turnId, { afterEventId: this.lastEventId });
      await this.readStream(stream);
    } catch (error) {
      if (this.paused) ForgeSession.observe({ ts: new Date().toISOString(), taskId: this.sessionId, sessionId: this.sessionId, turnId: this.turnId, event: 'error', outcome: 'error', errorType: 'RequestError', message: 'TrueForge operation failed; details omitted.' });
      else this.trace.fail();
      throw error;
    }
    finally { if (!this.paused) this.trace.finish(); }
  }
  async approve(events: TrueForgeApi.UserToolApprovalInputEvent[]): Promise<void> {
    if (!this.sessionId || !this.turnId || !this.paused || !events.length) throw new Error('No paused TrueForge turn is available for approval.');
    this.cancelled = false;
    try {
      await this.client.sessions.createTurnEvents(this.sessionId, this.turnId, { events });
      if (this.cancelled) { if (this.paused) { this.paused = false; this.trace.abandoned(); } return; }
      this.paused = false;
      const stream = await this.client.sessions.subscribeToTurn(this.sessionId, this.turnId, { afterEventId: this.lastEventId });
      await this.readStream(stream);
    } catch (error) {
      if (this.paused) ForgeSession.observe({ ts: new Date().toISOString(), taskId: this.sessionId, sessionId: this.sessionId, turnId: this.turnId, event: 'error', outcome: 'error', errorType: 'RequestError', message: 'TrueForge operation failed; details omitted.' });
      else this.trace.fail();
      throw error;
    }
    finally { if (!this.paused) this.trace.finish(); }
  }
  /** Continues this session on another model; PATCH replaces the whole spec, so the full spec is sent again. */
  async switchModel(model: string): Promise<void> {
    if (!/^[^/\s]+\/\S+$/u.test(model)) throw new Error('Use the full provider/model name for forgeAgent.fallbackModel.');
    if (this.paused) throw new Error('Answer the pending approval before switching models.');
    const length = await this.lookupContextLength(model);
    if (this.sessionId) await this.client.sessions.update(this.sessionId, { agent: { spec: this.spec(model, length) } });
    this.options.model = model;
    this.contextLength = length;
    this.contextResolved = true;
  }
  private spec(model: string, contextLength = this.contextLength): TrueForgeApi.AgentSpec {
    return agentSpec({ model, connector: this.options.editorManifest?.name ?? this.options.connector, reasoningEffort: this.options.reasoningEffort, contextLength, projectInstructions: this.options.projectInstructions, environment: this.environment() });
  }
  private environment(): string {
    const root = this.options.workspaceRoot;
    let gitRoot: string | undefined;
    try { gitRoot = root ? findGitRoot(root, existsSync) : undefined; } catch { gitRoot = undefined; }
    return environmentInstructions({ date: new Date(), workspaceRoot: root, gitRoot, platform: process.platform });
  }
  /** Points a saved session at this window's editor server and current instructions. A missing session leaves a new one to be created. */
  private async attach(sessionId: string): Promise<boolean> {
    try {
      await this.client.sessions.get(sessionId, { timeoutInSeconds: 15 });
      // PATCH replaces the spec: the editor MCP server name changes with every window, and the date and instructions may have too.
      await this.client.sessions.update(sessionId, { agent: { spec: this.spec(this.options.model) } }, { timeoutInSeconds: 15 });
      return true;
    } catch { return false; }
  }
  /** Reads one model's context length. A failure leaves it unknown and TrueForge applies its own compaction fallback. */
  private async lookupContextLength(model: string): Promise<number | undefined> {
    try {
      const listed = await this.client.models.list({ timeoutInSeconds: 15 });
      const length = listed.data.find(item => item.name === model)?.properties?.contextLength;
      return typeof length === 'number' && Number.isFinite(length) && length > 0 ? length : undefined;
    } catch { return undefined; }
  }
  private async resolveContext(): Promise<void> {
    if (this.contextResolved) return;
    this.contextResolved = true;
    this.contextLength = await this.lookupContextLength(this.options.model);
  }
  private async sendTurn(input: TrueForgeApi.CreateTurnSessionsStreamRequest['input'], previousTurnId?: string): Promise<void> {
    this.cancelled = false;
    if (!this.sessionId) {
      await this.resolveContext();
      if (this.cancelled) { this.trace.abandoned(); return; }
      if (this.options.editorManifest) {
        await this.client.settings.mcpServers.createOrUpdate({ manifest: this.options.editorManifest }, { timeoutInSeconds: 15 });
      }
      if (this.cancelled) { this.trace.abandoned(); return; }
      const resume = this.resumeState === 'pending' ? this.options.resume : undefined;
      if (resume && await this.attach(resume.sessionId)) {
        this.resumeState = 'attached';
        this.sessionId = resume.sessionId;
        this.lastGoodTurnId ??= resume.lastGoodTurnId;
      } else {
        if (this.cancelled) { this.trace.abandoned(); return; }
        const response = await this.client.sessions.create({ agent: { spec: this.spec(this.options.model) } });
        this.sessionId = response.data.id;
        if (resume) this.resumeState = 'lost';
        this.pendingTranscript = this.options.restoredTranscript?.trim() || undefined;
      }
      this.trace.created(this.sessionId);
    }
    if (this.cancelled) { this.trace.abandoned(); return; }
    // Until a turn succeeds, the transcript goes with every turn that starts from the root: the first one and retries of it.
    if (this.pendingTranscript && !this.lastGoodTurnId && (!previousTurnId || previousTurnId === 'none')) input = [{ type: 'user.message', content: this.pendingTranscript }, ...(input ?? [])];
    const stream = await this.client.sessions.createTurnStream(this.sessionId, { input, ...(previousTurnId ? { previousTurnId } : {}) });
    await this.readStream(stream);
  }
  private async readStream(stream: AsyncIterable<TrueForgeApi.TurnStreamingEvent>): Promise<void> {
    for await (const event of stream) {
      if (event.type === 'turn.created') this.turnId = event.turnId;
      if (event.type === 'turn.done' && event.state.status === 'done') { this.lastGoodTurnId = this.turnId; this.pendingTranscript = undefined; }
      this.lastEventId = event.id;
      this.paused = event.type === 'turn.update' && event.state.status === 'paused';
      this.trace.stream(event);
      this.options.onEvent(event);
      // A pause keeps the server turn alive; release this reader so the UI can answer it.
      if (this.paused || event.type === 'turn.done') return;
    }
  }
  async cancel(): Promise<void> {
    const complete = this.trace.cancellation();
    const wasPaused = this.paused;
    this.cancelled = true;
    try {
      if (this.sessionId) await this.client.sessions.cancel(this.sessionId);
      if (wasPaused && this.paused) { this.paused = false; this.trace.abandoned(); }
      complete(this.sessionId ? 'accepted' : 'local');
    } catch (error) { complete('error'); throw error; }
  }
}
