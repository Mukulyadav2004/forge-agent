import { build } from 'esbuild';
await build({ entryPoints: ['src/extension.ts', 'src/agent/ForgeSession.ts'], outdir: 'out', outbase: 'src', bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['vscode'], sourcemap: true });
