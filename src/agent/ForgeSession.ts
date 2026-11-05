import { TrueForge } from '@truefoundry/trueforge-sdk';
import type { TrueForgeApi } from '@truefoundry/trueforge-sdk';

export class ForgeSession {
  private readonly client: TrueForge;
  private sessionId: string | undefined;
  private cancelled = false;
  constructor(private readonly options: { baseUrl: string; model: string; connector: string; onEvent: (event: TrueForgeApi.TurnStreamingEvent) => void }) {
    const url = new URL(options.baseUrl);
    if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Use the local TrueForge HTTP URL.');
    this.client = new TrueForge({ baseUrl: options.baseUrl, maxRetries: 0, timeoutInSeconds: 600 });
  }
  get id(): string | undefined { return this.sessionId; }
  async send(input: TrueForgeApi.CreateTurnSessionsStreamRequest['input']): Promise<void> {
    this.cancelled = false;
    if (!this.sessionId) {
      const response = await this.client.sessions.create({ agent: { spec: {
        model: { name: this.options.model },
        instructions: 'You are Forge Agent in VS Code. Inspect workspace files using editor tools. Propose changes with propose_edit. Never claim a proposal was applied. All proposed changes remain in memory. Ask for missing context. Do not read secrets.',
        mcpServers: this.options.connector ? [{ name: this.options.connector, preload: true, enableTools: ['read_file', 'list_files', 'propose_edit'], requireApprovalForTools: ['propose_edit'] }] : [],
      } } });
      this.sessionId = response.data.id;
    }
    if (this.cancelled) return;
    const stream = await this.client.sessions.createTurnStream(this.sessionId, { input });
    for await (const event of stream) {
      this.options.onEvent(event);
    }
  }
  async cancel(): Promise<void> {
    this.cancelled = true;
    if (this.sessionId) await this.client.sessions.cancel(this.sessionId);
  }
}
