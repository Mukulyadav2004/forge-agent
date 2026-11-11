import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, readFile, readdir, rm, stat, writeFile, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const compiled = await mkdtemp(join(tmpdir(), 'forge-log-tests-'));
after(() => rm(compiled, { recursive: true, force: true }));
await build({ entryPoints: ['src/observability/events.ts'], outfile: join(compiled, 'events.mjs'), bundle: true, platform: 'node', format: 'esm' });
const { ToolLog, summarizeTools } = await import(pathToFileURL(join(compiled, 'events.mjs')).href);

async function fixture(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'forge-log-fixture-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const failures = [];
  const log = new ToolLog({ directory, resolvePath: async path => path, onFailure: () => failures.push(true), ...overrides });
  return { log, directory, failures };
}

test('JSONL stores only allowed metadata, never payloads, credentials, queries or raw errors', async t => {
  const secrets = ['Bearer dummy-bearer-123', 'dummy-api-key-456', 'dummy-header-789', 'private-source-body', 'private-prompt', 'private-model-reply'];
  const sensitive = secrets.join('\n');
  const error = new Error(sensitive, { cause: new Error(sensitive) });
  error.name = sensitive;
  const { log, failures } = await fixture(t, { resolvePath: async path => {
    if (path !== 'src/example.ts') throw error;
    return path;
  } });
  const input = { path: 'src/example.ts', query: sensitive, new_text: sensitive, explanation: sensitive, prompt: sensitive, headers: { Authorization: secrets[0] } };
  const response = { content: [{ type: 'text', text: sensitive }], structuredContent: { path: 'src/example.ts', text: sensitive, truncated: true } };
  assert.equal(await log.tool({ name: 'read_file', input, run: async () => response }), response);
  await assert.rejects(log.tool({ name: 'search_code', input: { query: sensitive }, run: async () => { throw error; } }), caught => caught === error);
  await assert.rejects(log.tool({ name: 'read_file', input: { path: '.env.private-secret' }, run: async () => { assert.fail('Refused path reached its handler'); } }), caught => caught === error);
  const path = await log.flush();
  const text = await readFile(path, 'utf8');
  for (const secret of [...secrets, '.env.private-secret', 'Authorization']) assert.ok(!text.includes(secret), secret);
  const rows = text.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(rows.length, 3);
  assert.equal(rows[0].resultChars, JSON.stringify(response.structuredContent).length, 'Do not count structured + text copies twice');
  assert.equal(rows[0].queryChars, sensitive.length);
  assert.equal(rows[0].truncated, true);
  assert.equal(rows[1].errorType, 'ToolError');
  assert.equal(rows[1].message, 'Tool failed; details omitted.');
  assert.equal(rows[2].outcome, 'refused');
  assert.equal(rows[2].pathRefused, true);
  assert.equal(rows[2].path, undefined);
  for (const row of rows) {
    assert.equal(row.taskId, null);
    assert.equal(row.event, 'tool.call');
    assert.equal(row.toolCallId, undefined);
    assert.equal(row.sessionId, undefined);
    assert.ok(row.durationMs >= 0);
    assert.ok(Number.isFinite(Date.parse(row.ts)));
    assert.deepEqual(Object.keys(row).filter(key => !['ts', 'taskId', 'event', 'name', 'outcome', 'durationMs', 'resultChars', 'path', 'pathRefused', 'queryChars', 'truncated', 'errorType', 'message'].includes(key)), []);
  }
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await stat(dirname(path))).mode & 0o777, 0o700);
  assert.deepEqual(failures, []);
});

test('summary counts completed calls once, includes failures and deduplicates successful paths', async t => {
  const { log } = await fixture(t);
  const textResult = { content: [{ type: 'text', text: 'abc' }, { type: 'text', text: 'de' }] };
  const failed = { content: [{ type: 'text', text: 'failure' }], isError: true };
  await Promise.all(Array.from({ length: 12 }, () => log.tool({ name: 'read_file', input: { path: 'src/example.ts' }, run: async () => textResult })));
  await log.tool({ name: 'propose_edit', input: { path: 'src/example.ts' }, run: async () => textResult });
  assert.equal(await log.tool({ name: 'read_file', input: { path: 'failed.txt' }, run: async () => failed }), failed);
  const abort = new Error('private cancellation detail');
  const controller = new AbortController();
  await assert.rejects(log.tool({ name: 'search_code', input: {}, signal: controller.signal, run: async () => { controller.abort(); throw abort; } }), caught => caught === abort);
  const summary = await log.summary();
  assert.equal(summary.scope, 'unjoined_tool_calls');
  assert.equal(summary.taskId, null);
  assert.equal(summary.tools.read_file.calls, 13);
  assert.equal(summary.tools.read_file.resultChars, 67);
  assert.equal(summary.tools.propose_edit.calls, 1);
  assert.deepEqual(summary.filesRead, ['src/example.ts']);
  assert.deepEqual(summary.filesProposed, ['src/example.ts']);
  assert.deepEqual(summary.errorsByType, { ToolError: 1, AbortError: 1 });
  assert.equal(summary.tokens, 'not available');
  assert.equal(summary.cost, 'not available');
  assert.throws(() => summarizeTools('{"incomplete":'), SyntaxError);
});

test('only validated relative paths reach the log, including canonical aliases', async t => {
  const resolvedPaths = ['/private/outside', '../outside', 'C:\\private', 'https://private', 'line\nbreak', 'x'.repeat(501), 'src/canonical.ts'];
  const { log } = await fixture(t, { resolvePath: async () => resolvedPaths.shift() });
  for (let i = 0; i < 7; i++) await log.tool({ name: 'read_file', input: { path: 'alias.txt' }, run: async () => ({ content: [] }) });
  const rows = (await readFile(await log.flush(), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.ok(rows.slice(0, 6).every(row => row.path === undefined));
  assert.equal(rows[6].path, 'src/canonical.ts');
});

test('storage creation failure warns once and preserves tool results and original errors', async t => {
  const { directory } = await fixture(t);
  const unavailable = join(directory, 'occupied');
  await writeFile(unavailable, 'fixture');
  const failures = [];
  const log = new ToolLog({ directory: unavailable, resolvePath: async path => path, onFailure: () => failures.push(true) });
  const response = { content: [] };
  assert.equal(await log.tool({ name: 'list_files', input: {}, run: async () => response }), response);
  const original = new Error('private failure');
  await assert.rejects(log.tool({ name: 'list_files', input: {}, run: async () => { throw original; } }), error => error === original);
  await assert.rejects(log.flush(), /incomplete or unavailable/);
  assert.deepEqual(failures, [true]);
});

test('append failures mark measurements incomplete without failing the tool', async t => {
  const { log, failures } = await fixture(t);
  const path = await log.flush();
  await rm(path);
  await mkdir(path);
  const response = { content: [{ type: 'text', text: 'result' }] };
  assert.equal(await log.tool({ name: 'list_files', input: {}, run: async () => response }), response);
  await assert.rejects(log.summary(), /incomplete or unavailable/);
  assert.deepEqual(failures, [true]);
});

test('disabled storage writes no log and does not block tools', async t => {
  const { log, directory, failures } = await fixture(t, { directory: undefined });
  await log.tool({ name: 'list_files', input: {}, run: async () => ({ content: [] }) });
  await assert.rejects(log.flush(), /incomplete or unavailable/);
  assert.deepEqual(await readdir(directory), []);
  assert.deepEqual(failures, [true]);
});

test('storage resolving into a workspace through a symlink is refused', async t => {
  const { directory } = await fixture(t);
  const workspace = join(directory, 'workspace'), alias = join(directory, 'alias');
  await mkdir(workspace);
  await symlink(workspace, alias);
  const log = new ToolLog({ directory: alias, workspaceRoots: [workspace], resolvePath: async path => path, onFailure: () => undefined });
  await log.tool({ name: 'list_files', input: {}, run: async () => ({ content: [] }) });
  await assert.rejects(log.flush(), /incomplete or unavailable/);
  assert.deepEqual(await readdir(workspace), []);
});
