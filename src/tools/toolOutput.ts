// Ported from anomalyco/opencode packages/core/src/tool-output.ts (MIT): every tool result is bounded to
// 2,000 lines and 50 KiB. As in opencode, the full text is saved to a retained file outside the workspace and the
// marker names its path; read_file and grep accept exactly those files, so the model can page through the rest.
import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export const MAX_OUTPUT_LINES = 2_000;
export const MAX_OUTPUT_BYTES = 50 * 1024;
/** opencode keeps saved tool output for seven days. */
export const OUTPUT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** One saved output is at most this large; a bigger one is not saved and the marker says so. */
export const MAX_SAVED_OUTPUT_BYTES = 16 * 1024 * 1024;
const FILE_NAME = /^tool_[0-9a-f]{12,}\.txt$/u;

/** How many lines `text` has, not counting an empty one after a final line break. */
export function countLines(text: string): number {
  if (text === '') return 0;
  let count = 1;
  for (let index = text.indexOf('\n'); index !== -1 && index < text.length - 1; index = text.indexOf('\n', index + 1)) count++;
  return count;
}

/** Where the line after the first `count` lines starts, or the end of `text`. */
function afterLines(text: string, count: number): number {
  let index = 0;
  for (let line = 0; line < count; line++) {
    const next = text.indexOf('\n', index);
    if (next === -1) return text.length;
    index = next + 1;
  }
  return index;
}

const encoder = new TextEncoder();
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** The longest start of `text` that fits in `budget` UTF-8 bytes without splitting a character. */
export function byteBoundary(text: string, budget: number): number {
  const index = encoder.encodeInto(text, new Uint8Array(Math.max(0, budget))).read ?? 0;
  if (index === text.length || index === 0) return index;
  const before = text.charCodeAt(index - 1), after = text.charCodeAt(index);
  if (before < 0x80 && after < 0x80) return before === 13 && after === 10 ? index - 1 : index;
  const start = text.lastIndexOf('\n', index - 1) + 1;
  return start + (graphemes.segment(text.slice(start, index + 2)).containing(index - start)?.index ?? index - start);
}

/** Saves the full text of a truncated result and returns its path, or an error message when it could not be saved. */
export type SaveOutput = (text: string) => { path: string } | { error: string };

export interface BoundedText { text: string; truncated: boolean; totalLines: number; shownLines: number; outputPath?: string }

/** Cuts once, at the line or byte limit, whichever comes first, and appends a marker naming what was kept. */
export function boundText(text: string, limits: { maxLines?: number; maxBytes?: number; save?: SaveOutput } = {}): BoundedText {
  const maxLines = limits.maxLines ?? MAX_OUTPUT_LINES, maxBytes = limits.maxBytes ?? MAX_OUTPUT_BYTES;
  const totalLines = countLines(text);
  if (totalLines <= maxLines && Buffer.byteLength(text, 'utf8') <= maxBytes) return { text, truncated: false, totalLines, shownLines: totalLines };
  const end = Math.min(afterLines(text, maxLines), byteBoundary(text, maxBytes - 600));
  const shown = text.slice(0, text.endsWith('\r\n', end) ? end - 2 : text.endsWith('\n', end) ? end - 1 : end);
  const shownLines = countLines(text.slice(0, end));
  const lastLineCut = shownLines > 0 && shown.length < text.length && !text.startsWith('\n', shown.length) && !text.startsWith('\r\n', shown.length);
  const range = shownLines === 0 ? '0 lines' : `lines 1-${shownLines}`;
  const saved = limits.save?.(text);
  const where = saved && 'path' in saved
    ? `full output saved to ${saved.path}. Read the rest with read_file on that path (offset ${shownLines + 1} continues; use offset/limit) or grep it with that path, rather than rerunning the call.`
    : `tool output is limited to ${MAX_OUTPUT_LINES} lines or ${MAX_OUTPUT_BYTES / 1024} KiB${saved ? ` and the full output could not be saved (${saved.error})` : ''}. Narrow the request (a smaller offset/limit, a more specific path, pattern or include glob, or a command that filters its output) to see the rest.`;
  const marker = `[Output truncated: showing ${range} of ${totalLines}${lastLineCut ? ' (last line cut)' : ''}; ${where}]`;
  return { text: `${shown}\n${marker}`, truncated: true, totalLines, shownLines, ...(saved && 'path' in saved ? { outputPath: saved.path } : {}) };
}

/** Bounds the text blocks of a tool result and, when the structured copy is also too large, replaces it with the bounded text. */
export function boundToolResult(result: CallToolResult, save?: SaveOutput): CallToolResult {
  const texts = result.content.filter((part): part is Extract<typeof part, { type: 'text' }> => part.type === 'text');
  const joined = texts.reduce((all, part) => all === '' || all.endsWith('\n') ? all + part.text : `${all}\n${part.text}`, '');
  const bounded = boundText(joined, { save });
  const structuredSize = result.structuredContent ? Buffer.byteLength(JSON.stringify(result.structuredContent), 'utf8') : 0;
  // JSON escaping adds a little to text that already fits; only a clearly oversized structured copy is replaced.
  const structuredTooLarge = structuredSize > MAX_OUTPUT_BYTES + 16 * 1024;
  if (!bounded.truncated && !structuredTooLarge) return result;
  const content = bounded.truncated ? [...result.content.filter(part => part.type !== 'text'), { type: 'text' as const, text: bounded.text }] : result.content;
  if (!result.structuredContent) return { ...result, content };
  const outputPath = bounded.outputPath ? { output_path: bounded.outputPath } : {};
  if (!structuredTooLarge) return { ...result, content, ...(bounded.outputPath ? { structuredContent: { ...result.structuredContent, ...outputPath } } : {}) };
  const scalars = Object.fromEntries(Object.entries(result.structuredContent).filter(([, value]) => value === null || typeof value === 'number' || typeof value === 'boolean' || (typeof value === 'string' && value.length <= 500)));
  return { ...result, content, structuredContent: { ...scalars, truncated: true, output: bounded.text, ...outputPath } };
}

/**
 * opencode's tool-output directory: full outputs the model could not receive inline, as tool_<id>.txt, kept for
 * seven days. Only files this store names are readable through it, so it never opens the rest of the disk.
 */
export class ToolOutputStore {
  private readonly directory: string;
  constructor(directory: string) { this.directory = resolve(directory); }
  /** A fresh file path for a command's streamed output. The directory is created on demand. */
  newFile(): string {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    return join(this.directory, `tool_${Date.now().toString(16).padStart(12, '0')}${randomBytes(4).toString('hex')}.txt`);
  }
  readonly save: SaveOutput = text => {
    if (Buffer.byteLength(text, 'utf8') > MAX_SAVED_OUTPUT_BYTES) return { error: `over ${MAX_SAVED_OUTPUT_BYTES / 1024 / 1024} MiB` };
    try {
      const path = this.newFile();
      writeFileSync(path, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      return { path };
    } catch (error) { return { error: error instanceof Error ? error.message.split('\n')[0] ?? 'write failed' : 'write failed' }; }
  };
  /** The real path of a saved output named by `path` (absolute, either slash style), or undefined for any other path. */
  resolve(path: string): string | undefined {
    if (!/^(?:[a-z]:)?[\\/]/iu.test(path) || !FILE_NAME.test(basename(path))) return undefined;
    try {
      const real = realpathSync(resolve(path));
      const root = realpathSync(this.directory);
      const same = process.platform === 'win32' ? dirname(real).toLowerCase() === root.toLowerCase() : dirname(real) === root;
      return same && FILE_NAME.test(basename(real)) && statSync(real).isFile() ? real : undefined;
    } catch { return undefined; }
  }
  /** Deletes saved outputs older than the retention period. */
  cleanup(now = Date.now()): void {
    let entries: string[];
    try { entries = readdirSync(this.directory); } catch { return; }
    for (const entry of entries) {
      if (!FILE_NAME.test(entry)) continue;
      const file = join(this.directory, entry);
      try { if (now - statSync(file).mtimeMs > OUTPUT_RETENTION_MS) unlinkSync(file); } catch { /* already gone or in use */ }
    }
  }
}
