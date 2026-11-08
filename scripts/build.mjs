import { build } from 'esbuild';
await build({ entryPoints: ['src/extension.ts', 'src/agent/ForgeSession.ts', 'src/context/projectContext.ts', 'src/edits/EditService.ts'], outdir: 'out', outbase: 'src', bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['vscode'], sourcemap: true });
await build({ entryPoints: ['src/webview/main.ts'], outfile: 'out-webview/webview/main.js', bundle: true, platform: 'browser', format: 'esm', target: 'chrome120', sourcemap: true });
