// Paging rules ported from anomalyco/opencode packages/core/src/tool/read-filesystem.ts and tool/plugin/read.ts (MIT):
// 1-based offset/limit, at most 2,000 lines or 50 KiB per call, lines clamped to 2,000 characters, a
// "continue with offset" hint, the file's tail for an offset past the end, and negative offsets counting from the end.

export const READ_LIMITS = { lines: 2_000, bytes: 50 * 1024, line_characters: 2_000, tail_lines: 100 };
const LINE_SUFFIX = `... (line truncated to ${READ_LIMITS.line_characters} chars)`;

export interface TextPage {
  /** First line shown (1-based). */
  offset: number;
  lines: string[];
  /** Lines in the file, not counting an empty one after a final line break. */
  total: number;
  /** The line to continue from, when more lines follow. */
  next?: number;
  /** The requested offset was past the end, so the file's tail is shown. */
  pastEnd: boolean;
  clampedLines: number;
}

/** File lines as read_file numbers them: split on LF, a CR before it dropped, no empty line after a final break. */
export function fileLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n').map(line => line.endsWith('\r') ? line.slice(0, -1) : line);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export function pageText(text: string, options: { offset?: number; limit?: number } = {}): TextPage {
  const all = fileLines(text);
  const total = all.length;
  const limit = Math.min(options.limit || READ_LIMITS.lines, READ_LIMITS.lines);
  const requested = options.offset || 1;
  let from: number, pastEnd = false;
  if (requested < 0) from = Math.max(1, total + 1 + requested);
  else if (requested > total && total > 0) { pastEnd = true; from = Math.max(1, total + 1 - Math.min(options.limit || READ_LIMITS.tail_lines, READ_LIMITS.tail_lines)); }
  else from = requested;
  const lines: string[] = [];
  let size = 0, next: number | undefined, clampedLines = 0;
  for (let line = from; line <= total; line++) {
    if (lines.length >= limit) { next = line; break; }
    let value = all[line - 1] ?? '';
    if (value.length > READ_LIMITS.line_characters) { value = value.slice(0, READ_LIMITS.line_characters) + LINE_SUFFIX; clampedLines++; }
    const cost = Buffer.byteLength(value, 'utf8') + (lines.length ? 1 : 0);
    if (size + cost > READ_LIMITS.bytes) {
      if (!lines.length) { lines.push(value.slice(0, 4000)); clampedLines++; next = line + 1 <= total ? line + 1 : undefined; }
      else next = line;
      break;
    }
    lines.push(value);
    size += cost;
  }
  return { offset: from, lines, total, ...(next !== undefined ? { next } : {}), pastEnd, clampedLines };
}

/** opencode's text layout: a header, `N: line` rows and a continuation hint. */
export function renderTextPage(path: string, page: TextPage, requestedOffset?: number): string {
  const end = page.offset + page.lines.length - 1;
  const header = (page.lines.length ? `Read file ${path}, lines ${page.offset}-${end} of ${page.total}` : `Read file ${path}, 0 lines`)
    + (page.pastEnd ? ` (offset ${requestedOffset} is past the end; the file has ${page.total} ${page.total === 1 ? 'line' : 'lines'})` : '');
  const rows = page.lines.map((line, index) => `${page.offset + index}: ${line}`);
  return [header, ...rows, ...(page.next !== undefined ? [`[Output truncated. Continue reading with offset: ${page.next}]`] : [])].join('\n');
}

export interface DirectoryEntry { name: string; directory: boolean }

/** Directories first, then names; directories end with "/". */
export function pageDirectory(entries: DirectoryEntry[], options: { offset?: number; limit?: number } = {}): { offset: number; entries: string[]; total: number; next?: number } {
  const offset = Math.max(1, options.offset || 1);
  const limit = Math.min(options.limit || READ_LIMITS.lines, READ_LIMITS.lines);
  const visible = [...entries].sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name)).map(entry => entry.name + (entry.directory ? '/' : ''));
  const selected = visible.slice(offset - 1, offset - 1 + limit);
  return { offset, entries: selected, total: visible.length, ...(offset - 1 + selected.length < visible.length ? { next: offset + selected.length } : {}) };
}

export function renderDirectoryPage(path: string, page: { offset: number; entries: string[]; next?: number }): string {
  const header = page.entries.length ? `Read directory ${path}, entries ${page.offset}-${page.offset + page.entries.length - 1}` : `Read directory ${path}, 0 entries`;
  return [header, ...page.entries, ...(page.next !== undefined ? [`[Output truncated. Continue reading with offset: ${page.next}]`] : [])].join('\n');
}

const stem = (name: string) => { const dot = name.lastIndexOf('.'); return dot > 0 ? name.slice(0, dot) : name; };
function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) current[j] = Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1));
    previous = current;
  }
  return previous[b.length] ?? 0;
}

/** Up to three entries of a folder that resemble a missing name: same name ignoring case, same stem, containment, then a typo. */
export function similarNames(names: readonly string[], requested: string): string[] {
  const name = requested.toLowerCase();
  const wanted = stem(name);
  const typos = wanted.length < 3 ? 0 : wanted.length < 5 ? 1 : 2;
  const tier = (candidate: string): number | undefined => {
    if (candidate === name) return 1;
    const found = stem(candidate);
    if (found === wanted) return 2;
    if (Math.min(found.length, wanted.length) >= 3 && (candidate.includes(name) || name.includes(candidate) || found.includes(wanted) || wanted.includes(found))) return 3;
    if (typos > 0 && Math.abs(found.length - wanted.length) <= typos && editDistance(found, wanted) <= typos) return 4;
    return undefined;
  };
  return names.filter(entry => entry !== requested).flatMap(entry => {
    const rank = tier(entry.toLowerCase());
    return rank === undefined ? [] : [{ entry, rank, distance: editDistance(entry.toLowerCase(), name) }];
  }).sort((a, b) => a.rank - b.rank || a.distance - b.distance || a.entry.localeCompare(b.entry)).slice(0, 3).map(match => match.entry);
}
