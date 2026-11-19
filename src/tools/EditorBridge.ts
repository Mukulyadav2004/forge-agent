import { createHash, randomBytes } from 'node:crypto';
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
import { buildProjectContext, buildProjectOverview, fileOutline } from '../context/projectContext';
import { loadWorkspaceInstructions } from '../context/environment';
import type { EditService } from '../edits/EditService';
import { MAX_EDIT_CHARACTERS } from '../edits/EditService';
import { savedExcerpt } from '../edits/lineChanges';
import { describeProblems, newProblems } from '../edits/diagnostics';
import { checkPlanCoverage, checklistLine, failureSignature, GUARD_LIMITS, itemStatus, PLAN_LIMITS, progressReport, RunGuard } from '../context/plan';
import type { PlanItem } from '../context/plan';
import type { Problem } from '../edits/diagnostics';
import type { WorkspaceFiles } from '../workspace/WorkspaceFiles';
import type { ToolLog, ToolName } from '../observability/events';
import { COMMAND_LIMITS, runCommand } from './runCommand';

/** Characters of workspace text one user request may bring into the model's context: reads, searches, listings and supplied context. */
/** Characters one request may read, about 90k tokens; TrueForge compacts the conversation at 100k tokens (forge-agent.json). */
export const CONTEXT_BUDGET = 350_000;
/** One read_file call: big enough to read a typical source file whole (Flask's cli.py is about 1,100 lines and 46,000 characters). */
/** Cline's per-read limits (2,000 lines, 48k characters); a file longer than one read also gets an outline so the next read can target a block. */
const READ_LIMITS = { default_window_lines: 2000, lines_per_call: 2000, characters_per_call: 48000, outline_characters: 4000 };
const SEARCH_LIMITS = { candidate_files: 1000, file_bytes: 262144, total_bytes: 8388608, output_characters: 20000, line_characters: 1000, matches_per_file: 3, timeout_ms: 5000 };
/** Lines as staging counts them: a final newline ends the last line instead of starting an empty one (an empty file is one empty line). */
function fileLines(text: string): string[] {
  const lines = text.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}
/** Errors VS Code currently reports for a file (from its language servers); warnings and hints are left out. */
function errorsOf(uri: vscode.Uri | undefined): Problem[] {
  if (!uri) return [];
  return vscode.languages.getDiagnostics(uri).filter(diagnostic => diagnostic.severity === vscode.DiagnosticSeverity.Error)
    .map(diagnostic => ({ line: diagnostic.range.start.line + 1, message: diagnostic.message, ...(diagnostic.source ? { source: diagnostic.source } : {}) }));
}
/** propose_edit arguments; the approval card and the later tool call carry the same ones. */
const PROPOSE_SHAPE = { path: z.string(), base_revision: z.string().optional().describe('From read_file. Required for start_line/end_line, insert_line and whole-file edits; optional with old_text, whose exact match proves the text is current.'), new_text: z.string({ error: 'new_text is required: the text that replaces the located lines. To delete them, pass an empty string.' }).max(MAX_EDIT_CHARACTERS), explanation: z.string().max(2000), old_text: z.string().min(1).max(MAX_EDIT_CHARACTERS).optional().describe('Exact current text to replace; must appear once. When given, it alone locates the change.'), start_line: z.number().int().min(1).optional().describe('First line to replace; requires end_line.'), end_line: z.number().int().min(1).optional().describe('Last line to replace (inclusive); requires start_line.'), insert_line: z.number().int().min(1).optional().describe('Insert new_text before this line instead of replacing lines.') };
const ProposeInputSchema = z.object(PROPOSE_SHAPE);
type ProposeInput = z.infer<typeof ProposeInputSchema>;
/** write_file arguments: a new file and its whole content. */
const WRITE_SHAPE = {
  path: z.string().describe('Workspace-relative path of the new file; folders are created as needed. It must not exist yet.'),
  content: z.string().max(MAX_EDIT_CHARACTERS).describe('The complete text of the new file.'),
  explanation: z.string().max(2000).describe('One short sentence telling the user why this file is needed.'),
};
const WriteInputSchema = z.object(WRITE_SHAPE);
type WriteInput = z.infer<typeof WriteInputSchema>;
function writeKey(input: WriteInput): string { return JSON.stringify(['write_file', input.path, input.content, input.explanation]); }
/** Identifies one propose_edit call by its arguments, so the tool call after an approval finds the result the user already decided. */
function editKey(input: ProposeInput): string {
  return JSON.stringify([input.path, input.base_revision, input.new_text, input.explanation, input.old_text ?? null, input.start_line ?? null, input.end_line ?? null, input.insert_line ?? null]);
}
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
  /** Commands run in this request; each needs its own approval, so a request gets a few and then must hand over to the user. */
  private commandsRun = 0;
  /** Line ranges the agent has read of each file at its current content; a whole-file replacement needs every line read. */
  private readonly readCoverage = new Map<string, [number, number][]>();
  private coverageKey(path: string, text: string): string { return `${normalize(path).replace(/^\.\//u, '')}\0${createHash('sha256').update(text).digest('hex')}`; }
  private unreadLines(path: string, text: string): number {
    const total = fileLines(text).length;
    let next = 1, unread = 0;
    for (const [start, end] of [...(this.readCoverage.get(this.coverageKey(path, text)) ?? [])].sort((a, b) => a[0] - b[0])) {
      if (start > next) unread += start - next;
      next = Math.max(next, end + 1);
    }
    return unread + Math.max(0, total - next + 1);
  }
  /** Called once per user request (not for approvals or retries of it). */
  beginRequest(scope?: string, requestText = ''): void {
    this.budgetUsed = 0; this.editScope = scope; this.commandsRun = 0; this.awaitingReview.clear(); this.reviewed.clear(); this.options.edits.beginRequest();
    this.requestText = requestText; this.plan = undefined; this.changedPaths.clear(); this.guard.reset(); this.refusals.clear(); this.lastCommand = undefined;
    this.activityEvents.fire({ kind: 'request', limit: CONTEXT_BUDGET });
  }
  /** The user's words for this request, its plan (plan_task), files changed so far, and the last failure of each command. */
  private requestText = '';
  private plan: PlanItem[] | undefined;
  private readonly changedPaths = new Set<string>();
  /** Loops, error streaks and stalls in this request (see RunGuard). */
  private readonly guard = new RunGuard();
  /** Asks the sidebar to stop the running turn; shown in the activity as a Forge refusal. */
  private stopTurn(reason: string): void { this.activityEvents.fire({ kind: 'refused', tool: 'forge', message: `Forge stopped the turn: ${reason}`.slice(0, 300) }); }
  /** A call the sidebar denied without running it (an invalid edit, a command past the limit) counts like a refused call. */
  guardDeny(name: string, argumentsJson: string, reason: string): string {
    let input: unknown = argumentsJson;
    try { input = JSON.parse(argumentsJson); } catch { /* compared as text */ }
    const verdict = this.guard.call(name, input);
    const outcome = this.guard.outcome(false, reason);
    const stop = verdict.stop ?? outcome.stop;
    if (stop) this.stopTurn(stop);
    return verdict.notice ? `${reason}\n${verdict.notice}` : reason;
  }
  /** The progress report for a stall, with the facts the model needs to decide how to go on. */
  private progress(failing?: { command: string; count: number; error: string }): string {
    return progressReport({ ...(failing ? { failing } : {}), edits: this.guard.topEdits(), open: this.openRequirements(), commandsLeft: this.commandsLeft(), siblings: [...new Set((this.plan ?? []).flatMap(item => item.sibling ? [item.sibling] : []))] });
  }
  /** Counts an edit to a file; at the threshold, once per file, returns the progress report. */
  private editedNote(path: string): string {
    const count = this.guard.edited(path.replace(/^\.\//u, ''));
    return count >= GUARD_LIMITS.file_edits_report && this.guard.firstReport(`edits:${path}`) ? `\n${this.progress()}` : '';
  }
  /** A missing path or a folder gets a plain answer instead of a file-system error. */
  private async assertFile(path: string): Promise<void> {
    const located = await this.options.files.locate(path);
    if (located.kind === 'missing') throw new Error(`${path} does not exist. To create it, use write_file; otherwise check the path with list_files.`);
    if (located.kind === 'directory') throw new Error(`${path} is a folder. Use list_files to see what is in it.`);
  }
  /** Identical refused calls in this request, and the last command that ran (shown in the end-of-turn checklist). */
  private readonly refusals = new Map<string, number>();
  private lastCommand: { command: string; exitCode: number | null } | undefined;
  /** The checklist line; for a saved or staged file the plan does not name, a note so a wrong file is noticed early. */
  private checklistNote(path?: string): string {
    const line = checklistLine(this.plan, this.changedPaths);
    const clean = path?.trim().replace(/\\/gu, '/').replace(/^\.\//u, '');
    const unplanned = clean && this.plan?.length && !this.plan.some(item => item.file === clean)
      ? `\n${clean} is not a file in your plan. If it replaces a planned file, call plan_task again with this file; otherwise check that it belongs to this task.` : '';
    return `${line ? `\n${line}` : ''}${unplanned}`;
  }
  /** Commands this request may still run; approvals beyond it are denied without asking the user. */
  commandsLeft(): number { return Math.max(0, COMMAND_LIMITS.per_request - this.commandsRun); }
  /** Requirements of this request's plan that have no change and no stated reason. */
  openRequirements(): PlanItem[] { return (this.plan ?? []).filter(item => itemStatus(item, this.changedPaths) === 'open'); }
  /** The last command and its exit code, for the end-of-turn check. */
  lastCommandResult(): { command: string; exitCode: number | null } | undefined { return this.lastCommand; }
  /** When the turn ends: show the checklist and return requirements that have no change and no stated reason. */
  finishChecklist(): PlanItem[] {
    if (!this.plan?.length) return [];
    const rows = this.plan.map(item => ({ quote: item.quote.slice(0, 300), file: item.file.slice(0, 400), ...(item.sibling ? { sibling: item.sibling.slice(0, 150) } : {}), status: itemStatus(item, this.changedPaths), ...(item.skip_reason ? { note: item.skip_reason.slice(0, 300) } : {}) }));
    const last = this.lastCommand ? `last command: ${this.lastCommand.command.slice(0, 160)} → exit ${this.lastCommand.exitCode ?? 'signal'}` : undefined;
    this.activityEvents.fire({ kind: 'plan', stage: 'end', items: rows, ...(last ? { lastCommand: last } : {}) });
    return this.openRequirements();
  }
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
  async openFile(options: { path: string; line: number }): Promise<void> { await this.showFile(options); }
  private async showFile(options: { path: string; line: number; preserveFocus?: boolean }): Promise<void> {
    const document = await this.options.files.open(options.path);
    const position = new vscode.Position(Math.max(0, Math.min(options.line - 1, document.lineCount - 1)), 0);
    await vscode.window.showTextDocument(document, { selection: new vscode.Range(position, position), preview: true, preserveFocus: options.preserveFocus ?? false });
  }
  async architectureContext(): Promise<string> {
    const paths = await vscode.workspace.findFiles('**/*', '**/{node_modules,.git,.env*,out,dist,.venv,venv,__pycache__}/**', 500);
    const context = await buildProjectContext({ paths: paths.map(uri => vscode.workspace.asRelativePath(uri)), readFile: async path => (await this.options.files.open(path)).getText() });
    this.budgetUsed += context.text.length;
    for (const file of context.files) this.activityEvents.fire({ kind: 'context', used: this.budgetUsed, path: file.path, startLine: file.startLine, endLine: file.endLine });
    return context.text;
  }
  /** Checks and stages one propose_edit call; nothing is written. Used by the tool and when an edit waits for approval. */
  private async stageProposal(input: ProposeInput): Promise<{ id: string; combined: boolean; replaced: string[]; detail: string; ignored: string[] }> {
    const { path, base_revision, new_text, explanation, old_text, start_line, end_line, insert_line } = input;
    await this.assertFile(path);
    if (this.editScope !== undefined && normalize(path).replace(/^\.\//u, '') !== this.editScope) throw new Error(`This request is limited to ${this.editScope}, the file the user selected. Do not stage changes to other files; mention any other change you think is needed in your reply instead.`);
    if (old_text === undefined && start_line === undefined && end_line === undefined && insert_line === undefined) {
      // Replacing a whole file the agent has not fully read silently drops the parts it never saw.
      const unread = this.unreadLines(path, (await this.options.files.open(path)).getText());
      if (unread > 0) throw new Error(`A whole-file replacement needs the whole file read first, and ${unread} line(s) of ${path} have not been read at its current content. Read the rest first, or change only part of it with old_text or start_line/end_line.`);
    }
    // old_text must match exactly once, so it locates the change unambiguously; line numbers sent with it are only hints and are ignored.
    const ignored = old_text === undefined ? [] : Object.entries({ start_line, end_line, insert_line }).filter(([, value]) => value !== undefined).map(([name]) => name);
    if (old_text === undefined && (start_line === undefined) !== (end_line === undefined)) throw new Error('Provide both start_line and end_line to replace lines, or use old_text or insert_line.');
    if (old_text === undefined && start_line !== undefined && insert_line !== undefined) throw new Error('Use either start_line/end_line (replace lines) or insert_line (insert before a line), not both.');
    const range = old_text === undefined && start_line !== undefined && end_line !== undefined ? { startLine: start_line, endLine: end_line } : undefined;
    const { id, combined, replaced } = await this.options.edits.stageEdit({ path, revision: base_revision, text: new_text, explanation, range, oldText: old_text, insertLine: old_text === undefined ? insert_line : undefined });
    const detail = old_text !== undefined ? 'replace matched text' : range ? `lines ${range.startLine}–${range.endLine}` : insert_line !== undefined ? `insert at line ${insert_line}` : 'whole file';
    return { id, combined, replaced, detail, ignored };
  }
  /** Edits staged while TrueForge waits for the user's approval, by call; and the results the following tool calls return. */
  private readonly awaitingReview = new Map<string, { path: string }>();
  private readonly reviewed = new Map<string, { message: string; saved: number; rejected: number; revision?: string; error?: string; problems?: number }>();
  /** How long a save waits for VS Code to re-check the file; a language server usually answers within a second. */
  private static readonly DIAGNOSTICS_WAIT_MS = 2500;
  /**
   * Save-on-approve, step 1: when TrueForge pauses on a propose_edit approval, stage the edit and open its diff so the
   * user reviews it hunk by hunk before deciding. Edit Selection keeps the staged review ('stage'); a call that cannot
   * be staged is returned with its error ('invalid') so the agent can correct it without asking the user.
   */
  async prepareEdit(name: 'propose_edit' | 'write_file', argumentsJson: string): Promise<{ status: 'review' | 'stage' } | { status: 'invalid'; message: string }> {
    if (this.editScope !== undefined) return { status: 'stage' };
    let parsed: unknown;
    try { parsed = JSON.parse(argumentsJson); } catch { return { status: 'invalid', message: `The ${name} arguments could not be read. Send the call again with valid arguments.` }; }
    try {
      let key: string, path: string, explanation: string, detail: string, id: string;
      if (name === 'write_file') {
        const input = WriteInputSchema.parse(parsed);
        ({ id } = await this.stageWrite(input));
        [key, path, explanation, detail] = [writeKey(input), input.path, input.explanation, 'new file'];
      } else {
        const input = ProposeInputSchema.parse(parsed);
        const staged = await this.stageProposal(input);
        [key, path, explanation, detail, id] = [editKey(input), input.path, input.explanation, staged.detail, staged.id];
      }
      this.awaitingReview.set(key, { path });
      this.activityEvents.fire({ kind: 'propose', path, detail: `${detail} · waiting for your review`, reason: explanation.slice(0, 300) });
      await this.options.edits.preview(id).catch(() => undefined);
      return { status: 'review' };
    } catch (error) {
      const message = error instanceof z.ZodError ? `The ${name} arguments are invalid: ${error.issues.map(issue => issue.message.startsWith(String(issue.path[0] ?? '')) ? issue.message : `${issue.path.join('.')} ${issue.message}`).join('; ')}` : error instanceof Error ? error.message : 'The edit could not be prepared.';
      this.activityEvents.fire({ kind: 'refused', tool: name, message });
      return { status: 'invalid', message };
    }
  }
  /** Checks and stages one new file; nothing is written. */
  private async stageWrite(input: WriteInput): Promise<{ id: string }> {
    if (this.editScope !== undefined) throw new Error(`This request is limited to ${this.editScope}, the file the user selected. Do not create files; mention any other change you think is needed in your reply instead.`);
    return this.options.edits.stageCreate({ path: input.path, text: input.content, explanation: input.explanation });
  }
  /**
   * Save-on-approve, step 2: Approve saves every hunk the user did not reject (guarded apply, undoable); Deny rejects them.
   * The result for each call is kept for the tool call TrueForge makes after an approval.
   */
  async settleEdits(allow: boolean): Promise<void> {
    const waiting = [...this.awaitingReview];
    this.awaitingReview.clear();
    const latest = (path: string) => [...this.options.edits.state.proposals].reverse().find(proposal => proposal.path === path && proposal.status !== 'superseded');
    const textBefore = new Map<string, string>();
    const problemsBefore = new Map<string, Problem[]>();
    const root = vscode.workspace.workspaceFolders?.[0];
    const uriOf = (path: string) => root ? vscode.Uri.joinPath(root.uri, path) : undefined;
    // Listen before saving, so a fast language server's re-check is not missed.
    const rechecked = allow ? this.waitForDiagnostics([...new Set(waiting.map(([, item]) => item.path))].flatMap(path => uriOf(path) ?? []), EditorBridge.DIAGNOSTICS_WAIT_MS) : Promise.resolve();
    for (const path of new Set(waiting.map(([, item]) => item.path))) {
      const proposal = latest(path);
      if (!proposal || (proposal.status !== 'pending' && proposal.status !== 'conflict')) continue;
      if (!allow) { await this.options.edits.reject(proposal.id).catch(() => undefined); continue; }
      // A new file has no text yet; the saved excerpt then shows all of it.
      textBefore.set(path, await this.options.edits.read(path).then(read => read.file.text, () => ''));
      problemsBefore.set(path, errorsOf(uriOf(path)));
      try { if (proposal.hunks.some(hunk => hunk.status === 'pending')) await this.options.edits.apply(proposal.id); }
      catch (error) {
        for (const [key, item] of waiting) if (item.path === path) this.reviewed.set(key, { message: '', saved: 0, rejected: 0, error: `Nothing was saved to ${path}: ${error instanceof Error ? error.message : 'the apply failed'} Read the file again and propose the edit again.` });
      }
    }
    if (!allow) return;
    await rechecked;
    const afterSave = new Map<string, { revision?: string; excerpt: string; firstLine?: number; problems: Problem[] }>();
    let shown: { path: string; line: number } | undefined;
    for (const [key, { path }] of waiting) {
      if (this.reviewed.has(key)) continue;
      const hunks = latest(path)?.hunks ?? [];
      const saved = hunks.filter(hunk => hunk.status === 'applied').length;
      const rejected = hunks.filter(hunk => hunk.status === 'rejected');
      let state = afterSave.get(path);
      if (!state) {
        state = { excerpt: '', problems: [] };
        try {
          const read = await this.options.edits.read(path);
          const excerpt = saved ? savedExcerpt(textBefore.get(path) ?? '', read.file.text) : { text: '' };
          const problems = saved ? newProblems(problemsBefore.get(path) ?? [], errorsOf(uriOf(path))) : [];
          state = { revision: read.revision, excerpt: excerpt.text, problems, ...(excerpt.firstLine ? { firstLine: excerpt.firstLine } : {}) };
        } catch { /* reported without a revision or excerpt */ }
        afterSave.set(path, state);
        if (saved && state.firstLine) shown = { path, line: state.firstLine };
      }
      const message = [
        saved ? `Saved ${path} after the user reviewed the diff: ${saved} of ${hunks.length} hunk(s) are on disk, so commands now see them.` : `The user rejected every hunk of this edit to ${path}; nothing was saved.`,
        rejected.length ? `The user rejected the hunk(s) at original line(s) ${rejected.map(hunk => hunk.oldStart).join(', ')}; they were not saved. Do not propose them again unless the user asks.` : '',
        state.revision ? `Use base_revision ${state.revision} for further edits to ${path}.` : '',
      ].filter(Boolean).join(' ') + (saved && state.excerpt ? `\nSaved lines of ${path}, numbered as the file is now:\n${state.excerpt}` : '')
        + (state.problems.length ? `\n${describeProblems(path, state.problems)}` : '');
      if (saved) this.changedPaths.add(path.replace(/^\.\//u, ''));
      this.reviewed.set(key, { message: message + this.checklistNote(saved ? path : undefined) + (saved ? this.editedNote(path) : ''), saved, rejected: rejected.length, problems: state.problems.length, ...(state.revision ? { revision: state.revision } : {}) });
    }
    // Like Cline, the saved file opens in the editor at the change; focus stays in the sidebar so review continues there.
    if (shown) await this.showFile({ ...shown, preserveFocus: true }).catch(() => undefined);
  }
  /** Resolves once VS Code has re-published diagnostics for every given file, or after the wait; never rejects. */
  private waitForDiagnostics(uris: vscode.Uri[], waitMs: number): Promise<void> {
    if (!uris.length) return Promise.resolve();
    return new Promise(resolvePromise => {
      const pending = new Set(uris.map(uri => uri.toString()));
      const done = () => { clearTimeout(timer); subscription.dispose(); resolvePromise(); };
      const timer = setTimeout(done, waitMs);
      const subscription = vscode.languages.onDidChangeDiagnostics(event => {
        for (const uri of event.uris) pending.delete(uri.toString());
        if (!pending.size) done();
      });
    });
  }
  /** Python interpreters of virtual environments at the workspace root (existence only; nothing is run or read). */
  private async workspaceEnvironments(): Promise<string[]> {
    const root = vscode.workspace.workspaceFolders?.[0];
    if (!root) return [];
    const found: string[] = [];
    for (const candidate of ['.venv/bin/python', 'venv/bin/python', '.venv/Scripts/python.exe', 'venv/Scripts/python.exe']) {
      try { await vscode.workspace.fs.stat(vscode.Uri.joinPath(root.uri, candidate)); found.push(candidate); } catch { /* not present */ }
    }
    return found;
  }
  /** After "command not found" or a missing module, point at the workspace environment or the overview's setup instead of letting the model guess variants. */
  private async missingToolHint(output: string, exitCode: number | null): Promise<string> {
    if (exitCode !== 127 && !/command not found|No module named|is not recognized as an internal or external command/u.test(output)) return '';
    const [environment] = await this.workspaceEnvironments();
    return environment
      ? `Hint: a program or module was not found. The workspace has a virtual environment; run Python tools through it, for example ${environment} -m pytest, instead of retrying system commands.`
      : 'Hint: a program or module was not found and the workspace has no virtual environment. Use the setup commands from the project overview, or ask the user how they run tests. Do not retry variants of the same command.';
  }
  /** A new session's AGENTS.md or CLAUDE.md from the workspace root, read through the guarded reader, counted in the budget and shown in the activity. */
  async projectInstructions(): Promise<string> {
    if (!vscode.workspace.isTrusted) return '';
    const loaded = await loadWorkspaceInstructions(async path => (await this.options.files.open(path)).getText());
    if (!loaded.text || !loaded.file) return '';
    this.budgetUsed += loaded.text.length;
    this.activityEvents.fire({ kind: 'context', used: this.budgetUsed, path: loaded.file.path, startLine: 1, endLine: loaded.file.lines });
    return loaded.text;
  }
  /** First request of a chat: a depth-2 tree and the project's declared test setup, charged to the budget and shown in the activity. */
  async projectOverview(): Promise<string> {
    const root = vscode.workspace.workspaceFolders?.[0];
    if (!root || root.uri.scheme !== 'file' || !vscode.workspace.isTrusted) return '';
    const uris = await vscode.workspace.findFiles('**/*', '**/{node_modules,.git,.env*,out,dist,build,.venv,venv,__pycache__,coverage,.tox,.nox,.mypy_cache,.pytest_cache,.ruff_cache,target}/**', 3000);
    const paths = uris.map(uri => vscode.workspace.asRelativePath(uri, false)).filter(path => !/(^|\/)\.env(\.|$)/u.test(path));
    const overview = await buildProjectOverview({ paths, environments: await this.workspaceEnvironments(), platform: process.platform, readFile: async path => (await this.options.files.open(path)).getText() });
    if (!overview.text) return '';
    this.budgetUsed += overview.text.length;
    this.activityEvents.fire({ kind: 'list', used: this.budgetUsed, glob: 'project overview (folders to depth 2)', count: paths.length });
    for (const file of overview.files) this.activityEvents.fire({ kind: 'context', used: this.budgetUsed, path: file.path, startLine: file.startLine, endLine: file.endLine });
    return overview.text;
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
        // Loops (Cline's model): the third identical call in a row gets a note, the fifth stops the turn.
        const verdict = this.guard.call(name, input);
        if (verdict.stop) { this.stopTurn(verdict.stop); throw new Error(`Stopped: ${verdict.stop} Write your summary instead of calling tools.`); }
        // A refused call is shown in the feed too; otherwise the user sees an approval and then nothing.
        try {
          const result = await handler(input, extra);
          this.guard.outcome(true);
          if (!verdict.notice) return result;
          // TrueForge may read only the structured result, so the note goes in both places.
          const first = result.content[0];
          return { ...result, content: first?.type === 'text' ? [{ ...first, text: `${first.text}\n${verdict.notice}` }, ...result.content.slice(1)] : result.content,
            ...(result.structuredContent ? { structuredContent: { ...result.structuredContent, forge_notice: verdict.notice } } : {}) };
        }
        catch (error) {
          const streak = this.guard.outcome(false, error instanceof Error ? error.message : '');
          if (streak.stop) this.stopTurn(streak.stop);
          // The same refused call again gets the same answer, so say so: models otherwise repeat it many times.
          const key = `${name}\0${JSON.stringify(input)}`;
          const times = (this.refusals.get(key) ?? 0) + 1;
          this.refusals.set(key, times);
          const message = error instanceof Error ? error.message : 'The tool call failed.';
          this.activityEvents.fire({ kind: 'refused', tool: name, message: message.slice(0, 300) });
          const notes = [times > 1 ? `This exact call was already refused ${times - 1} time(s) and will be refused again. Change the call, or stop and summarize what is done and what is not.` : '', verdict.notice ?? ''].filter(Boolean);
          if (notes.length) throw new Error(`${message}\n${notes.join('\n')}`, { cause: error });
          throw error;
        }
      } }));
    };
    register('search_code', { description: 'Search saved workspace text. Returns hits grouped by file with line numbers, up to three excerpts per file, observed folder counts and a next-step hint. Run one focused search per fact you need (for example where a name is defined, then where it is registered, imported or called); a distinctive identifier finds far fewer, better hits than a common word. Literal and case-insensitive by default; set regex to true for patterns such as alternatives (name_a|name_b). Use glob to filter paths and narrow incomplete searches. Then open each relevant hit with read_file around its line number.', inputSchema: SearchInputSchema.shape, annotations: { readOnlyHint: true } }, async (input, extra) => this.searchCode({ ...input, signal: extra.signal }));
    register('read_file', { description: `Read numbered lines from a workspace file. Without end_line it returns up to ${READ_LIMITS.default_window_lines} lines from start_line; if the file is longer, it also returns an outline of the whole file (definitions or headings with line numbers). Use the outline or a search hit to read just the block you need with start_line and end_line (up to ${READ_LIMITS.lines_per_call} lines or ${READ_LIMITS.characters_per_call} characters per call). Returns the actual range, total_lines, whether more lines follow, and the base_revision that propose_edit needs.`, inputSchema: { path: z.string(), start_line: z.number().int().min(1).default(1), end_line: z.number().int().min(1).optional(), reason: z.string().max(300).optional().describe('Optional: one short sentence telling the user why, shown in the editor activity feed.') }, annotations: { readOnlyHint: true } }, async ({ path, start_line, end_line, reason }) => {
      await this.assertFile(path);
      const { revision, file } = await this.options.edits.read(path);
      const lines = fileLines(file.text);
      if (start_line > lines.length || (end_line !== undefined && end_line < start_line)) throw new Error('Choose a line range inside this file.');
      const end = Math.min(end_line ?? start_line + READ_LIMITS.default_window_lines - 1, start_line + READ_LIMITS.lines_per_call - 1, lines.length);
      const allowance = Math.min(READ_LIMITS.characters_per_call, this.remaining());
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
      // A default-window read of a longer file also gets the file's outline, so the next read can target one block.
      const outline = end_line === undefined && (start_line > 1 || actualEnd < lines.length) ? fileOutline(path, file.text, Math.min(READ_LIMITS.outline_characters, Math.max(0, this.remaining() - text.length))) : '';
      this.budgetUsed += text.length + outline.length;
      const key = this.coverageKey(path, file.text);
      this.readCoverage.set(key, [...(this.readCoverage.get(key) ?? []), [start_line, actualEnd]]);
      this.activityEvents.fire({ kind: 'open', used: this.budgetUsed, path, startLine: start_line, endLine: actualEnd, ...(reason ? { reason } : {}) });
      // TrueForge prefers structured MCP results, so the source must be present there too.
      const outlineText = outline ? `\n\nOutline of ${path} (${lines.length} lines; read a block with start_line and end_line):\n${outline}` : '';
      return { content: [{ type: 'text', text: `Base revision: ${revision}\n${path}: lines ${start_line}-${actualEnd} of ${lines.length}${actualEnd < lines.length ? '. More lines are available.' : ''}\n${this.budgetNote()}\n${text}${outlineText}` }], structuredContent: { base_revision: revision, path, start_line, end_line: actualEnd, total_lines: lines.length, text, ...(outline ? { outline } : {}), truncated: actualEnd < lines.length, context_budget: this.budget } };
    });
    register('run_command', { description: 'Run one non-interactive shell command in the workspace, such as a test, lint or type check, after the user approves its exact text. Prefer the narrowest command that checks your change (for example one test file). Returns the exit code, duration and combined output; long output keeps the start and the end. There is no input, so prompts, servers and watch modes run until the timeout. Commands can change files and Forge cannot undo that, so stage source edits with propose_edit rather than editing through commands.', inputSchema: { command: z.string().min(1).max(COMMAND_LIMITS.command_characters), cwd: z.string().max(500).default('.').describe('Workspace-relative folder to run in; defaults to the workspace root.'), timeout_seconds: z.number().int().min(1).max(COMMAND_LIMITS.timeout_seconds_max).default(COMMAND_LIMITS.timeout_seconds_default), reason: z.string().min(1).max(300).describe('One short sentence telling the user why this command is needed; shown in the approval and the activity feed.') }, annotations: { readOnlyHint: false } }, async ({ command, cwd, timeout_seconds, reason }, extra) => {
      if (this.editScope !== undefined) throw new Error(`This is an inline edit of ${this.editScope}; commands are not part of it. Stage the edit, then tell the user which check to run.`);
      if (this.commandsRun >= COMMAND_LIMITS.per_request) throw new Error(`This request already ran ${COMMAND_LIMITS.per_request} commands, the limit per request. Stop running commands; tell the user what to run or what is missing, and they can ask you to continue.`);
      const root = vscode.workspace.workspaceFolders?.[0];
      if (!root || root.uri.scheme !== 'file' || !vscode.workspace.isTrusted) throw new Error('Open a trusted local workspace first.');
      const rootPath = await realpath(root.uri.fsPath);
      const folder = await realpath(resolve(rootPath, cwd)).catch(() => { throw new Error('Choose an existing workspace folder for cwd.'); });
      if (folder !== rootPath && !folder.startsWith(rootPath + sep)) throw new Error('cwd must stay inside the workspace.');
      if (!(await stat(folder)).isDirectory()) throw new Error('cwd must be a folder.');
      const outputCharacters = Math.min(COMMAND_LIMITS.output_characters, this.remaining());
      if (outputCharacters < 1000) throw this.budgetError();
      this.lastCommand = undefined;
      this.commandsRun++; // counted only once it actually runs; refused calls do not use the budget
      const result = await runCommand({ command, cwd: folder, timeoutSeconds: timeout_seconds, outputCharacters, signal: extra.signal });
      this.budgetUsed += result.output.length;
      const where = relative(rootPath, folder) || '.';
      this.activityEvents.fire({ kind: 'command', used: this.budgetUsed, command, cwd: where, exitCode: result.exit_code, timedOut: result.timed_out, cancelled: result.cancelled, durationMs: result.duration_ms, ...(reason ? { reason } : {}) });
      const ended = result.cancelled ? 'cancelled' : result.timed_out ? `stopped at the ${timeout_seconds} s timeout` : `exit code ${result.exit_code ?? result.signal}`;
      this.lastCommand = { command, exitCode: result.exit_code };
      const missing = await this.missingToolHint(result.output, result.exit_code);
      // The same failure twice in a row means the last change did not touch the cause: point at the code to compare with.
      const signature = result.exit_code ? failureSignature(result.output) : '';
      const failedInARow = this.guard.commandResult(command, signature);
      const repeated = failedInARow === 2;
      const siblings = [...new Set((this.plan ?? []).flatMap(item => item.sibling ? [item.sibling] : []))];
      // From the third identical failure on, once per command: the facts and three ways on, for the model to choose.
      const stalled = failedInARow >= GUARD_LIMITS.same_failure_report && this.guard.firstReport(`fail:${command}`) ? this.progress({ command, count: failedInARow, error: signature }) : '';
      const same = stalled ? stalled : repeated ? `Same failure as the previous run of this command, so the last change did not reach the cause. Before editing the test again, compare your code with how ${siblings.length ? siblings.join(', ') : 'the existing similar code'} is defined, registered and tested, or run a small probe to see the actual state.` : '';
      const hint = [missing, same].filter(Boolean).join('\n') + (this.plan ? checklistLine(this.plan, this.changedPaths) ? `\n${checklistLine(this.plan, this.changedPaths)}` : '' : '');
      const structured = { command, cwd: where, ...result, ...(hint ? { hint } : {}), context_budget: this.budget };
      return { content: [{ type: 'text', text: `$ ${command}\n(cwd ${where}) ${ended} after ${(result.duration_ms / 1000).toFixed(1)} s${result.output_truncated ? `; output shortened from ${result.total_output_characters} characters` : ''}\n${result.output}\n${hint ? `${hint}\n` : ''}${this.budgetNote()}` }], structuredContent: structured };
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
    register('plan_task', { description: `Start every coding task (add, change or fix) with this, before any edit. List one requirement per thing the user's request asks for: quote the user's own words for it, say what will change, name the file you will change, and name an existing similar thing in this project to copy (for example a sibling function, command, route, test or docs section). The plan is checked against the request: a part of the request with no requirement is reported back. For each sibling the result shows every place it appears (where it is defined, registered, tested and documented), so your change can follow the same path. Call it again to update the plan; give skip_reason for a requirement that needs no change. Up to ${PLAN_LIMITS.max_items} requirements.`, inputSchema: {
      requirements: z.array(z.object({
        quote: z.string().min(1).max(PLAN_LIMITS.quote_characters).describe("The user's own words for this requirement, copied from the request."),
        change: z.string().min(1).max(300).describe('What will change for it, in one short sentence.'),
        file: z.string().min(1).max(400).describe('Workspace-relative path of the file you will change or create for it.'),
        sibling: z.string().max(120).optional().describe('The name of an existing similar function, class, command, route or test in this project to copy (a code name, not a file path).'),
        skip_reason: z.string().max(300).optional().describe('Only if this requirement needs no change: why, in plain words.'),
      })).min(1).max(PLAN_LIMITS.max_items),
    }, annotations: { readOnlyHint: true } }, async ({ requirements }, extra) => {
      const coverage = checkPlanCoverage(this.requestText, requirements);
      if (!coverage.ok) throw new Error(coverage.message);
      this.plan = requirements.map(item => ({ ...item, file: item.file.trim().replace(/\\/gu, '/').replace(/^\.\//u, '') }));
      this.activityEvents.fire({ kind: 'plan', stage: 'start', items: this.plan.map(item => ({ quote: item.quote.slice(0, 300), file: item.file.slice(0, 400), ...(item.sibling ? { sibling: item.sibling.slice(0, 150) } : {}), status: item.skip_reason ? 'skipped' : 'planned', ...(item.skip_reason ? { note: item.skip_reason.slice(0, 300) } : {}) })) });
      // The sibling's footprint: every place an existing similar thing appears, so a weak model sees where to register, test and document.
      const footprints: string[] = [];
      for (const named of [...new Set(this.plan.flatMap(item => item.sibling?.trim() ? [item.sibling.trim()] : []))].slice(0, 4)) {
        // A dotted name (module.path.name) is searched by its last part, which is how code mentions it; a file path is not a sibling.
        if (/[\\/]/u.test(named) || /\.(?:py|pyi|ts|tsx|js|jsx|mjs|rst|md|txt|json|toml|cfg|ini|ya?ml|html|css|go|rs|java|rb)$/iu.test(named)) { footprints.push(`${named} is a file, not a sibling: name an existing function, class, command, route or test in it instead.`); continue; }
        const sibling = named.includes('.') ? named.split('.').pop() ?? named : named;
        try {
          const found = await this.searchCode({ query: sibling, glob: '**/*', regex: false, case_sensitive: true, max_results: 40, reason: `Footprint of ${sibling} for the plan.`, signal: extra.signal });
          const files = ((found.structuredContent as { files?: { path: string; match_count: number; matches: { line: number; text: string }[] }[] } | undefined)?.files ?? []);
          footprints.push(files.length ? `${sibling} appears in:\n${files.slice(0, 12).map(file => file.matches.map(match => `  ${file.path}:${match.line}  ${match.text.trim().slice(0, 140)}`).join('\n')).join('\n')}` : `${sibling} does not appear in the workspace; name an existing similar thing instead.`);
        } catch (error) { footprints.push(`${sibling}: the footprint search failed (${error instanceof Error ? error.message.slice(0, 120) : 'error'}).`); }
      }
      const message = [`Plan recorded: ${this.plan.length} requirement(s). Each saved change is matched to its file; the checklist in later results shows what is still open.`,
        ...footprints, footprints.length ? 'Follow the sibling: define, register, test and document your change where it does.' : ''].filter(Boolean).join('\n');
      return { content: [{ type: 'text', text: message }], structuredContent: { status: 'recorded', requirements: this.plan.length, message } };
    });
    register('write_file', { description: 'Create a new file with its complete content, for example a new module or test file; folders are created as needed. The path must not exist: to change an existing file, read it and use propose_edit. The user reviews the new file like an edit; depending on a setting it is saved when they approve it, or staged for them to apply later, and the result says which.', inputSchema: WRITE_SHAPE, annotations: { readOnlyHint: true } }, async input => {
      const key = writeKey(input);
      const reviewed = this.reviewed.get(key);
      if (reviewed) {
        this.reviewed.delete(key);
        if (reviewed.error) throw new Error(reviewed.error);
        this.activityEvents.fire({ kind: 'propose', path: input.path, detail: reviewed.saved ? `new file saved after your review${reviewed.problems ? ` · ${reviewed.problems} new problem(s) reported to the agent` : ''}` : 'new file rejected in review, nothing saved', reason: input.explanation.slice(0, 300) });
        return { content: [{ type: 'text', text: reviewed.message }], structuredContent: { status: reviewed.saved ? 'saved' : 'rejected', path: input.path, ...(reviewed.revision ? { base_revision: reviewed.revision } : {}), message: reviewed.message } };
      }
      const { id } = await this.stageWrite(input);
      this.activityEvents.fire({ kind: 'propose', path: input.path, detail: 'new file', reason: input.explanation.slice(0, 300) });
      this.changedPaths.add(input.path.replace(/^\.\//u, ''));
      const message = `Proposal ${id} stages the new file ${input.path}. No files changed. To create it, the user must open Review changes in the Forge sidebar and click Accept hunk, Apply file or Apply all.${this.checklistNote(input.path)}`;
      return { content: [{ type: 'text', text: message }], structuredContent: { proposal_id: id, status: 'staged', path: input.path, message } };
    });
    register('propose_edit', { description: 'Propose an edit for the user to review. Depending on a setting, the user approves the diff and the accepted hunks are saved before this call returns, or the edit is staged for them to apply later; the result says which. Pass base_revision from read_file (it may be omitted with old_text). Locate the change in exactly one way: (1) old_text, the current text to replace, which must appear once in the file (include enough surrounding lines to make it unique; any line numbers sent with it are ignored; differences only in typographic quotes, dashes or trailing spaces still match, and when nothing matches the error shows the closest numbered lines to copy from); (2) start_line and end_line, to replace those inclusive complete lines; (3) insert_line, to insert new_text before that line (line count + 1 appends); (4) none of these, so new_text replaces the whole file. Line numbers refer to the file as read_file returned it. Several edits to one file combine into a single pending review; a whole-file edit replaces earlier pending changes.', inputSchema: PROPOSE_SHAPE, annotations: { readOnlyHint: true } }, async input => {
      // An edit the user already reviewed in the approval card was settled before TrueForge called the tool: report that result.
      // Matched by the exact arguments; if TrueForge re-encoded them, by path and base_revision when that is unambiguous.
      const sameRead = [...this.reviewed.keys()].filter(candidate => { const [path, revision] = JSON.parse(candidate) as [string, string]; return path === input.path && revision === input.base_revision; });
      const key = this.reviewed.has(editKey(input)) ? editKey(input) : sameRead.length === 1 ? sameRead[0] ?? '' : editKey(input);
      const reviewed = this.reviewed.get(key);
      if (reviewed) {
        this.reviewed.delete(key);
        if (reviewed.error) throw new Error(reviewed.error);
        this.activityEvents.fire({ kind: 'propose', path: input.path, detail: reviewed.saved ? `saved ${reviewed.saved} hunk(s) after your review${reviewed.rejected ? `, ${reviewed.rejected} rejected` : ''}${reviewed.problems ? ` · ${reviewed.problems} new problem(s) reported to the agent` : ''}` : 'rejected in review, nothing saved', reason: input.explanation.slice(0, 300) });
        return { content: [{ type: 'text', text: reviewed.message }], structuredContent: { status: reviewed.saved ? 'saved' : 'rejected', path: input.path, saved_hunks: reviewed.saved, rejected_hunks: reviewed.rejected, ...(reviewed.revision ? { base_revision: reviewed.revision } : {}), message: reviewed.message } };
      }
      const { path, explanation } = input;
      const { id, combined, replaced, detail, ignored } = await this.stageProposal(input);
      const note = combined ? ` It includes your earlier pending changes to ${path}; all of them are reviewed together.`
        : replaced.length ? ` It replaced an earlier pending proposal for ${path} that could not be combined; include every change this file still needs.` : '';
      this.activityEvents.fire({ kind: 'propose', path, detail: `${detail}${combined ? ', combined with earlier changes' : replaced.length ? ', replaced an earlier proposal' : ''}`, reason: explanation.slice(0, 300) });
      const hint = ignored.length ? ` Ignored ${ignored.join(', ')} because old_text already locates the change.` : '';
      this.changedPaths.add(path.replace(/^\.\//u, ''));
      const editNote = this.editedNote(path);
      const message = `Proposal ${id} is staged for ${path}.${note}${hint} No files changed. To save it, the user must open Review changes in the Forge sidebar and click Accept hunk, Apply file or Apply all. The Command Palette also offers Forge: Apply All Proposed Changes. Chat approval alone does not write files. Do not ask the user to retype the changes manually.${this.checklistNote(path)}${editNote}`;
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
