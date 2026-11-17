import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { agentSpec, classifyModelError, ForgeSession, listModelNames } from '../out/agent/ForgeSession.js';
import { readFileSync } from 'node:fs';
import { buildProjectContext, isArchitectureRequest } from '../out/context/projectContext.js';
import { describeApproval, StreamedToolCalls } from '../out/agent/approvalText.js';
import './sidebar/feedback.mjs';
import './observability/events.mjs';

test('architecture context is bounded and includes implementations across directories', async () => {
  assert.equal(isArchitectureRequest('now make an arctecture mao out of it'), true);
  assert.equal(isArchitectureRequest('hi'), false);
  const paths = ['main.py', 'test_main.py', '.env', 'app/service.py', 'data/store.py', 'worker/run.py'];
  const context = await buildProjectContext({ paths, readFile: async path => `${path}\nclass Component:\n    def run(self):\n        pass\n`.repeat(5000) });
  assert.ok(context.text.length <= 64000);
  assert.ok(context.files.length >= 3);
  assert.ok(context.files.every(file => file.origin === 'context' && file.path !== 'test_main.py' && file.path !== '.env'));
  assert.equal(context.files[0].path, 'main.py');
});

test('approval prompts name the file, change and reason from the tool call arguments', () => {
  const call = (args) => ({ name: 'propose_edit', arguments: JSON.stringify({ path: 'src/flask/cli.py', base_revision: 'r', explanation: 'Register the config command', ...args }) });
  const ranged = describeApproval(call({ new_text: 'a\nb\n', start_line: 10, end_line: 12 }));
  assert.match(ranged, /File: `src\/flask\/cli\.py`/u);
  assert.match(ranged, /replace lines 10–12 with 2 line\(s\)/u);
  assert.match(ranged, /Agent's reason: Register the config command/u);
  assert.match(ranged, /Nothing is written until you accept it/u);
  assert.match(describeApproval(call({ new_text: 'x', insert_line: 4 })), /insert 1 line\(s\) at line 4/u);
  assert.match(describeApproval(call({ new_text: 'X\n', old_text: 'x\ny\n' })), /replace one matched passage of 2 line\(s\) with 1 line\(s\)/u);
  assert.match(describeApproval(call({ new_text: '' })), /replace the whole file \(0 line\(s\)\)/u);
  assert.match(describeApproval(call({ new_text: 'x', explanation: 'y'.repeat(400) })), /y{300}…/u);
  assert.match(describeApproval({ name: 'other_tool', arguments: '{"value":"rm `x`"}' }), /Approve `other_tool`\?[\s\S]*rm 'x'/u);
  assert.match(describeApproval({ name: 'propose_edit', arguments: 'not json' }), /Approve `propose_edit`/u);
  assert.match(describeApproval(undefined), /details were not received/u);
  const command = describeApproval({ name: 'run_command', arguments: JSON.stringify({ command: 'python -m pytest tests/test_cli.py -q', cwd: '.', timeout_seconds: 120, reason: 'Run the CLI tests' }) });
  assert.match(command, /```sh\npython -m pytest tests\/test_cli\.py -q\n```/u, 'The exact command is shown in full.');
  assert.match(command, /Folder: `\.`[\s\S]*Stops after: 120 s[\s\S]*Run the CLI tests[\s\S]*Forge cannot undo/u);
  assert.match(describeApproval({ name: 'run_command', arguments: JSON.stringify({ command: 'echo ```x```' }) }), /````sh\necho ```x```\n````/u, 'Backticks in a command cannot break out of its block.');
  assert.doesNotMatch(ranged, /will refuse/u);
  const shown = describeApproval(call({ old_text: '    return bool(val)\n', new_text: '    # off and n are false\n    return bool(val and val.lower() not in FALSE)\n' }));
  assert.match(shown, /Proposed change:\n\n```diff\n-     return bool\(val\)\n\+     # off and n are false\n\+     return bool\(val and/u, 'The approval shows the exact lines removed and added.');
  assert.match(describeApproval(call({ new_text: 'a\nb\n', start_line: 28, end_line: 33 })), /Lines 28–33 become:\n\n```diff\n\+ a\n\+ b\n```/u);
  const long = describeApproval(call({ new_text: Array.from({ length: 60 }, (_, index) => `line ${index}`).join('\n') }));
  assert.match(long, /\+ line 39\n… 20 more line\(s\) not shown/u);
  assert.doesNotMatch(long, /line 40\b/u, 'The preview is bounded to 40 lines.');
  assert.match(describeApproval(call({ old_text: 'x', new_text: 'use ```code```' })), /````diff[\s\S]*use ```code```[\s\S]*````/u, 'Backticks in code cannot break out of the block.');
  const located = describeApproval(call({ new_text: 'x', old_text: 'y', start_line: 2, end_line: 2, insert_line: 3 }));
  assert.match(located, /replace one matched passage/u);
  assert.doesNotMatch(located, /will refuse/u, 'old_text alone locates the change; line numbers sent with it are ignored.');
  assert.match(describeApproval(call({ new_text: 'x', start_line: 2, end_line: 2, insert_line: 3 })), /editor will refuse this call:\*\* it asks both to replace lines and to insert/u);
  assert.match(describeApproval(call({ new_text: 'x', end_line: 2 })), /editor will refuse this call:\*\* it gives only one of start_line and end_line/u);
});

test('streamed tool call deltas are rebuilt for the approval that names them', () => {
  // Shapes captured from a live TrueForge 0.185.1 stream: the first delta names the call, a later one carries arguments.
  const calls = new StreamedToolCalls();
  calls.add('msg-1', [{ index: 0, id: 'call_1', type: 'function', function: { name: 'propose_edit', arguments: '' } }]);
  calls.add('msg-1', [{ index: 0, function: { arguments: '{"path":"src/a.py","new_text":"x\\n",' } }]);
  calls.add('msg-1', [{ index: 0, function: { arguments: '"insert_line":3,"explanation":"Add x"}' } }]);
  calls.add('msg-2', [{ index: 0, id: 'call_2', function: { name: 'read_file', arguments: '{}' } }]);
  assert.deepEqual(calls.find('msg-1', 'call_1'), { name: 'propose_edit', arguments: '{"path":"src/a.py","new_text":"x\\n","insert_line":3,"explanation":"Add x"}' });
  assert.match(describeApproval(calls.find('msg-1', 'call_1')), /File: `src\/a\.py`[\s\S]*insert 1 line\(s\) at line 3[\s\S]*Add x/u);
  assert.equal(calls.find('msg-2', 'call_1'), undefined, 'A call id must match the message that produced it.');
  calls.clear();
  assert.equal(calls.find('msg-1', 'call_1'), undefined);
});

test('the agent definition file is what TrueForge receives', () => {
  const definition = JSON.parse(readFileSync(new URL('../src/agent/forge-agent.json', import.meta.url), 'utf8'));
  const spec = agentSpec({ model: 'test/model', connector: 'forge-editor-abc', reasoningEffort: 'low' });
  assert.deepEqual(spec.config, definition.config);
  assert.deepEqual(spec.mcpServers, [{ name: 'forge-editor-abc', ...definition.editorServer }]);
  assert.deepEqual(spec.model, { name: 'test/model', params: { reasoningEffort: 'low' } });
  assert.ok(spec.instructions.startsWith('You are Forge Agent'));
  assert.deepEqual(definition.editorServer.requireApprovalForTools, ['propose_edit', 'run_command'], 'Every tool that writes or runs needs approval.');
  assert.deepEqual(definition.config.contextManagement.compaction, { enabled: true, trigger: { type: 'input_tokens', value: 32000 } }, 'TrueForge\'s default threshold (80% of a 1M-token window) would never fire; ours is explicit.');
  assert.deepEqual(agentSpec({ model: 'test/model' }).mcpServers, []);
});

test('model errors are classified for retry and summarised without the provider prefix', () => {
  // Message shape captured from TrueForge 0.185.1 when the provider quota is zero.
  const quota = classifyModelError('[Model Error] Request failed (429): You exceeded your current quota.\n* Quota exceeded for metric: x');
  assert.deepEqual(quota, { transient: true, summary: 'Request failed (429): You exceeded your current quota.', stepLimit: false });
  assert.equal(classifyModelError('[Model Error] Request failed (503): overloaded').transient, true);
  // Captured from TrueForge 0.185.1 with a provider whose endpoint is closed, and one with an invalid key.
  assert.equal(classifyModelError('[Model Error] Cannot connect to API: connect ECONNREFUSED 127.0.0.1:59999').transient, true);
  assert.equal(classifyModelError('[Model Error] Cannot connect to API: bad port').transient, true);
  assert.equal(classifyModelError('[Model Error] Request failed (400): Bad Request').transient, false);
  assert.equal(classifyModelError('[Model Error] Request failed (401): API key not valid').transient, false);
  assert.equal(classifyModelError('[Model Error] Request failed (404): model not found').transient, false);
  assert.equal(classifyModelError('').summary, 'The model request failed.');
  // Captured from TrueForge 0.185.1: the agent used every allowed step. Not a provider failure, so no retry or fallback.
  assert.deepEqual(classifyModelError('You have reached iteration limit of 32, please request again'), { transient: false, summary: 'You have reached iteration limit of 32, please request again', stepLimit: true });
  assert.equal(classifyModelError('[Model Error] Request failed (429): quota').stepLimit, false);
});

test('a failed turn can switch the session model with the full spec and retry without the failed turn', async () => {
  const requests = [];
  let fail = true;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    requests.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null });
    if (req.url === '/api/v1/sessions' || req.method === 'PATCH') { res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: { id: 's1' } })); return; }
    const done = fail ? { status: 'error', completed_at: new Date().toISOString(), message: '[Model Error] Request failed (401): API key not valid' } : { status: 'done', completed_at: new Date().toISOString(), output: null, required_actions: [] };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const event of [{ type: 'turn.created', id: 'c', created_at: new Date().toISOString(), thread_id: null, turn_id: `t${requests.length}`, previous_turn_id: null, state: { status: 'running' } }, { type: 'turn.done', id: 'd', created_at: new Date().toISOString(), thread_id: null, state: done }]) res.write(`data: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const events = [];
  try {
    const session = new ForgeSession({ baseUrl: `http://127.0.0.1:${address.port}`, model: 'broken/model', connector: 'forge-editor', onEvent: event => events.push(event) });
    await session.send([{ type: 'user.message', content: 'hello' }]);
    assert.equal(events.at(-1).state.status, 'error');
    await assert.rejects(session.switchModel('unqualified'), /provider\/model/);
    await session.switchModel('backup/model');
    assert.equal(session.model, 'backup/model');
    const patch = requests.find(request => request.method === 'PATCH');
    assert.equal(patch.url, '/api/v1/sessions/s1');
    assert.equal(patch.body.agent.spec.model.name, 'backup/model');
    assert.deepEqual(patch.body.agent.spec.mcp_servers[0].require_approval_for_tools, ['propose_edit', 'run_command'], 'PATCH replaces the spec, so approvals must be resent.');
    assert.equal(patch.body.agent.spec.config.dynamic_sub_agents.enabled, false);
    fail = false;
    await session.send([{ type: 'user.message', content: 'hello' }], { retry: true });
    assert.equal(requests.at(-1).body.previous_turn_id, 'none', 'With no successful turn yet, the retry starts from an empty history.');
    await session.send([{ type: 'user.message', content: 'again' }], { retry: true });
    assert.match(requests.at(-1).body.previous_turn_id, /^t\d+$/u, 'Later retries branch from the last successful turn.');
  } finally { server.close(); }
});

test('SDK session, stream, approval resume, cancellation and error handling', async () => {
  const requests = [];
  let reject = false;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    requests.push({ url: req.url, body: body ? JSON.parse(body) : null });
    if (reject) { res.writeHead(401, { 'Content-Type': 'application/json' }).end(JSON.stringify({ message: 'Invalid test credential' })); return; }
    if (req.url === '/api/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: [{ name: 'test/model' }] })); return;
    }
    if (req.url === '/api/v1/settings/mcp-servers') {
      const { manifest } = JSON.parse(body);
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: { name: manifest.name, manifest, auth_status: { status: 'authenticated' } } })); return;
    }
    if (req.url === '/api/v1/sessions') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: { id: 'test-session' } })); return;
    }
    if (req.url?.endsWith('/cancel')) { res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}'); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const event of [
      { type: 'model.message.delta', id: 'm1', thread_id: 'main', content: 'Hello ' },
      { type: 'model.message.delta', id: 'm1', thread_id: 'main', content: 'Forge' },
      { type: 'turn.done', id: 'done', created_at: new Date().toISOString(), thread_id: null, state: { status: 'done', completed_at: new Date().toISOString(), output: null, required_actions: [] } },
    ]) res.write(`data: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const events = [];
  const options = { baseUrl: `http://127.0.0.1:${address.port}`, model: 'test/model', connector: 'forge-editor', reasoningEffort: 'medium', onEvent: event => events.push(event) };
  try {
    assert.deepEqual(await listModelNames({ baseUrl: options.baseUrl }), ['test/model']);
    assert.throws(() => new ForgeSession({ ...options, model: 'unqualified-model' }), /provider\/model/);
    assert.equal(requests.filter(request => request.url === '/api/v1/sessions').length, 0);
    const session = new ForgeSession(options);
    await session.send([{ type: 'user.message', content: 'hello' }]);
    assert.equal(session.id, 'test-session');
    const createdSpec = requests.find(request => request.url === '/api/v1/sessions').body.agent.spec;
    assert.equal(createdSpec.config.generative_ui.enabled, false);
    assert.equal(createdSpec.config.ask_user_questions.enabled, false);
    assert.equal(createdSpec.model.params.reasoning_effort, 'medium');
    assert.ok(createdSpec.mcp_servers[0].enable_tools.includes('search_code'));
    assert.equal(events.filter(event => event.type === 'model.message.delta').map(event => event.content).join(''), 'Hello Forge');
    await session.send([{ type: 'user.message', content: 'Follow up' }]);
    assert.equal(requests.filter(request => request.url === '/api/v1/sessions').length, 1);
    assert.equal(requests.at(-1).body.input[0].content, 'Follow up');
    await session.cancel();
    assert.ok(requests.at(-1).url.endsWith('/cancel'));
    const beforeReconnect = requests.length;
    const firstManifest = { type: 'remote', name: 'forge-editor-window-one', description: 'Test editor', url: 'http://127.0.0.1:43101/mcp', auth: { type: 'header', headers: { Authorization: 'Bearer test-first-token' } } };
    await new ForgeSession({ ...options, editorManifest: firstManifest }).send([{ type: 'user.message', content: 'First window' }]);
    assert.equal(requests[beforeReconnect].url, '/api/v1/settings/mcp-servers');
    assert.deepEqual(requests[beforeReconnect].body.manifest, firstManifest);
    assert.equal(requests[beforeReconnect + 1].body.agent.spec.mcp_servers[0].name, firstManifest.name);
    const reopenedManifest = { ...firstManifest, name: 'forge-editor-window-two', url: 'http://127.0.0.1:43102/mcp', auth: { type: 'header', headers: { Authorization: 'Bearer test-new-token' } } };
    const reopenIndex = requests.length;
    await new ForgeSession({ ...options, editorManifest: reopenedManifest }).send([{ type: 'user.message', content: 'Reopened project' }]);
    assert.deepEqual(requests[reopenIndex].body.manifest, reopenedManifest);
    assert.equal(requests[reopenIndex + 1].body.agent.spec.mcp_servers[0].name, reopenedManifest.name);
    assert.notEqual(firstManifest.name, reopenedManifest.name);
    reject = true;
    const failedRegistrationIndex = requests.length;
    await assert.rejects(new ForgeSession({ ...options, editorManifest: reopenedManifest }).send([{ type: 'user.message', content: 'Registration must succeed first' }]));
    assert.equal(requests.length, failedRegistrationIndex + 1);
    await assert.rejects(new ForgeSession(options).send([{ type: 'user.message', content: 'fail' }]));
    assert.throws(() => new ForgeSession({ ...options, baseUrl: 'https://example.com' }), /local/);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('SDK approvals resume a paused turn with a cursor, retry rejected decisions and preserve cancellation', { timeout: 10000 }, async t => {
  const requests = [], events = [], rows = [];
  let turns = 0, resumes = 0, decisions = [], rejectApproval = false, holdApproval = false, heldResponse, approvalArrived;
  const oldObserver = ForgeSession.observe;
  ForgeSession.observe = row => rows.push(row);
  t.after(() => { ForgeSession.observe = oldObserver; });
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    requests.push({ method: req.method, url: req.url, body });
    const json = (value, status = 200) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
    if (req.url === '/api/v1/sessions') { json({ data: { id: 'approval-session' } }); return; }
    if (req.url.endsWith('/cancel')) { json({}); return; }
    if (req.method === 'POST' && req.url.endsWith('/events')) {
      if (holdApproval) { heldResponse = res; approvalArrived(); return; }
      if (rejectApproval) { json({ error: { message: 'Temporary approval failure' } }, 400); return; }
      decisions = body.events;
      json({ data: decisions.map((decision, i) => ({ ...decision, id: `decision-${resumes}-${i}`, created_at: new Date().toISOString() })) }, 201);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const write = event => res.write(`data: ${JSON.stringify({ created_at: new Date().toISOString(), thread_id: null, ...event })}\n\n`);
    if (req.method === 'POST' && req.url.endsWith('/turns')) {
      turns++;
      write({ type: 'turn.created', id: 'created', turn_id: `approval-turn-${turns}`, previous_turn_id: null, state: { status: 'running' } });
      write({ type: 'model.message.delta', id: 'initial', thread_id: 'main', content: 'Before approval' });
      write({ type: 'tool.approval_required', id: 'ask', thread_id: 'main', tool_calls: [{ id: 'tool-1', source_event_id: 'initial' }, { id: 'tool-2', source_event_id: 'initial' }] });
      write({ type: 'turn.update', id: 'paused-initial', state: { status: 'paused' } });
      return; // Deliberately keep the SSE open: the client must release the reader at pause.
    }
    if (req.method === 'GET' && req.url.includes('/subscribe')) {
      resumes++;
      for (const [i, decision] of decisions.entries()) write({ ...decision, id: `decision-${resumes}-${i}` });
      write({ type: 'turn.update', id: `running-${resumes}`, state: { status: 'running' } });
      write({ type: 'model.message.delta', id: `reply-${resumes}`, thread_id: 'main', content: `Resumed ${resumes}` });
      if (resumes === 1) {
        write({ type: 'tool.approval_required', id: 'ask-again', thread_id: 'main', tool_calls: [{ id: 'tool-3', source_event_id: 'reply-1' }] });
        write({ type: 'turn.update', id: 'paused-again', state: { status: 'paused' } });
      } else {
        write({ type: 'turn.done', id: 'done', state: { status: 'done', completed_at: new Date().toISOString(), output: null, required_actions: [], metrics: { total_tokens: 8 } } });
        res.end();
      }
      return;
    }
    res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const session = new ForgeSession({ baseUrl: `http://127.0.0.1:${server.address().port}`, model: 'test/model', connector: '', onEvent: event => events.push(event) });
  const approve = (id, status = 'allow') => ({ type: 'user.tool_approval', threadId: 'main', toolCallId: id, approval: status === 'allow' ? { status } : { status, reason: 'Declined in VS Code' } });
  await assert.rejects(session.approve([approve('tool-1')]), /No paused/);
  assert.equal(requests.length, 0);
  await session.send([{ type: 'user.message', content: 'Stage changes' }]);
  assert.equal(session.awaitingApproval, true);
  assert.equal(rows.filter(row => row.event === 'turn.end').length, 0, 'A pause must not be logged as a failed or completed turn');
  await assert.rejects(session.send([{ type: 'user.message', content: 'Must wait' }]), /pending tool request/);
  rejectApproval = true;
  await assert.rejects(session.approve([approve('tool-1')]), /Temporary approval failure/);
  assert.equal(session.awaitingApproval, true, 'A rejected decision can be retried');
  rejectApproval = false;
  await session.approve([approve('tool-1'), approve('tool-2')]);
  assert.equal(session.awaitingApproval, true);
  await session.approve([approve('tool-3', 'deny')]);
  assert.equal(session.awaitingApproval, false);
  assert.equal(turns, 1, 'Decisions must not create new turns');
  const subscriptions = requests.filter(request => request.method === 'GET');
  assert.deepEqual(subscriptions.map(request => request.url), [
    '/api/v1/sessions/approval-session/turns/approval-turn-1/subscribe?after_event_id=paused-initial',
    '/api/v1/sessions/approval-session/turns/approval-turn-1/subscribe?after_event_id=paused-again',
  ]);
  const submissions = requests.filter(request => request.method === 'POST' && request.url.endsWith('/events'));
  assert.deepEqual(submissions[1].body.events.map(event => event.tool_call_id), ['tool-1', 'tool-2']);
  assert.deepEqual(submissions[2].body.events[0].approval, { status: 'deny', reason: 'Declined in VS Code' });
  assert.ok(submissions.every(request => !('input' in request.body)));
  assert.deepEqual(events.filter(event => event.type === 'model.message.delta').map(event => event.content), ['Before approval', 'Resumed 1', 'Resumed 2']);
  assert.equal(rows.filter(row => row.event === 'turn.start').length, 1);
  assert.equal(rows.filter(row => row.event === 'approval.decision').length, 3);
  assert.equal(rows.filter(row => row.event === 'turn.end').length, 1);
  assert.equal(rows.find(row => row.event === 'turn.end').turnId, 'approval-turn-1');
  assert.ok(!rows.some(row => row.errorType === 'IncompleteStream'));
  await assert.rejects(session.approve([approve('tool-3')]), /No paused/);
  await session.send([{ type: 'user.message', content: 'Another request' }]);
  await session.cancel();
  assert.equal(session.awaitingApproval, false);
  await assert.rejects(session.approve([approve('tool-1')]), /No paused/);
  assert.equal(rows.find(row => row.event === 'turn.cancel').turnId, 'approval-turn-2');
  assert.equal(submissions.length, requests.filter(request => request.url.endsWith('/events')).length);
  await session.send([{ type: 'user.message', content: 'Cancel an in-flight decision' }]);
  holdApproval = true;
  const arrived = new Promise(resolve => { approvalArrived = resolve; });
  const pending = session.approve([approve('tool-1')]);
  await arrived;
  await session.cancel();
  heldResponse.writeHead(201, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: [] }));
  await pending;
  assert.equal(requests.filter(request => request.method === 'GET').length, 2, 'Cancellation must prevent a late decision from reopening the stream');
  assert.equal(rows.filter(row => row.event === 'turn.end' && row.turnId === 'approval-turn-3').length, 1);
});
