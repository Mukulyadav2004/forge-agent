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
