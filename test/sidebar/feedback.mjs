import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ReviewFeedback } from '../../out/sidebar/ReviewFeedback.js';

const state = (statuses) => ({
  busy: false, canUndo: statuses.includes('applied'), message: 'Review result',
  proposals: [{ id: 'proposal-1', path: 'src/example.py', explanation: 'Edit', status: statuses.includes('pending') ? 'pending' : statuses[0],
    hunks: statuses.map((status, index) => ({ id: `h${index}`, status, oldStart: index + 1, newStart: index + 1, oldLines: 1, newLines: 1, removed: 'old', added: 'new', truncated: false })) }],
});
const updates = feedback => feedback.message()?.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));

test('review feedback records apply, partial rejection and undo as distinct actual outcomes', () => {
  const feedback = new ReviewFeedback();
  assert.equal(feedback.message(), undefined);
  feedback.record({ command: { action: 'apply_hunk', id: 'proposal-1', hunkId: 'h0' }, before: state(['pending', 'pending']), after: state(['applied', 'pending']), succeeded: true, message: 'Saved first hunk' });
  feedback.record({ command: { action: 'reject_hunk', id: 'proposal-1', hunkId: 'h1' }, before: state(['applied', 'pending']), after: state(['applied', 'rejected']), succeeded: true, message: 'Rejected second hunk' });
  feedback.record({ command: { action: 'undo' }, before: state(['applied', 'rejected']), after: state(['undone', 'rejected']), succeeded: true, message: 'Restored previous file' });
  const events = updates(feedback);
  assert.deepEqual(events.map(event => event.action), ['apply_hunk', 'reject_hunk', 'undo']);
  assert.deepEqual(events[0].proposals[0].hunks, { pending: 1, applied: 1, rejected: 0, undone: 0 });
  assert.deepEqual(events[1].proposals[0].hunks, { pending: 0, applied: 1, rejected: 1, undone: 0 });
  assert.deepEqual(events[2].proposals[0].hunks, { pending: 0, applied: 0, rejected: 1, undone: 1 });
  assert.ok(feedback.message().includes('read_file'));
  assert.ok(!feedback.message().includes('"removed"'));
});

test('preview is silent, failed undo is not reported as a successful restoration, and clear discards feedback', () => {
  const feedback = new ReviewFeedback();
  const applied = state(['applied']);
  feedback.record({ command: { action: 'preview', id: 'proposal-1' }, before: applied, after: applied, succeeded: true, message: 'Preview opened' });
  assert.equal(feedback.message(), undefined);
  feedback.record({ command: { action: 'undo' }, before: applied, after: applied, succeeded: false, message: 'File changed; refused undo' });
  assert.equal(updates(feedback)[0].succeeded, false);
  assert.deepEqual(updates(feedback)[0].proposals, []);
  assert.ok(feedback.message().includes('refused undo'));
  feedback.clear();
  assert.equal(feedback.message(), undefined);
});

test('feedback stays bounded and reports omitted data without exposing source text', () => {
  const feedback = new ReviewFeedback();
  for (let index = 0; index < 100; index++) {
    const after = state(['undone']);
    after.proposals[0].path = 'x'.repeat(10_000);
    after.proposals = Array.from({ length: 20 }, (_, offset) => ({ ...after.proposals[0], id: `p-${index}-${offset}` }));
    feedback.record({ command: { action: 'undo' }, before: { ...after, proposals: [] }, after, succeeded: true, message: 'result'.repeat(2000) });
  }
  assert.ok(feedback.message().length < 13_000);
  assert.ok(feedback.message().includes('Earlier review updates were omitted'));
  const last = updates(feedback).at(-1);
  assert.equal(last.omitted_proposals, 12);
  assert.ok(last.proposals[0].path.length <= 512);
  assert.equal(last.proposals[0].proposal_id, 'p-99-0');
});
