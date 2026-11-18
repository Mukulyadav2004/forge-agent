import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { open, realpath, stat } from 'node:fs/promises';
import { join, normalize, relative, resolve, sep } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { CallToolResult, ServerRequest, ServerNotification } from '@modelcontextprotocol/sdk/types.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import { z } from 'zod';
import type { TrueForgeApi } from '@truefoundry/trueforge-sdk';
import * as vscode from 'vscode';
import type { ActivityEntry } from '../shared/messages';
import { buildProjectContext } from '../context/projectContext';
import type { EditService } from '../edits/EditService';
import { MAX_EDIT_CHARACTERS } from '../edits/EditService';
import type { WorkspaceFiles } from '../workspace/WorkspaceFiles';
import type { ToolLog, ToolName } from '../observability/events';
import { COMMAND_LIMITS, runCommand } from './runCommand';

/** Characters of workspace text one user request may bring into the model's context: reads, searches, listings and supplied context. */
export const CONTEXT_BUDGET = 200_000;
const SEARCH_LIMITS = { candidate_files: 1000, file_bytes: 262144, total_bytes: 8388608, output_characters: 20000, line_characters: 1000, matches_per_file: 3, timeout_ms: 5000 };
const SEARCH_EXCLUDE = '**/{node_modules,.git,.env*,out,dist,build,.venv,venv,__pycache__,coverage}/**';
const SearchInputSchema = z.object({ query: z.string().min(1).max(500), glob: z.string().min(1).max(200).default('**/*').describe('Workspace-relative path filter. Narrow to a folder or extension when results are incomplete.'), regex: z.boolean().default(false), case_sensitive: z.boolean().default(false), max_results: z.number().int().min(1).max(100).default(40), reason: z.string().max(300).optional().describe('Optional: one short sentence telling the user why, shown in the editor activity feed.') });
type SearchInput = z.infer<typeof SearchInputSchema>;
const SearchMatchEventSchema = z.object({ type: z.literal('match'), data: z.object({ path: z.object({ text: z.string() }), line_number: z.number().int().positive(), lines: z.object({ text: z.string() }), submatches: z.array(z.object({ start: z.number().int().nonnegative() })) }) });
interface SearchHit { line: number; text: string; line_truncated: boolean }
interface SearchFile { path: string; match_count: number; matches: SearchHit[] }

export class EditorBridge implements vscode.Disposable {
  private readonly token = randomBytes(32).toString('hex');
  private readonly instanceId = randomBytes(6).toString('hex');
  private readonly activityEvents = new vscode.EventEmitter<ActivityEntry>();
  /** Completed editor tool calls for the sidebar feed: searches stay separate from files actually opened. */
  readonly onDidActivity = this.activityEvents.event;
  private budgetUsed = 0;
  get budget(): { used: number; limit: number } { return { used: this.budgetUsed, limit: CONTEXT_BUDGET }; }
  /** The one file an Edit Selection request may change; other files are refused until the next request. */
  private editScope: string | undefined;
  /** Called once per user request (not for approvals or retries of it). */
  beginRequest(scope?: string): void { this.budgetUsed = 0; this.editScope = scope; this.activityEvents.fire({ kind: 'request', limit: CONTEXT_BUDGET }); }
  private remaining(): number { return Math.max(0, CONTEXT_BUDGET - this.budgetUsed); }
  private budgetNote(): string { return `Context budget: ${this.budgetUsed.toLocaleString('en-US')} of ${CONTEXT_BUDGET.toLocaleString('en-US')} characters used for this request.`; }
  private budgetError(): Error { return new Error(`${this.budgetNote()} Too little remains for this call. Answer from the evidence you already have and label anything unverified, or ask the user to continue in a new message.`); }
  private readonly server = createServer((request, response) => {
    if (request.url !== '/mcp') { response.writeHead(404).end(); return; }
    // Streamable HTTP: a server without a GET event stream or session DELETE answers 405 with the allowed method.
    if (request.method !== 'POST') { response.writeHead(405, { Allow: 'POST' }).end(); return; }
    if (request.headers.origin || request.headers.authorization !== `Bearer ${this.token}`) { response.writeHead(403).end(); return; }
    const mcp = this.makeServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    response.on('close', () => { void transport.close(); void mcp.close(); });
    void mcp.connect(transport).then(() => transport.handleRequest(request, response)).catch(() => {
      if (!response.headersSent) response.writeHead(500).end('MCP request failed');
    });
  });
  constructor(private readonly options: { files: WorkspaceFiles; edits: EditService; log: ToolLog }) {}
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
  dispose(): void { this.server.close(); this.activityEvents.dispose(); }
  async openFile(options: { path: string; line: number }): Promise<void> {
    const document = await this.options.files.open(options.path);
    const position = new vscode.Position(Math.max(0, Math.min(options.line - 1, document.lineCount - 1)), 0);
    await vscode.window.showTextDocument(document, { selection: new vscode.Range(position, position), preview: true });
  }
  async architectureContext(): Promise<string> {
    const paths = await vscode.workspace.findFiles('**/*', '**/{node_modules,.git,.env*,out,dist,.venv,venv,__pycache__}/**', 500);
    const context = await buildProjectContext({ paths: paths.map(uri => vscode.workspace.asRelativePath(uri)), readFile: async path => (await this.options.files.open(path)).getText() });
    this.budgetUsed += context.text.length;
    for (const file of context.files) this.activityEvents.fire({ kind: 'context', used: this.budgetUsed, path: file.path, startLine: file.startLine, endLine: file.endLine });
    return context.text;
  }
  private async searchCode(options: SearchInput & { signal: AbortSignal }): Promise<CallToolResult> {
    const root = vscode.workspace.workspaceFolders?.[0];
    if (!root || root.uri.scheme !== 'file' || !vscode.workspace.isTrusted) throw new Error('Open a trusted local workspace first.');
    if (options.glob.includes('..') || options.glob.startsWith('/') || options.glob.includes('\\')) throw new Error('Use a workspace-relative glob.');
    const outputCharacters = Math.min(SEARCH_LIMITS.output_characters, this.remaining());
    if (outputCharacters < 6000) throw this.budgetError();
    const signal = AbortSignal.any([options.signal, AbortSignal.timeout(SEARCH_LIMITS.timeout_ms)]);
    const cancellation = new vscode.CancellationTokenSource();
    const abort = () => cancellation.cancel();
    signal.addEventListener('abort', abort, { once: true });
    try {
      signal.throwIfAborted();
      const candidates = await vscode.workspace.findFiles(new vscode.RelativePattern(root, options.glob), SEARCH_EXCLUDE, SEARCH_LIMITS.candidate_files + 1, cancellation.token);
      const paths = new Map<string, string>();
      // Binary and non-UTF-8 files cannot hold a text match, so skipping them does not limit coverage; other skips do.
      let bytes = 0, pathCharacters = 0, skipped = 0, nonText = 0;
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
            if (bytesRead > target.size) { skipped++; continue; }
            if (source.includes(0)) { nonText++; continue; }
            try { new TextDecoder('utf-8', { fatal: true }).decode(source); } catch { nonText++; continue; }
          } finally { await handle.close(); }
          paths.set(target.realPath, path);
          pathCharacters += target.realPath.length;
        } catch { skipped++; }
      }
      signal.throwIfAborted();
      const found = await searchWithRipgrep({ ...options, paths, signal, output_characters: outputCharacters });
      const coverageLimited = skipped > 0 || candidates.length > SEARCH_LIMITS.candidate_files;
      const truncated = found.truncated || coverageLimited;
      const result = { ...found, truncated, counts_complete: found.counts_complete && !coverageLimited, path_filter: options.glob, next_step: `${found.returned_matches} of ${found.observed_matches} observed matching lines shown.${truncated ? ' Results or coverage are incomplete: narrow the query or glob path filter using folder_counts, then search again.' : ''} Open relevant ranges with read_file before answering each requested part.`, candidate_limit_reached: candidates.length > SEARCH_LIMITS.candidate_files, skipped_files: skipped, non_text_files: nonText, eligible_files: paths.size, inspected_bytes: bytes, coverage: 'Saved UTF-8 text only. Counts refer to observed matching lines, not occurrences or all workspace files. Dirty, secret, unavailable, binary and oversized files are excluded. Omitted folder counts are aggregated separately. Use read_file for current editor text and an edit revision.', limits: SEARCH_LIMITS };
      this.budgetUsed += JSON.stringify(result).length;
      this.activityEvents.fire({ kind: 'search', used: this.budgetUsed, query: options.query, glob: options.glob, matches: found.returned_matches, fileCount: found.files.length, files: found.files.slice(0, 20).map(file => file.path), truncated: found.truncated || coverageLimited, ...(options.reason ? { reason: options.reason } : {}) });
      const budgeted = { ...result, context_budget: this.budget };
      return { content: [{ type: 'text', text: JSON.stringify(budgeted) }], structuredContent: budgeted };
    } finally { signal.removeEventListener('abort', abort); cancellation.dispose(); }
  }
  private makeServer(): McpServer {
    const server = new McpServer({ name: 'forge-editor', version: '0.0.1' });
    const register = <S extends z.ZodRawShape>(name: ToolName, config: { description: string; inputSchema: S; annotations: { readOnlyHint: boolean } }, handler: (input: z.output<z.ZodObject<S>>, extra: RequestHandlerExtra<ServerRequest, ServerNotification>) => Promise<CallToolResult>) => {
      const schema = z.object(config.inputSchema);
      return server.registerTool<z.ZodRawShape, typeof schema>(name, { ...config, inputSchema: schema }, (input, extra) => this.options.log.tool({ name, input, signal: extra.signal, run: async () => {
        // A refused call is shown in the feed too; otherwise the user sees an approval and then nothing.
        try { return await handler(input, extra); }
        catch (error) { this.activityEvents.fire({ kind: 'refused', tool: name, message: (error instanceof Error ? error.message : 'The tool call failed.').slice(0, 300) }); throw error; }
      } }));
    };
    register('search_code', { description: 'Search saved workspace text. Returns hits grouped by file with line numbers, up to three excerpts per file, observed folder counts and a next-step hint. Run one focused search per fact you need (for example where a name is defined, then where it is registered, imported or called); a distinctive identifier finds far fewer, better hits than a common word. Literal and case-insensitive by default; set regex to true for patterns such as alternatives (name_a|name_b). Use glob to filter paths and narrow incomplete searches. Then open each relevant hit with read_file around its line number.', inputSchema: SearchInputSchema.shape, annotations: { readOnlyHint: true } }, async (input, extra) => this.searchCode({ ...input, signal: extra.signal }));
    register('read_file', { description: 'Read numbered lines from a workspace file: 200 lines from start_line by default, at most 500 per call. Returns the actual range, total_lines, whether more lines follow, and the base_revision that propose_edit needs. When a search hit or other evidence gives a line number, start a few lines before it and read to the end of the enclosing block instead of starting at line 1; continue with a later start_line if the block is cut off.', inputSchema: { path: z.string(), start_line: z.number().int().min(1).default(1), end_line: z.number().int().min(1).optional(), reason: z.string().max(300).optional().describe('Optional: one short sentence telling the user why, shown in the editor activity feed.') }, annotations: { readOnlyHint: true } }, async ({ path, start_line, end_line, reason }) => {
      const { revision, file } = await this.options.edits.read(path);
      const lines = file.text.split('\n');
      if (start_line > lines.length || (end_line !== undefined && end_line < start_line)) throw new Error('Choose a line range inside this file.');
      const end = Math.min(end_line ?? start_line + 199, start_line + 499, lines.length);
      const allowance = Math.min(30000, this.remaining());
      if (allowance < 1000) throw this.budgetError();
      const output: string[] = [];
      let length = 0;
      for (let index = start_line - 1; index < end; index++) {
        const numbered = `${index + 1}: ${lines[index]}`;
        if (length + numbered.length + 1 > allowance) break;
        output.push(numbered);
        length += numbered.length + 1;
      }
      if (!output.length) throw new Error('This line exceeds the read budget. Inspect another range or file.');
      const actualEnd = start_line + output.length - 1;
      const text = output.join('\n');
      this.budgetUsed += text.length;
      this.activityEvents.fire({ kind: 'open', used: this.budgetUsed, path, startLine: start_line, endLine: actualEnd, ...(reason ? { reason } : {}) });
      // TrueForge prefers structured MCP results, so the source must be present there too.
      return { content: [{ type: 'text', text: `Base revision: ${revision}\n${path}: lines ${start_line}-${actualEnd} of ${lines.length}${actualEnd < lines.length ? '. More lines are available.' : ''}\n${this.budgetNote()}\n${text}` }], structuredContent: { base_revision: revision, path, start_line, end_line: actualEnd, total_lines: lines.length, text, truncated: actualEnd < lines.length, context_budget: this.budget } };
    });
    register('run_command', { description: 'Run one non-interactive shell command in the workspace, such as a test, lint or type check, after the user approves its exact text. Prefer the narrowest command that checks your change (for example one test file). Returns the exit code, duration and combined output; long output keeps the start and the end. There is no input, so prompts, servers and watch modes run until the timeout. Commands can change files and Forge cannot undo that, so stage source edits with propose_edit rather than editing through commands.', inputSchema: { command: z.string().min(1).max(COMMAND_LIMITS.command_characters), cwd: z.string().max(500).default('.').describe('Workspace-relative folder to run in; defaults to the workspace root.'), timeout_seconds: z.number().int().min(1).max(COMMAND_LIMITS.timeout_seconds_max).default(COMMAND_LIMITS.timeout_seconds_default), reason: z.string().max(300).optional().describe('Optional: one short sentence telling the user why, shown in the editor activity feed.') }, annotations: { readOnlyHint: false } }, async ({ command, cwd, timeout_seconds, reason }, extra) => {
      if (this.editScope !== undefined) throw new Error(`This is an inline edit of ${this.editScope}; commands are not part of it. Stage the edit, then tell the user which check to run.`);
      const root = vscode.workspace.workspaceFolders?.[0];
      if (!root || root.uri.scheme !== 'file' || !vscode.workspace.isTrusted) throw new Error('Open a trusted local workspace first.');
      const rootPath = await realpath(root.uri.fsPath);
      const folder = await realpath(resolve(rootPath, cwd)).catch(() => { throw new Error('Choose an existing workspace folder for cwd.'); });
      if (folder !== rootPath && !folder.startsWith(rootPath + sep)) throw new Error('cwd must stay inside the workspace.');
      if (!(await stat(folder)).isDirectory()) throw new Error('cwd must be a folder.');
      const outputCharacters = Math.min(COMMAND_LIMITS.output_characters, this.remaining());
      if (outputCharacters < 1000) throw this.budgetError();
      const result = await runCommand({ command, cwd: folder, timeoutSeconds: timeout_seconds, outputCharacters, signal: extra.signal });
      this.budgetUsed += result.output.length;
      const where = relative(rootPath, folder) || '.';
      this.activityEvents.fire({ kind: 'command', used: this.budgetUsed, command, cwd: where, exitCode: result.exit_code, timedOut: result.timed_out, cancelled: result.cancelled, durationMs: result.duration_ms, ...(reason ? { reason } : {}) });
      const ended = result.cancelled ? 'cancelled' : result.timed_out ? `stopped at the ${timeout_seconds} s timeout` : `exit code ${result.exit_code ?? result.signal}`;
      const structured = { command, cwd: where, ...result, context_budget: this.budget };
      return { content: [{ type: 'text', text: `$ ${command}\n(cwd ${where}) ${ended} after ${(result.duration_ms / 1000).toFixed(1)} s${result.output_truncated ? `; output shortened from ${result.total_output_characters} characters` : ''}\n${result.output}\n${this.budgetNote()}` }], structuredContent: structured };
    });
    register('list_files', { description: 'List up to 100 workspace file paths matching a glob, to get oriented when you do not yet know where relevant code lives. Narrow the glob to a folder or extension when the list is incomplete. A listing shows names only; read files before making claims about them.', inputSchema: { glob: z.string().max(200).default('**/*') }, annotations: { readOnlyHint: true } }, async ({ glob }) => {
      if (!vscode.workspace.isTrusted) throw new Error('Workspace trust is required.');
      const found = await vscode.workspace.findFiles(glob, '**/{node_modules,.git,.env*,out,dist}/**', 101);
      const files = found.slice(0, 100);
      const listed = files.map(uri => vscode.workspace.asRelativePath(uri)).join('\n');
      if (listed.length > this.remaining()) throw this.budgetError();
      this.budgetUsed += listed.length;
      this.activityEvents.fire({ kind: 'list', used: this.budgetUsed, glob, count: files.length });
      return { content: [{ type: 'text', text: `${listed}${found.length > 100 ? '\nMore files match; narrow the glob to see them.' : ''}\n${this.budgetNote()}` }] };
    });
    register('propose_edit', { description: 'Stage an edit for the user to review; nothing is written until they accept it. Pass base_revision from read_file. Locate the change in exactly one way: (1) old_text, the exact current text to replace, which must appear once in the file (include enough surrounding lines to make it unique; any line numbers sent with it are ignored); (2) start_line and end_line, to replace those inclusive complete lines; (3) insert_line, to insert new_text before that line (line count + 1 appends); (4) none of these, so new_text replaces the whole file. Line numbers refer to the file as read_file returned it. Several edits to one file combine into a single pending review; a whole-file edit replaces earlier pending changes.', inputSchema: { path: z.string(), base_revision: z.string(), new_text: z.string().max(MAX_EDIT_CHARACTERS), explanation: z.string().max(2000), old_text: z.string().min(1).max(MAX_EDIT_CHARACTERS).optional().describe('Exact current text to replace; must appear once. When given, it alone locates the change.'), start_line: z.number().int().min(1).optional().describe('First line to replace; requires end_line.'), end_line: z.number().int().min(1).optional().describe('Last line to replace (inclusive); requires start_line.'), insert_line: z.number().int().min(1).optional().describe('Insert new_text before this line instead of replacing lines.') }, annotations: { readOnlyHint: true } }, async ({ path, base_revision, new_text, explanation, old_text, start_line, end_line, insert_line }) => {
      if (this.editScope !== undefined && normalize(path).replace(/^\.\//u, '') !== this.editScope) throw new Error(`This request is limited to ${this.editScope}, the file the user selected. Do not stage changes to other files; mention any other change you think is needed in your reply instead.`);
      // old_text must match exactly once, so it locates the change unambiguously; line numbers sent with it are only hints and are ignored.
      const ignored = old_text === undefined ? [] : Object.entries({ start_line, end_line, insert_line }).filter(([, value]) => value !== undefined).map(([name]) => name);
      if (old_text === undefined && (start_line === undefined) !== (end_line === undefined)) throw new Error('Provide both start_line and end_line to replace lines, or use old_text or insert_line.');
      if (old_text === undefined && start_line !== undefined && insert_line !== undefined) throw new Error('Use either start_line/end_line (replace lines) or insert_line (insert before a line), not both.');
      const range = old_text === undefined && start_line !== undefined && end_line !== undefined ? { startLine: start_line, endLine: end_line } : undefined;
      const { id, combined, replaced } = await this.options.edits.stageEdit({ path, revision: base_revision, text: new_text, explanation, range, oldText: old_text, insertLine: old_text === undefined ? insert_line : undefined });
      const note = combined ? ` It includes your earlier pending changes to ${path}; all of them are reviewed together.`
        : replaced.length ? ` It replaced an earlier pending proposal for ${path} that could not be combined; include every change this file still needs.` : '';
      const detail = old_text !== undefined ? 'replace matched text' : range ? `lines ${range.startLine}–${range.endLine}` : insert_line !== undefined ? `insert at line ${insert_line}` : 'whole file';
      this.activityEvents.fire({ kind: 'propose', path, detail: `${detail}${combined ? ', combined with earlier changes' : replaced.length ? ', replaced an earlier proposal' : ''}`, reason: explanation.slice(0, 300) });
      const hint = ignored.length ? ` Ignored ${ignored.join(', ')} because old_text already locates the change.` : '';
      const message = `Proposal ${id} is staged for ${path}.${note}${hint} No files changed. To save it, the user must open Review changes in the Forge sidebar and click Accept hunk, Apply file or Apply all. The Command Palette also offers Forge: Apply All Proposed Changes. Chat approval alone does not write files. Do not ask the user to retype the changes manually.`;
      return { content: [{ type: 'text', text: message }], structuredContent: { proposal_id: id, status: 'staged', path, combined, replaced_proposal_ids: replaced, message } };
    });
    return server;
  }
}

// Adapted from cline/cline sdk/packages/core/src/extensions/tools/executors/search.ts
// at 7a7878cb52fc33967d8b464b3e3d899beac42d4d; Copyright 2026 Cline Bot Inc., Apache-2.0.
// Replaces Cline contracts/fallback with guarded paths, typed events and explicit limits/errors.
function searchWithRipgrep(options: SearchInput & { paths: Map<string, string>; signal: AbortSignal; output_characters: number }): Promise<{ files: SearchFile[]; folder_counts: Record<string, number>; omitted_folder_matches: number; observed_matches: number; returned_matches: number; counts_complete: boolean; truncated: boolean }> {
  options.signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const byFile = new Map<string, SearchFile>();
    const byFolder = new Map<string, number>();
    const folderFor = (path: string) => path.includes('/') ? path.split('/')[0] ?? '.' : '.';
    let observed = 0;
    const summarize = (incomplete: boolean) => {
      const buckets = new Map<string, SearchFile[]>();
      for (const file of [...byFile.values()].sort((a, b) => a.path.localeCompare(b.path))) {
        const key = folderFor(file.path);
        const bucket = buckets.get(key) ?? []; bucket.push(file); buckets.set(key, bucket);
      }
      const ordered: SearchFile[] = [];
      while ([...buckets.values()].some(bucket => bucket.length)) for (const bucket of buckets.values()) { const file = bucket.shift(); if (file) ordered.push(file); }
      const selected = new Map<string, SearchFile>();
      let shown = 0, size = 0;
      // Take one excerpt from each file before additional excerpts, rotating across folders.
      for (let index = 0; index < SEARCH_LIMITS.matches_per_file; index++) for (const file of ordered) {
        const hit = file.matches[index];
        if (!hit || shown >= options.max_results) continue;
        const cost = JSON.stringify(hit).length + (selected.has(file.path) ? 1 : JSON.stringify({ path: file.path, match_count: file.match_count, matches: [] }).length + 1);
        if (size + cost > options.output_characters - 4000) continue;
        const group = selected.get(file.path) ?? { path: file.path, match_count: file.match_count, matches: [] };
        group.matches.push(hit); selected.set(file.path, group); size += cost; shown++;
      }
      const folderCounts: Record<string, number> = {};
      let folderSize = 0, omitted = 0;
      for (const [folder, count] of byFolder) {
        const cost = JSON.stringify(folder).length + 24;
        if (folderSize + cost > 1200) { omitted += count; continue; }
        Object.defineProperty(folderCounts, folder, { value: count, enumerable: true }); folderSize += cost;
      }
      return { files: [...selected.values()], folder_counts: folderCounts, omitted_folder_matches: omitted, observed_matches: observed, returned_matches: shown, counts_complete: !incomplete, truncated: incomplete || shown < observed };
    };
    if (!options.paths.size) { resolve(summarize(false)); return; }
    const executable = join(vscode.env.appRoot, 'node_modules', '@vscode', 'ripgrep', 'bin', process.platform === 'win32' ? 'rg.exe' : 'rg');
    const child = spawn(executable, ['--no-config', '--json', '--max-filesize=256K', ...(options.regex ? [] : ['--fixed-strings']), ...(options.case_sensitive ? [] : ['--ignore-case']), '-e', options.query, '--', ...options.paths.keys()], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let pending = '', stderr = '', received = 0, settled = false;
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
      if (error) reject(error); else resolve(summarize(truncated));
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
          observed++;
          const folder = folderFor(path);
          byFolder.set(folder, (byFolder.get(folder) ?? 0) + 1);
          const file = byFile.get(path) ?? { path, match_count: 0, matches: [] };
          file.match_count++; byFile.set(path, file);
          if (file.matches.length >= SEARCH_LIMITS.matches_per_file) continue;
          const source = data.lines.text.replace(/\r?\n$/, '');
          const offset = Buffer.from(source).subarray(0, data.submatches[0]?.start ?? 0).toString('utf8').length;
          const start = Math.max(0, offset - 200);
          file.matches.push({ line: data.line_number, text: source.slice(start, start + SEARCH_LIMITS.line_characters), line_truncated: source.length > SEARCH_LIMITS.line_characters });
        } catch (error) { finish(new Error('Invalid ripgrep search output.', { cause: error })); }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(0, 2000); });
    child.once('error', error => finish(new Error('VS Code bundled ripgrep could not start. Check your VS Code installation.', { cause: error })));
    child.once('close', code => finish(code === 0 || code === 1 ? undefined : new Error(`Code search failed: ${stderr.trim() || `exit ${code}`}`)));
  });
}
