import { randomUUID } from 'node:crypto';
import { diffLines } from 'diff';
import type { HunkView } from './review';

export type ReviewPart = { kind: 'unchanged'; text: string } | { kind: 'change'; id: string; before: string; after: string };

export function buildLineChanges(options: { before: string; after: string }): { parts: ReviewPart[]; hunks: HunkView[] } {
  const changes = diffLines(options.before, options.after, { timeout: 150, maxEditLength: 2000 });
  if (!changes) throw new Error('This diff is too complex to review safely. Request smaller edits.');
  const parts: ReviewPart[] = [];
  const hunks: HunkView[] = [];
  let oldLine = 1;
  let newLine = 1;
  let current: { before: string; after: string; oldStart: number; newStart: number; oldLines: number; newLines: number } | undefined;
  function flush(): void {
    if (!current) return;
    const id = randomUUID();
    parts.push({ kind: 'change', id, before: current.before, after: current.after });
    hunks.push({ id, oldStart: current.oldStart, newStart: current.newStart, oldLines: current.oldLines, newLines: current.newLines,
      removed: current.before.slice(0, 6000), added: current.after.slice(0, 6000),
      truncated: current.before.length > 6000 || current.after.length > 6000, status: 'pending' });
    current = undefined;
  }
  for (const change of changes) {
    if (!change.added && !change.removed) {
      flush(); parts.push({ kind: 'unchanged', text: change.value });
      oldLine += change.count; newLine += change.count;
    } else {
      current ??= { before: '', after: '', oldStart: oldLine, newStart: newLine, oldLines: 0, newLines: 0 };
      if (change.removed) { current.before += change.value; current.oldLines += change.count; oldLine += change.count; }
      if (change.added) { current.after += change.value; current.newLines += change.count; newLine += change.count; }
    }
  }
  flush();
  if (hunks.length > 200) throw new Error('This proposal has too many hunks. Request smaller edits.');
  return { parts, hunks };
}

export function composeLineChanges(options: { parts: ReviewPart[]; accepted: Set<string> }): string {
  return options.parts.map(part => part.kind === 'unchanged' ? part.text : options.accepted.has(part.id) ? part.after : part.before).join('');
}

/** Bounds for the saved lines a reviewed edit returns: changed lines with two lines of context, numbered as the file is now. */
const SAVED_EXCERPT = { context_lines: 2, max_lines: 60, max_characters: 4000 };
/** Like Cline's editor result: the model sees what is on disk after a save, with current line numbers for its next edit. */
export function savedExcerpt(before: string, after: string): { text: string; firstLine?: number } {
  let hunks: HunkView[];
  try { ({ hunks } = buildLineChanges({ before, after })); } catch { return { text: '' }; }
  const lines = after.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop(); // a final newline ends the last line
  const shown = new Set<number>();
  for (const hunk of hunks) {
    const from = Math.max(1, hunk.newStart - SAVED_EXCERPT.context_lines);
    const to = Math.min(lines.length, hunk.newStart + Math.max(hunk.newLines, 1) - 1 + SAVED_EXCERPT.context_lines);
    for (let line = from; line <= to; line++) shown.add(line);
  }
  const ordered = [...shown].sort((a, b) => a - b);
  const out: string[] = [];
  let length = 0, previous = 0;
  for (const line of ordered.slice(0, SAVED_EXCERPT.max_lines)) {
    const row = `${previous && line > previous + 1 ? '…\n' : ''}${line}: ${lines[line - 1] ?? ''}`;
    if (length + row.length + 1 > SAVED_EXCERPT.max_characters) break;
    out.push(row); length += row.length + 1; previous = line;
  }
  const cut = out.length < ordered.length ? `\n… ${ordered.length - out.length} more changed or context line(s); read_file shows them` : '';
  return { text: out.length ? `${out.join('\n')}${cut}` : '', ...(hunks[0] ? { firstLine: hunks[0].newStart } : {}) };
}
