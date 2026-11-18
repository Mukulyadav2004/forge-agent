// grep and glob ported from anomalyco/opencode packages/core/src/tool/plugin/grep.ts, glob.ts and ripgrep.ts (MIT):
// ripgrep arguments, a default limit of 100 results, and the same result layout. Glob results are sorted newest
// first by modification time, as opencode's glob tool did. Secrets and VCS folders are always excluded.
import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';

export const DEFAULT_SEARCH_LIMIT = 100;
export const SEARCH_TOOL_LIMITS = { max_limit: 1000, line_characters: 2000, timeout_ms: 15_000, glob_candidates: 20_000 };
const SECRET_GLOBS = ['--glob=!**/.git/**', '--glob=!**/.env', '--glob=!**/.env.*', '--glob=!**/id_rsa*', '--glob=!**/id_ed25519*'];
const UNAVAILABLE = /(^|\/)(\.env(?:\.[^/]+)?|\.git|id_rsa|id_ed25519)(\/|$)/iu;

export interface GrepMatch { path: string; line: number; text: string }

/** Runs ripgrep and hands each stdout line to `onLine`; `onLine` returns false to stop early. */
function runRipgrep(options: { rgPath: string; cwd: string; args: string[]; signal: AbortSignal; onLine: (line: string) => boolean }): Promise<{ stopped: boolean }> {
  options.signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const signal = AbortSignal.any([options.signal, AbortSignal.timeout(SEARCH_TOOL_LIMITS.timeout_ms)]);
    const child = spawn(options.rgPath, options.args, { cwd: options.cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let pending = '', stderr = '', settled = false, stopped = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      if (child.exitCode === null && child.signalCode === null) child.kill();
      if (error) reject(error); else resolve({ stopped });
    };
    const abort = () => finish(new Error(options.signal.aborted ? 'Search cancelled.' : `Search exceeded its ${SEARCH_TOOL_LIMITS.timeout_ms / 1000}-second budget. Narrow the path or pattern.`));
    signal.addEventListener('abort', abort, { once: true });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (settled) return;
      pending += chunk;
      let newline: number;
      while ((newline = pending.indexOf('\n')) !== -1 && !settled) {
        const line = pending.slice(0, newline).replace(/\r$/u, '');
        pending = pending.slice(newline + 1);
        if (!options.onLine(line)) { stopped = true; finish(); return; }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(0, 2000); });
    child.once('error', error => finish(new Error('VS Code bundled ripgrep could not start. Check your VS Code installation.', { cause: error })));
    child.once('close', code => {
      if (!settled && pending) options.onLine(pending);
      if (code === 0 || code === 1 || settled) { finish(); return; }
      const message = stderr.trim();
      finish(new Error(/regex parse error|error parsing glob|unclosed/iu.test(message) ? `Invalid pattern: ${message.split('\n').slice(0, 6).join('\n')}` : `Search failed: ${message || `exit ${code}`}`));
    });
  });
}

const toPosix = (path: string) => path.replace(/\\/gu, '/').replace(/^\.\//u, '');

/**
 * Content search in `cwd` (or only `file` inside it). Result paths are workspace-relative: `prefix` is `cwd`
 * relative to the workspace root.
 */
export async function grepFiles(options: { rgPath: string; cwd: string; prefix: string; file?: string; pattern: string; include?: string; literal: boolean; caseSensitive: boolean; limit: number; signal: AbortSignal }): Promise<{ matches: GrepMatch[]; truncated: boolean }> {
  const matches: GrepMatch[] = [];
  let truncated = false;
  const args = ['--no-config', '--json', '--hidden', '--no-messages', ...(options.literal ? ['--fixed-strings'] : []), ...(options.caseSensitive ? [] : ['--ignore-case']), ...(options.include ? [`--glob=${options.include}`] : []), ...SECRET_GLOBS, '--', options.pattern, options.file ?? '.'];
  await runRipgrep({ rgPath: options.rgPath, cwd: options.cwd, args, signal: options.signal, onLine: line => {
    if (!line.startsWith('{"type":"match"')) return true;
    let event: { data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } } };
    try { event = JSON.parse(line) as typeof event; } catch { return true; }
    const relative = event.data?.path?.text, lineNumber = event.data?.line_number, text = event.data?.lines?.text;
    if (typeof relative !== 'string' || typeof lineNumber !== 'number' || typeof text !== 'string') return true;
    const path = toPosix(options.prefix ? `${options.prefix}/${toPosix(relative)}` : relative);
    if (UNAVAILABLE.test(path)) return true;
    if (matches.length >= options.limit) { truncated = true; return false; }
    const clean = text.replace(/\r?\n$/u, '');
    matches.push({ path, line: lineNumber, text: clean.length > SEARCH_TOOL_LIMITS.line_characters ? `${clean.slice(0, SEARCH_TOOL_LIMITS.line_characters)}...` : clean });
    return true;
  } });
  return { matches, truncated };
}

/** opencode's grep layout: a count, then each file's matches as "Line N: text". */
export function renderGrep(matches: GrepMatch[], truncated: boolean): string {
  const lines = matches.length === 0 ? ['No matches found'] : [`Found ${matches.length} matches`];
  let current = '';
  for (const match of matches) {
    if (current !== match.path) { if (current) lines.push(''); current = match.path; lines.push(`${match.path}:`); }
    lines.push(`  Line ${match.line}: ${match.text}`);
  }
  if (truncated) lines.push('', `(Results are truncated: showing first ${matches.length} results. Consider using a more specific path or pattern.)`);
  return lines.join('\n');
}

/** File path search, newest first. */
export async function globFiles(options: { rgPath: string; cwd: string; prefix: string; pattern: string; hidden: boolean; limit: number; signal: AbortSignal }): Promise<{ files: string[]; truncated: boolean }> {
  const found: string[] = [];
  let capped = false;
  const args = ['--no-config', '--files', ...(options.hidden ? ['--hidden'] : []), `--glob=${options.pattern}`, ...(options.hidden ? [] : ['--glob=!**/.*']), ...SECRET_GLOBS, '.'];
  await runRipgrep({ rgPath: options.rgPath, cwd: options.cwd, args, signal: options.signal, onLine: line => {
    if (!line) return true;
    if (found.length >= SEARCH_TOOL_LIMITS.glob_candidates) { capped = true; return false; }
    found.push(toPosix(line));
    return true;
  } });
  const dated = await Promise.all(found.filter(path => !UNAVAILABLE.test(path)).map(async path => ({ path, mtime: await stat(join(options.cwd, path)).then(info => info.mtimeMs, () => 0) })));
  dated.sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path));
  const files = dated.slice(0, options.limit).map(entry => options.prefix ? `${options.prefix}/${entry.path}` : entry.path);
  return { files, truncated: capped || dated.length > options.limit };
}

export function renderGlob(files: string[], truncated: boolean): string {
  const lines = files.length === 0 ? ['No files found'] : [...files];
  if (truncated) lines.push('', `(Results are truncated: showing first ${files.length} results. Consider using a more specific path or pattern.)`);
  return lines.join('\n');
}
