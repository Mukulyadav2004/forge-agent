import { build } from 'esbuild';
import { buildStyles, webviewOptions } from './webview-build.mjs';
await build({ entryPoints: ['src/extension.ts', 'src/agent/ForgeSession.ts', 'src/context/projectContext.ts', 'src/edits/EditService.ts', 'src/sidebar/ReviewFeedback.ts', 'src/sidebar/TaskHistory.ts', 'src/agent/approvalText.ts'], outdir: 'out', outbase: 'src', bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['vscode'], sourcemap: true });
await build(webviewOptions);
await buildStyles();
