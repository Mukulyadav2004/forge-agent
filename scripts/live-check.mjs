import { parseArgs } from 'node:util';
import { ForgeSession } from '../out/agent/ForgeSession.js';

const { values } = parseArgs({ options: {
  model: { type: 'string' },
  'base-url': { type: 'string', default: 'http://127.0.0.1:8790' },
  connector: { type: 'string', default: '' },
} });
if (!values.model) throw new Error('Pass --model with the exact provider/model name configured in TrueForge.');

let reply = '';
let completed = false;
let timedOut = false;
let failure;
const session = new ForgeSession({
  baseUrl: values['base-url'], model: values.model, connector: values.connector,
  onEvent(event) {
    if (event.type === 'model.message.delta' && event.threadId === 'main') reply += event.content ?? '';
    if (event.type === 'model.message' && event.threadId === 'main' && typeof event.content === 'string' && !reply) reply = event.content;
    if (event.type === 'turn.done') {
      completed = event.state.status === 'done';
      if (event.state.status === 'error') failure = event.state.message;
    }
  },
});
const timeout = setTimeout(() => {
  timedOut = true;
  void session.cancel().catch(() => undefined);
}, 45_000);
try {
  await session.send([{ type: 'user.message', content: 'Say hello in one short sentence. Do not call any tools.' }]);
  if (timedOut) throw new Error('Live model check timed out; cancellation was requested.');
  if (failure) throw new Error(failure);
  if (!completed || !reply.trim()) throw new Error('The turn ended without a completed assistant reply.');
  console.log(`Live TrueForge reply (${values.model}): ${reply}`);
} finally {
  clearTimeout(timeout);
}
