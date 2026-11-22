// Ported from anomalyco/opencode packages/core/src/tool/plugin/edit.ts (MIT).
// Matching runs on the LF view the model reads and maps offsets back, so CRLF files keep their endings.

interface Match { start: number; end: number }
export type MatchTier = 'exact' | 'normalized' | 'line-trim' | 'indent';
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

const leading = (line: string) => /^[ \t]*/u.exec(line)?.[0] ?? '';

/**
 * A block's indentation: the shortest leading whitespace of its non-blank lines (every line must start with it) and
 * each line's extra indentation, which must be all spaces or all tabs. Undefined when the block has no common base or
 * mixes them.
 */
function indentation(lines: string[]): { base: string; extra: (string | undefined)[]; char?: string } | undefined {
  const filled = lines.filter(line => line.trim());
  if (!filled.length) return undefined;
  const base = filled.map(leading).reduce((shortest, indent) => indent.length < shortest.length ? indent : shortest);
  const extra = lines.map(line => line.trim() ? leading(line) : undefined);
  if (extra.some(indent => indent !== undefined && !indent.startsWith(base))) return undefined;
  const rest = extra.map(indent => indent?.slice(base.length));
  const char = rest.find(indent => indent)?.[0];
  if (rest.some(indent => indent && [...indent].some(c => c !== char))) return undefined;
  return { base, extra: rest, ...(char ? { char } : {}) };
}

/**
 * Line-by-line match that ignores how deep the block is indented, for old_text copied at another depth or with spaces
 * where the file has tabs. The block's shape must agree: each line's extra indentation in the file is the same multiple
 * of the one in old_text. new_text is re-indented the same way, so its lines land at the file's depth in the file's
 * characters; a line that cannot be mapped (less indented than old_text, or not a whole step) gives no match.
 */
function findIndentedOccurrences(content: string, search: string, replacement: string): Array<Match & { replacement: string }> {
  const trailingNewline = search.endsWith('\n');
  const expected = search.split('\n');
  if (trailingNewline) expected.pop();
  const wanted = indentation(expected);
  if (!wanted) return [];
  const lines = [...content.matchAll(/[^\n]*(?:\n|$)/gu)].filter(match => match[0] !== '').map(match => {
    const newline = match[0].endsWith('\n');
    const text = (newline ? match[0].slice(0, -1) : match[0]).replace(/\r$/u, '');
    const start = match.index ?? 0;
    return { start, end: start + match[0].length, text, contentEnd: start + text.length, newline };
  });
  const key = (line: string) => normalizeForMatch(line.trim());
  const found: Array<Match & { replacement: string }> = [];
  for (let index = 0; index + expected.length <= lines.length; index++) {
    const actual = lines.slice(index, index + expected.length);
    if (!actual.every((line, offset) => key(line.text) === key(expected[offset] ?? ''))) continue;
    const have = indentation(actual.map(line => line.text));
    if (!have) continue;
    // The ratio of the file's extra indentation to old_text's, from the first line that has any.
    const pair = expected.findIndex((_, offset) => (wanted.extra[offset] ?? '') !== '' || (have.extra[offset] ?? '') !== '');
    const [fileStep, searchStep] = pair < 0 ? [1, 1] : [have.extra[pair]?.length ?? 0, wanted.extra[pair]?.length ?? 0];
    if (!fileStep !== !searchStep || (pair >= 0 && (!fileStep || !searchStep))) continue;
    if (!expected.every((_, offset) => (have.extra[offset]?.length ?? 0) * searchStep === (wanted.extra[offset]?.length ?? 0) * fileStep)) continue;
    const reindented = replacement.split('\n').map(line => {
      if (!line.trim()) return line.trim();
      const indent = leading(line);
      if (!indent.startsWith(wanted.base)) return undefined;
      const extra = indent.slice(wanted.base.length);
      if (!extra) return have.base + line.slice(indent.length);
      if (pair < 0) return have.base + extra + line.slice(indent.length);
      if ([...extra].some(c => c !== (wanted.char ?? extra[0])) || (extra.length * fileStep) % searchStep) return undefined;
      return have.base + (have.char ?? extra[0] ?? ' ').repeat((extra.length * fileStep) / searchStep) + line.slice(indent.length);
    });
    if (reindented.some(line => line === undefined)) continue;
    const last = actual[actual.length - 1];
    if (!last || (trailingNewline && !last.newline)) continue;
    found.push({ start: lines[index]?.start ?? 0, end: trailingNewline ? last.end : last.contentEnd, replacement: reindented.join('\n') });
  }
  return found;
}

/**
 * old_text (or new_text) with the line-number prefixes of read_file output removed ("12: text" or "12\ttext"), when
 * every line carries one in the same format with consecutive numbers; otherwise undefined.
 */
export function withoutLineNumbers(text: string): string | undefined {
  const view = text.replaceAll(crlf, '\n');
  const trailingNewline = view.endsWith('\n');
  const lines = (trailingNewline ? view.slice(0, -1) : view).split('\n');
  for (const format of [/^(\d+): ?/u, /^(\d+)\t/u]) {
    const numbers = lines.map(line => format.exec(line)?.[1]);
    if (numbers.some(number => number === undefined)) continue;
    if (!numbers.every((number, index) => Number(number) === Number(numbers[0]) + index)) continue;
    return lines.map(line => line.replace(format, '')).join('\n') + (trailingNewline ? '\n' : '');
  }
  return undefined;
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

/** old_text that looks JSON-escaped twice: \" or a literal \n where the file has neither. Never unescaped automatically. */
const DOUBLE_ESCAPED = 'Your old_text looks double-escaped (\\" or \\n). Send the text exactly as it appears in the file, with plain quotes and real line breaks.';
const doubleEscaped = (source: string, oldText: string) => ['\\"', '\\n'].some(sequence => oldText.includes(sequence) && !source.includes(sequence));

function matchOnce(options: { source: string; oldText: string; newText: string; replaceAll?: boolean }): MatchResult {
  const { source } = options;
  const view = source.replaceAll(crlf, '\n');
  const removed = [...source.matchAll(/\r\n/gu)].map((match, index) => (match.index ?? 0) - index);
  const fileEnding = lineEnding(source, '\n');
  const search = options.oldText.replaceAll(crlf, '\n');
  const replacement = options.newText.replaceAll(crlf, '\n');
  const exact = findOccurrences(view, search);
  const unicode = exact.length ? [] : findOccurrences(normalizeForMatch(view), normalizeForMatch(search));
  const trailing = exact.length || unicode.length ? [] : findLineOccurrences(view, search);
  const indented = exact.length || unicode.length || trailing.length ? [] : findIndentedOccurrences(view, search, replacement);
  const tier: MatchTier = exact.length ? 'exact' : unicode.length ? 'normalized' : trailing.length ? 'line-trim' : 'indent';
  const found: Array<Match & { replacement?: string }> = exact.length ? exact : unicode.length ? unicode : trailing.length ? trailing : indented;
  const matches = found.map(match => ({ start: match.start + countBefore(removed, match.start), end: match.end + countBefore(removed, match.end), replacement: match.replacement ?? replacement }));
  if (!matches.length) return { ok: false, count: 0 };
  // A re-indented match is only trusted when it is the one place: replaceAll does not widen it.
  if (matches.length > 1 && (!options.replaceAll || tier === 'indent')) return { ok: false, count: matches.length };
  const chosen = options.replaceAll ? matches : matches.slice(0, 1);
  let text = source;
  for (const match of [...chosen].reverse()) {
    const region = source.slice(match.start, match.end);
    text = `${text.slice(0, match.start)}${withRegionEndings(region, match.replacement, lineEnding(region, fileEnding))}${text.slice(match.end)}`;
  }
  return { ok: true, text, count: chosen.length, tier };
}

/**
 * Replaces old_text in source in four tiers: exact, then ignoring typographic quote/dash/space variants, then line by
 * line ignoring trailing whitespace, then line by line at another indentation depth (new_text re-indented to match).
 * Without replaceAll the match must be unique. When old_text matches nowhere and every line carries a read_file line
 * number, the tiers run again without the numbers (on new_text too when all of its lines carry them).
 */
export function replaceMatched(options: { source: string; oldText: string; newText: string; replaceAll?: boolean }): MatchResult {
  const first = matchOnce(options);
  if (first.ok || first.count) return first;
  const oldText = withoutLineNumbers(options.oldText);
  if (oldText !== undefined) {
    const second = matchOnce({ ...options, oldText, newText: withoutLineNumbers(options.newText) ?? options.newText });
    if (second.ok || second.count) return second;
  }
  const hint = [doubleEscaped(options.source, options.oldText) ? DOUBLE_ESCAPED : '', missHint(options.source, options.oldText, options.newText) ?? ''].filter(Boolean).join('\n');
  return { ok: false, count: 0, ...(hint ? { hint } : {}) };
}
