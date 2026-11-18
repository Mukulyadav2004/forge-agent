import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/** esbuild options for the React sidebar webview. */
export const webviewOptions = {
  entryPoints: ['src/webview/main.tsx'],
  outfile: 'out-webview/webview/main.js',
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: 'chrome120',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  minify: true,
  sourcemap: true,
};

const require = createRequire(import.meta.url);
const tailwindCli = join(dirname(require.resolve('@tailwindcss/cli/package.json')), 'dist', 'index.mjs');

/** Runs the Tailwind CLI over src/webview/index.css. With `watch`, the process keeps rebuilding until it exits. */
export function buildStyles({ watch = false } = {}) {
  const args = [tailwindCli, '-i', 'src/webview/index.css', '-o', 'out-webview/webview/main.css', ...(watch ? ['--watch'] : ['--minify'])];
  const child = spawn(process.execPath, args, { stdio: 'inherit' });
  if (watch) return child;
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`Tailwind exited with code ${code}`)));
  });
}
