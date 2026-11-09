import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const extension = fileURLToPath(new URL('../', import.meta.url));
const output = join(extension, 'out-test', 'task-a');
const workspace = join(output, 'flask');
const python = join(output, 'venv', 'bin', 'python');
const commit = '22d924701a6ae2e4cd01e9a15bbaf3946094af65';
const instruction = "Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.";
const { positionals, values } = parseArgs({ allowPositionals: true, options: { model: { type: 'string' }, 'reasoning-effort': { type: 'string' }, 'base-url': { type: 'string', default: 'http://127.0.0.1:8790' } } });
if (values['reasoning-effort'] && !['minimal', 'low', 'medium', 'high'].includes(values['reasoning-effort'])) throw new Error('Choose minimal, low, medium or high reasoning effort.');
const action = positionals[0];
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: workspace, encoding: 'utf8', timeout: 120_000, ...options });
  if (result.error) throw new Error(`Could not run ${command}.`, { cause: result.error });
  if (result.status !== 0) throw new Error(`${command} failed (${result.status}):\n${result.stderr ?? ''}\n${result.stdout ?? ''}`);
  return result.stdout?.trim() ?? '';
}
function pinned() {
  if (!existsSync(join(workspace, '.git'))) throw new Error('Run pnpm run task:a:prepare first.');
  if (run('git', ['rev-parse', 'HEAD']) !== commit) throw new Error('The rehearsal checkout is not the required Flask 3.1.3 commit.');
}
mkdirSync(output, { recursive: true });
if (action === 'prepare') {
  if (!existsSync(workspace)) run('git', ['clone', '--depth', '1', '--branch', '3.1.3', 'https://github.com/pallets/flask.git', workspace], { cwd: output, stdio: 'inherit' });
  pinned();
  if (run('git', ['status', '--porcelain'])) throw new Error('The rehearsal checkout has changes. Use Forge Undo or preserve them before preparing again.');
  if (!existsSync(python)) run('python3', ['-m', 'venv', join(output, 'venv')]);
  run(python, ['-m', 'pip', 'install', '-e', workspace, 'pytest==8.4.2', 'python-dotenv', 'asgiref'], { stdio: 'inherit' });
  const baseline = run(python, ['-c', 'from flask.helpers import get_debug_flag; print(get_debug_flag())'], { env: { ...process.env, FLASK_DEBUG: 'off' } });
  if (baseline !== 'True') throw new Error(`Unexpected untouched baseline: ${baseline}`);
  console.log(`Pinned Flask 3.1.3 at ${commit}\nWorkspace: ${workspace}\nBaseline FLASK_DEBUG=off: ${baseline}\nExact instruction: ${instruction}`);
} else if (action === 'verify') {
  pinned();
  const result = run(python, ['-c', 'from flask.helpers import get_debug_flag; print(get_debug_flag())'], { env: { ...process.env, FLASK_DEBUG: 'off' } });
  console.log(`FLASK_DEBUG=off → ${result}`);
  if (result !== 'False') throw new Error('Task A is not applied yet, or the proposed behavior is incorrect.');
  console.log(run(python, [join(extension, 'test', 'task-a', 'verify.py')]));
  console.log(run('git', ['diff', '--stat']));
} else if (action === 'open') {
  pinned();
  run('code', ['--new-window', `--extensionDevelopmentPath=${extension}`, workspace, '--goto', `${join(workspace, 'src/flask/helpers.py')}:28`], { stdio: 'inherit' });
  console.log(`Select get_debug_flag and run Forge: Edit Selection.\n${instruction}`);
} else if (action === 'test') {
  pinned();
  if (run('git', ['status', '--porcelain'])) throw new Error('The rehearsal checkout must be clean before the automated Task A run.');
  const profile = mkdtempSync(join(tmpdir(), 'forge-task-a-'));
  const resultFile = join(output, values.model ? 'live-result.json' : 'editor-result.json');
  rmSync(resultFile, { force: true });
  writeFileSync(join(output, 'config.json'), JSON.stringify({ instruction, workspace, python, commit, model: values.model, reasoningEffort: values['reasoning-effort'], baseUrl: values['base-url'], resultFile, verifier: join(extension, 'test', 'task-a', 'verify.py') }));
  const server = createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not reserve an editor test port.');
  const port = address.port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  const result = spawnSync('code', ['--new-window', workspace, '--disable-workspace-trust', '--wait', '--disable-extensions', '--skip-welcome', '--skip-release-notes',
    `--extensionDevelopmentPath=${extension}`, `--extensionTestsPath=${join(extension, 'out-test', 'task-a', 'editor.js')}`, `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`],
  { stdio: 'inherit', timeout: values.model ? 240_000 : 90_000, env: { ...process.env, FORGE_TASK_A_CONFIG: join(output, 'config.json'), FORGE_SMOKE_CDP_PORT: String(port) } });
  if (result.error) throw new Error(`Task A editor run failed. Profile retained: ${profile}`, { cause: result.error });
  if (result.status !== 0 || !existsSync(resultFile)) throw new Error(`Task A editor run failed. Profile retained: ${profile}`);
  const report = JSON.parse(readFileSync(resultFile, 'utf8'));
  const sessionId = typeof report.session_id === 'string' ? report.session_id : typeof report.trueforge_status === 'string' ? /Session ([^\s]+)/.exec(report.trueforge_status)?.[1] : undefined;
  if (values.model && sessionId) {
    const base = values['base-url'].replace(/\/$/, '');
    const eventsResponse = await fetch(`${base}/api/v1/sessions/${sessionId}/events?limit=100`, { signal: AbortSignal.timeout(10_000) });
    if (!eventsResponse.ok) throw new Error(`Could not verify the TrueForge trace: ${eventsResponse.status}`);
    const events = (await eventsResponse.json()).data.map(item => item.event);
    const reads = events.filter(event => event.type === 'tool.response' && typeof event.content === 'string').flatMap(event => {
      try { const value = JSON.parse(event.content); return typeof value.text === 'string' && typeof value.base_revision === 'string' ? [value] : []; }
      catch { return []; }
    });
    report.trueforge_received_source = reads.some(read => read.text.includes('def get_debug_flag'));
    report.read_ranges = reads.map(read => ({ path: read.path, start_line: read.start_line, end_line: read.end_line }));
    if (!report.trueforge_received_source) { report.passed = false; report.trace_error = 'The model did not receive source text through TrueForge.'; }
    const sessionResponse = await fetch(`${base}/api/v1/sessions/${sessionId}`, { signal: AbortSignal.timeout(10_000) });
    if (sessionResponse.ok) {
      const session = (await sessionResponse.json()).data;
      report.final_turn_status = session.last_turn_details?.state?.status;
      report.agent_completed_cleanly = report.final_turn_status === 'done';
      if (!report.agent_completed_cleanly) { report.passed = false; report.run_error = 'The model turn did not complete cleanly, even if the staged change passed verification.'; }
      for (const connector of session.agent?.spec?.mcp_servers ?? []) {
        if (/^forge-editor-[0-9a-f]{12}$/.test(connector.name)) {
          const cleanup = await fetch(`${base}/api/v1/settings/mcp-servers/${connector.name}`, { method: 'DELETE', signal: AbortSignal.timeout(10_000) });
          report.test_connector_removed = cleanup.ok;
        }
      }
    }
    writeFileSync(resultFile, JSON.stringify(report, null, 2));
  }
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) throw new Error(`Task A did not pass. Inspect ${resultFile}.`);
  rmSync(profile, { recursive: true, force: true });
} else throw new Error('Use a package script: task:a:prepare, task:a:open, task:a:verify, or test:task-a [--model provider/model].');
