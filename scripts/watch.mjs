import { context } from 'esbuild';
const builder = await context({ entryPoints: ['src/extension.ts', 'src/agent/ForgeSession.ts', 'src/context/projectContext.ts'], outdir: 'out', outbase: 'src', bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['vscode'], sourcemap: true });
await builder.watch();
const webview = await context({ entryPoints: ['src/webview/main.ts'], outfile: 'out-webview/webview/main.js', bundle: true, platform: 'browser', format: 'esm', target: 'chrome120', sourcemap: true });
await webview.watch();
process.on('SIGINT', () => { void Promise.all([builder.dispose(), webview.dispose()]).then(() => process.exit()); });
