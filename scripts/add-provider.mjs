// Adds a model provider to local TrueForge from an example file. ${NAME} placeholders are filled from environment variables,
// so keys stay in your shell and in TrueForge, never in a file in this repository.
import { readFileSync } from 'node:fs';

const [file, baseUrl = process.env.TRUEFORGE_URL ?? 'http://127.0.0.1:8790'] = process.argv.slice(2);
if (!file) throw new Error('Usage: pnpm run trueforge:add-provider <examples/model-provider.*.json> [base-url]');
const url = new URL(baseUrl);
if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('Use the local TrueForge URL.');
const body = readFileSync(file, 'utf8').replace(/\$\{([A-Z0-9_]+)\}/gu, (_, name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} in your environment first, for example: export ${name}=...`);
  return value.replace(/["\\]/gu, '\\$&');
});
const response = await fetch(new URL('/api/v1/settings/model-providers', url), { method: 'PUT', headers: { 'content-type': 'application/json' }, body });
const result = await response.json().catch(() => ({}));
if (!response.ok) throw new Error(`TrueForge refused the provider (${response.status}): ${result?.error?.message ?? 'no details'}`);
const models = await fetch(new URL('/api/v1/models', url)).then(r => r.json());
const name = result?.data?.name ?? JSON.parse(body).manifest.type;
console.log(`Added provider ${name}. Models now available:\n${models.data.map(model => `  ${model.name}`).filter(line => line.includes(`${name}/`)).join('\n')}`);
