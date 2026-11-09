// @license Copyright 2026 Cline Bot Inc. Licensed under Apache-2.0.
// Adapted from Cline DiffEditRow: DOM rendering, VS Code theme tokens, and exact indentation.
import type { HunkView } from '../edits/review.js';

function renderDiffLine(options: { line: string; lineNumber?: number }): HTMLElement {
  const { line, lineNumber } = options;
  const isAddition = line.startsWith('+');
  const isDeletion = line.startsWith('-');
  const code = isAddition || isDeletion ? line.slice(1) : line;
  const prefix = isAddition ? '+' : isDeletion ? '-' : ' ';
  const row = document.createElement('div');
  row.className = `cline-diff-line ${isAddition ? 'cline-diff-added' : isDeletion ? 'cline-diff-removed' : ''}`;
  row.setAttribute('aria-label', `${isAddition ? 'Added' : 'Removed'} line${lineNumber === undefined ? '' : ` ${lineNumber}`}`);
  const number = document.createElement('span');
  number.className = 'cline-diff-number'; number.textContent = lineNumber === undefined ? '' : String(lineNumber);
  number.setAttribute('aria-hidden', 'true');
  const marker = document.createElement('span');
  marker.className = 'cline-diff-prefix'; marker.textContent = prefix;
  marker.setAttribute('aria-hidden', 'true');
  const content = document.createElement('span');
  content.className = 'cline-diff-code'; content.textContent = code;
  row.append(number, marker, content);
  return row;
}

function displayLines(text: string): string[] {
  if (!text) return [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines;
}

export function renderClineDiffLines(options: { hunk: HunkView; showLineNumbers: boolean }): HTMLElement {
  const { hunk, showLineNumbers } = options;
  const container = document.createElement('div');
  container.className = 'cline-diff-lines';
  container.setAttribute('role', 'group');
  container.setAttribute('aria-label', 'Changed lines');
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;
  for (const line of displayLines(hunk.removed)) {
    container.append(renderDiffLine({ line: `-${line}`, lineNumber: showLineNumbers ? oldLine : undefined })); oldLine++;
  }
  for (const line of displayLines(hunk.added)) {
    container.append(renderDiffLine({ line: `+${line}`, lineNumber: showLineNumbers ? newLine : undefined })); newLine++;
  }
  if (!hunk.truncated) {
    for (const [side, text] of [['original', hunk.removed], ['proposed', hunk.added]]) {
      if (!text || text.endsWith('\n')) continue;
      const marker = document.createElement('div');
      marker.className = 'cline-diff-eof'; marker.textContent = `No newline at end of file (${side} side).`;
      container.append(marker);
    }
  }
  return container;
}
