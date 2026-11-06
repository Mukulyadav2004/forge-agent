import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { ForgeSession, listModelNames } from '../out/agent/ForgeSession.js';
import { buildProjectContext, isArchitectureRequest } from '../out/context/projectContext.js';

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
  const options = { baseUrl: `http://127.0.0.1:${address.port}`, model: 'test/model', connector: 'forge-editor', onEvent: event => events.push(event) };
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
    assert.equal(events.filter(event => event.type === 'model.message.delta').map(event => event.content).join(''), 'Hello Forge');
    await session.send([{ type: 'user.tool_approval', threadId: 'main', toolCallId: 'tool-1', approval: { status: 'deny', reason: 'Test' } }]);
    assert.equal(requests.filter(request => request.url === '/api/v1/sessions').length, 1);
    assert.equal(requests.at(-1).body.input[0].tool_call_id, 'tool-1');
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
