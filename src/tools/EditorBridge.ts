import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import * as vscode from 'vscode';

export class EditorBridge implements vscode.Disposable {
  private readonly token = randomBytes(32).toString('hex');
  private readonly previews = new Map<string, string>();
  private readonly contentRegistration: vscode.Disposable;
  private readonly server = createServer((request, response) => {
    if (request.url !== '/mcp' || request.method !== 'POST') { response.writeHead(404).end(); return; }
    if (request.headers.origin || request.headers.authorization !== `Bearer ${this.token}`) { response.writeHead(403).end(); return; }
    const mcp = this.makeServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    response.on('close', () => { void transport.close(); void mcp.close(); });
    void mcp.connect(transport).then(() => transport.handleRequest(request, response)).catch(() => {
      if (!response.headersSent) response.writeHead(500).end('MCP request failed');
    });
  });
  constructor() {
    this.contentRegistration = vscode.workspace.registerTextDocumentContentProvider('forge-preview', {
      provideTextDocumentContent: uri => this.previews.get(uri.toString()) ?? '',
    });
  }
  async start(): Promise<void> {
    await new Promise<void>((resolvePromise, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => { this.server.removeListener('error', reject); resolvePromise(); });
    });
  }
  async copyConnection(): Promise<void> {
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('The editor bridge has not started.');
    await vscode.env.clipboard.writeText(JSON.stringify({ url: `http://127.0.0.1:${address.port}/mcp`, headers: { Authorization: `Bearer ${this.token}` } }, null, 2));
    void vscode.window.showInformationMessage('Editor MCP connection copied. Add it as a Streamable HTTP connector in local TrueForge. Refresh after restarting the extension.');
  }
  clear(): void { this.previews.clear(); }
  dispose(): void { this.server.close(); this.contentRegistration.dispose(); this.clear(); }
  private async file(path: string): Promise<vscode.TextDocument> {
    const root = vscode.workspace.workspaceFolders?.[0];
    if (!root || root.uri.scheme !== 'file' || !vscode.workspace.isTrusted) throw new Error('Open a trusted local workspace first.');
    if (isAbsolute(path) || /(^|[/\\])(\.env(?:\.[^/\\]+)?|\.git|id_rsa|id_ed25519)([/\\]|$)/i.test(path)) throw new Error('This path is not available to the agent.');
    const rootPath = await realpath(root.uri.fsPath);
    const filePath = await realpath(resolve(rootPath, path));
    const rel = relative(rootPath, filePath);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Path is outside the workspace.');
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    if (document.getText().length > 500_000) throw new Error('File is too large for this tool.');
    return document;
  }
  private makeServer(): McpServer {
    const server = new McpServer({ name: 'forge-editor', version: '0.0.1' });
    server.registerTool('read_file', { description: 'Read a bounded line range from a workspace file.', inputSchema: { path: z.string(), start_line: z.number().int().min(1).default(1), end_line: z.number().int().min(1).optional() }, annotations: { readOnlyHint: true } }, async ({ path, start_line, end_line }) => {
      const document = await this.file(path);
      const lines = document.getText().split('\n');
      const end = Math.min(end_line ?? start_line + 199, start_line + 499, lines.length);
      return { content: [{ type: 'text', text: lines.slice(start_line - 1, end).map((line, index) => `${start_line + index}: ${line}`).join('\n').slice(0, 30000) }] };
    });
    server.registerTool('list_files', { description: 'Discover up to 100 workspace file paths by glob.', inputSchema: { glob: z.string().max(200).default('**/*') }, annotations: { readOnlyHint: true } }, async ({ glob }) => {
      if (!vscode.workspace.isTrusted) throw new Error('Workspace trust is required.');
      const files = await vscode.workspace.findFiles(glob, '**/{node_modules,.git,.env*,out,dist}/**', 100);
      return { content: [{ type: 'text', text: files.map(uri => vscode.workspace.asRelativePath(uri)).join('\n') }] };
    });
    server.registerTool('propose_edit', { description: 'Open a read-only proposed diff. This never applies or saves changes.', inputSchema: { path: z.string(), new_text: z.string().max(500000), explanation: z.string().max(2000) }, annotations: { readOnlyHint: true } }, async ({ path, new_text, explanation }) => {
      const document = await this.file(path);
      const id = randomUUID();
      const before = vscode.Uri.parse(`forge-preview:/${id}/before`);
      const after = vscode.Uri.parse(`forge-preview:/${id}/after`);
      this.previews.set(before.toString(), document.getText());
      this.previews.set(after.toString(), new_text);
      await vscode.commands.executeCommand('vscode.diff', before, after, `Proposal: ${path}`, { preview: true });
      return { content: [{ type: 'text', text: `Preview opened. No files changed. ${explanation}` }] };
    });
    return server;
  }
}
