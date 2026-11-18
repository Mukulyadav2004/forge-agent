import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { agentSpec, ForgeSession } from '../../out/agent/ForgeSession.js';
import { environmentInstructions, estimateTokens, findGitRoot, globalInstructionFiles, loadProjectInstructions, modelIdentity, renderRestoredTranscript } from '../../out/context/projectContext.js';
import { latestTodos, pruneHistory, TaskHistory } from '../../out/sidebar/TaskHistory.js';

test('global AGENTS.md files load before the workspace walk, with ~/.claude/CLAUDE.md only as a fallback', async () => {
  const base = await mkdtemp(join(tmpdir(), 'forge-memory-'));
  try {
    const home = join(base, 'home');
    const repo = join(base, 'repo');
    await mkdir(join(home, '.config', 'forge-agent'), { recursive: true });
    await mkdir(join(home, '.config', 'opencode'), { recursive: true });
    await mkdir(join(home, '.claude'), { recursive: true });
    await mkdir(join(repo, '.git'), { recursive: true });
    await mkdir(join(repo, 'app'), { recursive: true });
    await writeFile(join(home, '.claude', 'CLAUDE.md'), 'claude global\n');
    assert.deepEqual(globalInstructionFiles(home, existsSync), [resolve(home, '.claude', 'CLAUDE.md')], 'With no global AGENTS.md, ~/.claude/CLAUDE.md stands in.');
    await writeFile(join(home, '.config', 'forge-agent', 'AGENTS.md'), 'forge global\n');
    await writeFile(join(home, '.config', 'opencode', 'AGENTS.md'), 'opencode global\n');
    assert.deepEqual(globalInstructionFiles(home, existsSync), [resolve(home, '.config', 'forge-agent', 'AGENTS.md'), resolve(home, '.config', 'opencode', 'AGENTS.md')]);
    await writeFile(join(repo, 'AGENTS.md'), 'repo rules\n');
    await writeFile(join(repo, 'app', 'CLAUDE.md'), 'app rules\n');
    const loaded = await loadProjectInstructions({ workspaceRoot: join(repo, 'app'), exists: existsSync, readFile: path => readFile(path, 'utf8'), home });
    const order = ['forge global', 'opencode global', 'repo rules', 'app rules'].map(text => loaded.text.indexOf(text));
    assert.ok(order.every(index => index >= 0), loaded.text);
    assert.deepEqual([...order].sort((a, b) => a - b), order, 'Global files come first, then the workspace from the git root inward.');
    assert.doesNotMatch(loaded.text, /claude global/u);
    assert.equal(loaded.files[0].path, '~/.config/forge-agent/AGENTS.md');
    const none = await loadProjectInstructions({ workspaceRoot: join(repo, 'app'), exists: existsSync, readFile: path => readFile(path, 'utf8'), home: null });
    assert.doesNotMatch(none.text, /forge global|opencode global/u);
    assert.equal(findGitRoot(join(repo, 'app'), existsSync), resolve(repo));
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('the system prompt carries the model identity, instructions and environment in OpenCode order', () => {
  const environment = environmentInstructions({ date: new Date(2026, 10, 19), workspaceRoot: '/work/app', gitRoot: '/work', platform: 'linux' });
  assert.match(environment, /Today's date: Thu Nov 19 2026/u);
  assert.match(environment, /<env>\n {2}Working directory: \/work\/app\n {2}Workspace root folder: \/work\n {2}Is directory a git repo: yes\n {2}Platform: linux\n<\/env>/u);
  assert.match(environmentInstructions({ date: new Date(), platform: 'win32' }), /Is directory a git repo: no/u);
  assert.equal(modelIdentity('openai/gpt-x'), '# Your Model\n- Name: openai/gpt-x\n- Provider ID: openai\n- Model ID: gpt-x');
  const spec = agentSpec({ model: 'openai/gpt-x', projectInstructions: 'PROJECT RULES', environment });
  const at = text => spec.instructions.lastIndexOf(text);
  assert.ok(spec.instructions.startsWith('You are Forge Agent'));
  assert.ok(at('You are Forge Agent') < at('# Your Model') && at('# Your Model') < at('PROJECT RULES') && at('PROJECT RULES') < at('<env>'));
});

test('a restored transcript keeps the newest ~15k tokens and clips long messages from the middle', () => {
  assert.equal(estimateTokens('abcd'.repeat(10)), 10);
  const messages = Array.from({ length: 60 }, (_, index) => ({ id: String(index), role: index % 2 ? 'assistant' : 'user', text: `message ${index} ${'x'.repeat(5_000)}` }));
  const transcript = renderRestoredTranscript(messages);
  assert.match(transcript, /message 59/u);
  assert.doesNotMatch(transcript, /message 0 /u);
  assert.match(transcript, /older messages omitted/u);
  assert.match(transcript, /characters omitted/u);
  assert.ok(estimateTokens(transcript) <= 15_500, 'The kept tail stays near the 15,000-token budget.');
  assert.equal(renderRestoredTranscript([]), '');
});

test('task history saves chats with their todo list, survives a reload and prunes the oldest beyond the limit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'forge-history-'));
  try {
    const task = (id, updatedAt, extra = {}) => ({ version: 1, id, title: `Task ${id}`, createdAt: updatedAt, updatedAt, messages: [{ id: 'm', role: 'user', text: `hello ${id}` }], activity: [], inspectedFiles: [], contextTokens: 10, contextWindow: 100, ...extra });
    const todos = [{ content: 'Write tests', status: 'in_progress' }];
    const history = new TaskHistory(directory, { maxTasks: 3, delayMs: 5 });
    await history.load();
    history.save(task('a', 1, { sessionId: 'session-a', lastGoodTurnId: 'turn-1', model: 'p/m', activity: [{ kind: 'todo', todos }, { kind: 'request' }] }));
    history.save(task('b', 2));
    history.save(task('c', 3));
    history.save(task('d', 4));
    assert.deepEqual(history.list().map(item => item.id), ['d', 'c', 'b'], 'Newest first; the oldest falls off past the limit.');
    await history.flush();
    assert.deepEqual((await readdir(join(directory, 'tasks'))).sort(), ['b.json', 'c.json', 'd.json']);
    history.save(task('a', 10, { sessionId: 'session-a', lastGoodTurnId: 'turn-1', activity: [{ kind: 'request' }], todos }));
    await history.flush();
    const reloaded = new TaskHistory(directory, { maxTasks: 3 });
    await reloaded.load();
    assert.deepEqual(reloaded.list().map(item => item.id), ['a', 'd', 'c']);
    const restored = await reloaded.get('a');
    assert.equal(restored.sessionId, 'session-a');
    assert.equal(restored.lastGoodTurnId, 'turn-1');
    assert.deepEqual(restored.todos, todos, 'The latest todo list is kept with the task.');
    assert.equal(await reloaded.get('../escape'), undefined);
    await reloaded.delete('d');
    assert.deepEqual(reloaded.list().map(item => item.id), ['a', 'c']);
    assert.ok(!existsSync(join(directory, 'tasks', 'd.json')));
    await writeFile(join(directory, 'index.json'), '{not json');
    const damaged = new TaskHistory(directory);
    await damaged.load();
    assert.deepEqual(damaged.list(), [], 'A damaged index starts an empty history instead of failing.');
  } finally { await rm(directory, { recursive: true, force: true }); }
  assert.deepEqual(pruneHistory([{ id: 'x', title: '', updatedAt: 1, messageCount: 0 }, { id: 'y', title: '', updatedAt: 2, messageCount: 0 }], 1), { kept: [{ id: 'y', title: '', updatedAt: 2, messageCount: 0 }], removed: ['x'] });
  assert.deepEqual(latestTodos([{ kind: 'todo', todos: [] }, { kind: 'todo', todos: [{ content: 'b', status: 'pending' }] }]), [{ content: 'b', status: 'pending' }]);
});

test('a reopened chat reattaches its TrueForge session, or starts a new one that is given the transcript', async () => {
  const requests = [];
  const known = new Set(['kept-session']);
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    requests.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null });
    const json = (status, value) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
    if (req.url === '/api/v1/models') return json(200, { data: [{ name: 'test/model', properties: { context_length: 200_000 } }] });
    if (req.url === '/api/v1/sessions' && req.method === 'POST') return json(200, { data: { id: 'new-session' } });
    const match = /^\/api\/v1\/sessions\/([^/]+)$/u.exec(req.url ?? '');
    if (match) return known.has(match[1]) ? json(200, { data: { id: match[1] } }) : json(404, { message: 'Session not found' });
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ type: 'turn.done', id: 'done', created_at: new Date().toISOString(), thread_id: null, state: { status: 'done', completed_at: new Date().toISOString(), output: null, required_actions: [] } })}\n\n`);
    res.end();
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const kept = new ForgeSession({ baseUrl, model: 'test/model', connector: '', workspaceRoot: process.cwd(), resume: { sessionId: 'kept-session', lastGoodTurnId: 'turn-7' }, restoredTranscript: 'EARLIER TALK', onEvent: () => undefined });
    await kept.send([{ type: 'user.message', content: 'continue' }]);
    assert.equal(kept.id, 'kept-session');
    assert.equal(kept.resumed, 'attached');
    const patch = requests.find(request => request.method === 'PATCH');
    assert.equal(patch.url, '/api/v1/sessions/kept-session', 'The saved session gets this window\'s spec.');
    assert.match(patch.body.agent.spec.instructions, /<env>[\s\S]*Platform:/u);
    assert.equal(patch.body.agent.spec.config.context_management.compaction.trigger.value, 170_000, '200k window minus 15%.');
    const keptTurn = requests.find(request => request.url === '/api/v1/sessions/kept-session/turns');
    assert.deepEqual(keptTurn.body.input.map(event => event.content), ['continue'], 'A reattached session already has the conversation.');
    assert.ok(!requests.some(request => request.url === '/api/v1/sessions' && request.method === 'POST'));

    const lost = new ForgeSession({ baseUrl, model: 'test/model', connector: '', resume: { sessionId: 'gone-session' }, restoredTranscript: 'EARLIER TALK', onEvent: () => undefined });
    await lost.send([{ type: 'user.message', content: 'continue' }]);
    assert.equal(lost.id, 'new-session');
    assert.equal(lost.resumed, 'lost');
    const lostTurn = requests.find(request => request.url === '/api/v1/sessions/new-session/turns');
    assert.deepEqual(lostTurn.body.input.map(event => event.content), ['EARLIER TALK', 'continue']);
    await lost.send([{ type: 'user.message', content: 'next' }]);
    assert.deepEqual(requests.filter(request => request.url === '/api/v1/sessions/new-session/turns').at(-1).body.input.map(event => event.content), ['next'], 'The transcript is sent once.');
  } finally { server.closeAllConnections(); await new Promise(done => server.close(done)); }
});
