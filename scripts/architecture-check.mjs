import { parseArgs } from 'node:util';
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { TrueForge } from '@truefoundry/trueforge-sdk';
import { ForgeSession } from '../out/agent/ForgeSession.js';
import { buildProjectContext } from '../out/context/projectContext.js';

const { values } = parseArgs({ options: {
  model: { type: 'string' }, connector: { type: 'string' },
  'base-url': { type: 'string', default: 'http://127.0.0.1:8790' },
  workspace: { type: 'string' },
} });
if (!values.model || !values.connector) throw new Error('Pass --model and --connector for the open project. This makes one real architecture request through TrueForge.');
let failure;
let context = { text: '', files: [] };
if (values.workspace) {
  const root = resolve(values.workspace);
  const paths = [];
  const ignored = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', 'dist', 'out']);
  async function walk(directory = '') {
    for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
      if (paths.length >= 500) return;
      if (entry.name.startsWith('.') || ignored.has(entry.name)) continue;
      const path = directory ? `${directory}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) paths.push(path);
    }
  }
  await walk();
  context = await buildProjectContext({ paths, readFile: path => readFile(join(root, path), 'utf8') });
}
const session = new ForgeSession({ baseUrl: values['base-url'], model: values.model, connector: values.connector,
  onEvent(event) {
    if (event.type === 'turn.done' && event.state.status === 'error') failure = event.state.message;
  },
});
const timeout = setTimeout(() => { void session.cancel().catch(() => undefined); }, 180_000);
try {
  const request = 'Inspect this project and make an architecture map. Verify the important relationships against implementation files, cite the source, and identify important discrepancies between the documentation and the implemented behavior. Do not edit any files or run commands.';
  await session.send([{ type: 'user.message', content: context.text ? `${request}\n\n${context.text}` : request }]);
  if (failure) throw new Error(failure);
  const client = new TrueForge({ baseUrl: values['base-url'], maxRetries: 0 });
  const events = [];
  for await (const item of await client.sessions.listEvents(session.id, { limit: 100 })) events.push(item.event);
  const calls = new Map();
  for (const event of events) {
    if (event.type !== 'model.message') continue;
    for (const call of event.toolCalls ?? []) {
      let args;
      try { args = JSON.parse(call.function.arguments); } catch { continue; }
      calls.set(call.id, { name: call.toolInfo.name, args });
    }
  }
  const inspected = new Set();
  for (const event of events) {
    if (event.type !== 'tool.response') continue;
    const call = calls.get(event.toolCallId);
    if (call?.name !== 'read_file' || typeof call.args?.path !== 'string') continue;
    let failed = false;
    try { failed = JSON.parse(event.content)?.isError === true; } catch { /* Text results are permitted. */ }
    if (!failed) inspected.add(call.args.path);
  }
  const responses = events.filter(event => event.type === 'model.message' && event.threadId === 'main' && typeof event.content === 'string');
  const report = responses.find(event => event.content.includes('```mermaid'))?.content ?? '';
  const checks = {
    model: values.model,
    source_files_available: [...new Set([...inspected, ...context.files.map(file => file.path)])].filter(path => /\.(?:py|tsx?|jsx?|go|rs|java|rb|c|cpp)$/u.test(path)),
    source_files_supplied: context.files.map(file => file.path),
    files_read_via_tools: [...inspected],
    mermaid_present: report.includes('```mermaid'),
    source_links_present: /\]\([^\s)]+#L\d+\)/u.test(report),
    no_openui: !/```openui/iu.test(report),
    session_id: session.id,
  };
  await mkdir(new URL('../out-test/', import.meta.url), { recursive: true });
  await writeFile(new URL('../out-test/architecture-report.md', import.meta.url), report);
  await writeFile(new URL('../out-test/architecture-result.json', import.meta.url), JSON.stringify(checks, null, 2));
  console.log(JSON.stringify(checks, null, 2));
  if (checks.source_files_available.length < 3 || !checks.mermaid_present || !checks.source_links_present || !checks.no_openui) throw new Error('Architecture coverage/format checks did not pass; inspect out-test/architecture-report.md.');
} finally { clearTimeout(timeout); }
