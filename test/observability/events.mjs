import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, readFile, readdir, rm, stat, writeFile, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { ForgeSession } from '../../out/agent/ForgeSession.js';

const compiled = await mkdtemp(join(tmpdir(), 'forge-log-tests-'));
after(() => rm(compiled, { recursive: true, force: true }));
await build({ entryPoints: ['src/observability/events.ts'], outfile: join(compiled, 'events.mjs'), bundle: true, platform: 'node', format: 'esm' });
const { ToolLog, summarizeTools, SessionTrace, summarizeTask } = await import(pathToFileURL(join(compiled, 'events.mjs')).href);

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

const turnCreated = id => ({ type: 'turn.created', id: `event-${id}`, turnId: id });
const turnDone = (metrics, status = 'done') => ({ type: 'turn.done', state: { status, metrics } });
const reportedUsage = { inputTokens: 10, outputTokens: 3, inputTokensBreakdown: { harness: 2, instructions: 2, messages: 2, skills: 2, toolDefinitions: 2 } };

test('session rows join real IDs, measure first visible text once, and preserve redaction', async t => {
  let now = 100;
  t.mock.method(performance, 'now', () => now);
  const { log } = await fixture(t);
  const trace = new SessionTrace({ model: 'test/model', sink: event => log.recordSession(event) });
  trace.begin(); trace.created('server-session'); trace.stream(turnCreated('server-turn'));
  trace.stream({ type: 'model.message.delta', id: 'child', threadId: 'child', content: 'private-child-text' });
  trace.stream({ type: 'model.message.delta', id: 'main', threadId: 'main', content: '', reasoningContent: 'private-reasoning' });
  now = 140;
  trace.stream({ type: 'model.message.delta', id: 'main', threadId: 'main', content: 'private-model-reply', usage: reportedUsage });
  now = 155;
  trace.stream({ type: 'model.message.delta', id: 'main', threadId: 'main', content: 'private-next-chunk' });
  trace.stream({ type: 'user.tool_approval', toolCallId: 'server-call', approval: { status: 'deny', reason: 'private-denial-reason' } });
  trace.stream({ type: 'tool.response', toolCallId: 'server-call', content: 'Bearer dummy-session-token' });
  now = 200;
  trace.stream(turnDone({ totalTokens: 29, totalCostInUsd: 0.002, rawReply: 'private-usage-extra' }));
  trace.stream(turnDone({ totalTokens: 29, totalCostInUsd: 0.002 })); trace.finish();
  await log.tool({ name: 'read_file', input: { path: 'src/example.ts' }, run: async () => ({ content: [{ type: 'text', text: 'private-tool-result' }] }) });
  const text = await readFile(await log.flush(), 'utf8');
  for (const secret of ['private-', 'Bearer', 'dummy-session-token', 'reasoningContent', 'rawReply']) assert.ok(!text.includes(secret));
  const rows = text.trim().split('\n').map(line => JSON.parse(line));
  const ends = rows.filter(row => row.event === 'turn.end');
  assert.equal(ends.length, 1);
  assert.equal(ends[0].firstTextMs, 40);
  assert.equal(ends[0].durationMs, 100);
  assert.equal(ends[0].turnId, 'server-turn');
  assert.equal(ends[0].taskId, 'server-session');
  assert.equal(ends[0].sessionId, 'server-session');
  assert.equal(rows.find(row => row.event === 'approval.decision').toolCallId, 'server-call');
  assert.equal(rows.find(row => row.event === 'approval.decision').outcome, 'deny');
  assert.equal(rows.find(row => row.event === 'tool.response').toolCallId, 'server-call');
  assert.equal(rows.some(row => row.event === 'session.end'), false);
  assert.equal(rows.filter(row => row.event === 'tool.call')[0].taskId, null, 'Do not guess a join from timing');
  assert.equal((await log.summary()).tools.read_file.calls, 1, 'SDK responses must not count as MCP executions');
  const summary = await log.summary('server-session');
  assert.equal(summary.tokens, 29);
  assert.equal(summary.cost, 0.002);
  assert.equal(summary.tools, 'not available');
  assert.equal(summary.turns[0].firstTextMs, 40);
});

test('model usage is deduplicated by message ID, turn totals take precedence, and missing usage stays unavailable', async t => {
  const { log } = await fixture(t);
  const trace = new SessionTrace({ model: 'test/model', sink: event => log.recordSession(event) });
  trace.begin(); trace.created('usage-session'); trace.stream(turnCreated('usage-1'));
  trace.stream({ type: 'model.message.delta', id: 'message-1', threadId: 'main', usage: reportedUsage });
  trace.stream({ type: 'model.message', id: 'message-1', threadId: 'main', usage: reportedUsage });
  trace.stream(turnDone({ totalCostInUsd: 0 })); trace.finish();
  assert.equal((await log.summary('usage-session')).tokens, 13);
  assert.equal((await log.summary('usage-session')).cost, 0, 'Reported zero is available');
  trace.begin(); trace.stream(turnCreated('usage-2'));
  trace.stream({ type: 'model.message', id: 'message-2', threadId: 'main', content: 'full non-streamed message', usage: reportedUsage });
  trace.stream(turnDone({ totalInputTokens: 30, totalOutputTokens: 5, totalTokens: 35 })); trace.finish();
  let summary = await log.summary('usage-session');
  assert.equal(summary.tokens, 48);
  assert.equal(summary.cost, 'not available', 'Do not total a partial cost report');
  assert.equal(summary.turns[1].firstTextMs, 'not available', 'A full message is not proof of streamed text');
  trace.begin(); trace.stream(turnCreated('usage-3')); trace.stream(turnDone()); trace.finish();
  summary = await log.summary('usage-session');
  assert.equal(summary.tokens, 'not available');
  assert.equal(summary.turns[2].usage, 'not available');
});

test('partially reported model usage is not presented as the complete turn total', async t => {
  const { log } = await fixture(t);
  const trace = new SessionTrace({ model: 'test/model', sink: event => log.recordSession(event) });
  trace.begin(); trace.created('partial'); trace.stream(turnCreated('partial-turn'));
  trace.stream({ type: 'model.message', id: 'known', threadId: 'main', usage: reportedUsage });
  trace.stream({ type: 'model.message', id: 'unknown', threadId: 'main' });
  trace.stream(turnDone()); trace.finish();
  assert.equal((await log.summary('partial')).tokens, 'not available');
});

test('cancellation completion retains the originating turn and does not invent a server terminal state', async t => {
  const { log } = await fixture(t);
  const trace = new SessionTrace({ model: 'test/model', sink: event => log.recordSession(event) });
  trace.begin(); trace.created('cancel-session'); trace.stream(turnCreated('old-turn'));
  const complete = trace.cancellation();
  trace.finish();
  trace.begin(); trace.stream(turnCreated('new-turn')); complete('accepted');
  trace.stream(turnDone(undefined, 'cancelled')); trace.finish();
  const summary = await log.summary('cancel-session');
  assert.deepEqual(summary.turns.map(turn => turn.outcome), ['incomplete', 'cancelled']);
  assert.equal(summary.cancels, 1);
  assert.deepEqual(summary.errorsByType, { IncompleteStream: 1 });
  const rows = (await readFile(await log.flush(), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(rows.find(row => row.event === 'turn.cancel').turnId, 'old-turn');
  assert.equal(rows.find(row => row.event === 'turn.cancel').outcome, 'accepted');
});

test('pre-session failures keep null IDs and unsafe model metadata is omitted', async t => {
  const { log } = await fixture(t);
  const trace = new SessionTrace({ model: 'provider/model?api_key=dummy-private-key', sink: event => log.recordSession(event) });
  trace.begin(); trace.fail(); trace.finish();
  const text = await readFile(await log.flush(), 'utf8');
  assert.ok(!text.includes('dummy-private-key'));
  const rows = text.trim().split('\n').map(line => JSON.parse(line));
  assert.ok(rows.every(row => row.taskId === null && row.sessionId === undefined && row.turnId === undefined));
  assert.equal(rows.filter(row => row.event === 'error').length, 1);
  assert.equal(rows.find(row => row.event === 'error').errorType, 'RequestError');
  assert.equal(rows.find(row => row.event === 'model.config').model, undefined);
  assert.equal(summarizeTask({ jsonl: text, taskId: 'missing' }).tokens, 'not available');
});

test('SDK boundary writes lifecycle, approval, cancellation and safe failures to the real JSONL sink', async t => {
  const { log } = await fixture(t);
  const oldObserver = ForgeSession.observe;
  ForgeSession.observe = event => log.recordSession(event);
  t.after(() => { ForgeSession.observe = oldObserver; });
  const secret = 'dummy-private-sdk-prompt-reply-and-key';
  let mode = 'success', turns = 0;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    if (mode === 'reject') { res.writeHead(401, { 'Content-Type': 'application/json' }).end(JSON.stringify({ message: secret })); return; }
    if (req.url === '/api/v1/sessions') { res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: { id: 'sdk-session' } })); return; }
    if (req.url.endsWith('/cancel')) { res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}'); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const stamp = new Date().toISOString();
    const write = event => res.write(`data: ${JSON.stringify({ created_at: stamp, thread_id: null, ...event })}\n\n`);
    write({ type: 'turn.created', id: `created-${++turns}`, turn_id: `sdk-turn-${turns}`, previous_turn_id: turns === 1 ? null : `sdk-turn-${turns - 1}`, state: { status: 'running' } });
    if (body.input?.[0]?.type === 'user.tool_approval') write({ type: 'user.tool_approval', id: 'approved', thread_id: 'main', tool_call_id: body.input[0].tool_call_id, approval: body.input[0].approval });
    write({ type: 'model.message.delta', id: `message-${turns}`, thread_id: 'main', content: secret });
    write({ type: 'tool.response', id: `result-${turns}`, thread_id: 'main', tool_call_id: 'sdk-call', content: secret });
    const state = mode === 'error' ? { status: 'error', completed_at: stamp, message: secret } : { status: 'done', completed_at: stamp, output: null, required_actions: [], metrics: { total_tokens: 8, total_cost_in_usd: 0.001 } };
    write({ type: 'turn.done', id: `done-${turns}`, state }); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const delivered = [];
  const session = new ForgeSession({ baseUrl: `http://127.0.0.1:${address.port}`, model: 'test/model', connector: '', onEvent: event => delivered.push(event) });
  await session.send([{ type: 'user.message', content: secret }]);
  await session.send([{ type: 'user.tool_approval', threadId: 'main', toolCallId: 'sdk-call', approval: { status: 'allow' } }]);
  await session.cancel();
  assert.equal((await log.summary('sdk-session')).tokens, 16);
  assert.ok(delivered.some(event => event.type === 'model.message.delta' && event.content === secret), 'Logging must preserve streaming to the UI');
  mode = 'error'; await session.send([{ type: 'user.message', content: secret }]);
  mode = 'reject'; await assert.rejects(session.send([{ type: 'user.message', content: secret }]));
  await assert.rejects(session.cancel());
  const text = await readFile(await log.flush(), 'utf8');
  assert.ok(!text.includes(secret));
  const rows = text.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(rows.filter(row => row.event === 'session.start').length, 1);
  assert.equal(rows.filter(row => row.event === 'turn.send').length, 4);
  assert.equal(rows.filter(row => row.event === 'approval.decision').length, 1);
  assert.equal(rows.find(row => row.event === 'approval.decision').toolCallId, 'sdk-call');
  assert.equal(rows.find(row => row.event === 'turn.cancel' && row.outcome === 'accepted').turnId, undefined, 'Idle cancellation must not target a completed turn');
  assert.equal(rows.filter(row => row.event === 'turn.end').at(-1).turnId, undefined, 'A rejected request must not retain the previous turn ID');
  const summary = await log.summary('sdk-session');
  assert.equal(summary.cancels, 2);
  assert.equal(summary.turns.length, 4);
  assert.deepEqual(summary.errorsByType, { TurnError: 1, RequestError: 1, CancelError: 1 });
  assert.equal(summary.tokens, 'not available');
});
