/*
 * Styled after Cline's apps/vscode/webview-ui/src/components/chat/DiffEditRow.tsx (FileBlock) at
 * eff43e19b267e171f597ab03733bfed25090f72d.
 * Copyright 2026 Cline Bot Inc. Licensed under Apache-2.0; see licenses/Cline-Apache-2.0.txt.
 */
import clsx from 'clsx';
import type { ReviewCommand, ReviewState } from '../../../edits/review.js';
import { FileDiffIcon } from '../common/Icons.js';
import { countLines, DiffLines, DiffStats } from './DiffLines.js';

function ActionButton({ text, command, disabled, primary, onCommand }: { text: string; command: ReviewCommand; disabled: boolean; primary?: boolean; onCommand: (command: ReviewCommand) => void }) {
  return <button className={clsx('btn', primary ? 'btn-primary' : 'btn-secondary')} disabled={disabled} onClick={() => { if (!disabled) onCommand(command); }} type="button">{text}</button>;
}

/** Proposed edits: whole-panel actions stay put while the proposal list scrolls on its own. */
export function ReviewPanel({ state, disabled, lockNote, onCommand }: { state: ReviewState; disabled: boolean; lockNote?: string; onCommand: (command: ReviewCommand) => void }) {
  const hidden = state.proposals.length === 0 && !state.canUndo && !state.recoveryPath;
  const locked = disabled || state.busy || !!state.recoveryPath;
  const previewLocked = state.busy || !!state.recoveryPath; // Preview only opens a diff editor, so it stays usable while the agent works.
  const active = state.proposals.filter(proposal => proposal.status === 'pending' || proposal.status === 'conflict');
  // Open proposals first; a superseded proposal is a one-line note because its changes live in the newer one.
  const ordered = [...active, ...state.proposals.filter(item => !active.includes(item))];
  return (
    <section aria-label="Proposed changes" hidden={hidden} id="review-panel" role="region">
      <h2>Review changes</h2>
      <p className={state.recoveryPath ? 'review-error' : 'hint'} role="status">
        {lockNote && <><strong className="review-lock">{lockNote}</strong><br /></>}
        {state.message}
      </p>
      <div className="review-actions">
        <ActionButton command={{ action: 'apply_all' }} disabled={locked || !active.length || active.some(proposal => proposal.status === 'conflict')} onCommand={onCommand} primary text="Apply all" />
        <ActionButton command={{ action: 'reject_all' }} disabled={locked || !active.length} onCommand={onCommand} text="Reject all" />
        <ActionButton command={{ action: 'undo' }} disabled={locked || !state.canUndo} onCommand={onCommand} text="Undo last apply" />
      </div>
      <div className="proposal-list">
        {ordered.map(proposal => {
          const additions = proposal.hunks.reduce((sum, hunk) => sum + countLines(hunk.added), 0);
          const deletions = proposal.hunks.reduce((sum, hunk) => sum + countLines(hunk.removed), 0);
          const header = (
            <div className="proposal-header">
              <FileDiffIcon className="proposal-icon" />
              <h3>{proposal.path}</h3>
              {proposal.status !== 'superseded' && <DiffStats additions={additions} deletions={deletions} />}
              <span className={clsx('proposal-status', `status-${proposal.status}`)}>{proposal.status}</span>
            </div>
          );
          if (proposal.status === 'superseded') {
            return (
              <article className="proposal-row superseded" data-proposal-id={proposal.id} key={proposal.id}>
                {header}
                <p className="hint">Replaced by a newer proposal for this file.</p>
              </article>
            );
          }
          const open = proposal.status === 'pending' || proposal.status === 'conflict';
          const showLineNumbers = !proposal.hunks.some(item => item.status === 'rejected' || item.status === 'undone');
          return (
            <article className="proposal-row" data-proposal-id={proposal.id} key={proposal.id}>
              {header}
              <p>{proposal.explanation}</p>
              <div className="review-actions">
                <ActionButton command={{ action: 'preview', id: proposal.id }} disabled={previewLocked} onCommand={onCommand} text="Preview" />
                {open && <>
                  <ActionButton command={{ action: 'apply', id: proposal.id }} disabled={locked || proposal.status === 'conflict'} onCommand={onCommand} primary text="Apply file" />
                  <ActionButton command={{ action: 'reject', id: proposal.id }} disabled={locked} onCommand={onCommand} text="Reject" />
                </>}
              </div>
              <div className="hunk-list">
                {proposal.hunks.map((hunk, index) => (
                  <section aria-label={`Hunk ${index + 1} in ${proposal.path}`} className={clsx('hunk-row', `hunk-${hunk.status}`)} data-hunk-id={hunk.id} key={hunk.id}>
                    <h4>{`Hunk ${index + 1} · original line ${hunk.oldStart} · −${hunk.oldLines} / +${hunk.newLines} · ${hunk.status}`}</h4>
                    <DiffLines hunk={hunk} showLineNumbers={showLineNumbers} />
                    {hunk.truncated && <p>Excerpt shortened. Open Preview for the full diff before accepting.</p>}
                    {hunk.status === 'pending' && open && (
                      <div className="review-actions">
                        <ActionButton command={{ action: 'apply_hunk', id: proposal.id, hunkId: hunk.id }} disabled={locked || proposal.status === 'conflict'} onCommand={onCommand} primary text="Accept hunk" />
                        <ActionButton command={{ action: 'reject_hunk', id: proposal.id, hunkId: hunk.id }} disabled={locked} onCommand={onCommand} text="Reject hunk" />
                      </div>
                    )}
                  </section>
                ))}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
