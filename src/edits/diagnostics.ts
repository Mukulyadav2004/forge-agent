// New problems after a save. The idea follows Cline's apps/vscode/src/integrations/diagnostics (getNewDiagnostics,
// Apache-2.0, commit 7a7878cb52fc33967d8b464b3e3d899beac42d4d): compare the editor's diagnostics before and after
// an edit and report only what is new. This is Forge's own code; nothing is copied.

/** One error VS Code reports for a file (from whatever language servers are installed), reduced to what the agent needs. */
export interface Problem { line: number; message: string; source?: string }

export const PROBLEM_LIMITS = { max_problems: 10, message_characters: 200 };

/**
 * Problems present after a save that were not there before. Matched by source and message, not position, because an
 * edit moves the lines below it; a problem that appears more often than before counts as new.
 */
export function newProblems(before: Problem[], after: Problem[]): Problem[] {
  const key = (problem: Problem) => `${problem.source ?? ''}\0${problem.message}`;
  const remaining = new Map<string, number>();
  for (const problem of before) remaining.set(key(problem), (remaining.get(key(problem)) ?? 0) + 1);
  return after.filter(problem => {
    const count = remaining.get(key(problem)) ?? 0;
    if (count === 0) return true;
    remaining.set(key(problem), count - 1);
    return false;
  });
}

/** The lines added to a saved edit's or a command's result, or '' when there are none. */
export function describeProblems(path: string, problems: Problem[]): string {
  if (!problems.length) return '';
  const shown = [...problems].sort((a, b) => a.line - b.line).slice(0, PROBLEM_LIMITS.max_problems)
    .map(problem => `${problem.line}: ${problem.source ? `[${problem.source}] ` : ''}${problem.message.replace(/\s+/gu, ' ').slice(0, PROBLEM_LIMITS.message_characters)}`);
  const more = problems.length > shown.length ? `\n… ${problems.length - shown.length} more` : '';
  return `Problems in ${path} that your edits in this request introduced and VS Code still reports:\n${shown.join('\n')}${more}\nFix these first; a test run would fail on them too.`;
}
