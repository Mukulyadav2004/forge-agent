import { createHash, randomUUID } from 'node:crypto';
import type { ProposalView, ReviewState } from './review';
import { buildLineChanges, composeLineChanges } from './lineChanges';
import type { ReviewPart } from './lineChanges';

export const MAX_EDIT_CHARACTERS = 500_000;

export interface FileSnapshot {
  path: string;
  realPath: string;
  documentUri: string;
  identity: string;
  text: string;
  bytes: Uint8Array;
  version: number;
  dirty: boolean;
  eol: '\n' | '\r\n';
}
export interface Replacement { before: FileSnapshot; text: string }
export interface EditBackend {
  capture(path: string): Promise<FileSnapshot>;
  replace(changes: Replacement[]): Promise<boolean>;
  save(path: string): Promise<boolean>;
  backup(options: { id: string; files: FileSnapshot[] }): Promise<string>;
  preview(options: { id: string; path: string; before: string; after: string }): Promise<void>;
  closePreview(id: string): Promise<void>;
}
interface Proposal { view: ProposalView; before: FileSnapshot; original: string; after: string; parts: ReviewPart[]; task: string }
interface UndoBatch { id: string; selections: { proposalId: string; hunkIds: string[] }[]; before: FileSnapshot[]; after: FileSnapshot[] }
interface ReadReceipt { task: string; file: FileSnapshot }

export function contentHash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
function matches(options: { actual: FileSnapshot; expected: FileSnapshot }): boolean {
  const { actual, expected } = options;
  return actual.realPath === expected.realPath && actual.documentUri === expected.documentUri && actual.identity === expected.identity
    && actual.version === expected.version && actual.text === expected.text
    && actual.dirty === expected.dirty && contentHash(actual.bytes) === contentHash(expected.bytes);
}
function bytesForText(options: { original: Uint8Array; text: string }): Uint8Array {
  const bom = options.original[0] === 239 && options.original[1] === 187 && options.original[2] === 191;
  return Buffer.from(`${bom ? '\uFEFF' : ''}${options.text}`, 'utf8');
}

export class EditService {
  private task = randomUUID();
  private cancelled = false;
  private busy = false;
  private blocked = false;
  private message = 'Proposed changes stay in memory until you apply them.';
  private recoveryPath: string | undefined;
  private readonly receipts = new Map<string, ReadReceipt>();
  private readonly proposals = new Map<string, Proposal>();
  private readonly history: UndoBatch[] = [];

  constructor(private readonly options: { backend: EditBackend; onChange: () => void }) {}

  get state(): ReviewState {
    return {
      proposals: [...this.proposals.values()].map(proposal => ({ ...proposal.view, hunks: proposal.view.hunks.map(hunk => ({ ...hunk })) })),
      busy: this.busy, canUndo: !this.blocked && this.history.length > 0,
      message: this.message, ...(this.recoveryPath ? { recoveryPath: this.recoveryPath } : {}),
    };
  }
  private changed(message?: string): void {
    if (message) this.message = message;
    this.options.onChange();
  }
  private assertAvailable(): void {
    if (this.busy) throw new Error('An edit transaction is already running.');
    if (this.blocked) throw new Error(`Recovery is required before another apply or undo. Backups: ${this.recoveryPath ?? 'unavailable'}`);
  }
  async newTask(): Promise<void> {
    this.assertAvailable();
    this.busy = true;
    try {
      this.task = randomUUID();
      this.cancelled = false;
      this.receipts.clear();
      const ids = [...this.proposals.keys()];
      this.proposals.clear();
      this.changed('New task. Previous unapplied proposals were discarded.');
      await this.closePreviews(ids);
    } finally { this.busy = false; this.changed(); }
  }
  async cancel(): Promise<void> {
    if (this.busy) throw new Error('Wait for the edit transaction to finish before cancelling.');
    this.cancelled = true;
    this.task = randomUUID();
    this.receipts.clear();
    const ids: string[] = [];
    for (const proposal of this.proposals.values()) {
      if (proposal.view.status === 'pending' || proposal.view.status === 'conflict') {
        for (const hunk of proposal.view.hunks) if (hunk.status === 'pending') hunk.status = 'rejected';
        proposal.view.status = proposal.view.hunks.some(hunk => hunk.status === 'applied') ? 'applied' : 'rejected'; ids.push(proposal.view.id);
      }
    }
    this.changed('Pending proposals discarded. Applied changes can be restored with Undo.');
    await this.closePreviews(ids);
  }
  beginTurn(): void {
    this.assertAvailable();
    if (this.cancelled) { this.task = randomUUID(); this.cancelled = false; }
  }
  async read(path: string): Promise<{ revision: string; file: FileSnapshot }> {
    const task = this.task;
    const file = await this.options.backend.capture(path);
    if (task !== this.task || this.cancelled) throw new Error('This task was cancelled. Read the file again in a new turn.');
    const revision = randomUUID();
    if (this.receipts.size >= 200) this.receipts.delete(this.receipts.keys().next().value ?? '');
    this.receipts.set(revision, { task, file });
    return { revision, file };
  }
  async stage(options: { path: string; revision: string; text: string; explanation: string; range?: { startLine: number; endLine: number } }): Promise<string> {
    this.assertAvailable();
    const receipt = this.receipts.get(options.revision);
    if (!receipt || receipt.task !== this.task || this.cancelled || receipt.file.path !== options.path) throw new Error('Read this file again and pass its current base_revision to propose_edit.');
    const actual = await this.options.backend.capture(options.path);
    if (receipt.task !== this.task || this.cancelled) throw new Error('The proposal belongs to a cancelled task.');
    if (actual.dirty) throw new Error(`Save your unsaved changes in ${options.path}, then read it again before proposing edits.`);
    if (!matches({ actual, expected: receipt.file })) throw new Error(`${options.path} changed after it was read. Read it again before proposing edits.`);
    let text = options.text.replace(/\r\n|\r|\n/g, actual.eol);
    if (options.range) {
      const { startLine, endLine } = options.range;
      const lines = actual.text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
      if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) || startLine < 1 || endLine < startLine || endLine > lines.length) throw new Error('Choose complete lines inside this file for a ranged proposal.');
      if (endLine < lines.length && text && !text.endsWith(actual.eol)) text += actual.eol;
      text = lines.slice(0, startLine - 1).join('') + text + lines.slice(endLine).join('');
    }
    if (text.length > MAX_EDIT_CHARACTERS || text.includes('\0') || options.text.startsWith('\uFEFF') || new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(text, 'utf8')) !== text) {
      throw new Error('Proposals must contain valid UTF-8 text within the file limit, without NUL characters or a leading BOM. Encoding metadata is preserved automatically.');
    }
    if (text === actual.text) throw new Error('The proposed content is identical to the current file.');
    const { parts, hunks } = buildLineChanges({ before: actual.text, after: text });
    const id = randomUUID();
    const proposal: Proposal = { view: { id, path: options.path, explanation: options.explanation, status: 'pending', hunks }, before: actual, original: actual.text, after: text, parts, task: this.task };
    this.proposals.set(id, proposal);
    try {
      await this.options.backend.preview({ id, path: options.path, before: actual.text, after: text });
      if (proposal.task !== this.task || this.cancelled || proposal.view.status !== 'pending') throw new Error('This proposal was discarded while its preview was opening.');
    } catch (error) {
      proposal.view.status = 'rejected';
      await this.closePreviews([id]);
      this.changed('The preview could not be opened; no changes were applied.');
      throw new Error('Could not stage the proposed edit.', { cause: error });
    }
    const superseded: string[] = [];
    for (const previous of this.proposals.values()) {
      if (previous !== proposal && previous.before.realPath === actual.realPath && (previous.view.status === 'pending' || previous.view.status === 'conflict')) {
        previous.view.status = 'superseded'; superseded.push(previous.view.id);
      }
    }
    this.changed(`Proposed ${options.path}. Review the diff, then apply or reject.`);
    await this.closePreviews(superseded);
    return id;
  }
  async preview(id: string): Promise<void> {
    this.assertAvailable();
    const proposal = this.proposals.get(id);
    if (!proposal) throw new Error('This proposal is no longer available.');
    this.busy = true; this.changed();
    try {
      await this.openPreview(proposal);
      this.changed(`Preview opened for ${proposal.view.path}.`);
    } finally { this.busy = false; this.changed(); }
  }
  async reject(id?: string): Promise<void> {
    this.assertAvailable();
    const selected = [...this.proposals.values()].filter(proposal => (!id || proposal.view.id === id) && (proposal.view.status === 'pending' || proposal.view.status === 'conflict'));
    for (const proposal of selected) {
      for (const hunk of proposal.view.hunks) if (hunk.status === 'pending') hunk.status = 'rejected';
      proposal.view.status = proposal.view.hunks.some(hunk => hunk.status === 'applied') ? 'applied' : 'rejected';
    }
    this.changed(`Rejected ${selected.length} proposal(s). No files were changed.`);
    await this.closePreviews(selected.map(proposal => proposal.view.id));
  }
  async apply(id?: string): Promise<void> {
    this.assertAvailable();
    const selected = [...this.proposals.values()].filter(proposal => (!id || proposal.view.id === id) && (proposal.view.status === 'pending' || proposal.view.status === 'conflict'));
    if (!selected.length) throw new Error('There are no pending proposals to apply.');
    await this.applySelected({ selected });
  }
  async applyHunk(options: { id: string; hunkId: string }): Promise<void> {
    this.assertAvailable();
    const proposal = this.pendingHunk(options);
    await this.applySelected({ selected: [proposal], hunkId: options.hunkId });
  }
  async rejectHunk(options: { id: string; hunkId: string }): Promise<void> {
    this.assertAvailable();
    const proposal = this.pendingHunk(options);
    this.busy = true; this.changed();
    try {
      for (const hunk of proposal.view.hunks) if (hunk.id === options.hunkId) hunk.status = 'rejected';
      this.updateStatus(proposal);
      await this.refreshPreview(proposal);
      this.changed('Rejected this hunk. No files were changed. Previously accepted hunks remain saved.');
    } finally { this.busy = false; this.changed(); }
  }
  private pendingHunk(options: { id: string; hunkId: string }): Proposal {
    const proposal = this.proposals.get(options.id);
    if (!proposal || proposal.task !== this.task || !['pending', 'conflict'].includes(proposal.view.status)
      || !proposal.view.hunks.some(hunk => hunk.id === options.hunkId && hunk.status === 'pending')) throw new Error('This hunk is no longer pending.');
    return proposal;
  }
  private updateStatus(proposal: Proposal): void {
    proposal.view.status = proposal.view.hunks.some(hunk => hunk.status === 'pending') ? proposal.view.status === 'conflict' ? 'conflict' : 'pending'
      : proposal.view.hunks.some(hunk => hunk.status === 'applied') ? 'applied' : 'rejected';
  }
  private candidate(options: { proposal: Proposal; hunkId?: string }): string {
    return composeLineChanges({ parts: options.proposal.parts, accepted: new Set(options.proposal.view.hunks.filter(hunk =>
      hunk.status === 'applied' || (hunk.status === 'pending' && (!options.hunkId || hunk.id === options.hunkId))).map(hunk => hunk.id)) });
  }
  private async openPreview(proposal: Proposal): Promise<void> {
    const pending = proposal.view.status === 'pending' || proposal.view.status === 'conflict';
    const reviewed = proposal.view.hunks.some(hunk => hunk.status === 'applied' || hunk.status === 'undone');
    const reviewedText = composeLineChanges({ parts: proposal.parts, accepted: new Set(proposal.view.hunks.filter(hunk => hunk.status === 'applied').map(hunk => hunk.id)) });
    await this.options.backend.preview({ id: proposal.view.id, path: proposal.view.path,
      before: pending ? proposal.before.text : proposal.original, after: pending ? this.candidate({ proposal }) : reviewed ? reviewedText : proposal.after });
  }
  private async refreshPreview(proposal: Proposal): Promise<void> {
    try {
      if (proposal.view.status === 'pending') await this.openPreview(proposal);
      else await this.closePreviews([proposal.view.id]);
    } catch { this.changed('The review state is saved, but the preview could not refresh. Use Preview to reopen it.'); }
  }
  private async applySelected(options: { selected: Proposal[]; hunkId?: string }): Promise<void> {
    const { selected } = options;
    this.busy = true; this.changed();
    try {
      for (const proposal of selected) {
        const actual = await this.options.backend.capture(proposal.view.path);
        if (actual.dirty || !matches({ actual, expected: proposal.before })) {
          proposal.view.status = 'conflict';
          throw new Error(`${proposal.view.path} changed since the proposal. Nothing was applied; reject it and request a fresh proposal.`);
        }
      }
      const batchId = randomUUID();
      const before = selected.map(proposal => proposal.before);
      const selections = selected.map(proposal => ({ proposalId: proposal.view.id, hunkIds: proposal.view.hunks.filter(hunk =>
        hunk.status === 'pending' && (!options.hunkId || hunk.id === options.hunkId)).map(hunk => hunk.id) }));
      const after = await this.commit({ id: batchId, before, texts: selected.map(proposal => this.candidate({ proposal, hunkId: options.hunkId })) });
      this.history.push({ id: batchId, selections, before, after });
      if (this.history.length > 10) this.history.shift();
      for (const [index, proposal] of selected.entries()) {
        const current = after[index];
        const selection = selections[index];
        if (!current || !selection) throw new Error('Missing committed review state.');
        proposal.before = current;
        for (const hunk of proposal.view.hunks) if (selection.hunkIds.includes(hunk.id)) hunk.status = 'applied';
        this.updateStatus(proposal);
      }
      this.receipts.clear();
      this.changed(options.hunkId ? `Accepted and saved this hunk. Undo is available. ${selected.some(proposal => proposal.view.status === 'pending') ? 'Other hunks stay pending.' : 'No pending hunks remain.'}` : `Applied and saved ${selected.length} file(s). Undo is available.`);
      for (const proposal of selected) await this.refreshPreview(proposal);
    } catch (error) {
      this.changed(error instanceof Error ? error.message : 'Apply failed.');
      throw error;
    } finally { this.busy = false; this.changed(); }
  }
  async undo(): Promise<void> {
    this.assertAvailable();
    const batch = this.history.at(-1);
    if (!batch) throw new Error('There is no applied batch to undo.');
    this.busy = true; this.changed();
    try {
      for (const after of batch.after) {
        const actual = await this.options.backend.capture(after.path);
        if (actual.dirty || !matches({ actual, expected: after })) throw new Error(`${after.path} changed after applying. Undo was refused to preserve your edits.`);
      }
      const restored = await this.commit({ id: `undo-${batch.id}`, before: batch.after, texts: batch.before.map(file => file.text), expectedBytes: batch.before.map(file => file.bytes) });
      this.history.pop();
      for (const previous of this.history) {
        for (const [index, expected] of previous.after.entries()) {
          const current = restored.find(file => file.path === expected.path);
          if (current && current.text === expected.text && contentHash(current.bytes) === contentHash(expected.bytes)) previous.after[index] = current;
        }
      }
      for (const selection of batch.selections) {
        const proposal = this.proposals.get(selection.proposalId);
        if (proposal) {
          proposal.view.status = 'undone';
          for (const hunk of proposal.view.hunks) {
            if (selection.hunkIds.includes(hunk.id)) hunk.status = 'undone';
            else if (hunk.status === 'pending') hunk.status = 'rejected';
          }
          await this.closePreviews([proposal.view.id]);
        }
      }
      this.receipts.clear();
      this.changed(`Undid the last applied batch (${batch.before.length} file(s)).`);
    } catch (error) {
      this.changed(error instanceof Error ? error.message : 'Undo failed.');
      throw error;
    } finally { this.busy = false; this.changed(); }
  }
  private async commit(options: { id: string; before: FileSnapshot[]; texts: string[]; expectedBytes?: Uint8Array[] }): Promise<FileSnapshot[]> {
    const backup = await this.options.backend.backup({ id: options.id, files: options.before });
    const changes: Replacement[] = [];
    for (const [index, before] of options.before.entries()) {
      const text = options.texts[index];
      if (text === undefined) throw new Error('Missing transaction content.');
      changes.push({ before, text });
    }
    const owned = new Map<string, FileSnapshot>();
    let applied = false;
    try {
      if (!await this.options.backend.replace(changes)) throw new Error('The editor rejected the batch. No edits were applied.');
      applied = true;
      for (const change of changes) {
        const current = await this.options.backend.capture(change.before.path);
        if (current.text !== change.text) throw new Error(`${change.before.path} changed during apply.`);
        owned.set(current.path, current);
      }
      const after: FileSnapshot[] = [];
      for (const [index, change] of changes.entries()) {
        if (!await this.options.backend.save(change.before.path)) throw new Error(`Saving ${change.before.path} failed.`);
        const current = await this.options.backend.capture(change.before.path);
        // A save participant or another writer must not silently change the accepted diff.
        if (current.text !== change.text) throw new Error(`${change.before.path} was changed by a save participant or another writer.`);
        owned.set(current.path, current);
        const expected = options.expectedBytes?.[index] ?? bytesForText({ original: change.before.bytes, text: change.text });
        if (current.dirty || contentHash(current.bytes) !== contentHash(expected)) throw new Error(`Could not verify the saved bytes of ${current.path}.`);
        after.push(current);
      }
      for (const file of after) if (!matches({ actual: await this.options.backend.capture(file.path), expected: file })) throw new Error(`${file.path} changed before commit completed.`);
      return after;
    } catch (error) {
      if (!applied) throw error;
      const restored = await this.rollback({ before: options.before, owned });
      if (!restored) {
        this.blocked = true; this.recoveryPath = backup;
        throw new Error(`The transaction failed and rollback could not be completed without risking newer edits. Further writes are blocked. Recovery snapshots: ${backup}`, { cause: error });
      }
      throw new Error(`The transaction failed; all affected files were restored. ${error instanceof Error ? error.message : ''}`, { cause: error });
    }
  }
  private async rollback(options: { before: FileSnapshot[]; owned: Map<string, FileSnapshot> }): Promise<boolean> {
    try {
      const changes: Replacement[] = [];
      let complete = true;
      for (const before of options.before) {
        const current = await this.options.backend.capture(before.path);
        const expected = options.owned.get(before.path);
        if (!expected || !matches({ actual: current, expected })) { complete = false; continue; }
        changes.push({ before: current, text: before.text });
      }
      if (changes.length && !await this.options.backend.replace(changes)) return false;
      for (const change of changes) {
        if (!await this.options.backend.save(change.before.path)) { complete = false; continue; }
        const original = options.before.find(file => file.path === change.before.path);
        const current = await this.options.backend.capture(change.before.path);
        if (!original || current.dirty || current.text !== original.text || contentHash(current.bytes) !== contentHash(original.bytes)) complete = false;
      }
      return complete;
    } catch { return false; }
  }
  private async closePreviews(ids: string[]): Promise<void> {
    for (const id of ids) {
      try { await this.options.backend.closePreview(id); }
      catch { this.message += ' A preview tab could not be closed.'; }
    }
  }
}
