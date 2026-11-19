import { spawn } from 'node:child_process';
import { createWriteStream, unlink } from 'node:fs';
import type { WriteStream } from 'node:fs';

/**
 * Bounds for one agent command, following opencode's shell tool (packages/core/src/tool/plugin/shell.ts, MIT):
 * a 120 s default timeout (at most 600 s) after which a foreground command moves to the background, output capped
 * near the 50 KiB tool-output limit with the full output streamed to a file, and an optional background mode.
 * Commands run without input.
 */
export const COMMAND_LIMITS = { per_request: 3, command_characters: 2000, timeout_seconds_default: 120, timeout_seconds_max: 600, output_characters: 48 * 1024, output_lines: 1800, tail_characters: 4096, background_jobs: 4, output_file_bytes: 64 * 1024 * 1024 };

export interface CommandResult {
  exit_code: number | null;
  signal: string | null;
  timed_out: boolean;
  cancelled: boolean;
  duration_ms: number;
  output: string;
  output_truncated: boolean;
  total_output_characters: number;
  /** The file holding the full output, kept only when the output above was shortened. */
  output_path?: string;
}

export interface CommandHandle {
  readonly started: number;
  readonly result: Promise<CommandResult>;
  /** Output so far, bounded like the final result. */
  snapshot(): { output: string; output_truncated: boolean; total_output_characters: number; duration_ms: number; output_path?: string };
  /** Stops the command and its children; `timeout` records that its time ran out rather than that it was cancelled. */
  stop(reason?: 'cancel' | 'timeout'): void;
  isDone(): boolean;
}

/**
 * Starts one shell command (the user approved its exact text) in `cwd`, collecting combined stdout/stderr.
 * Output keeps the start (up to `outputCharacters` minus a short tail, and at most COMMAND_LIMITS.output_lines lines),
 * a note of how much was omitted, and the last few KiB, where errors usually are. With `outputFile`, every byte (up
 * to COMMAND_LIMITS.output_file_bytes) is also written there; the file is deleted when nothing was omitted.
 * A `timeoutSeconds` of 0 means no timeout: the caller stops it.
 */
export function startCommand(options: { command: string; cwd: string; timeoutSeconds: number; outputCharacters: number; signal?: AbortSignal; outputFile?: string }): CommandHandle {
  const started = Date.now();
  const tailLimit = Math.min(COMMAND_LIMITS.tail_characters, Math.floor(options.outputCharacters / 4));
  const headLimit = options.outputCharacters - tailLimit;
  let head = '', tail = '', total = 0, headLines = 0, headFull = false, done = false;
  let file: WriteStream | undefined, fileBytes = 0, fileUsable = false;
  if (options.outputFile) {
    file = createWriteStream(options.outputFile, { flags: 'wx', mode: 0o600 });
    fileUsable = true;
    file.on('error', () => { fileUsable = false; });
  }
  const collect = (chunk: Buffer) => {
    if (file && fileUsable && fileBytes < COMMAND_LIMITS.output_file_bytes) {
      const room = COMMAND_LIMITS.output_file_bytes - fileBytes;
      file.write(chunk.length > room ? chunk.subarray(0, room) : chunk);
      fileBytes += Math.min(chunk.length, room);
    }
    let text = chunk.toString('utf8');
    total += text.length;
    while (!headFull && text) {
      const newline = text.indexOf('\n');
      const piece = newline === -1 ? text : text.slice(0, newline + 1);
      const room = headLimit - head.length;
      if (piece.length > room) { head += piece.slice(0, room); text = text.slice(room); headFull = true; break; }
      head += piece; text = text.slice(piece.length);
      if (newline !== -1 && ++headLines >= COMMAND_LIMITS.output_lines) headFull = true;
    }
    if (text) { tail += text; if (tail.length > tailLimit * 2) tail = tail.slice(-tailLimit); }
  };
  const render = () => {
    const kept = tail.slice(-tailLimit);
    const omitted = total - head.length - kept.length;
    const saved = omitted > 0 && fileUsable && options.outputFile ? options.outputFile : undefined;
    const note = saved
      ? `… ${omitted} characters omitted; the full output${fileBytes >= COMMAND_LIMITS.output_file_bytes ? ` (first ${COMMAND_LIMITS.output_file_bytes / 1024 / 1024} MiB)` : ''} is saved to ${saved}: read_file or grep that path instead of rerunning the command …`
      : `… ${omitted} characters omitted (output is capped; narrow the command or filter its output to see more) …`;
    return { output: omitted > 0 ? `${head}\n${note}\n${kept}` : head + kept, output_truncated: omitted > 0, total_output_characters: total, ...(saved ? { output_path: saved } : {}) };
  };
  // shell: true uses /bin/sh on macOS/Linux and cmd.exe on Windows. stdin is closed so prompts cannot hang the turn.
  const child = spawn(options.command, { cwd: options.cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true, env: { ...process.env, PAGER: 'cat', GIT_PAGER: 'cat' } });
  let timedOut = false, cancelled = false;
  const stop = () => {
    if (done) return;
    // Kill the whole process group (or tree on Windows) so test runners and their children stop too.
    try {
      if (child.pid && process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => child.kill());
      else if (child.pid) process.kill(-child.pid, 'SIGTERM');
      else child.kill();
    } catch { /* already exited */ }
    setTimeout(() => { try { if (!done && child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ } }, 2000).unref();
  };
  const closeFile = (keep: boolean) => new Promise<void>(resolve => {
    if (!file) { resolve(); return; }
    const path = options.outputFile;
    file.end(() => { if (!keep && path) unlink(path, () => resolve()); else resolve(); });
    file.once('error', () => resolve());
  });
  const result = new Promise<CommandResult>((resolve, reject) => {
    const timer = options.timeoutSeconds > 0 ? setTimeout(() => { timedOut = true; stop(); }, options.timeoutSeconds * 1000) : undefined;
    const abort = () => { cancelled = true; stop(); };
    options.signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', error => {
      done = true; clearTimeout(timer); options.signal?.removeEventListener('abort', abort);
      void closeFile(false).then(() => reject(error));
    });
    child.on('close', (code, signal) => {
      done = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      const rendered = render();
      void closeFile(rendered.output_path !== undefined).then(() => resolve({ exit_code: code, signal, timed_out: timedOut, cancelled, duration_ms: Date.now() - started, ...rendered }));
    });
  });
  return {
    started, result, isDone: () => done,
    snapshot: () => ({ ...render(), duration_ms: Date.now() - started }),
    stop: reason => { if (done) return; if (reason === 'timeout') timedOut = true; else cancelled = true; stop(); },
  };
}

export function runCommand(options: { command: string; cwd: string; timeoutSeconds: number; outputCharacters: number; signal: AbortSignal; outputFile?: string }): Promise<CommandResult> {
  return startCommand(options).result;
}
