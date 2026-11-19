import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { EditService, contentHash, derivePatch, missHint, parsePatch, PatchParseError, replaceMatched } from '../../out/edits/EditService.js';

// The pure tool modules have no esbuild entry point of their own, so bundle them here.
let tools, folder;
before(async () => {
  folder = await mkdtemp(join(tmpdir(), 'forge-tools-'));
  const outfile = join(folder, 'tools.mjs');
  await build({
    stdin: { contents: ["export * from './src/tools/toolOutput';", "export * from './src/tools/readPage';", "export * from './src/tools/htmlMarkdown';", "export * from './src/tools/runCommand';"].join('\n'), resolveDir: process.cwd(), loader: 'ts' },
    bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent',
  });
  tools = await import(pathToFileURL(outfile).href);
});
after(async () => { if (folder) await rm(folder, { recursive: true, force: true }); });

test('old_text matching tries exact, then typographic variants, then trailing whitespace', () => {
  assert.deepEqual(replaceMatched({ source: 'a = 1\nb = 2\n', oldText: 'b = 2', newText: 'b = 3' }), { ok: true, text: 'a = 1\nb = 3\n', count: 1, tier: 'exact' });
  const quoted = replaceMatched({ source: 'say(\u201chello\u201d)\n', oldText: 'say("hello")', newText: 'say("bye")' });
  assert.equal(quoted.ok && quoted.tier, 'normalized');
  assert.equal(quoted.ok && quoted.text, 'say("bye")\n');
  const trailing = replaceMatched({ source: 'if (x) {   \n  run();\n}\n', oldText: 'if (x) {\n  run();', newText: 'if (y) {\n  run();' });
  assert.equal(trailing.ok && trailing.tier, 'line-trim');
  assert.equal(trailing.ok && trailing.text, 'if (y) {\n  run();\n}\n');
});

test('old_text must be unique unless replace_all is set', () => {
  const source = 'let x = 1;\nuse(x);\nuse(x);\n';
  const ambiguous = replaceMatched({ source, oldText: 'use(x);', newText: 'use(y);' });
  assert.deepEqual([ambiguous.ok, ambiguous.count], [false, 2]);
  const all = replaceMatched({ source, oldText: 'use(x);', newText: 'use(y);', replaceAll: true });
  assert.deepEqual(all.ok && [all.text, all.count], ['let x = 1;\nuse(y);\nuse(y);\n', 2]);
});

test('a miss explains itself with numbered nearby lines or an already-applied note', () => {
  const missed = replaceMatched({ source: 'function alpha() {\n  return 1;\n}\n', oldText: 'function alpha() {\n  return 2;\n}', newText: 'function alpha() {\n  return 3;\n}' });
  assert.equal(missed.ok, false);
  assert.match(missed.hint ?? '', /closest lines[\s\S]*1: function alpha\(\) \{/u);
  assert.match(missHint('const finished = computeTotal(items);\n', 'const done = total(items);', 'const finished = computeTotal(items);') ?? '', /already in the file/u);
});

test('the patch parser reads add, delete, update and move hunks', () => {
  const hunks = parsePatch([
    '*** Begin Patch',
    '*** Add File: docs/new.md', '+# Title', '+body',
    '*** Delete File: old.txt',
    '*** Update File: src/a.ts', '*** Move to: src/b.ts', '@@ function a', ' keep', '-old', '+new',
    '*** End Patch',
  ].join('\n'));
  assert.deepEqual(hunks.map(hunk => [hunk.type, hunk.path]), [['add', 'docs/new.md'], ['delete', 'old.txt'], ['update', 'src/a.ts']]);
  assert.equal(hunks[0].contents, '# Title\nbody', 'apply_patch adds the final line break when it stages the file.');
  assert.equal(hunks[2].movePath, 'src/b.ts');
  assert.deepEqual(hunks[2].chunks[0], { ...hunks[2].chunks[0], oldLines: ['keep', 'old'], newLines: ['keep', 'new'], changeContext: 'function a' });
  const heredoc = parsePatch("cat <<'EOF'\n*** Begin Patch\n*** Delete File: x\n*** End Patch\nEOF");
  assert.deepEqual(heredoc, [{ type: 'delete', path: 'x' }]);
  assert.throws(() => parsePatch('*** Begin Patch\n*** Frobnicate: x\n*** End Patch'), PatchParseError);
  assert.throws(() => parsePatch('no patch here'), /Begin Patch/u);
});

test('patch chunks apply by context and fail loudly when the context is missing', () => {
  const original = 'function a() {\n  const x = 1;\n  return x;\n}\n';
  const [hunk] = parsePatch('*** Begin Patch\n*** Update File: a.ts\n@@ function a() {\n   const x = 1;\n-  return x;\n+  return x + 1;\n*** End Patch');
  assert.equal(derivePatch('a.ts', hunk.chunks, original), 'function a() {\n  const x = 1;\n  return x + 1;\n}\n');
  const [stale] = parsePatch('*** Begin Patch\n*** Update File: a.ts\n-  return y;\n+  return z;\n*** End Patch');
  assert.throws(() => derivePatch('a.ts', stale.chunks, original), /a\.ts/u);
});

test('tool output is bounded to 2000 lines or 50 KiB with a narrowing hint', () => {
  const many = Array.from({ length: 3000 }, (_, index) => `line ${index + 1}`).join('\n');
  const lines = tools.boundText(many);
  assert.equal(lines.truncated, true);
  assert.equal(lines.shownLines, 2000);
  assert.match(lines.text, /line 2000\n[\s\S]*Output truncated[\s\S]*Narrow/u);
  assert.doesNotMatch(lines.text, /line 2001\n/u);
  const wide = tools.boundText('é'.repeat(80_000));
  assert.ok(Buffer.byteLength(wide.text) < tools.MAX_OUTPUT_BYTES + 1000 && wide.truncated);
  assert.deepEqual(tools.boundText('short'), { text: 'short', truncated: false, totalLines: 1, shownLines: 1 });
  const result = tools.boundToolResult({ content: [{ type: 'text', text: many }], structuredContent: { path: 'x', text: many.repeat(3) } });
  assert.match(result.content[0].text, /Output truncated/u);
  assert.equal(result.structuredContent.truncated, true);
  assert.equal(result.structuredContent.path, 'x');
});

test('truncated output is saved to a retained file that only the store resolves, as in opencode', async () => {
  const store = new tools.ToolOutputStore(join(folder, 'tool-output'));
  const many = Array.from({ length: 2500 }, (_, index) => `row ${index + 1}`).join('\n');
  const result = tools.boundToolResult({ content: [{ type: 'text', text: many }], structuredContent: { output: 'small' } }, store.save);
  const marker = /full output saved to (\S+)\. Read the rest with read_file on that path \(offset 2001 continues/u.exec(result.content[0].text);
  assert.ok(marker, result.content[0].text.slice(-400));
  const saved = marker[1];
  assert.equal(result.structuredContent.output_path, saved);
  assert.equal(await readFile(saved, 'utf8'), many, 'The whole text is saved.');
  assert.ok(store.resolve(saved) && store.resolve(saved.replace(/\\/gu, '/')), 'Either slash style resolves.');
  assert.equal(store.resolve(join(folder, 'tool-output', '..', 'tools.mjs')), undefined, 'Only saved outputs resolve.');
  assert.equal(store.resolve('tool_0123456789abcdef.txt'), undefined, 'A relative name is a workspace path, not a saved output.');
  const unsaved = tools.boundText(many, { save: () => ({ error: 'disk full' }) });
  assert.match(unsaved.text, /could not be saved \(disk full\)[\s\S]*Narrow the request/u);
  store.cleanup(Date.now() + tools.OUTPUT_RETENTION_MS + 1000);
  assert.equal(existsSync(saved), false, 'Saved outputs expire after the retention period.');
});

test('a command streams its full output to a file kept only when the inline output was shortened', async () => {
  const store = new tools.ToolOutputStore(join(folder, 'command-output'));
  const node = JSON.stringify(process.execPath);
  const longFile = store.newFile();
  const long = await tools.startCommand({ command: `${node} -e "for (let i = 0; i < 5000; i++) console.log('line ' + i)"`, cwd: folder, timeoutSeconds: 30, outputCharacters: 4096, outputFile: longFile }).result;
  assert.equal(long.output_truncated, true);
  assert.equal(long.output_path, longFile);
  assert.match(long.output, /is saved to [\s\S]*line 4999/u);
  assert.equal((await readFile(longFile, 'utf8')).split(/\r?\n/u).filter(Boolean).length, 5000);
  const shortFile = store.newFile();
  const short = await tools.startCommand({ command: `${node} -e "console.log('ok')"`, cwd: folder, timeoutSeconds: 30, outputCharacters: 4096, outputFile: shortFile }).result;
  assert.deepEqual([short.output.trim(), short.output_path, existsSync(shortFile)], ['ok', undefined, false]);
  const handle = tools.startCommand({ command: `${node} -e "setTimeout(() => {}, 30000)"`, cwd: folder, timeoutSeconds: 0, outputCharacters: 4096 });
  assert.equal(handle.isDone(), false, 'A timeout of 0 leaves the command running until it is stopped.');
  handle.stop('timeout');
  const stopped = await handle.result;
  assert.deepEqual([stopped.timed_out, stopped.cancelled], [true, false]);
});

test('read_file pages with offset and limit, hints the next offset and shows the tail past the end', () => {
  const text = Array.from({ length: 30 }, (_, index) => `row ${index + 1}`).join('\r\n') + '\r\n';
  const first = tools.pageText(text, { offset: 1, limit: 10 });
  assert.deepEqual([first.offset, first.lines.length, first.total, first.next, first.pastEnd], [1, 10, 30, 11, false]);
  assert.equal(first.lines[0], 'row 1', 'CR is dropped from lines.');
  assert.match(tools.renderTextPage('a.txt', first), /^Read file a\.txt, lines 1-10 of 30\n1: row 1[\s\S]*Continue reading with offset: 11\]$/u);
  const tail = tools.pageText(text, { offset: -5 });
  assert.deepEqual([tail.offset, tail.lines.at(-1), tail.next], [26, 'row 30', undefined]);
  const past = tools.pageText(text, { offset: 99, limit: 3 });
  assert.equal(past.pastEnd, true);
  assert.deepEqual(past.lines, ['row 28', 'row 29', 'row 30']);
  assert.match(tools.renderTextPage('a.txt', past, 99), /offset 99 is past the end; the file has 30 lines/u);
  const long = tools.pageText('x'.repeat(5000));
  assert.equal(long.clampedLines, 1);
  assert.match(long.lines[0], /line truncated to 2000 chars/u);
  assert.equal(tools.pageText(Array.from({ length: 2500 }, () => 'z').join('\n')).next, 2001, 'At most 2000 lines per call.');
});

test('directories list folders first and suggest similar names', () => {
  const page = tools.pageDirectory([{ name: 'b.ts', directory: false }, { name: 'src', directory: true }, { name: 'a.ts', directory: false }], { limit: 2 });
  assert.deepEqual([page.entries, page.total, page.next], [['src/', 'a.ts'], 3, 3]);
  assert.match(tools.renderDirectoryPage('.', page), /src\/[\s\S]*offset: 3/u);
  assert.ok(tools.similarNames(['EditService.ts', 'review.ts'], 'editservice.ts').includes('EditService.ts'));
});

test('HTML becomes markdown without scripts or styles', () => {
  const markdown = tools.convertHTMLToMarkdown('<html><head><title>T</title><style>p{}</style></head><body><h1>Title &amp; more</h1><script>alert(1)</script><p>Read <a href="https://x.test/doc">the <b>docs</b></a>.</p><ul><li>one</li><li>two</li></ul><pre><code>a &lt; b</code></pre></body></html>');
  assert.match(markdown, /^# Title & more/mu);
  assert.match(markdown, /\[the \*\*docs\*\*\]\(https:\/\/x\.test\/doc\)/u);
  assert.match(markdown, /^- one$/mu);
  assert.match(markdown, /a < b/u);
  assert.doesNotMatch(markdown, /alert|p\{\}/u);
  assert.equal(tools.extractTextFromHTML('<p>a</p><script>x()</script><p>b</p>').replace(/\s+/gu, ' ').trim(), 'a b');
});

/** In-memory files plus the optional missing/create/remove operations that new and deleted files need. */
class MemoryBackend {
  files = new Map(); backups = [];
  constructor(files) { for (const [path, text] of Object.entries(files)) this.put(path, text); }
  put(path, text) {
    const previous = this.files.get(path);
    this.files.set(path, { path, realPath: `/workspace/${path}`, documentUri: `file:///workspace/${path}`, identity: `file:${path}`, text, bytes: Buffer.from(text), version: (previous?.version ?? 0) + 1, dirty: false, eol: text.includes('\r\n') ? '\r\n' : '\n' });
  }
  async capture(path) { const file = this.files.get(path); if (!file) throw new Error('Missing file'); return { ...file, bytes: Uint8Array.from(file.bytes) }; }
  async missing(path) { return this.files.has(path) ? undefined : { path, realPath: `/workspace/${path}`, documentUri: `file:///workspace/${path}`, identity: `missing:${path}`, text: '', bytes: new Uint8Array(), version: 0, dirty: false, eol: '\n', missing: true }; }
  async create({ path, bytes }) { if (this.files.has(path)) return false; this.put(path, Buffer.from(bytes).toString('utf8')); return true; }
  async remove(snapshot) {
    const file = this.files.get(snapshot.path);
    if (!file || file.text !== snapshot.text || contentHash(file.bytes) !== contentHash(snapshot.bytes)) return false;
    this.files.delete(snapshot.path); return true;
  }
  async replace(changes) { for (const change of changes) Object.assign(this.files.get(change.before.path), { text: change.text, version: this.files.get(change.before.path).version + 1, dirty: true }); return true; }
  async save(path) { const file = this.files.get(path); file.bytes = Buffer.from(file.text); file.dirty = false; return true; }
  async backup(options) { this.backups.push(options); return `/snapshots/${options.id}.json`; }
  async preview() {}
  async closePreview() {}
}

test('a staged new file is created on apply and removed again by undo', async () => {
  const backend = new MemoryBackend({ 'a.txt': 'a\n' });
  const service = new EditService({ backend, onChange() {} });
  const { id } = await service.stageCreate({ path: 'docs/new.md', text: '# New\nbody\n', explanation: 'Add docs' });
  assert.equal(backend.files.has('docs/new.md'), false, 'Staging writes nothing.');
  await assert.rejects(service.stageCreate({ path: 'a.txt', text: 'x\n', explanation: 'Overwrite' }), /already exists/u);
  await service.apply(id);
  assert.equal(backend.files.get('docs/new.md')?.text, '# New\nbody\n');
  await service.undo();
  assert.equal(backend.files.has('docs/new.md'), false);
});

test('empty files can be created and deleted through review with one empty hunk', async () => {
  const backend = new MemoryBackend({ 'blank.txt': '' });
  const service = new EditService({ backend, onChange() {} });
  const created = await service.stageCreate({ path: 'pkg/__init__.py', text: '', explanation: 'Mark the package' });
  const [hunk] = service.state.proposals.find(proposal => proposal.id === created.id).hunks;
  assert.deepEqual([hunk.oldLines, hunk.newLines, hunk.status], [0, 0, 'pending']);
  await service.applyHunk({ id: created.id, hunkId: hunk.id });
  assert.equal(backend.files.get('pkg/__init__.py')?.text, '');
  assert.equal(service.state.proposals.find(proposal => proposal.id === created.id).status, 'applied');
  const read = await service.read('blank.txt');
  const deleted = await service.stageDelete({ path: 'blank.txt', revision: read.revision, explanation: 'Unused' });
  await service.apply(deleted.id);
  assert.equal(backend.files.has('blank.txt'), false);
  await service.undo();
  assert.equal(backend.files.get('blank.txt')?.text, '', 'Undo recreates the empty file.');
});

test('a staged deletion removes the file on apply and undo restores its bytes', async () => {
  const backend = new MemoryBackend({ 'old.txt': 'keep me\r\nplease\r\n' });
  const service = new EditService({ backend, onChange() {} });
  const read = await service.read('old.txt');
  const { id } = await service.stageDelete({ path: 'old.txt', revision: read.revision, explanation: 'Remove' });
  assert.equal(backend.files.has('old.txt'), true);
  await service.apply(id);
  assert.equal(backend.files.has('old.txt'), false);
  await service.undo();
  assert.equal(backend.files.get('old.txt')?.text, 'keep me\r\nplease\r\n');
});

test('replace_all and CRLF endings carry through propose_edit staging', async () => {
  const backend = new MemoryBackend({ 'w.ts': 'use(x);\r\nuse(x);\r\n' });
  const service = new EditService({ backend, onChange() {} });
  const read = await service.read('w.ts');
  await assert.rejects(service.stageEdit({ path: 'w.ts', revision: read.revision, oldText: 'use(x);', text: 'use(y);', explanation: 'Rename' }), /matches 2 places/u);
  const { id } = await service.stageEdit({ path: 'w.ts', revision: read.revision, oldText: 'use(x);\nuse(x);', text: 'use(y);\nuse(y);', replaceAll: true, explanation: 'Rename' });
  await service.apply(id);
  assert.equal(backend.files.get('w.ts')?.text, 'use(y);\r\nuse(y);\r\n');
});

test('a failed create rolls back the edits in the same batch', async () => {
  const backend = new MemoryBackend({ 'a.txt': 'one\n' });
  const service = new EditService({ backend, onChange() {} });
  const read = await service.read('a.txt');
  await service.stageEdit({ path: 'a.txt', revision: read.revision, oldText: 'one', text: 'two', explanation: 'Edit' });
  await service.stageCreate({ path: 'b.txt', text: 'new\n', explanation: 'Create' });
  backend.create = async () => false;
  await assert.rejects(service.apply(), /restored/u);
  assert.equal(backend.files.get('a.txt')?.text, 'one\n');
  assert.equal(backend.files.has('b.txt'), false);
});
