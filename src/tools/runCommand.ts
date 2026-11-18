import { spawn } from 'node:child_process';

/** Bounds for one agent command: it runs in the foreground, without input, and is stopped at its timeout. */
export const COMMAND_LIMITS = { per_request: 3, command_characters: 2000, timeout_seconds_default: 60, timeout_seconds_max: 300, output_characters: 16000 };

export interface CommandResult {
  exit_code: number | null;
  signal: string | null;
  timed_out: boolean;
  cancelled: boolean;
  duration_ms: number;
  output: string;
  output_truncated: boolean;
  total_output_characters: number;
}

/**
 * Runs one shell command (the user approved its exact text) in `cwd` and returns combined stdout/stderr.
 * Output keeps the first quarter and the last three quarters of `outputCharacters`, so errors at the end survive.
 */
export function runCommand(options: { command: string; cwd: string; timeoutSeconds: number; outputCharacters: number; signal: AbortSignal }): Promise<CommandResult> {
  const started = Date.now();
  const headLimit = Math.floor(options.outputCharacters / 4);
  const tailLimit = options.outputCharacters - headLimit;
  let head = '', tail = '', total = 0;
  const collect = (chunk: Buffer) => {
    const text = chunk.toString('utf8');
    total += text.length;
    if (head.length < headLimit) { const take = headLimit - head.length; head += text.slice(0, take); tail += text.slice(take); }
    else tail += text;
    if (tail.length > tailLimit * 2) tail = tail.slice(-tailLimit);
  };
  return new Promise((resolve, reject) => {
    // shell: true uses /bin/sh on macOS/Linux and cmd.exe on Windows. stdin is closed so prompts cannot hang the turn.
    const child = spawn(options.command, { cwd: options.cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true, env: { ...process.env, PAGER: 'cat', GIT_PAGER: 'cat' } });
    let timedOut = false, cancelled = false, finished = false;
    const stop = () => {
      // Kill the whole process group so test runners and their children stop too.
      try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM'); else child.kill(); } catch { /* already exited */ }
      setTimeout(() => { try { if (!finished && child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ } }, 2000).unref();
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, options.timeoutSeconds * 1000);
    const abort = () => { cancelled = true; stop(); };
    options.signal.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', error => { finished = true; clearTimeout(timer); options.signal.removeEventListener('abort', abort); reject(error); });
    child.on('close', (code, signal) => {
      finished = true;
      clearTimeout(timer);
      options.signal.removeEventListener('abort', abort);
      const kept = tail.slice(-tailLimit);
      const omitted = total - head.length - kept.length;
      resolve({ exit_code: code, signal, timed_out: timedOut, cancelled, duration_ms: Date.now() - started, output: omitted > 0 ? `${head}\n… ${omitted} characters omitted …\n${kept}` : head + kept, output_truncated: omitted > 0, total_output_characters: total });
    });
  });
}
