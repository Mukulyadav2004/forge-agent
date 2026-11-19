// Ported from anomalyco/opencode packages/core/src/tool/plugin/edit.ts (MIT).
// Matching runs on the LF view the model reads and maps offsets back, so CRLF files keep their endings.

interface Match { start: number; end: number }
export type MatchTier = 'exact' | 'normalized' | 'line-trim';
export type MatchResult =
  | { ok: true; text: string; count: number; tier: MatchTier }
  | { ok: false; count: number; hint?: string };

const crlf = '\r\n';

/** Typographic quotes, dashes and unusual spaces compare equal to their ASCII forms. Each replacement is one UTF-16 unit, so offsets survive. */
export const normalizeForMatch = (value: string): string => value
  .replace(/[‘’‚‛]/gu, "'")
  .replace(/[“”„‟]/gu, '"')
  .replace(/[‐‑‒–—―−]/gu, '-')
  .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/gu, ' ');

function findOccurrences(content: string, search: string): Match[] {
  const result: Match[] = [];
  if (!search) return result;
  let offset = 0;
  while ((offset = content.indexOf(search, offset)) !== -1) {
    result.push({ start: offset, end: offset + search.length });
    offset += search.length;
  }
  return result;
}

/** Line-by-line comparison ignoring trailing whitespace and typographic variants. */
function findLineOccurrences(content: string, search: string): Match[] {
  const trailingNewline = search.endsWith('\n');
  const expected = search.split('\n');
  if (trailingNewline) expected.pop();
  const lines = [...content.matchAll(/[^\n]*(?:\n|$)/gu)].filter(match => match[0] !== '').map(match => {
    const newline = match[0].endsWith('\n');
    const text = newline ? match[0].slice(0, -1) : match[0];
    const start = match.index ?? 0;
    return { start, end: start + match[0].length, text, contentEnd: start + text.length - (text.endsWith('\r') ? 1 : 0), newline };
  });
  const candidates = lines.flatMap((line, index) => {
    const actual = lines.slice(index, index + expected.length);
    if (actual.length !== expected.length) return [];
    if (!actual.every((item, lineIndex) => normalizeForMatch(item.text.trimEnd()) === normalizeForMatch((expected[lineIndex] ?? '').trimEnd()))) return [];
    const last = actual[actual.length - 1];
    if (!last || (trailingNewline && !last.newline)) return [];
    return [{ start: line.start, end: trailingNewline ? last.end : last.contentEnd }];
  });
  return candidates.reduce<Match[]>((result, candidate) => {
    if (!result.some(match => match.end > candidate.start && match.start < candidate.end)) result.push(candidate);
    return result;
  }, []);
}

/** The dominant line ending in text, or fallback when there is none. */
function lineEnding(text: string, fallback: string): string {
  const crlfCount = text.split(crlf).length - 1;
  const lfCount = text.split('\n').length - 1 - crlfCount;
  if (crlfCount === lfCount) return fallback;
  return crlfCount > lfCount ? crlf : '\n';
}

/**
 * For each line of `after`, the index of the `before` line it keeps (longest common subsequence) or, between kept
 * lines, the line it takes the place of; undefined for lines with no counterpart.
 */
function alignLines(before: string[], after: string[]): (number | undefined)[] {
  // The table is quadratic; very large replacements map lines by position instead.
  if ((before.length + 1) * (after.length + 1) > 4_000_000) return after.map((_, index) => index < before.length ? index : undefined);
  const width = after.length + 1;
  const table = new Uint32Array((before.length + 1) * width);
  for (let i = before.length - 1; i >= 0; i--) {
    for (let j = after.length - 1; j >= 0; j--) {
      table[i * width + j] = before[i] === after[j] ? (table[(i + 1) * width + j + 1] ?? 0) + 1 : Math.max(table[(i + 1) * width + j] ?? 0, table[i * width + j + 1] ?? 0);
    }
  }
  const result: (number | undefined)[] = [];
  let gapBefore: number[] = [], gapAfter: number[] = [];
  const flush = () => { gapAfter.forEach((j, k) => { result[j] = gapBefore[k]; }); gapBefore = []; gapAfter = []; };
  let i = 0, j = 0;
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) { flush(); result[j++] = i++; continue; }
    if ((table[(i + 1) * width + j] ?? 0) >= (table[i * width + j + 1] ?? 0)) gapBefore.push(i++);
    else gapAfter.push(j++);
  }
  while (i < before.length) gapBefore.push(i++);
  while (j < after.length) gapAfter.push(j++);
  flush();
  return result;
}

/** Joins the replacement's lines with endings taken from the matched region, so unchanged context keeps its bytes. */
function withRegionEndings(region: string, replacement: string, fallback: string): string {
  const before = region.split(/\r?\n/u);
  const endings = [...region.matchAll(/\r?\n/gu)].map(match => match[0]);
  const after = replacement.split('\n');
  const key = (line: string) => normalizeForMatch(line.trimEnd());
  const source = alignLines(before.map(key), after.map(key));
  return after.map((line, index) => index === after.length - 1 ? line : line + (endings[source[index] ?? -1] ?? fallback)).join('');
}

/** Number of sorted positions strictly before offset. */
function countBefore(positions: number[], offset: number): number {
  let low = 0, high = positions.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((positions[middle] ?? 0) < offset) low = middle + 1; else high = middle;
  }
  return low;
}

const HINT_LINES = 12;
const HINT_LINE_LENGTH = 200;

/**
 * A short hint for an old_text miss: new_text is already there (often an edit that already applied), or the lines
 * closest to old_text, numbered like read_file output. Lines vote for where old_text starts when they match ignoring
 * all whitespace; at least half must agree.
 */
export function missHint(source: string, oldText: string, newText: string): string | undefined {
  const view = source.replaceAll(crlf, '\n');
  const replacement = newText.replaceAll(crlf, '\n');
  if (replacement.trim().length >= 20 && normalizeForMatch(view).includes(normalizeForMatch(replacement))) return 'new_text is already in the file, so this edit may already be applied.';
  const key = (line: string) => normalizeForMatch(line).replace(/\s+/gu, ' ').trim();
  const distinct = (line: string) => /[\p{L}\p{N}]/u.test(line);
  const lines = view.split('\n');
  const search = oldText.replaceAll(crlf, '\n').split('\n');
  const positions = new Map<string, number[]>();
  lines.forEach((line, index) => {
    const value = key(line);
    if (!distinct(value)) return;
    const found = positions.get(value);
    if (found) found.push(index); else positions.set(value, [index]);
  });
  const votes = new Map<number, number>();
  const wanted = search.filter((line, offset) => {
    const value = key(line);
    if (!distinct(value)) return false;
    for (const index of positions.get(value) ?? []) votes.set(index - offset, (votes.get(index - offset) ?? 0) + 1);
    return true;
  }).length;
  const [start, count] = [...votes].reduce<[number, number]>((best, vote) => vote[1] > best[1] ? vote : best, [0, 0]);
  if (count === 0 || count * 2 < wanted) return undefined;
  const matched = search.flatMap((line, offset) => {
    const value = key(line);
    const index = start + offset;
    return value !== '' && index >= 0 && index < lines.length && key(lines[index] ?? '') === value ? [index] : [];
  });
  const from = matched[0];
  const last = matched[matched.length - 1];
  if (from === undefined || last === undefined) return undefined;
  const to = Math.min(last + 1, from + HINT_LINES);
  return ['The closest lines in the file:', ...lines.slice(from, to).map((line, index) => `${from + index + 1}: ${line.length > HINT_LINE_LENGTH ? `${line.slice(0, HINT_LINE_LENGTH)}…` : line}`)].join('\n');
}

/**
 * Replaces old_text in source in three tiers: exact, then ignoring typographic quote/dash/space variants, then
 * line by line ignoring trailing whitespace. Without replaceAll the match must be unique.
 */
export function replaceMatched(options: { source: string; oldText: string; newText: string; replaceAll?: boolean }): MatchResult {
  const { source } = options;
  const view = source.replaceAll(crlf, '\n');
  const removed = [...source.matchAll(/\r\n/gu)].map((match, index) => (match.index ?? 0) - index);
  const fileEnding = lineEnding(source, '\n');
  const search = options.oldText.replaceAll(crlf, '\n');
  const replacement = options.newText.replaceAll(crlf, '\n');
  const exact = findOccurrences(view, search);
  const unicode = exact.length ? [] : findOccurrences(normalizeForMatch(view), normalizeForMatch(search));
  const trailing = exact.length || unicode.length ? [] : findLineOccurrences(view, search);
  const tier: MatchTier = exact.length ? 'exact' : unicode.length ? 'normalized' : 'line-trim';
  const matches = (exact.length ? exact : unicode.length ? unicode : trailing).map(match => ({ start: match.start + countBefore(removed, match.start), end: match.end + countBefore(removed, match.end) }));
  if (!matches.length) return { ok: false, count: 0, hint: missHint(source, options.oldText, options.newText) };
  if (matches.length > 1 && !options.replaceAll) return { ok: false, count: matches.length };
  const chosen = options.replaceAll ? matches : matches.slice(0, 1);
  let text = source;
  for (const match of [...chosen].reverse()) {
    const region = source.slice(match.start, match.end);
    text = `${text.slice(0, match.start)}${withRegionEndings(region, replacement, lineEnding(region, fileEnding))}${text.slice(match.end)}`;
  }
  return { ok: true, text, count: chosen.length, tier };
}
