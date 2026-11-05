import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { ForgeSession } from '../out/agent/ForgeSession.js';

test('SDK session, stream, approval resume, cancellation and error handling', async () => {
  const requests = [];
  let reject = false;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    requests.push({ url: req.url, body: body ? JSON.parse(body) : null });
    if (reject) { res.writeHead(401, { 'Content-Type': 'application/json' }).end(JSON.stringify({ message: 'Invalid test credential' })); return; }
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
    const session = new ForgeSession(options);
    await session.send([{ type: 'user.message', content: 'hello' }]);
    assert.equal(session.id, 'test-session');
    assert.equal(events.filter(event => event.type === 'model.message.delta').map(event => event.content).join(''), 'Hello Forge');
    await session.send([{ type: 'user.tool_approval', threadId: 'main', toolCallId: 'tool-1', approval: { status: 'deny', reason: 'Test' } }]);
    assert.equal(requests.filter(request => request.url === '/api/v1/sessions').length, 1);
    assert.equal(requests.at(-1).body.input[0].tool_call_id, 'tool-1');
    await session.cancel();
    assert.ok(requests.at(-1).url.endsWith('/cancel'));
    reject = true;
    await assert.rejects(new ForgeSession(options).send([{ type: 'user.message', content: 'fail' }]));
    assert.throws(() => new ForgeSession({ ...options, baseUrl: 'https://example.com' }), /local/);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
