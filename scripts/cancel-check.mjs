import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { model: { type: 'string' }, 'base-url': { type: 'string', default: 'http://127.0.0.1:8790' } } });
if (!values.model) throw new Error('Use pnpm run test:cancel --model provider/model.');
const base = new URL(values['base-url']);
if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) throw new Error('Use local TrueForge HTTP.');
const extension = fileURLToPath(new URL('../', import.meta.url));
const source = join(extension, 'out-test', 'task-a', 'flask');
if (!existsSync(join(source, '.git'))) throw new Error('Prepare the pinned Flask rehearsal first; it will not be modified.');
const directory = join(extension, 'out-test', 'cancel', `${Date.now()}`);
mkdirSync(directory, { recursive: true });
const workspace = join(directory, 'flask');
const clone = spawnSync('git', ['clone', '--local', '--no-hardlinks', '--quiet', source, workspace], { encoding: 'utf8' });
if (clone.error) throw new Error('Could not clone the isolated cancellation fixture.', { cause: clone.error });
if (clone.status !== 0) throw new Error(clone.stderr);
const profile = mkdtempSync(join(tmpdir(), 'forge-cancel-'));
const resultFile = join(directory, 'result.json');
const configFile = join(directory, 'config.json');
writeFileSync(configFile, JSON.stringify({ workspace, directory, resultFile, baseUrl: base.href.replace(/\/$/, ''), model: values.model }));
const server = createServer().listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
if (!address || typeof address === 'string') throw new Error('No editor debugging port.');
await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
console.log(`Live cancellation check: ${values.model}\nIsolated workspace: ${workspace}`);
let launch;
try {
  launch = spawnSync('code', ['--new-window', workspace, '--disable-workspace-trust', '--disable-extensions', '--skip-welcome', '--skip-release-notes', '--wait',
    `--extensionDevelopmentPath=${extension}`, `--extensionTestsPath=${join(extension, 'out-test', 'cancel', 'editor.js')}`, `--user-data-dir=${profile}`, `--remote-debugging-port=${address.port}`],
  { stdio: 'inherit', timeout: 180_000, env: { ...process.env, FORGE_CANCEL_CONFIG: configFile, FORGE_SMOKE_CDP_PORT: String(address.port) } });
} finally {
  if (existsSync(resultFile)) {
    const report = JSON.parse(readFileSync(resultFile, 'utf8'));
    if (typeof report.connector_name === 'string' && /^forge-editor-[0-9a-f]{12}$/.test(report.connector_name)) {
      try {
        const cleanup = await fetch(new URL(`/api/v1/settings/mcp-servers/${report.connector_name}`, base), { method: 'DELETE', signal: AbortSignal.timeout(10_000) });
        report.test_connector_removed = cleanup.ok || cleanup.status === 404;
      } catch { report.test_connector_removed = false; }
    }
    writeFileSync(resultFile, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  }
  console.log(`Evidence: ${resultFile}\nIsolated editor profile: ${profile}`);
}
if (launch?.error) throw new Error('Cancellation editor check did not complete.', { cause: launch.error });
if (launch?.status !== 0 || !existsSync(resultFile)) throw new Error('Cancellation editor check failed; inspect the retained evidence.');
if (!JSON.parse(readFileSync(resultFile, 'utf8')).passed) throw new Error('Live cancellation did not pass.');
