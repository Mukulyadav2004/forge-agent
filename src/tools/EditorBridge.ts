import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { TrueForgeApi } from '@truefoundry/trueforge-sdk';
import * as vscode from 'vscode';
import type { FileEvidence } from '../shared/messages';
import { buildProjectContext } from '../context/projectContext';
import type { EditService } from '../edits/EditService';
import { MAX_EDIT_CHARACTERS } from '../edits/EditService';
import type { WorkspaceFiles } from '../workspace/WorkspaceFiles';

const SEARCH_LIMITS = { candidate_files: 1000, file_bytes: 262144, total_bytes: 8388608, output_characters: 20000, line_characters: 1000, timeout_ms: 5000 };
const SEARCH_EXCLUDE = '**/{node_modules,.git,.env*,out,dist,build,.venv,venv,__pycache__,coverage}/**';
const SearchInputSchema = z.object({ query: z.string().min(1).max(500), glob: z.string().min(1).max(200).default('**/*'), regex: z.boolean().default(false), case_sensitive: z.boolean().default(false), max_results: z.number().int().min(1).max(100).default(40) });
type SearchInput = z.infer<typeof SearchInputSchema>;
const SearchMatchEventSchema = z.object({ type: z.literal('match'), data: z.object({ path: z.object({ text: z.string() }), line_number: z.number().int().positive(), lines: z.object({ text: z.string() }), submatches: z.array(z.object({ start: z.number().int().nonnegative() })) }) });
interface SearchMatch { path: string; line: number; text: string; line_truncated: boolean }

export class EditorBridge implements vscode.Disposable {
  private readonly token = randomBytes(32).toString('hex');
  private readonly instanceId = randomBytes(6).toString('hex');
  private readonly readEvents = new vscode.EventEmitter<FileEvidence>();
  readonly onDidReadFile = this.readEvents.event;
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
  constructor(private readonly options: { files: WorkspaceFiles; edits: EditService }) {}
  async start(): Promise<void> {
    await new Promise<void>((resolvePromise, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => { this.server.removeListener('error', reject); resolvePromise(); });
    });
  }
  getManifest(options: { namePrefix: string }): TrueForgeApi.RemoteMcpServerManifest {
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('The editor bridge has not started.');
    return {
      type: 'remote',
      name: `${options.namePrefix}-${this.instanceId}`,
      description: `VS Code editor tools for ${vscode.workspace.name ?? 'this window'}`,
      url: `http://127.0.0.1:${address.port}/mcp`,
      auth: { type: 'header', headers: { Authorization: `Bearer ${this.token}` } },
    };
  }
  async copyConnection(): Promise<void> {
    const prefix = vscode.workspace.getConfiguration('forgeAgent').get<string>('connector', 'forge-editor');
    const manifest = this.getManifest({ namePrefix: prefix || 'forge-editor' });
    if (manifest.auth?.type !== 'header') throw new Error('Editor header authentication is unavailable.');
    await vscode.env.clipboard.writeText(JSON.stringify({ name: manifest.name, url: manifest.url, headers: manifest.auth.headers }, null, 2));
    void vscode.window.showInformationMessage('Editor MCP details copied. Forge connects automatically when a new task starts; use these details only for manual setup or diagnostics.');
  }
  dispose(): void { this.server.close(); this.readEvents.dispose(); }
  async openFile(options: { path: string; line: number }): Promise<void> {
    const document = await this.options.files.open(options.path);
    const position = new vscode.Position(Math.max(0, Math.min(options.line - 1, document.lineCount - 1)), 0);
    await vscode.window.showTextDocument(document, { selection: new vscode.Range(position, position), preview: true });
  }
  async architectureContext(): Promise<string> {
    const paths = await vscode.workspace.findFiles('**/*', '**/{node_modules,.git,.env*,out,dist,.venv,venv,__pycache__}/**', 500);
    const context = await buildProjectContext({ paths: paths.map(uri => vscode.workspace.asRelativePath(uri)), readFile: async path => (await this.options.files.open(path)).getText() });
    for (const file of context.files) this.readEvents.fire(file);
    return context.text;
  }
  private async searchCode(options: SearchInput & { signal: AbortSignal }): Promise<CallToolResult> {
    const root = vscode.workspace.workspaceFolders?.[0];
    if (!root || root.uri.scheme !== 'file' || !vscode.workspace.isTrusted) throw new Error('Open a trusted local workspace first.');
    if (options.glob.includes('..') || options.glob.startsWith('/') || options.glob.includes('\\')) throw new Error('Use a workspace-relative glob.');
    const signal = AbortSignal.any([options.signal, AbortSignal.timeout(SEARCH_LIMITS.timeout_ms)]);
    const cancellation = new vscode.CancellationTokenSource();
    const abort = () => cancellation.cancel();
    signal.addEventListener('abort', abort, { once: true });
    try {
      signal.throwIfAborted();
      const candidates = await vscode.workspace.findFiles(new vscode.RelativePattern(root, options.glob), SEARCH_EXCLUDE, SEARCH_LIMITS.candidate_files + 1, cancellation.token);
      const paths = new Map<string, string>();
      let bytes = 0, pathCharacters = 0, skipped = 0;
      for (const uri of candidates.slice(0, SEARCH_LIMITS.candidate_files)) {
        signal.throwIfAborted();
        const path = vscode.workspace.asRelativePath(uri, false);
        try {
          const target = await this.options.files.resolve(path);
          if (paths.has(target.realPath)) continue;
          if (target.dirty || target.size > SEARCH_LIMITS.file_bytes || bytes + target.size + 1 > SEARCH_LIMITS.total_bytes || pathCharacters + target.realPath.length > 64000) { skipped++; continue; }
          const handle = await open(target.realPath, 'r');
          try {
            // rg JSON can emit matches before identifying binary input; validate bounded bytes first.
            const buffer = Buffer.alloc(target.size + 1);
            let bytesRead = 0;
            while (bytesRead < buffer.length) {
              signal.throwIfAborted();
              const read = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
              if (!read.bytesRead) break;
              bytesRead += read.bytesRead;
            }
            bytes += bytesRead;
            const source = buffer.subarray(0, bytesRead);
            if (bytesRead > target.size || source.includes(0)) { skipped++; continue; }
            new TextDecoder('utf-8', { fatal: true }).decode(source);
          } finally { await handle.close(); }
          paths.set(target.realPath, path);
          pathCharacters += target.realPath.length;
        } catch { skipped++; }
      }
      signal.throwIfAborted();
      const found = paths.size ? await searchWithRipgrep({ ...options, paths, signal }) : { matches: [], truncated: false };
      for (const match of found.matches) this.readEvents.fire({ path: match.path, startLine: match.line, endLine: match.line, origin: 'tool' });
      const result = { ...found, truncated: found.truncated || skipped > 0 || candidates.length > SEARCH_LIMITS.candidate_files, candidate_limit_reached: candidates.length > SEARCH_LIMITS.candidate_files, skipped_files: skipped, eligible_files: paths.size, inspected_bytes: bytes, coverage: 'Saved UTF-8 text files only; dirty, secret, unavailable, binary and oversized files are excluded. No matches means no matches within these limits. Use read_file for current editor contents and an edit revision.', limits: SEARCH_LIMITS };
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    } finally { signal.removeEventListener('abort', abort); cancellation.dispose(); }
  }
  private makeServer(): McpServer {
    const server = new McpServer({ name: 'forge-editor', version: '0.0.1' });
    server.registerTool('search_code', { description: 'Find candidate code, tests and documentation by searching saved workspace text. Returns bounded matched lines, paths and coverage limits. Literal and case-insensitive by default; regex is optional. Then read_file on relevant ranges before proposing edits.', inputSchema: SearchInputSchema.shape, annotations: { readOnlyHint: true } }, async (input, extra) => this.searchCode({ ...input, signal: extra.signal }));
    server.registerTool('read_file', { description: 'Read a bounded line range from a workspace file.', inputSchema: { path: z.string(), start_line: z.number().int().min(1).default(1), end_line: z.number().int().min(1).optional() }, annotations: { readOnlyHint: true } }, async ({ path, start_line, end_line }) => {
      const { revision, file } = await this.options.edits.read(path);
      const lines = file.text.split('\n');
      if (start_line > lines.length || (end_line !== undefined && end_line < start_line)) throw new Error('Choose a line range inside this file.');
      const end = Math.min(end_line ?? start_line + 199, start_line + 499, lines.length);
      const output: string[] = [];
      let length = 0;
      for (let index = start_line - 1; index < end; index++) {
        const numbered = `${index + 1}: ${lines[index]}`;
        if (length + numbered.length + 1 > 30000) break;
        output.push(numbered);
        length += numbered.length + 1;
      }
      if (!output.length) throw new Error('This line exceeds the read budget. Inspect another range or file.');
      const actualEnd = start_line + output.length - 1;
      this.readEvents.fire({ path, startLine: start_line, endLine: actualEnd, origin: 'tool' });
      const text = output.join('\n');
      // TrueForge prefers structured MCP results, so the source must be present there too.
      return { content: [{ type: 'text', text: `Base revision: ${revision}\n${path}: lines ${start_line}-${actualEnd} of ${lines.length}${actualEnd < lines.length ? '. More lines are available.' : ''}\n${text}` }], structuredContent: { base_revision: revision, path, start_line, end_line: actualEnd, total_lines: lines.length, text, truncated: actualEnd < lines.length } };
    });
    server.registerTool('list_files', { description: 'Discover up to 100 workspace file paths by glob.', inputSchema: { glob: z.string().max(200).default('**/*') }, annotations: { readOnlyHint: true } }, async ({ glob }) => {
      if (!vscode.workspace.isTrusted) throw new Error('Workspace trust is required.');
      const files = await vscode.workspace.findFiles(glob, '**/{node_modules,.git,.env*,out,dist}/**', 100);
      return { content: [{ type: 'text', text: files.map(uri => vscode.workspace.asRelativePath(uri)).join('\n') }] };
    });
    server.registerTool('propose_edit', { description: 'Stage a read-only diff using read_file base_revision. Optional start_line and end_line replace only those inclusive complete lines; otherwise new_text replaces the file. The user applies hunks in the editor.', inputSchema: { path: z.string(), base_revision: z.string(), new_text: z.string().max(MAX_EDIT_CHARACTERS), explanation: z.string().max(2000), start_line: z.number().int().min(1).optional(), end_line: z.number().int().min(1).optional() }, annotations: { readOnlyHint: true } }, async ({ path, base_revision, new_text, explanation, start_line, end_line }) => {
      if ((start_line === undefined) !== (end_line === undefined)) throw new Error('Provide both start_line and end_line for a ranged proposal.');
      const range = start_line !== undefined && end_line !== undefined ? { startLine: start_line, endLine: end_line } : undefined;
      const id = await this.options.edits.stage({ path, revision: base_revision, text: new_text, explanation, range });
      const message = `Proposal ${id} is staged for ${path}. No files changed. To save it, the user must open Review changes in the Forge sidebar and click Accept hunk, Apply file or Apply all. The Command Palette also offers Forge: Apply All Proposed Changes. Chat approval alone does not write files. Do not ask the user to retype the changes manually.`;
      return { content: [{ type: 'text', text: message }], structuredContent: { proposal_id: id, status: 'staged', path, message } };
    });
    return server;
  }
}

// Adapted from cline/cline sdk/packages/core/src/extensions/tools/executors/search.ts
// at 7a7878cb52fc33967d8b464b3e3d899beac42d4d; Copyright 2026 Cline Bot Inc., Apache-2.0.
// Replaces Cline contracts/fallback with guarded paths, typed events and explicit limits/errors.
function searchWithRipgrep(options: SearchInput & { paths: Map<string, string>; signal: AbortSignal }): Promise<{ matches: SearchMatch[]; truncated: boolean }> {
  options.signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const executable = join(vscode.env.appRoot, 'node_modules', '@vscode', 'ripgrep', 'bin', process.platform === 'win32' ? 'rg.exe' : 'rg');
    const child = spawn(executable, ['--no-config', '--json', '--max-filesize=256K', ...(options.regex ? [] : ['--fixed-strings']), ...(options.case_sensitive ? [] : ['--ignore-case']), '-e', options.query, '--', ...options.paths.keys()], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const matches: SearchMatch[] = [];
    let pending = '', stderr = '', received = 0, outputSize = 0, settled = false;
    const finish = (error?: Error, truncated = false) => {
      if (settled) return;
      settled = true;
      options.signal.removeEventListener('abort', abort);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        const forceKill = setTimeout(() => child.kill('SIGKILL'), 200);
        child.once('close', () => clearTimeout(forceKill));
        forceKill.unref();
      }
      if (error) reject(error); else resolve({ matches, truncated });
    };
    const abort = () => finish(new Error('Code search cancelled or exceeded its five-second budget.', { cause: options.signal.reason }));
    options.signal.addEventListener('abort', abort, { once: true });
    if (options.signal.aborted) abort();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (settled) return;
      received += Buffer.byteLength(chunk);
      if (received > 1048576) { finish(undefined, true); return; }
      pending += chunk;
      let newline: number;
      while ((newline = pending.indexOf('\n')) !== -1 && !settled) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        try {
          const event = SearchMatchEventSchema.safeParse(JSON.parse(line));
          if (!event.success) continue;
          const data = event.data.data;
          const path = options.paths.get(data.path.text);
          if (!path) continue;
          const source = data.lines.text.replace(/\r?\n$/, '');
          const offset = Buffer.from(source).subarray(0, data.submatches[0]?.start ?? 0).toString('utf8').length;
          const start = Math.max(0, offset - 200);
          const match = { path, line: data.line_number, text: source.slice(start, start + SEARCH_LIMITS.line_characters), line_truncated: source.length > SEARCH_LIMITS.line_characters };
          const size = JSON.stringify(match).length + 1;
          if (outputSize + size > SEARCH_LIMITS.output_characters - 2000) { finish(undefined, true); break; }
          outputSize += size;
          matches.push(match);
          if (matches.length >= options.max_results) finish(undefined, true);
        } catch (error) { finish(new Error('Invalid ripgrep search output.', { cause: error })); }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(0, 2000); });
    child.once('error', error => finish(new Error('VS Code bundled ripgrep could not start. Check your VS Code installation.', { cause: error })));
    child.once('close', code => finish(code === 0 || code === 1 ? undefined : new Error(`Code search failed: ${stderr.trim() || `exit ${code}`}`)));
  });
}
