import { TrueForge } from '@truefoundry/trueforge-sdk';
import type { TrueForgeApi } from '@truefoundry/trueforge-sdk';
import { agentInstructions } from './instructions';

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
  private readonly client: TrueForge;
  private sessionId: string | undefined;
  private cancelled = false;
  constructor(private readonly options: { baseUrl: string; model: string; connector: string; editorManifest?: TrueForgeApi.RemoteMcpServerManifest; onEvent: (event: TrueForgeApi.TurnStreamingEvent) => void }) {
    this.client = createClient(options.baseUrl);
    if (!/^[^/\s]+\/\S+$/u.test(options.model)) {
      throw new Error('Use the full provider/model name. Click Select model or run Forge: Select Model to choose a configured model.');
    }
  }
  get id(): string | undefined { return this.sessionId; }
  async send(input: TrueForgeApi.CreateTurnSessionsStreamRequest['input']): Promise<void> {
    this.cancelled = false;
    if (!this.sessionId) {
      if (this.options.editorManifest) {
        await this.client.settings.mcpServers.createOrUpdate({ manifest: this.options.editorManifest }, { timeoutInSeconds: 15 });
      }
      if (this.cancelled) return;
      const connector = this.options.editorManifest?.name ?? this.options.connector;
      const response = await this.client.sessions.create({ agent: { spec: {
        model: { name: this.options.model },
        instructions: agentInstructions,
        // Enable harness capabilities as the editor gains support for their interactions.
        config: { generativeUi: { enabled: false }, askUserQuestions: { enabled: false }, dynamicSubAgents: { enabled: false }, sandbox: { enabled: false }, webSearch: { enabled: false }, iterationLimit: 32 },
        mcpServers: connector ? [{ name: connector, preload: true, enableTools: ['read_file', 'list_files', 'propose_edit'], requireApprovalForTools: ['propose_edit'] }] : [],
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
