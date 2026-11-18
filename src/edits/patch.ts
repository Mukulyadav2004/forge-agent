// Ported from anomalyco/opencode packages/util/src/patch.ts (MIT): the "*** Begin Patch" grammar used by its patch tool.
// Parsing and deriving are pure; EditorBridge stages the results as review proposals instead of writing files.

export type PatchHunk =
  | { type: 'add'; path: string; contents: string }
  | { type: 'delete'; path: string }
  | { type: 'update'; path: string; movePath?: string; chunks: UpdateFileChunk[] };

export interface UpdateFileChunk { oldLines: string[]; newLines: string[]; changeContext?: string; endOfFile?: boolean }

export class PatchParseError extends Error {}

const VALID_HEADERS = "Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'";
const invalid = (line: string, lineNumber: number, reason?: string) =>
  new PatchParseError(reason ? `Invalid hunk at line ${lineNumber}: ${reason}` : `Invalid hunk at line ${lineNumber}: '${line}' is not a valid hunk header. ${VALID_HEADERS}`);

const stripHeredoc = (input: string) => input.match(/^(?:cat\s+)?<<(['"]?)(\w+)\1\s*\n([\s\S]*?)\n\2\s*$/u)?.[3] ?? input;

function isBoundary(line: string): boolean {
  return line === '*** End Patch' || line.startsWith('*** Add File: ') || line.startsWith('*** Delete File: ') || line.startsWith('*** Update File: ');
}

/** Parses patch text into file hunks, or throws PatchParseError naming the offending line. */
export function parsePatch(patchText: string): PatchHunk[] {
  const lines = stripHeredoc(patchText.trim()).split('\n').map(line => line.endsWith('\r') ? line.slice(0, -1) : line);
  if (lines[0]?.trim() !== '*** Begin Patch') throw new PatchParseError("The first line of the patch must be '*** Begin Patch'");
  const end = lines[lines.length - 1]?.trim() === '*** End Patch' ? lines.length - 1 : -1;
  if (end <= 0) throw new PatchParseError("The last line of the patch must be '*** End Patch'");
  const hunks: PatchHunk[] = [];
  let index = 1;
  while (index < end) {
    const header = (lines[index] ?? '').trim();
    if (index === 1 && header.startsWith('*** Environment ID:') && header.slice('*** Environment ID:'.length).trim()) { index++; continue; }
    if (header.startsWith('*** Add File: ')) {
      const path = header.slice('*** Add File: '.length).trim();
      const content: string[] = [];
      index++;
      while (index < end && !isBoundary((lines[index] ?? '').trim())) {
        const line = lines[index] ?? '';
        if (!line.startsWith('+')) throw invalid(line.trim(), index + 1, `Invalid Add File line for '${path}': expected a line starting with '+', got '${line.trim()}'`);
        content.push(line.slice(1));
        index++;
      }
      hunks.push({ type: 'add', path, contents: content.join('\n') });
      continue;
    }
    if (header.startsWith('*** Delete File: ')) {
      const path = header.slice('*** Delete File: '.length).trim();
      const next = lines[index + 1]?.trim();
      if (index + 1 < end && next !== undefined && !isBoundary(next)) {
        if (next.startsWith('*** ')) throw invalid(next, index + 2);
        throw invalid(next, index + 2, `Unexpected line after Delete File '${path}': '${next}'. Delete hunks do not contain body lines`);
      }
      hunks.push({ type: 'delete', path });
      index++;
      continue;
    }
    if (header.startsWith('*** Update File: ')) {
      const path = header.slice('*** Update File: '.length).trim();
      let next = index + 1;
      let movePath: string | undefined;
      while (lines[next]?.trimEnd() === '*** End of File') next++;
      const move = lines[next]?.trimEnd();
      if (move === '*** Move to:' || move?.startsWith('*** Move to: ')) {
        movePath = move.slice('*** Move to: '.length).trim();
        if (!movePath) throw invalid(move.trim(), next + 1, `Move destination for '${path}' must not be empty`);
        next++;
      }
      const parsed = parseUpdate(lines, next, end, path, index);
      hunks.push({ type: 'update', path, ...(movePath ? { movePath } : {}), chunks: parsed.chunks });
      index = parsed.next;
      continue;
    }
    throw invalid(header, index + 1);
  }
  return hunks;
}

function parseUpdate(lines: string[], start: number, end: number, path: string, hunk: number): { chunks: UpdateFileChunk[]; next: number } {
  const chunks: UpdateFileChunk[] = [];
  let index = start;
  let afterEndOfFile = false;
  const unexpected = (line: string) => `Unexpected line found in update hunk: '${line}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`;
  while (index < end) {
    const line = lines[index] ?? '';
    const updateLine = line.trimEnd();
    if (afterEndOfFile) {
      if (updateLine === '') { index++; continue; }
      if (updateLine === '@@' || updateLine.startsWith('@@ ')) afterEndOfFile = false;
      else if (isBoundary(updateLine)) break;
      else throw invalid(line, index + 1, `Expected update hunk to start with a @@ context marker, got: '${line}'`);
    }
    if (updateLine === '*** End of File') {
      const chunk = chunks[chunks.length - 1];
      if (chunk && !chunk.oldLines.length && !chunk.newLines.length) throw invalid(updateLine, index + 1, 'Update hunk does not contain any lines');
      if (chunk) { chunk.endOfFile = true; afterEndOfFile = true; }
      index++;
      continue;
    }
    if (isBoundary(updateLine)) break;
    if (updateLine === '@@' || updateLine.startsWith('@@ ')) {
      const previous = chunks[chunks.length - 1];
      if (previous && !previous.oldLines.length && !previous.newLines.length) throw invalid(line, index + 1, unexpected(line));
      chunks.push({ oldLines: [], newLines: [], ...(updateLine === '@@' ? {} : { changeContext: updateLine.slice('@@ '.length) }) });
      index++;
      continue;
    }
    if (!chunks.length) chunks.push({ oldLines: [], newLines: [] });
    const chunk = chunks[chunks.length - 1] as UpdateFileChunk;
    if (line === '') { chunk.oldLines.push(''); chunk.newLines.push(''); index++; continue; }
    if (line.startsWith(' ')) { chunk.oldLines.push(line.slice(1)); chunk.newLines.push(line.slice(1)); index++; continue; }
    if (line.startsWith('-')) { chunk.oldLines.push(line.slice(1)); index++; continue; }
    if (line.startsWith('+')) { chunk.newLines.push(line.slice(1)); index++; continue; }
    const populated = chunk.oldLines.length > 0 || chunk.newLines.length > 0;
    throw invalid(line, index + 1, populated ? `Expected update hunk to start with a @@ context marker, got: '${line}'` : unexpected(line));
  }
  if (!chunks.length) throw invalid((lines[hunk] ?? '').trim(), hunk + 1, `Update file hunk for path '${path}' is empty`);
  const last = chunks[chunks.length - 1] as UpdateFileChunk;
  if (!last.oldLines.length && !last.newLines.length) {
    const line = (lines[index] ?? '').trim();
    throw invalid(line, index + 1, line === '*** End Patch' ? 'Update hunk does not contain any lines' : unexpected(line));
  }
  return { chunks, next: index };
}

/** Applies update chunks to LF text. The result always ends with a line break, as in opencode. */
export function derivePatch(path: string, chunks: readonly UpdateFileChunk[], original: string): string {
  const lines = original.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const replacements = computeReplacements(lines, path, chunks);
  for (const [start, remove, insert] of replacements.reverse()) lines.splice(start, remove, ...insert);
  if (lines[lines.length - 1] !== '') lines.push('');
  return lines.join('\n');
}

function computeReplacements(lines: string[], path: string, chunks: readonly UpdateFileChunk[]): Array<[number, number, string[]]> {
  const replacements: Array<[number, number, string[]]> = [];
  let lineIndex = 0;
  for (const chunk of chunks) {
    if (chunk.changeContext) {
      const context = seek(lines, [chunk.changeContext], lineIndex);
      if (context === -1) throw new Error(`Failed to find context '${chunk.changeContext}' in ${path}`);
      lineIndex = context + 1;
    }
    if (!chunk.oldLines.length) { replacements.push([lines.length, 0, chunk.newLines]); continue; }
    let oldLines = chunk.oldLines, newLines = chunk.newLines;
    let found = seek(lines, oldLines, lineIndex, chunk.endOfFile);
    if (found === -1 && oldLines[oldLines.length - 1] === '') {
      oldLines = oldLines.slice(0, -1);
      if (newLines[newLines.length - 1] === '') newLines = newLines.slice(0, -1);
      found = seek(lines, oldLines, lineIndex, chunk.endOfFile);
    }
    if (found === -1 && chunk.oldLines.every(line => line === '')) {
      throw new Error(`Failed to find ${chunk.oldLines.length === 1 ? 'an expected blank line' : `${chunk.oldLines.length} consecutive blank lines`} in ${path}`);
    }
    if (found === -1) throw new Error(`Failed to find expected lines in ${path}:\n${chunk.oldLines.join('\n')}`);
    replacements.push([found, oldLines.length, newLines]);
    lineIndex = found + oldLines.length;
  }
  return replacements.sort((left, right) => left[0] - right[0]);
}

const normalize = (value: string) => value
  .replace(/[‘’‚‛]/gu, "'")
  .replace(/[“”„‟]/gu, '"')
  .replace(/[‐‑‒–—―−]/gu, '-')
  .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/gu, ' ');
const COMPARISONS: Array<(left: string, right: string) => boolean> = [
  (left, right) => left === right,
  (left, right) => left.trimEnd() === right.trimEnd(),
  (left, right) => left.trim() === right.trim(),
  (left, right) => normalize(left.trim()) === normalize(right.trim()),
];

function seek(lines: string[], pattern: readonly string[], start: number, eof = false): number {
  if (!pattern.length) return -1;
  const at = (offset: number, compare: (left: string, right: string) => boolean) => pattern.every((line, index) => compare(lines[offset + index] ?? '', line));
  if (eof) {
    const offset = lines.length - pattern.length;
    if (offset < start) return -1;
    return COMPARISONS.some(compare => at(offset, compare)) ? offset : -1;
  }
  for (const compare of COMPARISONS) for (let offset = start; offset <= lines.length - pattern.length; offset++) if (at(offset, compare)) return offset;
  return -1;
}

/** The model-facing grammar, from opencode packages/core/src/tool/patch.txt. */
export const PATCH_GUIDE = `The patch language is a stripped-down, file-oriented diff format:

*** Begin Patch
[ one or more file sections ]
*** End Patch

Each file section starts with one header:
*** Add File: <path> - create a new file. Every following line is a + line (the initial contents).
*** Delete File: <path> - remove an existing file. Nothing follows.
*** Update File: <path> - patch an existing file in place, optionally followed by "*** Move to: <new path>" to rename it.

An update has one or more chunks. Start each chunk with "@@" or "@@ <a line just above the change, such as a def or class line>", then lines prefixed with " " (unchanged context), "-" (removed) or "+" (added). Give about three lines of context around each change. "*** End of File" after a chunk anchors it at the end of the file.

Example:
*** Begin Patch
*** Add File: hello.txt
+Hello world
*** Update File: src/app.py
*** Move to: src/main.py
@@ def greet():
-print("Hi")
+print("Hello, world!")
*** Delete File: obsolete.txt
*** End Patch

Always include a header for each action, and prefix every new line with + even when creating a file.`;
