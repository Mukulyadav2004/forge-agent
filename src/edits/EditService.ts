import { createHash, randomUUID } from 'node:crypto';
import type { ProposalView, ReviewState } from './review';

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
interface Proposal { view: ProposalView; before: FileSnapshot; after: string; task: string }
interface UndoBatch { id: string; proposalIds: string[]; before: FileSnapshot[]; after: FileSnapshot[] }
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
      proposals: [...this.proposals.values()].map(proposal => ({ ...proposal.view })),
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
        proposal.view.status = 'rejected'; ids.push(proposal.view.id);
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
  async stage(options: { path: string; revision: string; text: string; explanation: string }): Promise<string> {
    this.assertAvailable();
    const receipt = this.receipts.get(options.revision);
    if (!receipt || receipt.task !== this.task || this.cancelled || receipt.file.path !== options.path) throw new Error('Read this file again and pass its current base_revision to propose_edit.');
    const actual = await this.options.backend.capture(options.path);
    if (receipt.task !== this.task || this.cancelled) throw new Error('The proposal belongs to a cancelled task.');
    if (actual.dirty) throw new Error(`Save your unsaved changes in ${options.path}, then read it again before proposing edits.`);
    if (!matches({ actual, expected: receipt.file })) throw new Error(`${options.path} changed after it was read. Read it again before proposing edits.`);
    const text = options.text.replace(/\r\n|\r|\n/g, actual.eol);
    if (text.length > MAX_EDIT_CHARACTERS || text.includes('\0') || text.startsWith('\uFEFF') || new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(text, 'utf8')) !== text) {
      throw new Error('Proposals must contain valid UTF-8 text within the file limit, without NUL characters or a leading BOM. Encoding metadata is preserved automatically.');
    }
    if (text === actual.text) throw new Error('The proposed content is identical to the current file.');
    const id = randomUUID();
    const proposal: Proposal = { view: { id, path: options.path, explanation: options.explanation, status: 'pending' }, before: actual, after: text, task: this.task };
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
      await this.options.backend.preview({ id, path: proposal.view.path, before: proposal.before.text, after: proposal.after });
      this.changed(`Preview opened for ${proposal.view.path}.`);
    } finally { this.busy = false; this.changed(); }
  }
  async reject(id?: string): Promise<void> {
    this.assertAvailable();
    const selected = [...this.proposals.values()].filter(proposal => (!id || proposal.view.id === id) && (proposal.view.status === 'pending' || proposal.view.status === 'conflict'));
    for (const proposal of selected) proposal.view.status = 'rejected';
    this.changed(`Rejected ${selected.length} proposal(s). No files were changed.`);
    await this.closePreviews(selected.map(proposal => proposal.view.id));
  }
  async apply(id?: string): Promise<void> {
    this.assertAvailable();
    const selected = [...this.proposals.values()].filter(proposal => (!id || proposal.view.id === id) && (proposal.view.status === 'pending' || proposal.view.status === 'conflict'));
    if (!selected.length) throw new Error('There are no pending proposals to apply.');
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
      const after = await this.commit({ id: batchId, before, texts: selected.map(proposal => proposal.after) });
      this.history.push({ id: batchId, proposalIds: selected.map(proposal => proposal.view.id), before, after });
      if (this.history.length > 10) this.history.shift();
      for (const proposal of selected) proposal.view.status = 'applied';
      this.receipts.clear();
      this.changed(`Applied and saved ${selected.length} file(s). Undo is available.`);
      await this.closePreviews(selected.map(proposal => proposal.view.id));
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
      const previous = this.history.at(-1);
      if (previous) {
        for (const [index, expected] of previous.after.entries()) {
          const current = restored.find(file => file.path === expected.path);
          if (current && current.text === expected.text && contentHash(current.bytes) === contentHash(expected.bytes)) previous.after[index] = current;
        }
      }
      for (const id of batch.proposalIds) {
        const proposal = this.proposals.get(id);
        if (proposal) proposal.view.status = 'undone';
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
