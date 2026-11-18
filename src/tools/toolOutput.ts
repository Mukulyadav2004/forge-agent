// Ported from anomalyco/opencode packages/core/src/tool-output.ts (MIT): every tool result is bounded to
// 2,000 lines and 50 KiB. Forge cannot hand the model a file outside the workspace, so the overflow is dropped
// and the marker asks for a narrower request instead of pointing at a saved copy.
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export const MAX_OUTPUT_LINES = 2_000;
export const MAX_OUTPUT_BYTES = 50 * 1024;

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

export interface BoundedText { text: string; truncated: boolean; totalLines: number; shownLines: number }

/** Cuts once, at the line or byte limit, whichever comes first, and appends a marker naming what was kept. */
export function boundText(text: string, limits: { maxLines?: number; maxBytes?: number } = {}): BoundedText {
  const maxLines = limits.maxLines ?? MAX_OUTPUT_LINES, maxBytes = limits.maxBytes ?? MAX_OUTPUT_BYTES;
  const totalLines = countLines(text);
  if (totalLines <= maxLines && Buffer.byteLength(text, 'utf8') <= maxBytes) return { text, truncated: false, totalLines, shownLines: totalLines };
  const end = Math.min(afterLines(text, maxLines), byteBoundary(text, maxBytes - 400));
  const shown = text.slice(0, text.endsWith('\r\n', end) ? end - 2 : text.endsWith('\n', end) ? end - 1 : end);
  const shownLines = countLines(text.slice(0, end));
  const lastLineCut = shownLines > 0 && shown.length < text.length && !text.startsWith('\n', shown.length) && !text.startsWith('\r\n', shown.length);
  const range = shownLines === 0 ? '0 lines' : `lines 1-${shownLines}`;
  const marker = `[Output truncated: showing ${range} of ${totalLines}${lastLineCut ? ' (last line cut)' : ''}; tool output is limited to ${MAX_OUTPUT_LINES} lines or ${MAX_OUTPUT_BYTES / 1024} KiB. Narrow the request (a smaller offset/limit, a more specific path, pattern or include glob, or a command that filters its output) to see the rest.]`;
  return { text: `${shown}\n${marker}`, truncated: true, totalLines, shownLines };
}

/** Bounds the text blocks of a tool result and, when the structured copy is also too large, replaces it with the bounded text. */
export function boundToolResult(result: CallToolResult): CallToolResult {
  const texts = result.content.filter((part): part is Extract<typeof part, { type: 'text' }> => part.type === 'text');
  const joined = texts.reduce((all, part) => all === '' || all.endsWith('\n') ? all + part.text : `${all}\n${part.text}`, '');
  const bounded = boundText(joined);
  const structuredSize = result.structuredContent ? Buffer.byteLength(JSON.stringify(result.structuredContent), 'utf8') : 0;
  // JSON escaping adds a little to text that already fits; only a clearly oversized structured copy is replaced.
  const structuredTooLarge = structuredSize > MAX_OUTPUT_BYTES + 16 * 1024;
  if (!bounded.truncated && !structuredTooLarge) return result;
  const content = bounded.truncated ? [...result.content.filter(part => part.type !== 'text'), { type: 'text' as const, text: bounded.text }] : result.content;
  if (!result.structuredContent) return { ...result, content };
  if (!structuredTooLarge) return { ...result, content };
  const scalars = Object.fromEntries(Object.entries(result.structuredContent).filter(([, value]) => value === null || typeof value === 'number' || typeof value === 'boolean' || (typeof value === 'string' && value.length <= 500)));
  return { ...result, content, structuredContent: { ...scalars, truncated: true, output: bounded.text } };
}
