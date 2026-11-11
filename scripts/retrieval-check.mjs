import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { measureTrace } from '../out-test/retrieval/metrics.js';

const extension = fileURLToPath(new URL('../', import.meta.url));
const { values } = parseArgs({ options: { model: { type: 'string' }, 'base-url': { type: 'string', default: 'http://127.0.0.1:8790' }, 'reference-session': { type: 'string' }, 'verify-report': { type: 'string' } } });
if (values['verify-report']) {
  const saved = JSON.parse(readFileSync(values['verify-report'], 'utf8'));
  assert.equal(saved.runs.length, 5);
  assert.equal(new Set(saved.runs.map(run => run.session_id)).size, 5);
  for (const [path, hash] of Object.entries(saved.production_hashes)) assert.equal(createHash('sha256').update(readFileSync(join(extension, path))).digest('hex'), hash, `${path} changed since this baseline.`);
  for (const run of saved.runs) {
    const events = JSON.parse(readFileSync(join(dirname(values['verify-report']), `run-${run.attempt}`, 'events.json'), 'utf8'));
    const turns = events.filter(event => event.type === 'turn.created');
    assert.equal(turns.length, 1);
    assert.equal(turns[0].previous_turn_id, null);
    assert.deepEqual(turns[0].input, [{ type: 'user.message', content: saved.prompt }]);
    const metrics = measureTrace({ events, targets: ['tests/test_cli.py', 'docs/cli.rst'] });
    for (const [key, value] of Object.entries(metrics)) assert.deepEqual(run[key], JSON.parse(JSON.stringify(value)), `Run ${run.attempt}: ${key}`);
    assert.ok(run.workspace_unchanged && run.trace_complete);
  }
  console.log('Verified five saved baseline measurements against their raw tool events. No model requests.');
  process.exit(0);
}
if (!values.model) throw new Error('Use pnpm run test:retrieval --model provider/model. This makes five live model requests through local TrueForge.');
const base = new URL(values['base-url']);
assert.ok(base.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname), 'Use local TrueForge HTTP.');
const source = join(extension, 'out-test', 'task-a', 'flask');
assert.ok(existsSync(join(source, '.git')), 'Prepare the pinned Flask rehearsal first; it will not be changed.');
const directory = join(extension, 'out-test', 'retrieval', `${Date.now()}`);
mkdirSync(directory, { recursive: true });
const instruction = 'Use search_code to locate where built-in CLI commands are registered, tested and documented. Read only relevant ranges and explain your findings with source references. Do not edit files.';
const git = (args, cwd = source) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30000 });
  if (result.error) throw new Error('Fixture Git command failed.', { cause: result.error });
  assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
};
const sourceState = () => `${git(['status', '--porcelain'])}\n${git(['diff', '--binary'])}`;
const before = sourceState();
assert.equal(git(['rev-parse', 'HEAD']), '22d924701a6ae2e4cd01e9a15bbaf3946094af65');
const hashes = () => Object.fromEntries(['src/tools/EditorBridge.ts', 'src/agent/instructions.ts'].map(path => [path, createHash('sha256').update(readFileSync(join(extension, path))).digest('hex')]));
const report = { mode: 'unchanged_search_baseline', model: values.model, prompt: instruction, production_hashes: hashes(), character_definition: 'JavaScript string length of TrueForge tool.response.content, counted once per response; includes metadata and errors, excludes event envelopes. Not tokens or provider input usage.', runs: [] };
if (values['reference-session']) {
  const response = await fetch(new URL(`/api/v1/sessions/${encodeURIComponent(values['reference-session'])}/events?limit=100`, base), { signal: AbortSignal.timeout(10000) });
  assert.ok(response.ok, `Reference session lookup failed: ${response.status}`);
  const body = await response.json();
  writeFileSync(join(directory, 'reference-events.json'), JSON.stringify(body, null, 2));
  report.reference = { session_id: values['reference-session'], ...measureTrace({ events: body.data.map(row => row.event), targets: ['tests/test_cli.py', 'docs/cli.rst'] }) };
}
for (let attempt = 1; attempt <= 5; attempt++) {
  const runDirectory = join(directory, `run-${attempt}`);
  mkdirSync(runDirectory);
  const workspace = join(runDirectory, 'flask');
  git(['clone', '--local', '--no-hardlinks', '--quiet', source, workspace]);
  assert.equal(git(['status', '--porcelain'], workspace), '');
  const profile = mkdtempSync(join(tmpdir(), 'forge-retrieval-'));
  const resultFile = join(runDirectory, 'result.json');
  const configFile = join(runDirectory, 'config.json');
  const server = createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  writeFileSync(configFile, JSON.stringify({ workspace, directory: runDirectory, resultFile, baseUrl: base.href.replace(/\/$/, ''), model: values.model, instruction, attempt }));
  console.log(`Baseline ${attempt}/5: fresh Flask clone, fresh editor profile, ${values.model}`);
  const launched = spawnSync('code', ['--new-window', workspace, '--disable-workspace-trust', '--disable-extensions', '--skip-welcome', '--skip-release-notes', '--wait', `--extensionDevelopmentPath=${extension}`, `--extensionTestsPath=${join(extension, 'out-test', 'retrieval', 'editor.js')}`, `--user-data-dir=${profile}`, `--remote-debugging-port=${address.port}`], { stdio: 'inherit', timeout: 240000, env: { ...process.env, FORGE_RETRIEVAL_CONFIG: configFile, FORGE_SMOKE_CDP_PORT: String(address.port) } });
  const run = existsSync(resultFile) ? JSON.parse(readFileSync(resultFile, 'utf8')) : { attempt, measurement_complete: false, error: 'The editor did not produce a report.' };
  if (launched.error) run.launch_error = launched.error.message;
  run.editor_exit_code = launched.status;
  run.profile = profile;
  run.git_status_after = git(['status', '--porcelain'], workspace);
  if (typeof run.connector_name === 'string' && /^forge-editor-[0-9a-f]{12}$/.test(run.connector_name)) {
    try { const cleanup = await fetch(new URL(`/api/v1/settings/mcp-servers/${run.connector_name}`, base), { method: 'DELETE', signal: AbortSignal.timeout(10000) }); run.test_connector_removed = cleanup.ok || cleanup.status === 404; }
    catch (error) { run.cleanup_error = error instanceof Error ? error.message : String(error); }
  }
  writeFileSync(resultFile, JSON.stringify(run, null, 2));
  report.runs.push(run);
  writeFileSync(join(directory, 'baseline.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ attempt, session_id: run.session_id, status: run.final_turn_status, searches: run.search_calls, files_read: run.files_read, characters_returned: run.characters_returned, targets: run.targets, error: run.error }));
  assert.equal(sourceState(), before, 'The original rehearsal checkout changed.');
  assert.deepEqual(hashes(), report.production_hashes, 'Search or instructions changed during the baseline.');
}
report.measurement_complete = report.runs.every(run => run.measurement_complete && run.editor_exit_code === 0 && !run.launch_error && run.workspace_unchanged && run.git_status_after === '');
report.target_counts = Object.fromEntries(['tests/test_cli.py', 'docs/cli.rst'].map(path => [path, { appeared_in_results: report.runs.filter(run => run.targets?.[path]?.appeared_in_results).length, read: report.runs.filter(run => run.targets?.[path]?.read).length }]));
writeFileSync(join(directory, 'baseline.json'), JSON.stringify(report, null, 2));
console.log(`Baseline evidence: ${join(directory, 'baseline.json')}\n${JSON.stringify(report.target_counts)}`);
assert.ok(report.measurement_complete, 'Some measurements are incomplete; inspect each run. Missing targets are observations, not a runner failure.');
