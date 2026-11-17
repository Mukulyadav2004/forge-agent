import { TrueForge } from '@truefoundry/trueforge-sdk';
import type { TrueForgeApi } from '@truefoundry/trueforge-sdk';
import { agentInstructions } from './instructions';
import definition from './forge-agent.json';
import { SessionTrace } from '../observability/events';
import type { SessionEvent } from '../observability/events';

/** Model failures arrive as turn.done with status "error" and a message such as "[Model Error] Request failed (429): …". */
export function classifyModelError(message: string): { transient: boolean; summary: string; stepLimit: boolean } {
  const summary = message.replace(/^\[Model Error\]\s*/u, '').split('\n')[0]?.trim().slice(0, 240) || 'The model request failed.';
  // Rate limits, timeouts, server errors and network failures can pass; bad keys, missing models and bad requests will not.
  const transient = /\((?:408|409|425|429|5\d\d)\)/u.test(message) || /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed|cannot connect|timed? ?out|unreachable|overloaded|temporarily/iu.test(message);
  // TrueForge ends a turn this way when the agent used every allowed step; another model would not help.
  const stepLimit = /iteration limit/iu.test(message);
  return { transient: transient && !stepLimit, summary, stepLimit };
}

/** The full spec TrueForge receives: src/agent/forge-agent.json plus the model, the window's editor MCP server and the instructions. */
export function agentSpec(options: { model: string; connector?: string; reasoningEffort?: string }): TrueForgeApi.AgentSpec {
  return {
    model: { name: options.model, ...(options.reasoningEffort ? { params: { reasoningEffort: options.reasoningEffort } } : {}) },
    instructions: agentInstructions,
    config: definition.config,
    mcpServers: options.connector ? [{ name: options.connector, ...definition.editorServer }] : [],
  };
}

function createClient(baseUrl: string): TrueForge {
  const url = new URL(baseUrl);
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Use the local TrueForge HTTP URL.');
  return new TrueForge({ baseUrl, maxRetries: 0, timeoutInSeconds: 600 });
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
  constructor(private readonly options: { baseUrl: string; model: string; connector: string; reasoningEffort?: string; editorManifest?: TrueForgeApi.RemoteMcpServerManifest; onEvent: (event: TrueForgeApi.TurnStreamingEvent) => void }) {
    this.trace = new SessionTrace({ model: options.model, sink: event => ForgeSession.observe(event) });
    this.client = createClient(options.baseUrl);
    if (!/^[^/\s]+\/\S+$/u.test(options.model)) {
      throw new Error('Use the full provider/model name. Click Select model or run Forge: Select Model to choose a configured model.');
    }
  }
  private lastGoodTurnId: string | undefined;
  get id(): string | undefined { return this.sessionId; }
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
    if (this.sessionId) await this.client.sessions.update(this.sessionId, { agent: { spec: this.spec(model) } });
    this.options.model = model;
  }
  private spec(model: string): TrueForgeApi.AgentSpec {
    return agentSpec({ model, connector: this.options.editorManifest?.name ?? this.options.connector, reasoningEffort: this.options.reasoningEffort });
  }
  private async sendTurn(input: TrueForgeApi.CreateTurnSessionsStreamRequest['input'], previousTurnId?: string): Promise<void> {
    this.cancelled = false;
    if (!this.sessionId) {
      if (this.options.editorManifest) {
        await this.client.settings.mcpServers.createOrUpdate({ manifest: this.options.editorManifest }, { timeoutInSeconds: 15 });
      }
      if (this.cancelled) { this.trace.abandoned(); return; }
      const response = await this.client.sessions.create({ agent: { spec: this.spec(this.options.model) } });
      this.sessionId = response.data.id;
      this.trace.created(this.sessionId);
    }
    if (this.cancelled) { this.trace.abandoned(); return; }
    const stream = await this.client.sessions.createTurnStream(this.sessionId, { input, ...(previousTurnId ? { previousTurnId } : {}) });
    await this.readStream(stream);
  }
  private async readStream(stream: AsyncIterable<TrueForgeApi.TurnStreamingEvent>): Promise<void> {
    for await (const event of stream) {
      if (event.type === 'turn.created') this.turnId = event.turnId;
      if (event.type === 'turn.done' && event.state.status === 'done') this.lastGoodTurnId = this.turnId;
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
