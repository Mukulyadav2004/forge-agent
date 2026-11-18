/*
 * Adapted from Cline's apps/vscode/webview-ui/src/components/chat/DiffEditRow.tsx (DiffLine, DiffStats and the
 * old/new line counters in FileBlock) at eff43e19b267e171f597ab03733bfed25090f72d.
 * Copyright 2026 Cline Bot Inc. Licensed under Apache-2.0; see licenses/Cline-Apache-2.0.txt.
 */
import clsx from 'clsx';
import type { HunkView } from '../../../edits/review.js';

function displayLines(text: string): string[] {
  if (!text) return [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines;
}

export function countLines(text: string): number {
  return displayLines(text).length;
}

/** Indicator bar, line number, prefix and code. The code keeps every character after the single diff marker. */
function DiffLine({ added, code, lineNumber }: { added: boolean; code: string; lineNumber?: number }) {
  return (
    <div aria-label={`${added ? 'Added' : 'Removed'} line${lineNumber === undefined ? '' : ` ${lineNumber}`}`} className={clsx('cline-diff-line flex font-mono text-xs border-l-4', added ? 'cline-diff-added bg-green-500/10 border-l-green-500' : 'cline-diff-removed bg-red-500/10 border-l-red-500')}>
      <span aria-hidden="true" className={clsx('cline-diff-number w-10 min-w-10 select-none border-r border-code-block-background/50 py-0.5 pr-2 text-right', added ? 'text-green-400/60' : 'text-red-400/60')}>{lineNumber === undefined ? '' : String(lineNumber)}</span>
      <span aria-hidden="true" className={clsx('cline-diff-prefix w-4 min-w-4 select-none py-0.5 text-center', added ? 'text-green-400' : 'text-red-400')}>{added ? '+' : '-'}</span>
      <span className={clsx('cline-diff-code flex-1 whitespace-pre py-0.5 pr-2', added ? 'text-green-400' : 'text-red-400')}>{code}</span>
    </div>
  );
}

export function DiffLines({ hunk, showLineNumbers }: { hunk: HunkView; showLineNumbers: boolean }) {
  const removed = displayLines(hunk.removed);
  const added = displayLines(hunk.added);
  return (
    <div aria-label="Changed lines" className="cline-diff-lines max-h-80 overflow-auto border-t border-code-block-background" role="group">
      <div className="w-max min-w-full">
        {removed.map((line, index) => <DiffLine added={false} code={line} key={`r${index}`} lineNumber={showLineNumbers ? hunk.oldStart + index : undefined} />)}
        {added.map((line, index) => <DiffLine added code={line} key={`a${index}`} lineNumber={showLineNumbers ? hunk.newStart + index : undefined} />)}
        {!hunk.truncated && ([['original', hunk.removed], ['proposed', hunk.added]] as const).map(([side, text]) => (
          text && !text.endsWith('\n') ? <div className="cline-diff-eof px-1 py-1 text-xs text-description" key={side}>{`No newline at end of file (${side} side).`}</div> : null
        ))}
      </div>
    </div>
  );
}

export function DiffStats({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="diff-stats flex shrink-0 text-xs">
      {additions > 0 && <span className="text-success">+{additions}</span>}
      {additions > 0 && deletions > 0 && <span className="mx-1 text-description">·</span>}
      {deletions > 0 && <span className="text-error">-{deletions}</span>}
    </span>
  );
}
