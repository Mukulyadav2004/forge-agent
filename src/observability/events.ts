import { appendFile, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
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
  async summary(): Promise<ReturnType<typeof summarizeTools>> {
    return summarizeTools(await readFile(await this.flush(), 'utf8'));
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
      const line = JSON.stringify(ToolEventSchema.parse(event)) + '\n';
      this.pending = this.pending.then(async () => {
        if (!this.failed && this.file) await appendFile(this.file, line, 'utf8');
      }).catch(() => this.fail());
    }
  }
}

export function summarizeTools(jsonl: string) {
  const tools = new Map<string, { calls: number; resultChars: number; durationMs: number }>();
  const filesRead = new Set<string>(), filesProposed = new Set<string>(), errorsByType = new Map<string, number>();
  for (const line of jsonl.split('\n').filter(Boolean)) {
    const event = ToolEventSchema.parse(JSON.parse(line));
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
