import { dirname, join, resolve } from 'node:path';

/** The nearest directory at or above `start` that holds `.git` (a directory, or a worktree's file). */
export function findGitRoot(start: string, exists: (absolutePath: string) => boolean): string | undefined {
  let current = resolve(start);
  for (let step = 0; step < 64; step++) {
    if (exists(join(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
  return undefined;
}

/** OpenCode's core/date and core/environment built-in instructions (packages/core/src/instructions/builtins.ts). */
export function environmentInstructions(options: { date: Date; workspaceRoot?: string; gitRoot?: string; platform: string }): string {
  const lines = [`Today's date: ${options.date.toDateString()}`, '', 'Here is some useful information about the environment you are running in:', '<env>'];
  if (options.workspaceRoot) {
    lines.push(`  Working directory: ${options.workspaceRoot}`);
    lines.push(`  Workspace root folder: ${options.gitRoot ?? options.workspaceRoot}`);
  } else lines.push('  Working directory: (no folder is open)');
  lines.push(`  Is directory a git repo: ${options.gitRoot ? 'yes' : 'no'}`);
  lines.push(`  Platform: ${options.platform}`);
  lines.push('</env>');
  return lines.join('\n');
}

/** OpenCode's model identity block (packages/core/src/plugin/identity.ts). TrueForge names models provider/model. */
export function modelIdentity(model: string): string {
  const slash = model.indexOf('/');
  const provider = slash > 0 ? model.slice(0, slash) : 'unknown';
  const id = slash > 0 ? model.slice(slash + 1) : model;
  return ['# Your Model', `- Name: ${model}`, `- Provider ID: ${provider}`, `- Model ID: ${id}`].join('\n');
}
