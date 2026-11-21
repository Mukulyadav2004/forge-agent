import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { agentSpec, classifyModelError, ForgeSession, listModelNames, normalizeSkills } from '../out/agent/ForgeSession.js';
import { readFileSync } from 'node:fs';
import { evaluateSession } from '../scripts/eval-session.mjs';
import { buildProjectContext, buildProjectOverview, isArchitectureRequest, OVERVIEW_LIMITS, suggestTestCommands, fileOutline } from '../out/context/projectContext.js';
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
  // Task A shape: the def line, docstring opening and val line are identical in old and new text, so they carry no sign.
  const compared = describeApproval(call({
    old_text: 'def f():\n    """Doc.\n    Old line.\n    """\n    val = get()\n    return val not in {"0"}\n',
    new_text: 'def f():\n    """Doc.\n    New line one.\n    New line two.\n    """\n    val = get()\n    return val not in {"0", "off"}',
  }));
  assert.match(compared, /```diff\n  def f\(\):\n      """Doc\.\n-     Old line\.\n\+     New line one\.\n\+     New line two\.\n      """\n      val = get\(\)\n-     return val not in \{"0"\}\n\+     return val not in \{"0", "off"\}\n```/u, 'Only changed lines are marked; a missing final newline does not mark the last line changed.');
  const tenSame = Array.from({ length: 10 }, (_, index) => `same ${index}`).join('\n');
  const trimmed = describeApproval(call({ old_text: `${tenSame}\nold\n${tenSame}\n`, new_text: `${tenSame}\nnew\n${tenSame}\n` }));
  assert.match(trimmed, /```diff\n  … 7 unchanged line\(s\)\n  same 7\n  same 8\n  same 9\n- old\n\+ new\n  same 0\n  same 1\n  same 2\n  … 7 unchanged line\(s\)\n```/u, 'Long unchanged runs shrink to three lines of context on the side facing the change.');
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

test('deferred tool loading keeps the core editor tools eager and approvals name the tool behind call_tool', () => {
  const definition = JSON.parse(readFileSync(new URL('../src/agent/forge-agent.json', import.meta.url), 'utf8'));
  const [server] = agentSpec({ model: 'test/model', connector: 'c', deferTools: true }).mcpServers;
  assert.equal(server.preload, false);
  assert.deepEqual(server.preloadTools, definition.deferredTools.preloadTools);
  assert.ok(!server.preloadTools.includes('run_command') && !server.preloadTools.includes('write_file'), 'Rarely used tools are looked up when needed.');
  assert.deepEqual(server.requireApprovalForTools, definition.editorServer.requireApprovalForTools, 'Deferred tools keep their approvals.');
  assert.equal(agentSpec({ model: 'test/model', connector: 'c' }).mcpServers[0].preload, true, 'Off by default: every editor tool is sent with each request.');
  const calls = new StreamedToolCalls();
  const wrapped = { mcp_server: 'c', tool_name: 'run_command', input: { command: 'pytest -q', reason: 'Run the tests' } };
  calls.remember('msg-1', [{ id: 'call_1', function: { name: 'call_tool', arguments: JSON.stringify(wrapped) }, toolInfo: { type: 'mcp', name: 'call_tool' } }]);
  assert.deepEqual(calls.find('msg-1', 'call_1'), { name: 'run_command', arguments: JSON.stringify(wrapped.input) });
  assert.match(describeApproval(calls.find('msg-1', 'call_1')), /Approve running a command\?[\s\S]*pytest -q/u);
  calls.add('msg-2', [{ index: 0, id: 'call_2', function: { name: 'call_tool', arguments: '{"mcp_server":"c","tool_name":"list_tools"' } }]);
  assert.deepEqual(calls.find('msg-2', 'call_2'), { name: 'call_tool', arguments: '{"mcp_server":"c","tool_name":"list_tools"' }, 'Incomplete arguments stay as they arrived.');
});

test('session evaluation flags refused approvals, failed commands, repeats and turn errors', () => {
  // Event shapes as stored by TrueForge 0.185.1 (snake_case, tool results as JSON strings).
  const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
  const events = [
    { type: 'model.message', created_at: '2026-11-18T01:00:00Z', model: { name: 'p/a' }, usage: { input_tokens: 4000 }, tool_calls: [call('c1', 'propose_edit', { path: 'a.py', new_text: 'x' })] },
    { type: 'tool.approval_required', created_at: '2026-11-18T01:00:01Z', tool_calls: [{ id: 'c1' }] },
    { type: 'user.tool_approval', created_at: '2026-11-18T01:00:02Z', tool_call_id: 'c1', approval: { status: 'allow' } },
    { type: 'tool.response', created_at: '2026-11-18T01:00:03Z', tool_call_id: 'c1', content: JSON.stringify({ error: [{ type: 'text', text: 'The proposed content is identical to the current file.' }] }) },
    { type: 'model.message', created_at: '2026-11-18T01:00:04Z', model: { name: 'p/b' }, usage: { input_tokens: 6000 }, tool_calls: [call('c2', 'run_command', { command: 'pytest' }), call('c3', 'run_command', { command: 'pytest' })] },
    { type: 'tool.response', created_at: '2026-11-18T01:00:05Z', tool_call_id: 'c2', content: JSON.stringify({ exit_code: 127, timed_out: false }) },
    { type: 'tool.response', created_at: '2026-11-18T01:00:06Z', tool_call_id: 'c3', content: JSON.stringify({ exit_code: 0, timed_out: false }) },
    { type: 'thread.context_compaction_finished', created_at: '2026-11-18T01:00:07Z', trigger: { context_tokens: 31616.4 }, duration_ms: 37572 },
  ];
  const report = evaluateSession({ events, turns: [{ state: { status: 'error', message: 'You have reached iteration limit of 64, please request again' } }, { state: { status: 'done' } }] });
  assert.deepEqual([report.approvalsAsked, report.approvalsAllowed, report.approvedThenRefused], [1, 1, 1]);
  assert.deepEqual(report.filesStaged, []);
  assert.deepEqual(report.commands, [{ command: 'pytest', exitCode: 127, timedOut: false }, { command: 'pytest', exitCode: 0, timedOut: false }]);
  assert.deepEqual([report.peakInputTokens, report.compactions[0].fromTokens, report.models.join(',')], [6000, 31616, 'p/a,p/b']);
  const flags = report.flags.join('\n');
  for (const expected of [/1 approved call\(s\) were then refused/u, /identical to the current file/u, /1 of 2 command\(s\) failed: pytest → exit 127/u, /identical calls repeated: 2× run_command/u, /hit its step limit/u, /model changed during the session: p\/a → p\/b/u]) assert.match(flags, expected);
  assert.deepEqual(evaluateSession({ events: [] }).flags, [], 'An empty session has nothing to flag.');
});

test('the agent definition file is what TrueForge receives', () => {
  const definition = JSON.parse(readFileSync(new URL('../src/agent/forge-agent.json', import.meta.url), 'utf8'));
  const spec = agentSpec({ model: 'test/model', connector: 'forge-editor-abc', reasoningEffort: 'low' });
  assert.deepEqual(spec.config, definition.config);
  assert.deepEqual(spec.mcpServers, [{ name: 'forge-editor-abc', ...definition.editorServer }]);
  assert.deepEqual(spec.model, { name: 'test/model', params: { parallelToolCalls: true, reasoningEffort: 'low' } }, 'Several tool calls may come in one response, so independent reads take one round trip.');
  assert.ok(spec.instructions.startsWith('You are Forge Agent'));
  assert.deepEqual(definition.editorServer.requireApprovalForTools, ['run_command', 'propose_edit', 'write_file'], 'Commands and edits need approval: an edit or new file is reviewed and saved when approved.');
  assert.deepEqual(agentSpec({ model: 'test/model', connector: 'c', approveEdits: false }).mcpServers[0].requireApprovalForTools, ['run_command'], 'With forgeAgent.saveOnApprove off, propose_edit and write_file only stage a diff for Review changes.');
  assert.deepEqual(definition.config.contextManagement.compaction, { enabled: true }, 'By default TrueForge compacts at 80% of the configured model\'s context window, so it adapts to each model.');
  assert.deepEqual(agentSpec({ model: 'test/model', compactionTokens: 40000 }).config.contextManagement.compaction, { enabled: true, trigger: { type: 'input_tokens', value: 40000 } }, 'forgeAgent.compactionTokens sets a fixed trigger, for example to show compaction in a short demo task.');
  assert.deepEqual(agentSpec({ model: 'test/model', compactionTokens: 0 }).config, definition.config, '0 keeps TrueForge\'s default.');
  assert.deepEqual(agentSpec({ model: 'test/model' }).mcpServers, []);
});

test('Code Mode turns on the sandbox only when TrueForge reports a provider, and says so when it cannot', async () => {
  const definition = JSON.parse(readFileSync(new URL('../src/agent/forge-agent.json', import.meta.url), 'utf8'));
  const plain = agentSpec({ model: 'test/model' });
  assert.deepEqual(plain.config.sandbox, { enabled: false });
  assert.doesNotMatch(plain.instructions, /Code Mode/u);
  const coded = agentSpec({ model: 'test/model', sandbox: { environmentName: 'python' } });
  assert.deepEqual(coded.config.sandbox, { enabled: true, environmentName: 'python' });
  assert.match(coded.instructions, /Code Mode: [\s\S]*does not contain the user's workspace/u);
  assert.deepEqual({ ...coded.config, sandbox: definition.config.sandbox }, definition.config, 'Only the sandbox changes.');

  const requests = [];
  let sandbox = true;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    requests.push({ url: req.url, body: body ? JSON.parse(body) : null });
    const json = data => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data }));
    if (req.url === '/api/v1/capabilities') return json({ sandbox: { enabled: sandbox, environments: { enabled: false } }, skill: { enabled: sandbox } });
    if (req.url === '/api/v1/sessions') return json({ id: 'test-session' });
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ type: 'turn.done', id: 'done', created_at: new Date().toISOString(), thread_id: null, state: { status: 'done', completed_at: new Date().toISOString(), output: null, required_actions: [] } })}\n\n`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const notices = [];
  const options = { baseUrl: `http://127.0.0.1:${address.port}`, model: 'test/model', connector: 'forge-editor', onEvent: () => undefined, onNotice: text => notices.push(text) };
  const createdSpec = () => requests.filter(request => request.url === '/api/v1/sessions').at(-1).body.agent.spec;
  try {
    await new ForgeSession(options).send([{ type: 'user.message', content: 'no code mode' }]);
    assert.equal(requests.filter(request => request.url === '/api/v1/capabilities').length, 0, 'Without Code Mode the server is not asked.');
    assert.equal(createdSpec().config.sandbox.enabled, false);
    await new ForgeSession({ ...options, codeMode: true, sandboxEnvironment: ' python ' }).send([{ type: 'user.message', content: 'code mode' }]);
    assert.deepEqual(createdSpec().config.sandbox, { enabled: true, environment_name: 'python' });
    assert.match(createdSpec().instructions, /Code Mode:/u);
    assert.deepEqual(notices, []);
    sandbox = false;
    await new ForgeSession({ ...options, codeMode: true }).send([{ type: 'user.message', content: 'no provider' }]);
    assert.equal(createdSpec().config.sandbox.enabled, false, 'A server without a sandbox provider still gets a working session.');
    assert.match(notices.join('\n'), /Code Mode is off for this chat/u);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('skills are sent by name with a sandbox, and left out with a reason when the server cannot mount them', async () => {
  assert.deepEqual(normalizeSkills(['pdf', { name: 'git/review', preload: true }, 'pdf', ' bad name ', '.tfy-internal', '..', { preload: true }, 7]), [{ name: 'pdf' }, { name: 'git/review', preload: true }]);
  assert.deepEqual(normalizeSkills('pdf'), []);
  assert.equal(agentSpec({ model: 'test/model', skills: [{ name: 'pdf' }] }).skills, undefined, 'TrueForge rejects skills without a sandbox.');
  assert.deepEqual(agentSpec({ model: 'test/model', sandbox: {}, skills: [{ name: 'pdf' }] }).skills, [{ name: 'pdf' }]);

  const requests = [];
  let capabilities;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    requests.push({ url: req.url, body: body ? JSON.parse(body) : null });
    const json = data => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data }));
    if (req.url === '/api/v1/capabilities') return json(capabilities);
    if (req.url === '/api/v1/sessions') return json({ id: 'test-session' });
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ type: 'turn.done', id: 'done', created_at: new Date().toISOString(), thread_id: null, state: { status: 'done', completed_at: new Date().toISOString(), output: null, required_actions: [] } })}\n\n`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const notices = [];
  const options = { baseUrl: `http://127.0.0.1:${address.port}`, model: 'test/model', connector: 'forge-editor', skills: [{ name: 'pdf' }, { name: 'git/review', preload: true }], onEvent: () => undefined, onNotice: text => notices.push(text) };
  const createdSpec = () => requests.filter(request => request.url === '/api/v1/sessions').at(-1).body.agent.spec;
  try {
    capabilities = { sandbox: { enabled: true, environments: { enabled: false } }, skill: { enabled: true } };
    await new ForgeSession(options).send([{ type: 'user.message', content: 'skills' }]);
    assert.deepEqual(createdSpec().skills, [{ name: 'pdf' }, { name: 'git/review', preload: true }]);
    assert.equal(createdSpec().config.sandbox.enabled, true, 'Skills are mounted in a sandbox, so the session gets one without forgeAgent.codeMode.');
    assert.deepEqual(notices, []);
    capabilities = { sandbox: { enabled: true, environments: { enabled: false } }, skill: { enabled: false, reason: 'No skill store is configured' } };
    await new ForgeSession(options).send([{ type: 'user.message', content: 'no skill store' }]);
    assert.equal(createdSpec().skills, undefined);
    assert.equal(createdSpec().config.sandbox.enabled, false, 'Without usable skills or Code Mode no sandbox is started.');
    assert.match(notices.at(-1), /Skills are off for this chat: No skill store is configured\./u);
    capabilities = { sandbox: { enabled: false, environments: { enabled: false } }, skill: { enabled: false } };
    await new ForgeSession({ ...options, codeMode: true }).send([{ type: 'user.message', content: 'no sandbox' }]);
    assert.equal(createdSpec().skills, undefined);
    assert.match(notices.at(-1), /^Code Mode and skills are off for this chat/u);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
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
  // Captured from Google's free tier through TrueForge 0.185.1 (per-minute request limit).
  const limited = classifyModelError('[Model Error] Request failed (429): You exceeded your current quota, please check your plan and billing details.\n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 15, model: gemini-3.5-flash-lite\nPlease retry in 42.092876232s.');
  assert.deepEqual([limited.transient, limited.retryAfterSeconds], [true, 43]);
  assert.equal(classifyModelError('[Model Error] Request failed (503): overloaded').retryAfterSeconds, undefined);
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
    assert.deepEqual(patch.body.agent.spec.mcp_servers[0].require_approval_for_tools, ['run_command', 'propose_edit', 'write_file'], 'PATCH replaces the spec, so approvals must be resent.');
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
    assert.equal(createdSpec.config.ask_user_questions.enabled, true, 'ask_user_question is on (16c7610): the model can pause the turn with multiple-choice options.');
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

test('a new chat gets a bounded project overview: a depth-2 tree and the test setup the project declares', async () => {
  const paths = ['pyproject.toml', 'README.md', 'src/flask/app.py', 'src/flask/cli.py', 'src/flask/json/provider.py', 'tests/conftest.py', 'tests/test_cli.py', 'tests/test_apps/cliapp/app.py', 'docs/cli.rst', 'docs/api.rst',
    ...Array.from({ length: 60 }, (_, index) => `docs/patterns/page${index}.rst`)];
  const pyproject = ['[project]', 'name = "Flask"', 'dependencies = ["click>=8.1.3"]', '', '[dependency-groups]', 'tests = ["pytest", "python-dotenv"]', '', '[tool.pytest.ini_options]', 'testpaths = ["tests"]', '', '[tool.mypy]', 'strict = true'].join('\n');
  const read = [];
  const overview = await buildProjectOverview({ paths, environments: [], readFile: async path => { read.push(path); return pyproject; } });
  assert.deepEqual(read, ['pyproject.toml'], 'Only root test manifests are read, never source files.');
  assert.match(overview.text, /^\.\/ \(70 files\): README\.md, pyproject\.toml, docs\/ \(62\), src\/ \(3\), tests\/ \(3\)$/mu);
  assert.match(overview.text, /^src\/flask\/ \(3 files\): app\.py, cli\.py, json\/ \(1\)$/mu, 'A folder holding only one folder is merged with it.');
  assert.match(overview.text, /^tests\/ \(3 files\): conftest\.py, test_cli\.py, test_apps\/ \(1\)$/mu);
  assert.match(overview.text, /^docs\/ \(62 files\): api\.rst, cli\.rst, patterns\/ \(60\)$/mu);
  assert.match(overview.text, /\[dependency-groups\]\ntests = \["pytest", "python-dotenv"\]/u, 'Test dependencies are supplied.');
  assert.match(overview.text, /\[tool\.pytest\.ini_options\]\ntestpaths/u);
  assert.doesNotMatch(overview.text, /\[project\]|\[tool\.mypy\]/u, 'Sections unrelated to tests are left out.');
  assert.match(overview.text, /No Python virtual environment was found inside the workspace\./u);
  assert.deepEqual(overview.files, [{ path: 'pyproject.toml', startLine: 5, endLine: 10, origin: 'context' }]);
  assert.ok(overview.text.length < OVERVIEW_LIMITS.tree_characters + OVERVIEW_LIMITS.setup_characters + 1000);

  const wide = await buildProjectOverview({ paths: Array.from({ length: 3000 }, (_, index) => `pkg${index % 40}/module${index}.ts`), environments: [], readFile: async () => '' });
  assert.ok(wide.text.length < OVERVIEW_LIMITS.tree_characters + 1000, 'A large workspace is cut to the tree limit.');
  assert.match(wide.text, /\+\d+ more/u);
  const js = await buildProjectOverview({ paths: ['package.json', 'src/index.ts'], environments: [], readFile: async () => JSON.stringify({ scripts: { test: 'vitest run' }, devDependencies: { vitest: '1' }, dependencies: { secret: 'x' } }) });
  assert.match(js.text, /"test": "vitest run"/u);
  assert.doesNotMatch(js.text, /Python environment/u, 'A project without Python gets no Python line.');
  assert.match((await buildProjectOverview({ paths: ['app.py'], environments: ['.venv/bin/python'], readFile: async () => '' })).text, /Python environments in the workspace: \.venv\/bin\/python/u);
  assert.equal((await buildProjectOverview({ paths: [], environments: [], readFile: async () => '' })).text, '');
});

test('the overview suggests ready test commands from the project files, pinned by uv.lock when present', () => {
  const paths = ['pyproject.toml', 'uv.lock', 'src/app/core.py', 'tests/test_core.py'];
  const pyproject = ['[dependency-groups]', 'docs = ["sphinx"]', 'tests = [', '    "pytest",', '    "uvicorn[standard]",', ']', '', '[tool.pytest.ini_options]', 'testpaths = ["tests"]'].join('\n');
  const lock = ['[[package]]', 'name = "app"', 'source = { editable = "." }', '', '[package.dev-dependencies]', 'tests = [', '    { name = "pytest", version = "8.4.2", source = { registry = "x" }, marker = "python_full_version < \'3.10\'" },', '    { name = "pytest", version = "9.0.2", source = { registry = "x" }, marker = "python_full_version >= \'3.10\'" },', '    { name = "uvicorn" },', ']', '', '[[package]]', 'name = "uvicorn"', 'version = "0.30.1"'].join('\n');
  const suggest = (texts, environments = [], platform = 'darwin', list = paths) => suggestTestCommands({ paths: list, texts: new Map(Object.entries(texts)), environments, platform });
  assert.deepEqual(suggest({ 'pyproject.toml': pyproject }, ['venv/bin/python']), ['venv/bin/python -m pytest tests'], 'An existing environment is used as is.');
  assert.deepEqual(suggest({ 'pyproject.toml': pyproject }), ['python3 -m venv .venv', '.venv/bin/python -m pip install -e . "pytest" "uvicorn[standard]"', '.venv/bin/python -m pytest tests'], 'The group that holds pytest is installed by name; an extra inside it does not end the list.');
  assert.equal(suggest({ 'pyproject.toml': pyproject, 'uv.lock': lock })[1], '.venv/bin/python -m pip install -e . "pytest==8.4.2; python_full_version < \'3.10\'" "pytest==9.0.2; python_full_version >= \'3.10\'" "uvicorn==0.30.1"', 'uv.lock pins versions with their markers.');
  assert.deepEqual(suggest({ 'pyproject.toml': pyproject }, [], 'win32').slice(0, 2), ['py -m venv .venv', '.venv\\Scripts\\python.exe -m pip install -e . "pytest" "uvicorn[standard]"']);
  assert.equal(suggest({ 'pyproject.toml': '[project.optional-dependencies]\ntest = ["pytest"]' })[1], '.venv/bin/python -m pip install -e ".[test]"');
  assert.equal(suggest({}, [], 'darwin', ['requirements-dev.txt', 'tests/test_x.py'])[1], '.venv/bin/python -m pip install -r requirements-dev.txt');
  assert.deepEqual(suggest({ 'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }) }, [], 'darwin', ['package.json', 'pnpm-lock.yaml']), ['pnpm test']);
  assert.deepEqual(suggest({ 'package.json': JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }) }, [], 'darwin', ['package.json', 'Cargo.toml']), ['cargo test'], 'npm\'s placeholder test script is not a test command.');
  assert.deepEqual(suggest({}, [], 'darwin', ['README.md']), [], 'No test setup, no suggestion.');
});

test('a long file read gets an outline of definitions or headings with line numbers', () => {
  const code = ['import click', '', '@click.command("routes")', '@with_appcontext', 'def routes_command() -> None:', '    pass', '', 'class FlaskGroup(AppGroup):', '    def __init__(self):', '        x = 1', 'export const run = async () => 1;'].join('\n');
  assert.equal(fileOutline('src/cli.py', code), ['3: @click.command("routes")', '5: def routes_command() -> None:', '8: class FlaskGroup(AppGroup):', '9: def __init__(self):', '11: export const run = async () => 1;'].join('\n'), 'Decorators with arguments, functions, classes and methods are kept; plain statements are not.');
  const rst = ['Command Line Interface', '======================', '', 'Text.', '', 'Open a Shell', '------------', '', '    $ flask shell', '', '# Markdown title'].join('\n');
  assert.equal(fileOutline('docs/cli.rst', rst), '1: Command Line Interface\n6: Open a Shell\n11: # Markdown title', 'RST titles are found by their underline.');
  const many = Array.from({ length: 500 }, (_, index) => `def function_${index}():\n    pass`).join('\n');
  const capped = fileOutline('big.py', many, 1000);
  assert.ok(capped.length < 1100 && /… \+\d+ more; read a later range to see them$/u.test(capped), 'The outline is bounded and says what it left out.');
});

test('an edit approval card asks for review and says Approve saves the kept hunks', () => {
  const call = { name: 'propose_edit', arguments: JSON.stringify({ path: 'src/app.py', base_revision: 'r', old_text: 'a = 1\n', new_text: 'a = 2\n', explanation: 'Change a' }) };
  const card = describeApproval(call, { saveOnApprove: true });
  assert.match(card, /^\*\*Review this edit, then approve to save it\*\*/u);
  assert.match(card, /- a = 1\n\+ a = 2/u, 'The diff is in the card.');
  assert.match(card, /\*\*Approve\*\* saves every hunk you did not reject[\s\S]*\*\*Deny\*\* discards the edit[\s\S]*Undo last apply/u);
  assert.match(describeApproval(call), /Approving only stages a diff for review/u, 'Without save on approve the old wording stays.');
});

test('a new-file approval card shows the content and says Approve creates it', () => {
  const call = { name: 'write_file', arguments: JSON.stringify({ path: 'tests/test_config.py', content: 'def test_config():\n    assert True\n', explanation: 'Cover flask config' }) };
  const card = describeApproval(call, { saveOnApprove: true });
  assert.match(card, /^\*\*Review this new file, then approve to create it\*\*/u);
  assert.match(card, /`tests\/test_config\.py` \(new, 2 line\(s\)\)/u);
  assert.match(card, /\+ def test_config\(\):\n\+     assert True/u);
  assert.match(describeApproval(call), /Approving only stages it for review/u);
});

test('a session gets the model identity, the workspace AGENTS.md or CLAUDE.md, and an <env> block after the prompt', async () => {
  const { environmentInstructions, findGitRoot, loadWorkspaceInstructions, modelIdentity, renderProjectInstructions, MAX_INSTRUCTION_CHARACTERS } = await import('../out/context/environment.js');
  const env = environmentInstructions({ date: new Date('2026-11-19T10:00:00Z'), workspaceRoot: '/work/flask', gitRoot: '/work/flask', platform: 'darwin' });
  assert.match(env, /^Today's date: Thu Nov 19 2026\n[\s\S]*<env>\n {2}Working directory: \/work\/flask\n {2}Workspace root folder: \/work\/flask\n {2}Is directory a git repo: yes\n {2}Platform: darwin\n<\/env>$/u);
  assert.equal(findGitRoot('/work/flask/src', path => path === '/work/flask/.git'), '/work/flask');
  assert.equal(modelIdentity('google-gemini/gemini-3-1-flash-lite'), '# Your Model\n- Name: google-gemini/gemini-3-1-flash-lite\n- Provider ID: google-gemini\n- Model ID: gemini-3-1-flash-lite');
  const files = { 'AGENTS.md': '# Rules\nUse pytest.\n', 'CLAUDE.md': 'Fallback only.\n' };
  const read = async path => { if (!(path in files)) throw new Error('missing'); return files[path]; };
  const loaded = await loadWorkspaceInstructions(read);
  assert.deepEqual(loaded.file, { path: 'AGENTS.md', lines: 2 });
  assert.match(loaded.text, /untrusted data[\s\S]*<project_instructions path="AGENTS\.md">\n# Rules\nUse pytest\.\n<\/project_instructions>$/u);
  assert.doesNotMatch(loaded.text, /Fallback only/u, 'AGENTS.md wins; CLAUDE.md is only a fallback.');
  delete files['AGENTS.md'];
  assert.equal((await loadWorkspaceInstructions(read)).file?.path, 'CLAUDE.md');
  assert.equal((await loadWorkspaceInstructions(async () => { throw new Error('none'); })).text, '', 'No instruction file, no block.');
  assert.ok(renderProjectInstructions([{ path: 'AGENTS.md', text: 'x'.repeat(100_000) }]).length <= MAX_INSTRUCTION_CHARACTERS, 'A huge instruction file is cut to the limit.');
  const spec = agentSpec({ model: 'p/m', projectInstructions: '<project_instructions path="AGENTS.md">\nRules\n</project_instructions>', environment: env });
  const order = ['You are Forge Agent', '# Your Model', '<project_instructions path="AGENTS.md">', '<env>\n'].map(marker => spec.instructions.indexOf(marker));
  assert.ok(order.every((index, position) => index >= 0 && (position === 0 || index > order[position - 1])), `Prompt, identity, instructions, then env (${order}).`);
});

test('plan_task covers the user\'s words, the checklist tracks changed files, and repeated failures are recognised', async () => {
  const { checkPlanCoverage, checklistLine, failureSignature, itemStatus } = await import('../out/context/plan.js');
  const request = 'Add a new built-in CLI command flask config that prints the loaded application\'s configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.';
  const feature = { quote: 'Add a new built-in CLI command flask config that prints the loaded application\'s configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***"', change: 'Add config_command', file: 'src/flask/cli.py', sibling: 'routes_command' };
  const help = { quote: 'It must appear in flask --help', change: 'Register it in FlaskGroup', file: 'src/flask/cli.py' };
  const test = { quote: 'be covered by a test', change: 'Add a CLI test', file: 'tests/test_cli.py' };
  const docs = { quote: 'be documented alongside the other built-in commands', change: 'Document it', file: 'docs/cli.rst' };
  assert.deepEqual(checkPlanCoverage(request, [feature, help, test, docs]), { ok: true });
  const missingDocs = checkPlanCoverage(request, [feature, help, test]);
  assert.equal(missingDocs.ok, false);
  assert.match(missingDocs.message, /does not yet cover these words of the request: documented, alongside, commands \(in: "It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands\."\)\./u, 'A forgotten part is named as its words, with the whole sentence, never comma fragments.');
  // The live failure: a quote with one extra comma ("TOKEN, or KEY") is still the user's words.
  assert.deepEqual(checkPlanCoverage(request, [{ ...feature, quote: 'Add a new built-in CLI command flask config that prints the loaded application\'s configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN, or KEY as \u201c***\u201d' }, help, test, docs]), { ok: true }, 'Punctuation and quote marks do not change the words.');
  const fragments = checkPlanCoverage(request, [help, test, docs]);
  assert.ok(!fragments.ok && !/"PASSWORD"|; "TOKEN/u.test(fragments.message) && fragments.message.includes('SECRET, PASSWORD, TOKEN'), 'A list in the request is reported whole, not split at its commas.');
  assert.match(checkPlanCoverage(request, [{ ...docs, quote: 'write docs in docs/cli.rst' }, feature, help, test]).message, /not in the user's request/u, 'Quotes must be the user\'s words.');
  assert.match(checkPlanCoverage(request, [{ ...feature, quote: request }]).message, /^Split the request/u, 'One requirement for the whole request is refused.');
  assert.deepEqual(checkPlanCoverage('', [docs]), { ok: true }, 'Without request text there is nothing to compare.');
  const plan = [feature, help, test, docs, { quote: 'covered by a test', change: 'none', file: 'tests/x.py', skip_reason: 'test_cli.py already covers it' }];
  const changed = new Set(['src/flask/cli.py', 'tests/test_cli.py']);
  assert.equal(itemStatus(docs, changed), 'open');
  assert.equal(itemStatus(plan[4], changed), 'skipped');
  assert.equal(checklistLine(plan, changed), 'Checklist: 4 of 5 requirement(s) have a change. Still open: "be documented alongside the other built-in commands" (planned: docs/cli.rst).');
  assert.equal(checklistLine(plan, new Set([...changed, 'docs/cli.rst'])), 'Checklist: all 5 requirement(s) have a change or a stated reason.');
  assert.equal(checklistLine(undefined, changed), '');
  const first = "E   AssertionError: No such command 'config'.\n1 failed in 0.03s\n<Result at 0x10a1b2c3d>";
  const second = "E   AssertionError: No such command 'config'.\n1 failed in 0.05s\n<Result at 0x99ffee00>";
  assert.equal(failureSignature(first), failureSignature(second), 'Timings and addresses do not make two identical failures differ.');
  assert.notEqual(failureSignature(first), failureSignature('E   TypeError: Object of type timedelta is not JSON serializable'));
  assert.equal(failureSignature('3 passed in 0.02s'), '');
});

test('the setup command pins the project runtime packages from uv.lock too, so a fresh environment matches the lock', async () => {
  const { suggestTestCommands } = await import('../out/context/projectContext.js');
  const pyproject = ['[dependency-groups]', 'tests = ["pytest"]'].join('\n');
  const lock = ['[[package]]', 'name = "app"', 'source = { editable = "." }', 'dependencies = [', '    { name = "werkzeug" },', '    { name = "click", version = "8.3.1", source = { registry = "x" }, marker = "python_full_version >= \'3.10\'" },', ']', '', '[package.dev-dependencies]', 'tests = [', '    { name = "pytest" },', ']', '', '[[package]]', 'name = "werkzeug"', 'version = "3.1.5"', '', '[[package]]', 'name = "pytest"', 'version = "9.0.2"'].join('\n');
  const [, install] = suggestTestCommands({ paths: ['pyproject.toml', 'uv.lock', 'tests/test_x.py'], texts: new Map([['pyproject.toml', pyproject], ['uv.lock', lock]]), environments: [], platform: 'darwin' });
  assert.equal(install, '.venv/bin/python -m pip install -e . "werkzeug==3.1.5" "click==8.3.1; python_full_version >= \'3.10\'" "pytest==9.0.2"');
});

test('the run guard follows Cline: a note at 3 identical calls, a stop at 5, a stop after 6 errors in a row, reset by success; stalls get a progress report', async () => {
  const { RunGuard, progressReport, callSignature } = await import('../out/context/plan.js');
  assert.equal(callSignature('read_file', { b: 1, a: 2 }), callSignature('read_file', { a: 2, b: 1 }), 'Key order does not matter.');
  const guard = new RunGuard();
  const call = { path: 'a.py', start_line: 1 };
  assert.deepEqual([guard.call('read_file', call), guard.call('read_file', call)], [{}, {}]);
  assert.match(guard.call('read_file', call).notice ?? '', /this exact read_file call 3 times in a row/u);
  assert.deepEqual(guard.call('read_file', call), {});
  assert.match(guard.call('read_file', call).stop ?? '', /same read_file call 5 times in a row/u);
  assert.deepEqual(guard.call('read_file', { path: 'b.py' }), {}, 'A different call starts a new count.');
  for (let index = 0; index < 5; index++) assert.deepEqual(guard.outcome(false, 'old_text was not found'), {});
  assert.deepEqual(guard.outcome(true), {}, 'A success resets the error streak.');
  for (let index = 0; index < 5; index++) guard.outcome(false, 'x');
  assert.match(guard.outcome(false, 'old_text was not found').stop ?? '', /6 errors in a row \(latest: old_text was not found\)/u);
  assert.deepEqual([guard.commandResult('pytest', 'E boom'), guard.commandResult('pytest', 'E boom'), guard.commandResult('pytest', 'E boom')], [1, 2, 3]);
  assert.equal(guard.commandResult('pytest', ''), 0, 'A passing run clears the failure count.');
  assert.equal(guard.commandResult('pytest', 'E boom'), 1);
  for (let index = 0; index < 6; index++) guard.edited('src/cli_config.py');
  assert.deepEqual(guard.topEdits(), [['src/cli_config.py', 6]]);
  assert.deepEqual([guard.firstReport('fail:pytest'), guard.firstReport('fail:pytest')], [true, false], 'Each stall is reported once.');
  const report = progressReport({ failing: { command: 'pytest tests/test_cli.py', count: 3, error: 'E   AssertionError: assert 1 == 0' }, edits: guard.topEdits(), open: [{ quote: 'be documented alongside the other built-in commands', change: '', file: 'docs/cli.rst' }], commandsLeft: 6, siblings: ['run_command'] });
  assert.match(report, /^Progress check:\n- pytest tests\/test_cli\.py has failed 3 times in a row with the same error: E {3}AssertionError: assert 1 == 0\n- Edits since the plan: src\/cli_config\.py ×6\n- Still open: "be documented alongside the other built-in commands"\n- Commands left in this request: 6\nChoose one and say which: \(a\) step back and change approach, comparing with how run_command is defined, registered and tested; \(b\) ask the user with ask_user_question/u);
});

test('placeholder comments for left-out code are found in any comment style, but not real code or lines already in the file', async () => {
  const { placeholderLine, checkPlanCoverage } = await import('../out/context/plan.js');
  assert.deepEqual(placeholderLine('import json\n# ... (rest of imports)\n', 'import os\n'), { line: 2, text: '# ... (rest of imports)' });
  assert.equal(placeholderLine('    // … existing code …\n', '')?.line, 1);
  assert.equal(placeholderLine('<!-- ... -->\n', '')?.line, 1);
  assert.equal(placeholderLine('def f():\n    ...\n', ''), undefined, "Python's Ellipsis body is code, not a comment.");
  assert.equal(placeholderLine('>>> f(\n... 1)\n# loading...\n', ''), undefined, 'A doctest continuation or a comment ending in dots is not a placeholder.');
  assert.equal(placeholderLine('x = 1\n# ... see below\n', 'a\n# ... see below\n'), undefined, 'A line already in the file is kept, not refused.');
  const refused = checkPlanCoverage('Add a command.\nIt\nmust appear in help', [{ quote: 'Add a command', change: 'add', file: 'a.py' }]);
  assert.ok(!refused.ok && refused.message.includes('"It must appear in help"'), 'Line breaks in the request are shown as spaces, so the model can copy the words.');
});

test('@-mentions: paths and names are found, e-mail addresses and trailing punctuation are not; a definition block covers decorators and its body', async () => {
  const { parseMentions, looksLikePath, definitionBlock, definitionPattern } = await import('../out/context/projectContext.js');
  assert.deepEqual(parseMentions('Look at @src/flask/cli.py, then @routes_command. Mail a@b.com or @"docs/my file.rst" and @/tests/test_cli.py!'), ['src/flask/cli.py', 'routes_command', 'docs/my file.rst', 'tests/test_cli.py']);
  assert.deepEqual([looksLikePath('src/flask/cli.py'), looksLikePath('README.md'), looksLikePath('routes_command'), looksLikePath('FlaskGroup.make_context')], [true, true, false, false]);
  const python = ['import x', '', '@click.command("routes")', '@with_appcontext', 'def routes_command():', '    """Show routes."""', '', '    for row in rows:', '        echo(row)', '', '', 'cli = FlaskGroup()'];
  assert.deepEqual(definitionBlock(python, 5), [3, 9], 'Decorators above and the indented body below, not the next top-level statement.');
  const js = ['export function load(a) {', '  return a;', '}', 'const other = 1;'];
  assert.deepEqual(definitionBlock(js, 1), [1, 3], 'The closing brace belongs to the block.');
  assert.match('    def routes_command(self):', new RegExp(definitionPattern('routes_command')));
  assert.doesNotMatch('    self.add_command(routes_command)', new RegExp(definitionPattern('routes_command')), 'A use is not a definition.');
});

test('untouched code: deleting a definition the request does not name is found, lines removed inside one are counted, moves and named changes are allowed', async () => {
  const { codeRemovedOutsideRequest, definitionNames } = await import('../out/context/projectContext.js');
  const before = ['@click.command("routes")', 'def routes_command():', '    rows = []', '    rows.insert(0, headers)', '    widths = [1]', '    echo(rows)', '', '', 'class TestRoutes:', '    def test_simple(self):', '        assert 1', '', '    def test_sort(self):', '        assert 2', ''].join('\n');
  const existing = definitionNames(before);
  const request = 'Add a new built-in CLI command flask config that prints the configuration as JSON.';
  // The live run's two mistakes: old_text used as an anchor and not repeated, so the anchor lines were deleted.
  const anchor = before.replace('    rows.insert(0, headers)\n    widths = [1]\n', 'def config_command():\n    echo(config)\n');
  assert.deepEqual(codeRemovedOutsideRequest({ before, after: anchor, existing, request }), { definitions: [], inside: [{ name: 'routes_command', lines: 2 }] });
  const header = before.replace('class TestRoutes:\n', 'class TestConfig:\n    def test_config(self):\n        assert 3\n');
  assert.deepEqual(codeRemovedOutsideRequest({ before, after: header, existing, request }).definitions, ['TestRoutes']);
  const gone = before.replace('    def test_simple(self):\n        assert 1\n\n', '');
  assert.deepEqual(codeRemovedOutsideRequest({ before, after: gone, existing, request }).definitions, ['test_simple']);
  // Allowed: adding next to existing code, moving a definition, changing what the request names, removing the agent's own code.
  const added = before.replace('    echo(rows)\n', '    echo(rows)\n\n\ndef config_command():\n    echo(config)\n');
  assert.deepEqual(codeRemovedOutsideRequest({ before, after: added, existing, request }), { definitions: [], inside: [] });
  const moved = ['class TestRoutes:', '    def test_simple(self):', '        assert 1', '', '    def test_sort(self):', '        assert 2', '', '', '@click.command("routes")', 'def routes_command():', '    rows = []', '    rows.insert(0, headers)', '    widths = [1]', '    echo(rows)', ''].join('\n');
  assert.deepEqual(codeRemovedOutsideRequest({ before, after: moved, existing, request }).definitions, []);
  assert.deepEqual(codeRemovedOutsideRequest({ before, after: gone, existing, request: 'Remove test_simple, it is obsolete.' }).definitions, [], 'A definition the request names may be removed.');
  assert.deepEqual(codeRemovedOutsideRequest({ before, after: gone, existing: new Set(['routes_command', 'TestRoutes']), request }).definitions, [], 'Code the agent added in this request is its own to remove.');
});

test('a failing command stays unresolved until the same command passes; a narrower command passing does not clear it', async () => {
  const { unresolvedFailures } = await import('../out/context/plan.js');
  // The live run: bare pytest not found, the full file failing, then only "-k config" run and passing.
  const results = new Map([['pytest tests/test_cli.py', 127], ['.venv/bin/pytest tests/test_cli.py', 1], ['.venv/bin/pytest tests/test_cli.py -k config', 0]]);
  assert.deepEqual(unresolvedFailures(results, '.venv/bin/pytest tests/test_cli.py -k config'), [{ command: '.venv/bin/pytest tests/test_cli.py', exitCode: 1 }]);
  results.delete('.venv/bin/pytest tests/test_cli.py'); results.set('.venv/bin/pytest tests/test_cli.py', 0);
  assert.deepEqual(unresolvedFailures(results, '.venv/bin/pytest tests/test_cli.py'), [], 'Running the same command again and passing clears it.');
  assert.deepEqual(unresolvedFailures(new Map([['pytest', 127]]), 'pytest'), [{ command: 'pytest', exitCode: 127 }], 'A last command that was not found still counts: nothing was checked.');
});
