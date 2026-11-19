import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EditService, contentHash } from '../../out/edits/EditService.js';

class MemoryBackend {
  files = new Map(); previews = new Map(); backups = []; replaceCalls = 0; saveCalls = 0;
  failSaveAt = 0; failEverySaveFor; refuseReplace = false; beforeSave; beforeBackup; beforeCapture;
  constructor(files) {
    for (const [path, text] of Object.entries(files)) this.files.set(path, { path, realPath: `/workspace/${path}`, documentUri: `file:///workspace/${path}`, identity: `file:${path}`, text, bytes: Buffer.from(text), version: 1, dirty: false, eol: text.includes('\r\n') ? '\r\n' : '\n' });
  }
  get(path) { const file = this.files.get(path); if (!file) throw new Error('Missing file'); return file; }
  async capture(path) {
    await this.beforeCapture?.(path);
    const file = this.get(path); return { ...file, bytes: Uint8Array.from(file.bytes) };
  }
  async replace(changes) {
    if (this.refuseReplace) return false;
    for (const { before } of changes) {
      const current = this.get(before.path);
      if (current.text !== before.text || current.version !== before.version || contentHash(current.bytes) !== contentHash(before.bytes)) return false;
    }
    this.replaceCalls++;
    for (const change of changes) Object.assign(this.get(change.before.path), { text: change.text, version: this.get(change.before.path).version + 1, dirty: true });
    return true;
  }
  async save(path) {
    this.saveCalls++;
    await this.beforeSave?.(path);
    if (this.saveCalls === this.failSaveAt || path === this.failEverySaveFor) return false;
    const file = this.get(path);
    const bom = file.bytes[0] === 239 && file.bytes[1] === 187 && file.bytes[2] === 191;
    file.bytes = Buffer.from(`${bom ? '\uFEFF' : ''}${file.text}`); file.dirty = false;
    return true;
  }
  async backup(options) {
    await this.beforeBackup?.();
    this.backups.push({ id: options.id, files: options.files.map(file => ({ ...file, bytes: Uint8Array.from(file.bytes) })) });
    return `/snapshots/${options.id}.json`;
  }
  async preview(options) { this.previews.set(options.id, options); }
  async closePreview(id) { this.previews.delete(id); }
  change(options) {
    const file = this.get(options.path);
    file.text = options.text; file.version++; file.dirty = options.dirty ?? false;
    if (!file.dirty) file.bytes = Buffer.from(options.text);
  }
}
function setup(files = { 'a.txt': 'old a\n', 'b.txt': 'old b\n', 'c.txt': 'old c\n' }) {
  const backend = new MemoryBackend(files);
  const service = new EditService({ backend, onChange() {} });
  return { backend, service };
}
async function stage(options) {
  const read = await options.service.read(options.path);
  return options.service.stage({ path: options.path, revision: read.revision, text: options.text, explanation: 'Test proposal' });
}
async function stageBatch(service) {
  for (const path of ['a.txt', 'b.txt', 'c.txt']) await stage({ service, path, text: `new ${path}\n` });
}

test('an agent turn stages without opening diff tabs and shows one diff when it ends', async () => {
  const { backend, service } = setup({ 'a.txt': 'one\n', 'b.txt': 'two\n' });
  service.beginTurn();
  const a = await stage({ service, path: 'a.txt', text: 'ONE\n' });
  const b = await stage({ service, path: 'b.txt', text: 'TWO\n' });
  assert.equal(backend.previews.size, 0, 'Staging during a turn must not switch editor tabs.');
  await service.endTurn();
  assert.deepEqual([...backend.previews.keys()], [a], 'Only the first pending proposal opens when the turn ends.');
  await service.preview(b);
  assert.equal(backend.previews.has(b), true, 'Preview still opens any proposal on request.');
  await service.endTurn();
  assert.equal(backend.previews.size, 2, 'Ending again without a turn opens nothing more.');
  const c = await stage({ service, path: 'a.txt', text: 'uno\n' });
  assert.equal(backend.previews.has(c), true, 'Outside a turn, staging still opens its preview at once.');
});

test('a new task ends quiet staging', async () => {
  const { backend, service } = setup({ 'a.txt': 'one\n' });
  service.beginTurn();
  await service.newTask();
  const id = await stage({ service, path: 'a.txt', text: 'ONE\n' });
  assert.equal(backend.previews.has(id), true);
});

test('preview and rejection do not write files; previews have independent lifetimes', async () => {
  const { backend, service } = setup();
  const a = await stage({ service, path: 'a.txt', text: 'new a\n' });
  const b = await stage({ service, path: 'b.txt', text: 'new b\n' });
  assert.equal(backend.replaceCalls, 0); assert.equal(backend.get('a.txt').text, 'old a\n');
  await service.reject(a);
  assert.equal(backend.previews.has(a), false); assert.equal(backend.previews.has(b), true);
  assert.equal(backend.backups.length, 0);
});
test('a conflict in any file blocks every write in a multi-file apply', async () => {
  const { backend, service } = setup(); await stageBatch(service);
  backend.change({ path: 'b.txt', text: 'user change\n' });
  await assert.rejects(service.apply(), /changed since the proposal/);
  assert.equal(backend.replaceCalls, 0); assert.equal(backend.backups.length, 0);
  assert.equal(backend.get('a.txt').text, 'old a\n'); assert.equal(backend.get('c.txt').text, 'old c\n');
  assert.equal(backend.get('b.txt').text, 'user change\n');
});
test('dirty buffers and read-to-propose changes invalidate the read revision', async () => {
  const { backend, service } = setup(); const read = await service.read('a.txt');
  backend.change({ path: 'a.txt', text: 'unsaved work', dirty: true });
  await assert.rejects(service.stage({ path: 'a.txt', revision: read.revision, text: 'replacement', explanation: '' }), /unsaved/);
  backend.change({ path: 'a.txt', text: 'saved different content' });
  await assert.rejects(service.stage({ path: 'a.txt', revision: read.revision, text: 'replacement', explanation: '' }), /changed after it was read/);
  await assert.rejects(service.stage({ path: 'b.txt', revision: read.revision, text: 'replacement', explanation: '' }), /Read this file again/);
  assert.equal(backend.replaceCalls, 0);
});
test('one editor batch applies and one undo restores exact bytes across three files', async () => {
  const { backend, service } = setup(); const originals = [...backend.files.values()].map(file => Buffer.from(file.bytes));
  await stageBatch(service); await service.apply();
  assert.equal(backend.replaceCalls, 1); assert.equal(service.state.canUndo, true);
  assert.ok(service.state.proposals.every(proposal => proposal.status === 'applied'));
  assert.equal(backend.backups.length, 1);
  await service.undo();
  assert.equal(backend.replaceCalls, 2); assert.equal(service.state.canUndo, false);
  assert.deepEqual([...backend.files.values()].map(file => Buffer.from(file.bytes)), originals);
});
test('undo refuses later manual edits without changing any file', async () => {
  const { backend, service } = setup(); await stageBatch(service); await service.apply();
  backend.change({ path: 'b.txt', text: 'later user work' });
  const before = [...backend.files.values()].map(file => file.text);
  await assert.rejects(service.undo(), /preserve your edits/);
  assert.deepEqual([...backend.files.values()].map(file => file.text), before); assert.equal(backend.replaceCalls, 1);
});
test('a save failure restores all editor buffers and saved files', async () => {
  const { backend, service } = setup(); await stageBatch(service); backend.failSaveAt = 2;
  await assert.rejects(service.apply(), /all affected files were restored/);
  for (const [path, expected] of [['a.txt','old a\n'],['b.txt','old b\n'],['c.txt','old c\n']]) {
    assert.equal(backend.get(path).text, expected); assert.equal(Buffer.from(backend.get(path).bytes).toString(), expected); assert.equal(backend.get(path).dirty, false);
  }
  assert.equal(service.state.canUndo, false); assert.equal(service.state.recoveryPath, undefined);
});
test('persistent recovery failure preserves snapshots and blocks more writes', async () => {
  const { backend, service } = setup(); await stageBatch(service); backend.failEverySaveFor = 'b.txt';
  await assert.rejects(service.apply(), /Further writes are blocked/);
  assert.ok(service.state.recoveryPath); assert.equal(backend.backups.length, 1);
  await assert.rejects(service.apply(), /Recovery is required/);
  await assert.rejects(service.undo(), /Recovery is required/);
});
test('rollback preserves a concurrent writer instead of overwriting it', async () => {
  const { backend, service } = setup(); await stageBatch(service);
  backend.beforeSave = async path => { if (path === 'b.txt') backend.change({ path: 'a.txt', text: 'concurrent user edit' }); };
  backend.failSaveAt = 2;
  await assert.rejects(service.apply(), /without risking newer edits/);
  assert.equal(backend.get('a.txt').text, 'concurrent user edit');
  assert.equal(Buffer.from(backend.get('a.txt').bytes).toString(), 'concurrent user edit');
});
test('the editor rejecting an atomic batch leaves files unchanged', async () => {
  const { backend, service } = setup(); await stageBatch(service); backend.refuseReplace = true;
  await assert.rejects(service.apply(), /editor rejected/); assert.equal(backend.replaceCalls, 0);
  assert.equal(backend.get('a.txt').text, 'old a\n');
});
test('a cancelled task cannot stage a stale or in-flight read', async () => {
  const { backend, service } = setup(); const receipt = await service.read('a.txt'); await service.cancel(); service.beginTurn();
  await assert.rejects(service.stage({ path: 'a.txt', revision: receipt.revision, text: 'bad', explanation: '' }), /Read this file again/);
  let release; backend.beforeCapture = () => new Promise(resolve => { release = resolve; });
  const pendingRead = service.read('b.txt'); await service.cancel(); release();
  await assert.rejects(pendingRead, /cancelled/); assert.equal(backend.replaceCalls, 0);
});
test('repeated acceptance is serialized and creates only one undo entry', async () => {
  const { backend, service } = setup(); await stage({ service, path: 'a.txt', text: 'new a' });
  let release; backend.beforeBackup = () => new Promise(resolve => { release = resolve; });
  const first = service.apply();
  while (!release) await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(service.apply(), /already running/);
  release(); await first; assert.equal(backend.replaceCalls, 1); assert.equal(backend.backups.length, 1);
});
test('UTF-8 BOM and CRLF survive apply and undo', async () => {
  const { backend, service } = setup({ 'a.txt': 'α\r\n' }); backend.get('a.txt').bytes = Buffer.from('\uFEFFα\r\n');
  const original = Buffer.from(backend.get('a.txt').bytes);
  await stage({ service, path: 'a.txt', text: 'β\n' }); await service.apply();
  assert.equal(backend.get('a.txt').text, 'β\r\n');
  await service.undo(); assert.deepEqual(Buffer.from(backend.get('a.txt').bytes), original);
});
test('successive batches on the same file can be undone in reverse order', async () => {
  const { backend, service } = setup(); await stage({ service, path: 'a.txt', text: 'first' }); await service.apply();
  await stage({ service, path: 'a.txt', text: 'second' }); await service.apply();
  await service.undo(); assert.equal(backend.get('a.txt').text, 'first');
  await service.undo(); assert.equal(backend.get('a.txt').text, 'old a\n');
});
test('a fresh proposal supersedes the previous proposal for the same file', async () => {
  const { backend, service } = setup(); const old = await stage({ service, path: 'a.txt', text: 'first' });
  const next = await stage({ service, path: 'a.txt', text: 'second' });
  assert.equal(service.state.proposals.find(proposal => proposal.id === old).status, 'superseded');
  assert.equal(backend.previews.has(old), false); assert.equal(backend.previews.has(next), true);
  await service.apply(); assert.equal(backend.get('a.txt').text, 'second');
});

test('failure to create recovery snapshots prevents all writes', async () => {
  const { backend, service } = setup(); await stageBatch(service);
  backend.beforeBackup = async () => { throw new Error('Snapshot storage unavailable'); };
  await assert.rejects(service.apply(), /Snapshot storage unavailable/);
  assert.equal(backend.replaceCalls, 0); assert.equal(backend.get('a.txt').text, 'old a\n');
});

test('opening a preview serializes concurrent apply and preview requests', async () => {
  const { backend, service } = setup(); const id = await stage({ service, path: 'a.txt', text: 'new' });
  let release; backend.preview = async () => new Promise(resolve => { release = resolve; });
  const opening = service.preview(id);
  await assert.rejects(service.apply(), /already running/);
  await assert.rejects(service.preview(id), /already running/);
  release(); await opening; assert.equal(backend.replaceCalls, 0);
});
test('starting a new task discards a proposal whose preview is still opening', async () => {
  const { backend, service } = setup(); const read = await service.read('a.txt');
  let release; backend.preview = async options => { backend.previews.set(options.id, options); await new Promise(resolve => { release = resolve; }); };
  const pending = service.stage({ path: 'a.txt', revision: read.revision, text: 'new', explanation: '' });
  while (!release) await new Promise(resolve => setImmediate(resolve));
  await service.newTask(); release();
  await assert.rejects(pending, /Could not stage/);
  assert.equal(service.state.proposals.length, 0); assert.equal(backend.previews.size, 0); assert.equal(backend.replaceCalls, 0);
});

test('invalid text and CRLF expansion are rejected before a preview or write', async () => {
  const { backend, service } = setup({ 'a.txt': 'old\r\n' });
  for (const text of ['nul\0text', '\uD800', '\uFEFFunexpected BOM', '\n'.repeat(300000)]) {
    const read = await service.read('a.txt');
    await assert.rejects(service.stage({ path: 'a.txt', revision: read.revision, text, explanation: '' }), /valid UTF-8/);
  }
  assert.equal(backend.previews.size, 0); assert.equal(backend.replaceCalls, 0);
});

test('hunks accept independently, preserve rejected lines, and undo exact partial changes', async () => {
  const original = 'header\nold a\nseparator\nold b\nfooter\n';
  const { backend, service } = setup({ 'a.txt': original });
  const id = await stage({ service, path: 'a.txt', text: 'header\nnew a\nextra line\nseparator\nnew b\nfooter\n' });
  const [first, second] = service.state.proposals[0].hunks;
  assert.equal(service.state.proposals[0].hunks.length, 2);
  await service.rejectHunk({ id, hunkId: second.id });
  assert.equal(backend.replaceCalls, 0);
  await service.applyHunk({ id, hunkId: first.id });
  assert.equal(backend.get('a.txt').text, 'header\nnew a\nextra line\nseparator\nold b\nfooter\n');
  assert.equal(backend.get('a.txt').dirty, false);
  await service.preview(id);
  assert.equal(backend.previews.get(id).after, backend.get('a.txt').text);
  await service.undo();
  assert.equal(backend.get('a.txt').text, original);
  assert.equal(service.state.proposals[0].status, 'undone');
});

test('accepting an insertion rebases remaining hunks; apply-all never resurrects a rejection', async () => {
  const { backend, service } = setup({ 'a.txt': 'a\nkeep\nb\nkeep\nc\n' });
  const id = await stage({ service, path: 'a.txt', text: 'a\ninserted\nkeep\nB\nkeep\nC\n' });
  const [first, second, third] = service.state.proposals[0].hunks;
  await service.applyHunk({ id, hunkId: first.id });
  assert.equal(service.state.proposals[0].status, 'pending');
  await service.rejectHunk({ id, hunkId: second.id });
  await service.apply();
  assert.equal(backend.get('a.txt').text, 'a\ninserted\nkeep\nb\nkeep\nC\n');
  assert.equal(service.state.proposals[0].hunks.find(hunk => hunk.id === third.id).status, 'applied');
  await service.undo();
  assert.equal(backend.get('a.txt').text, 'a\ninserted\nkeep\nb\nkeep\nc\n');
  await service.undo();
  assert.equal(backend.get('a.txt').text, 'a\nkeep\nb\nkeep\nc\n');
});

test('a manual change after one accepted hunk blocks subsequent acceptance', async () => {
  const { backend, service } = setup({ 'a.txt': 'a\nkeep\nb\n' });
  const id = await stage({ service, path: 'a.txt', text: 'A\nkeep\nB\n' });
  const [first, second] = service.state.proposals[0].hunks;
  await service.applyHunk({ id, hunkId: first.id });
  backend.change({ path: 'a.txt', text: 'user edited this\n' });
  await assert.rejects(service.applyHunk({ id, hunkId: second.id }), /changed since the proposal/);
  assert.equal(backend.get('a.txt').text, 'user edited this\n');
  await assert.rejects(service.undo(), /preserve your edits/);
});

test('ranged proposals preserve surrounding code and the original CRLF/BOM bytes', async () => {
  const { backend, service } = setup({ 'a.txt': 'before\r\nold\r\nafter\r\n' });
  backend.get('a.txt').bytes = Buffer.from('\uFEFFbefore\r\nold\r\nafter\r\n');
  const original = Buffer.from(backend.get('a.txt').bytes);
  const read = await service.read('a.txt');
  await service.stage({ path: 'a.txt', revision: read.revision, text: 'new\nextra', range: { startLine: 2, endLine: 2 }, explanation: '' });
  await service.apply();
  assert.equal(backend.get('a.txt').text, 'before\r\nnew\r\nextra\r\nafter\r\n');
  await service.undo(); assert.deepEqual(Buffer.from(backend.get('a.txt').bytes), original);
});

test('ranged deletion, EOF newline changes and invalid ranges are handled without offset guessing', async () => {
  const { backend, service } = setup({ 'a.txt': 'before\ndelete\nafter' });
  const read = await service.read('a.txt');
  await assert.rejects(service.stage({ path: 'a.txt', revision: read.revision, text: '', range: { startLine: 2, endLine: 9 }, explanation: '' }), /complete lines/);
  const id = await service.stage({ path: 'a.txt', revision: read.revision, text: '', range: { startLine: 2, endLine: 2 }, explanation: '' });
  await service.applyHunk({ id, hunkId: service.state.proposals[0].hunks[0].id });
  assert.equal(backend.get('a.txt').text, 'before\nafter');
  await service.undo(); assert.equal(backend.get('a.txt').text, 'before\ndelete\nafter');
});

test('undo of a hunk discards remaining pending hunks instead of applying a stale proposal', async () => {
  const { backend, service } = setup({ 'a.txt': 'a\nkeep\nb\n' });
  const id = await stage({ service, path: 'a.txt', text: 'A\nkeep\nB\n' });
  const [first, second] = service.state.proposals[0].hunks;
  await service.applyHunk({ id, hunkId: first.id }); await service.undo();
  await assert.rejects(service.applyHunk({ id, hunkId: second.id }), /no longer pending/);
  assert.equal(backend.get('a.txt').text, 'a\nkeep\nb\n');
  assert.equal(backend.previews.size, 0);
});

test('hunk undo stays valid across an interleaved apply to another file', async () => {
  const { backend, service } = setup({ 'a.txt': 'a\nkeep\nb\n', 'b.txt': 'old\n' });
  const id = await stage({ service, path: 'a.txt', text: 'A\nkeep\nB\n' });
  const [first, second] = service.state.proposals[0].hunks;
  await service.applyHunk({ id, hunkId: first.id });
  const other = await stage({ service, path: 'b.txt', text: 'new\n' }); await service.apply(other);
  await service.applyHunk({ id, hunkId: second.id });
  await service.undo(); await service.undo(); await service.undo();
  assert.equal(backend.get('a.txt').text, 'a\nkeep\nb\n');
  assert.equal(backend.get('b.txt').text, 'old\n');
});

test('line-range, insert and old_text edits to one file combine into one review, apply and undo', async () => {
  const { backend, service } = setup({ 'a.txt': 'one\ntwo\nthree\nfour\n' });
  const read = await service.read('a.txt');
  const first = await service.stageEdit({ path: 'a.txt', revision: read.revision, text: 'TWO', range: { startLine: 2, endLine: 2 }, explanation: 'first' });
  assert.deepEqual([first.combined, first.replaced], [false, []]);
  const second = await service.stageEdit({ path: 'a.txt', revision: read.revision, text: 'added\nlines', insertLine: 4, explanation: 'second' });
  const third = await service.stageEdit({ path: 'a.txt', revision: read.revision, text: 'ONE', oldText: 'one', explanation: 'third' });
  assert.deepEqual([second.combined, third.combined, third.replaced], [true, true, []]);
  assert.equal(service.state.proposals.find(proposal => proposal.id === first.id).status, 'superseded');
  assert.equal(service.state.proposals.filter(proposal => proposal.status === 'pending').length, 1);
  await service.apply(); assert.equal(backend.get('a.txt').text, 'ONE\nTWO\nthree\nadded\nlines\nfour\n');
  await service.undo(); assert.equal(backend.get('a.txt').text, 'one\ntwo\nthree\nfour\n');
});

test('overlapping, ambiguous or missing edits are refused and keep the pending proposal', async () => {
  const { service } = setup({ 'a.txt': 'x\ny\nx\nz\n' });
  const read = await service.read('a.txt');
  const first = await service.stageEdit({ path: 'a.txt', revision: read.revision, text: 'Y', range: { startLine: 2, endLine: 3 }, explanation: '' });
  const attempt = (extra) => service.stageEdit({ path: 'a.txt', revision: read.revision, text: 'new', explanation: '', ...extra });
  await assert.rejects(attempt({ range: { startLine: 3, endLine: 4 } }), /overlap your pending change at line 2/);
  await assert.rejects(attempt({ insertLine: 3 }), /overlap your pending change/);
  await assert.rejects(attempt({ oldText: 'missing' }), /not found in a.txt including your pending changes/);
  await assert.rejects(attempt({ insertLine: 6 }), /between 1 and 5/);
  const { service: other } = setup({ 'a.txt': 'x\ny\nx\n' }); const otherRead = await other.read('a.txt');
  await assert.rejects(other.stageEdit({ path: 'a.txt', revision: otherRead.revision, text: 'q', oldText: 'x', explanation: '' }), /matches 2 places/);
  assert.equal(service.state.proposals.find(proposal => proposal.id === first.id).status, 'pending');
});

test('old_text keeps $ sequences literal and inserting after an unterminated last line adds a line break', async () => {
  const { backend, service } = setup({ 'a.txt': 'cost\nend' });
  const read = await service.read('a.txt');
  await service.stageEdit({ path: 'a.txt', revision: read.revision, text: "price = '$&$1'", oldText: 'cost', explanation: '' });
  await service.stageEdit({ path: 'a.txt', revision: read.revision, text: 'tail', insertLine: 3, explanation: '' });
  await service.apply(); assert.equal(backend.get('a.txt').text, "price = '$&$1'\nend\ntail");
});

test('a combined proposal lists each distinct explanation once', async () => {
  const { service } = setup({ 'a.txt': 'one\ntwo\nthree\nfour\n' });
  const read = await service.read('a.txt');
  const stage = (extra, explanation) => service.stageEdit({ path: 'a.txt', revision: read.revision, explanation, ...extra });
  await stage({ text: 'TWO', range: { startLine: 2, endLine: 2 } }, 'Fix casing');
  await stage({ text: 'ONE', oldText: 'one' }, 'Fix casing');
  await stage({ text: 'x', insertLine: 4 }, '');
  const last = await stage({ text: 'FOUR', oldText: 'four' }, 'Add marker');
  assert.equal(service.state.proposals.find(proposal => proposal.id === last.id).explanation, 'Fix casing\nAdd marker');
});

test('a whole-file proposal or a partly reviewed proposal is replaced and reported, not combined', async () => {
  const { service } = setup({ 'a.txt': 'a\nb\nc\n' });
  const read = await service.read('a.txt');
  const first = await service.stageEdit({ path: 'a.txt', revision: read.revision, text: 'A', range: { startLine: 1, endLine: 1 }, explanation: '' });
  const whole = await service.stageEdit({ path: 'a.txt', revision: read.revision, text: 'all new\n', explanation: '' });
  assert.deepEqual([whole.combined, whole.replaced], [false, [first.id]]);
  await service.reject(whole.id);
  const ranged = await service.stageEdit({ path: 'a.txt', revision: read.revision, text: 'A\nb\nC', range: { startLine: 1, endLine: 3 }, explanation: '' });
  await service.rejectHunk({ id: ranged.id, hunkId: service.state.proposals.find(proposal => proposal.id === ranged.id).hunks[0].id });
  const after = await service.stageEdit({ path: 'a.txt', revision: read.revision, text: 'B', range: { startLine: 2, endLine: 2 }, explanation: '' });
  assert.deepEqual([after.combined, after.replaced], [false, [ranged.id]]);
});

test('review messages count pending hunks across every open file', async () => {
  const { service } = setup();
  const a = await stage({ service, path: 'a.txt', text: 'new a\n' });
  await stage({ service, path: 'b.txt', text: 'new b\n' });
  const c = await stage({ service, path: 'c.txt', text: 'new c\n' });
  const hunk = id => service.state.proposals.find(proposal => proposal.id === id).hunks[0].id;
  await service.applyHunk({ id: a, hunkId: hunk(a) });
  assert.match(service.state.message, /^Accepted and saved this hunk\. Undo is available\. 2 hunk\(s\) in 2 file\(s\) still pending\.$/);
  await service.rejectHunk({ id: c, hunkId: hunk(c) });
  assert.match(service.state.message, /1 hunk\(s\) in 1 file\(s\) still pending\.$/);
  await service.apply();
  assert.match(service.state.message, /^Applied and saved 1 file\(s\)\. Undo is available\. No pending hunks remain\.$/);
});

test('save on approve: each approved edit is its own guarded batch, other reads stay valid, and Undo this request restores only this request', async () => {
  const { backend, service } = setup();
  service.beginRequest();
  const earlier = await stage({ service, path: 'c.txt', text: 'earlier c\n' });
  await service.apply(earlier);
  service.beginRequest(); // a new user request: only its own saves are offered for one-click undo
  const readB = await service.read('b.txt'); // read before a.txt is saved, used after
  const first = await stage({ service, path: 'a.txt', text: 'approved a\n' });
  await service.apply(first);
  const second = await service.stage({ path: 'b.txt', revision: readB.revision, text: 'approved b\n', explanation: 'Uses a read made before a.txt was saved' });
  await service.apply(second);
  assert.deepEqual([backend.get('a.txt').text, backend.get('b.txt').text], ['approved a\n', 'approved b\n']);
  assert.deepEqual(service.state.requestSaved, ['a.txt', 'b.txt'], 'Both files saved in this request are listed; c.txt from the earlier request is not.');
  await service.undoRequest();
  assert.deepEqual([backend.get('a.txt').text, backend.get('b.txt').text, backend.get('c.txt').text], ['old a\n', 'old b\n', 'earlier c\n'], 'Undo this request restores its files and keeps the earlier request.');
  assert.equal(service.state.requestSaved, undefined);
  await assert.rejects(service.undoRequest(), /Nothing saved in this request/u);
});

// Matcher tests from the team's opencode port (src/edits/match.ts, MIT; see THIRD_PARTY_NOTICES.md).
test('old_text matching tries exact, then typographic variants, then trailing whitespace', async () => {
  const { replaceMatched } = await import('../../out/edits/EditService.js');
  assert.deepEqual(replaceMatched({ source: 'a = 1\nb = 2\n', oldText: 'b = 2', newText: 'b = 3' }), { ok: true, text: 'a = 1\nb = 3\n', count: 1, tier: 'exact' });
  const quoted = replaceMatched({ source: 'say(“hello”)\n', oldText: 'say("hello")', newText: 'say("bye")' });
  assert.equal(quoted.ok && quoted.tier, 'normalized');
  assert.equal(quoted.ok && quoted.text, 'say("bye")\n');
  const trailing = replaceMatched({ source: 'if (x) {   \n  run();\n}\n', oldText: 'if (x) {\n  run();', newText: 'if (y) {\n  run();' });
  assert.equal(trailing.ok && trailing.tier, 'line-trim');
  assert.equal(trailing.ok && trailing.text, 'if (y) {\n  run();\n}\n');
  const ambiguous = replaceMatched({ source: 'let x = 1;\nuse(x);\nuse(x);\n', oldText: 'use(x);', newText: 'use(y);' });
  assert.deepEqual([ambiguous.ok, ambiguous.count], [false, 2], 'More than one match is still refused.');
});

test('a staged old_text edit tolerates trailing spaces, keeps CRLF, and a miss returns the closest numbered lines', async () => {
  const { backend, service } = setup({ 'w.py': 'def alpha():   \r\n    return 1\r\n\r\ndef beta():\r\n    return "$1"\r\n' });
  const read = await service.read('w.py');
  const id = await service.stageEdit({ path: 'w.py', revision: read.revision, oldText: 'def alpha():\n    return 1', text: 'def alpha():\n    return 2', explanation: 'Trailing spaces differ' });
  await service.apply(id.id);
  assert.equal(backend.get('w.py').text, 'def alpha():\r\n    return 2\r\n\r\ndef beta():\r\n    return "$1"\r\n', 'The match ignores trailing spaces and the file keeps CRLF and literal "$1".');
  const again = await service.read('w.py');
  await assert.rejects(service.stageEdit({ path: 'w.py', revision: again.revision, oldText: 'def beta():\n    return "$2"', text: 'def beta():\n    return 3', explanation: 'Wrong old text' }),
    /old_text was not found in w\.py\. Copy the exact current text, including indentation\.\nThe closest lines in the file:\n4: def beta\(\):/u);
  await assert.rejects(service.stageEdit({ path: 'w.py', revision: again.revision, oldText: 'def gone():\n    pass', text: 'def alpha():\n    return 2\n', explanation: 'Already applied' }), /may already be applied/u);
});

// File creation (ported with the team's tests from the opencode-aligned branch).
class CreatingBackend extends MemoryBackend {
  async missing(path) { return this.files.has(path) ? undefined : { path, realPath: `/workspace/${path}`, documentUri: `file:///workspace/${path}`, identity: `missing:${path}`, text: '', bytes: new Uint8Array(), version: 0, dirty: false, eol: '\n', missing: true }; }
  async create({ path, bytes }) {
    if (this.files.has(path)) return false;
    const text = Buffer.from(bytes).toString('utf8');
    this.files.set(path, { path, realPath: `/workspace/${path}`, documentUri: `file:///workspace/${path}`, identity: `file:${path}`, text, bytes: Buffer.from(bytes), version: 1, dirty: false, eol: text.includes('\r\n') ? '\r\n' : '\n' });
    return true;
  }
  async remove(snapshot) {
    const file = this.files.get(snapshot.path);
    if (!file || file.text !== snapshot.text || contentHash(file.bytes) !== contentHash(snapshot.bytes)) return false;
    this.files.delete(snapshot.path); return true;
  }
}
function creating(files) { const backend = new CreatingBackend(files); return { backend, service: new EditService({ backend, onChange() {} }) }; }

test('a staged new file is written only on apply, and undo removes it again', async () => {
  const { backend, service } = creating({ 'a.txt': 'a\n' });
  const { id } = await service.stageCreate({ path: 'docs/new.md', text: '# New\nbody\n', explanation: 'Add docs' });
  assert.equal(backend.files.has('docs/new.md'), false, 'Staging writes nothing.');
  assert.equal(service.state.proposals.find(proposal => proposal.id === id).change, 'create');
  await assert.rejects(service.stageCreate({ path: 'a.txt', text: 'x\n', explanation: 'Overwrite' }), /already exists/u, 'An existing file is never overwritten by a create.');
  await service.apply(id);
  assert.equal(backend.files.get('docs/new.md')?.text, '# New\nbody\n');
  await service.undo();
  assert.equal(backend.files.has('docs/new.md'), false);
});

test('an empty new file is reviewed as one empty hunk', async () => {
  const { backend, service } = creating({});
  const created = await service.stageCreate({ path: 'pkg/__init__.py', text: '', explanation: 'Mark the package' });
  const [hunk] = service.state.proposals.find(proposal => proposal.id === created.id).hunks;
  assert.deepEqual([hunk.oldLines, hunk.newLines, hunk.status], [0, 0, 'pending']);
  await service.applyHunk({ id: created.id, hunkId: hunk.id });
  assert.equal(backend.files.get('pkg/__init__.py')?.text, '');
});

test('a failed create rolls back the edits in the same batch', async () => {
  const { backend, service } = creating({ 'a.txt': 'one\n' });
  const read = await service.read('a.txt');
  await service.stageEdit({ path: 'a.txt', revision: read.revision, oldText: 'one', text: 'two', explanation: 'Edit' });
  await service.stageCreate({ path: 'b.txt', text: 'new\n', explanation: 'Create' });
  backend.create = async () => false;
  await assert.rejects(service.apply(), /restored/u);
  assert.equal(backend.get('a.txt').text, 'one\n');
  assert.equal(backend.files.has('b.txt'), false);
});

test('Undo this request removes a file created in it and restores edited files', async () => {
  const { backend, service } = creating({ 'cli.py': 'old\n' });
  service.beginRequest();
  const read = await service.read('cli.py');
  await service.apply((await service.stageEdit({ path: 'cli.py', revision: read.revision, oldText: 'old', text: 'new', explanation: 'Edit' })).id);
  await service.apply((await service.stageCreate({ path: 'tests/test_new.py', text: 'def test_x():\n    pass\n', explanation: 'Add a test' })).id);
  assert.deepEqual(service.state.requestSaved, ['cli.py', 'tests/test_new.py']);
  await service.undoRequest();
  assert.equal(backend.get('cli.py').text, 'old\n');
  assert.equal(backend.files.has('tests/test_new.py'), false);
});

test('an old_text edit may omit base_revision; line-based and whole-file edits still need it', async () => {
  const { backend, service } = setup({ 'a.txt': 'alpha\nbeta\n' });
  const { id } = await service.stageEdit({ path: 'a.txt', oldText: 'beta', text: 'BETA', explanation: 'No revision: the exact match proves the text is current' });
  await service.apply(id);
  assert.equal(backend.get('a.txt').text, 'alpha\nBETA\n');
  await assert.rejects(service.stageEdit({ path: 'a.txt', range: { startLine: 1, endLine: 1 }, text: 'x', explanation: 'Range without revision' }), /Pass base_revision from read_file/u);
  await assert.rejects(service.stageEdit({ path: 'a.txt', text: 'whole', explanation: 'Whole file without revision' }), /Only old_text edits can omit it/u);
  await assert.rejects(service.stageEdit({ path: 'a.txt', oldText: 'gone', text: 'x', explanation: 'Stale text' }), /old_text was not found/u, 'Without a revision, a stale old_text is still refused.');
});

test('a saved edit reports the saved lines with context, numbered as the file is now', async () => {
  const { savedExcerpt } = await import('../../out/edits/EditService.js');
  const before = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join('\n') + '\n';
  const after = before.replace('line 10\n', 'line 10\ninserted A\ninserted B\n').replace('line 25\n', 'changed 25\n');
  const excerpt = savedExcerpt(before, after);
  assert.equal(excerpt.firstLine, 11);
  assert.equal(excerpt.text, ['9: line 9', '10: line 10', '11: inserted A', '12: inserted B', '13: line 11', '14: line 12', '…', '25: line 23', '26: line 24', '27: changed 25', '28: line 26', '29: line 27'].join('\n'), 'Changed lines with two lines of context; a gap is marked; numbers follow the saved file.');
  const created = savedExcerpt('', 'a\nb\n');
  assert.deepEqual([created.firstLine, created.text], [1, '1: a\n2: b'], 'A new file shows all of its lines.');
  const big = savedExcerpt('', Array.from({ length: 500 }, (_, index) => `x${index}`).join('\n'));
  assert.ok(big.text.split('\n').length <= 61 && /… \d+ more changed or context line\(s\); read_file shows them$/u.test(big.text), 'A large change is cut to the limit and says so.');
});

test('after a save, only errors that are new are reported, even when lines moved', async () => {
  const { newProblems, describeProblems } = await import('../../out/edits/EditService.js');
  const before = [{ line: 10, message: '"itemgetter" is not defined', source: 'Pylance' }, { line: 40, message: 'Import "yaml" could not be resolved', source: 'Pylance' }];
  const after = [
    { line: 12, message: '"itemgetter" is not defined', source: 'Pylance' }, // existed before; the edit moved it down
    { line: 42, message: 'Import "yaml" could not be resolved', source: 'Pylance' },
    { line: 1118, message: 'Expected expression', source: 'Pylance' },
    { line: 30, message: '"itemgetter" is not defined', source: 'Pylance' }, // a second copy is new
  ];
  assert.deepEqual(newProblems(before, after).map(problem => problem.line), [1118, 30]);
  assert.equal(describeProblems('src/flask/cli.py', newProblems(before, after)),
    'New problems in src/flask/cli.py after saving (VS Code diagnostics):\n30: [Pylance] "itemgetter" is not defined\n1118: [Pylance] Expected expression\nFix these first; a test run would fail on them too.');
  assert.equal(describeProblems('a.py', []), '', 'No new errors, nothing added.');
  const many = Array.from({ length: 14 }, (_, index) => ({ line: index + 1, message: `problem ${index}\n  detail` }));
  const text = describeProblems('a.py', newProblems([], many));
  assert.match(text, /^1: problem 0 detail$/mu, 'Multi-line messages become one line.');
  assert.match(text, /\n… 4 more\n/u, 'At most ten problems are listed.');
});
