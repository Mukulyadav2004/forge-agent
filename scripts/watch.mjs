import { context } from 'esbuild';
import { buildStyles, webviewOptions } from './webview-build.mjs';
const builder = await context({ entryPoints: ['src/extension.ts', 'src/agent/ForgeSession.ts', 'src/context/projectContext.ts', 'src/edits/EditService.ts'], outdir: 'out', outbase: 'src', bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['vscode'], sourcemap: true });
await builder.watch();
const webview = await context({ ...webviewOptions, minify: false });
await webview.watch();
const styles = buildStyles({ watch: true });
process.on('SIGINT', () => { styles.kill(); void Promise.all([builder.dispose(), webview.dispose()]).then(() => process.exit()); });
