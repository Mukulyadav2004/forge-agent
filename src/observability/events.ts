import { appendFile, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { TrueForgeApi } from '@truefoundry/trueforge-sdk';
import { z } from 'zod';

const ToolNameSchema = z.enum(['read_file', 'list_files', 'search_code', 'propose_edit']);
export type ToolName = z.infer<typeof ToolNameSchema>;
const ToolEventSchema = z.object({
  ts: z.iso.datetime(), taskId: z.null(), event: z.literal('tool.call'), name: ToolNameSchema,
  outcome: z.enum(['ok', 'error', 'cancelled', 'refused']), durationMs: z.number().nonnegative(), resultChars: z.number().int().nonnegative(),
  path: z.string().optional(), pathRefused: z.boolean().optional(), queryChars: z.number().int().nonnegative().optional(), truncated: z.boolean().optional(),
  errorType: z.enum(['ToolError', 'AbortError', 'PathRefused']).optional(), message: z.string().optional(),
});
type ToolEvent = z.infer<typeof ToolEventSchema>;
const failureMessages = { ToolError: 'Tool failed; details omitted.', AbortError: 'Tool cancelled.', PathRefused: 'Workspace path refused.' };
const UsageSchema = z.object({ totalTokens: z.number().nonnegative().optional(), totalInputTokens: z.number().nonnegative().optional(), totalOutputTokens: z.number().nonnegative().optional(), totalCostInUsd: z.number().nonnegative().optional() });
type Usage = z.infer<typeof UsageSchema>;
const SessionEventSchema = z.object({
  ts: z.iso.datetime(), taskId: z.string().nullable(), sessionId: z.string().optional(), turnId: z.string().optional(), toolCallId: z.string().optional(),
  event: z.enum(['session.start', 'model.config', 'turn.send', 'turn.start', 'turn.end', 'turn.cancel', 'approval.decision', 'tool.response', 'error']),
  outcome: z.enum(['ok', 'requested', 'observed', 'allow', 'deny', 'done', 'cancelled', 'error', 'incomplete', 'accepted', 'local']),
  durationMs: z.number().nonnegative().optional(), firstTextMs: z.number().nonnegative().optional(), usage: UsageSchema.optional(), model: z.string().max(200).regex(/^[\w.-]+\/[\w./:@-]+$/u).optional(),
  errorType: z.enum(['RequestError', 'TurnError', 'IncompleteStream', 'CancelError']).optional(), message: z.literal('TrueForge operation failed; details omitted.').optional(),
});
export type SessionEvent = z.infer<typeof SessionEventSchema>;
const LogEventSchema = z.discriminatedUnion('event', [ToolEventSchema, SessionEventSchema]);

export class ToolLog {
  private pending: Promise<void>;
  private file: string | undefined;
  private failed = false;
  constructor(private readonly options: { directory?: string; workspaceRoots?: readonly string[]; resolvePath: (path: string) => Promise<string>; onFailure: () => void }) {
    this.pending = Promise.resolve().then(async () => {
      if (!options.directory) throw new Error('Storage is unavailable outside this workspace.');
      await mkdir(options.directory, { recursive: true, mode: 0o700 });
      const storage = await realpath(options.directory);
      for (const root of options.workspaceRoots ?? []) {
        const path = relative(await realpath(root), storage);
        if (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)) throw new Error('Log storage overlaps the workspace.');
      }
      const directory = await mkdtemp(join(options.directory, 'window-'));
      this.file = join(directory, 'events.jsonl');
      await writeFile(this.file, '', { flag: 'wx', mode: 0o600 });
    }).catch(() => this.fail());
  }
  private fail(): void {
    if (!this.failed) { this.failed = true; this.options.onFailure(); }
  }
  async flush(): Promise<string> {
    await this.pending;
    if (this.failed || !this.file) throw new Error('Tool log is incomplete or unavailable.');
    return this.file;
  }
  async summary(taskId?: string) {
    const jsonl = await readFile(await this.flush(), 'utf8');
    return taskId ? summarizeTask({ jsonl, taskId }) : summarizeTools(jsonl);
  }
  recordSession(event: SessionEvent): void {
    const safe = SessionEventSchema.safeParse(event);
    if (safe.success) this.append(safe.data); else this.fail();
  }
  private append(event: ToolEvent | SessionEvent): void {
    const line = JSON.stringify(event) + '\n';
    this.pending = this.pending.then(async () => {
      if (!this.failed && this.file) await appendFile(this.file, line, 'utf8');
    }).catch(() => this.fail());
  }
  async tool(options: { name: ToolName; input: Record<string, unknown>; signal?: AbortSignal; run: () => Promise<CallToolResult> }): Promise<CallToolResult> {
    const started = performance.now();
    let path: string | undefined, truncated: boolean | undefined, errorType: ToolEvent['errorType'];
    let outcome: ToolEvent['outcome'] = 'ok', resultChars = 0, pathRefused = false;
    try {
      if (typeof options.input.path === 'string') {
        try {
          const resolved = await this.options.resolvePath(options.input.path);
          if (!isAbsolute(resolved) && !resolved.split(/[/\\]/u).includes('..') && !/[\x00-\x1f\\:]/u.test(resolved) && resolved.length <= 500) path = resolved;
        } catch (error) { pathRefused = true; throw error; }
      }
      const result = await options.run();
      // Count the structured result once, or the text blocks once; never persist either payload.
      resultChars = result.structuredContent ? JSON.stringify(result.structuredContent).length : result.content.reduce((sum, part) => sum + (part.type === 'text' ? part.text.length : 0), 0);
      if (typeof result.structuredContent?.truncated === 'boolean') truncated = result.structuredContent.truncated;
      if (result.isError) { outcome = 'error'; errorType = 'ToolError'; }
      return result;
    } catch (error) {
      errorType = pathRefused ? 'PathRefused' : options.signal?.aborted || (error instanceof Error && error.name === 'AbortError') ? 'AbortError' : 'ToolError';
      outcome = pathRefused ? 'refused' : errorType === 'AbortError' ? 'cancelled' : 'error';
      throw error;
    } finally {
      const event: ToolEvent = {
        ts: new Date().toISOString(), taskId: null, event: 'tool.call', name: options.name, outcome,
        durationMs: Math.round(performance.now() - started), resultChars, path, truncated,
        ...(pathRefused ? { pathRefused: true } : {}),
        ...(typeof options.input.query === 'string' ? { queryChars: options.input.query.length } : {}),
        ...(errorType ? { errorType, message: failureMessages[errorType] } : {}),
      };
      this.append(ToolEventSchema.parse(event));
    }
  }
}

export function summarizeTools(jsonl: string) {
  const tools = new Map<string, { calls: number; resultChars: number; durationMs: number }>();
  const filesRead = new Set<string>(), filesProposed = new Set<string>(), errorsByType = new Map<string, number>();
  for (const line of jsonl.split('\n').filter(Boolean)) {
    const event = LogEventSchema.parse(JSON.parse(line));
    if (event.event !== 'tool.call') continue;
    const counts = tools.get(event.name) ?? { calls: 0, resultChars: 0, durationMs: 0 };
    counts.calls++; counts.resultChars += event.resultChars; counts.durationMs += event.durationMs;
    tools.set(event.name, counts);
    if (event.errorType) errorsByType.set(event.errorType, (errorsByType.get(event.errorType) ?? 0) + 1);
    if (event.outcome === 'ok' && event.path) {
      if (event.name === 'read_file') filesRead.add(event.path);
      if (event.name === 'propose_edit') filesProposed.add(event.path);
    }
  }
  return { taskId: null, scope: 'unjoined_tool_calls', tools: Object.fromEntries(tools), filesRead: [...filesRead], filesProposed: [...filesProposed], errorsByType: Object.fromEntries(errorsByType), tokens: 'not available', cost: 'not available' };
}

export function summarizeTask(options: { jsonl: string; taskId: string }) {
  const events = options.jsonl.split('\n').filter(Boolean).map(line => LogEventSchema.parse(JSON.parse(line))).filter((event): event is SessionEvent => event.event !== 'tool.call' && event.taskId === options.taskId);
  const turns = events.filter(event => event.event === 'turn.end');
  const total = (key: 'totalTokens' | 'totalCostInUsd') => turns.length && turns.every(turn => turn.usage?.[key] !== undefined) ? turns.reduce((sum, turn) => sum + (turn.usage?.[key] ?? 0), 0) : 'not available';
  const errors = new Map<string, number>();
  for (const event of events) if (event.errorType) errors.set(event.errorType, (errors.get(event.errorType) ?? 0) + 1);
  return { taskId: options.taskId, scope: 'trueforge_session', tools: 'not available', cancels: events.filter(event => event.event === 'turn.cancel').length, errorsByType: Object.fromEntries(errors),
    turns: turns.map(turn => ({ turnId: turn.turnId ?? null, outcome: turn.outcome, durationMs: turn.durationMs, firstTextMs: turn.firstTextMs ?? 'not available', usage: turn.usage ?? 'not available' })), tokens: total('totalTokens'), cost: total('totalCostInUsd') };
}

export class SessionTrace {
  private sessionId: string | undefined;
  private turnId: string | undefined;
  private started = 0;
  private firstTextMs: number | undefined;
  private finished = false;
  private readonly modelUsage = new Map<string, TrueForgeApi.ModelMessageUsage | undefined>();
  constructor(private readonly options: { model: string; sink: (event: SessionEvent) => void }) {}
  private context() { return { taskId: this.sessionId ?? null, sessionId: this.sessionId, turnId: this.turnId }; }
  private emit(event: Omit<SessionEvent, 'ts' | 'taskId' | 'sessionId' | 'turnId'>): void {
    this.options.sink({ ...this.context(), ts: new Date().toISOString(), ...event });
  }
  begin(): void {
    this.started = performance.now(); this.turnId = undefined; this.firstTextMs = undefined; this.finished = false; this.modelUsage.clear();
    this.emit({ event: 'turn.send', outcome: 'requested' });
    this.model();
  }
  private model(): void {
    const model = SessionEventSchema.shape.model.safeParse(this.options.model);
    this.emit({ event: 'model.config', outcome: 'observed', model: model.success ? model.data : undefined });
  }
  created(id: string): void { this.sessionId = id; this.emit({ event: 'session.start', outcome: 'ok' }); this.model(); }
  stream(event: TrueForgeApi.TurnStreamingEvent): void {
    if (this.finished) return;
    if (event.type === 'turn.created') { this.turnId = event.turnId; this.emit({ event: 'turn.start', outcome: 'ok' }); }
    if (event.type === 'model.message' || event.type === 'model.message.delta') {
      this.modelUsage.set(event.id, event.usage ?? this.modelUsage.get(event.id));
      if (event.type === 'model.message.delta' && event.threadId === 'main' && event.content && this.firstTextMs === undefined) this.firstTextMs = Math.round(performance.now() - this.started);
    }
    if (event.type === 'tool.response') this.emit({ event: 'tool.response', outcome: 'observed', toolCallId: event.toolCallId });
    if (event.type === 'user.tool_approval') this.emit({ event: 'approval.decision', outcome: event.approval.status, toolCallId: event.toolCallId });
    if (event.type === 'turn.done') {
      if (event.state.status === 'done' && event.state.output?.usage) this.modelUsage.set(event.state.output.id, event.state.output.usage);
      const reported = UsageSchema.safeParse(event.state.metrics);
      const models = [...this.modelUsage.values()];
      const fallback: Usage | undefined = models.length && models.every(usage => usage !== undefined) ? { totalInputTokens: models.reduce((sum, usage) => sum + usage.inputTokens, 0), totalOutputTokens: models.reduce((sum, usage) => sum + usage.outputTokens, 0) } : undefined;
      const usage = reported.success ? { ...fallback, ...reported.data } : fallback;
      this.end({ outcome: event.state.status, usage: usage ? { ...usage, totalTokens: usage.totalTokens ?? (usage.totalInputTokens !== undefined && usage.totalOutputTokens !== undefined ? usage.totalInputTokens + usage.totalOutputTokens : undefined) } : undefined });
      if (event.state.status === 'error') this.emit({ event: 'error', outcome: 'error', errorType: 'TurnError', message: 'TrueForge operation failed; details omitted.' });
    }
  }
  private end(options: { outcome: SessionEvent['outcome']; usage?: Usage }): void {
    this.finished = true;
    this.emit({ event: 'turn.end', ...options, durationMs: Math.round(performance.now() - this.started), firstTextMs: this.firstTextMs });
  }
  abandoned(): void { this.end({ outcome: 'cancelled' }); }
  fail(): void { if (!this.finished) { this.end({ outcome: 'error' }); this.emit({ event: 'error', outcome: 'error', errorType: 'RequestError', message: 'TrueForge operation failed; details omitted.' }); } }
  finish(): void { if (!this.finished) { this.end({ outcome: 'incomplete' }); this.emit({ event: 'error', outcome: 'error', errorType: 'IncompleteStream', message: 'TrueForge operation failed; details omitted.' }); } }
  cancellation(): (outcome: 'accepted' | 'error' | 'local') => void {
    const context = { ...this.context(), turnId: this.finished ? undefined : this.turnId }, started = performance.now();
    return outcome => {
      this.options.sink({ ...context, ts: new Date().toISOString(), event: 'turn.cancel', outcome, durationMs: Math.round(performance.now() - started) });
      if (outcome === 'error') this.options.sink({ ...context, ts: new Date().toISOString(), event: 'error', outcome, errorType: 'CancelError', message: 'TrueForge operation failed; details omitted.' });
    };
  }
}
