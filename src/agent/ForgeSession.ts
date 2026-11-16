import { TrueForge } from '@truefoundry/trueforge-sdk';
import type { TrueForgeApi } from '@truefoundry/trueforge-sdk';
import { agentInstructions } from './instructions';
import { SessionTrace } from '../observability/events';
import type { SessionEvent } from '../observability/events';

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
  get id(): string | undefined { return this.sessionId; }
  get awaitingApproval(): boolean { return this.paused; }
  async send(input: TrueForgeApi.CreateTurnSessionsStreamRequest['input']): Promise<void> {
    if (this.paused) throw new Error('Approve, deny or cancel the pending tool request before sending another message.');
    this.turnId = undefined; this.lastEventId = undefined;
    this.trace.begin();
    try { await this.sendTurn(input); }
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
  private async sendTurn(input: TrueForgeApi.CreateTurnSessionsStreamRequest['input']): Promise<void> {
    this.cancelled = false;
    if (!this.sessionId) {
      if (this.options.editorManifest) {
        await this.client.settings.mcpServers.createOrUpdate({ manifest: this.options.editorManifest }, { timeoutInSeconds: 15 });
      }
      if (this.cancelled) { this.trace.abandoned(); return; }
      const connector = this.options.editorManifest?.name ?? this.options.connector;
      const response = await this.client.sessions.create({ agent: { spec: {
        model: { name: this.options.model, ...(this.options.reasoningEffort ? { params: { reasoningEffort: this.options.reasoningEffort } } : {}) },
        instructions: agentInstructions,
        // Enable harness capabilities as the editor gains support for their interactions.
        config: { generativeUi: { enabled: false }, askUserQuestions: { enabled: false }, dynamicSubAgents: { enabled: false }, sandbox: { enabled: false }, webSearch: { enabled: false }, iterationLimit: 32 },
        mcpServers: connector ? [{ name: connector, preload: true, enableTools: ['read_file', 'list_files', 'search_code', 'propose_edit'], requireApprovalForTools: ['propose_edit'] }] : [],
      } } });
      this.sessionId = response.data.id;
      this.trace.created(this.sessionId);
    }
    if (this.cancelled) { this.trace.abandoned(); return; }
    const stream = await this.client.sessions.createTurnStream(this.sessionId, { input });
    await this.readStream(stream);
  }
  private async readStream(stream: AsyncIterable<TrueForgeApi.TurnStreamingEvent>): Promise<void> {
    for await (const event of stream) {
      if (event.type === 'turn.created') this.turnId = event.turnId;
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
