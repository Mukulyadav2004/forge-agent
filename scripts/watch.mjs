import { context } from 'esbuild';
import { spawn } from 'node:child_process';
const builder = await context({ entryPoints: ['src/extension.ts', 'src/agent/ForgeSession.ts'], outdir: 'out', outbase: 'src', bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['vscode'], sourcemap: true });
await builder.watch();
const webview = spawn('pnpm', ['exec', 'tsc', '--project', 'tsconfig.webview.json', '--watch'], { stdio: 'inherit' });
process.on('SIGINT', () => { webview.kill(); void builder.dispose().then(() => process.exit()); });
