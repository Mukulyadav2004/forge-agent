// The coding plan: one requirement per thing the user's request asks for, the file each will change, and an existing
// similar thing to copy. Pure functions, so the checks are the same for every model and testable without VS Code.

export interface PlanItem { quote: string; change: string; file: string; sibling?: string; skip_reason?: string }
export type PlanStatus = 'planned' | 'changed' | 'skipped' | 'open';

export const PLAN_LIMITS = { max_items: 12, quote_characters: 300, max_quote_share: 0.6, open_items_shown: 6 };

/** Common words that carry no requirement; a requirement word is a longer word not in this list. */
const STOPWORDS = new Set(['that', 'this', 'with', 'from', 'into', 'must', 'should', 'would', 'could', 'have', 'also', 'which', 'their', 'them',
  'then', 'than', 'each', 'when', 'will', 'your', 'what', 'where', 'there', 'these', 'those', 'make', 'sure', 'please', 'other', 'like', 'some',
  'only', 'very', 'such', 'more', 'most', 'just', 'does', 'been', 'being', 'were', 'they', 'well', 'onto', 'over', 'under', 'about']);

/** The user's words as shown back in a message: line breaks in the request become spaces, so a quote copied from it matches. */
const oneLine = (text: string) => text.replace(/\s+/gu, ' ').trim();
const normalize = (text: string) => text.toLowerCase().replace(/[“”"'`]/gu, '').replace(/\s+/gu, ' ').trim();
const words = (text: string) => normalize(text).match(/[\p{L}\p{N}_-]{4,}/gu)?.filter(word => !STOPWORDS.has(word)) ?? [];
/** The request split into its sentences (a comma does not end a part, so a list such as "A, B or C" stays whole). */
const clauses = (request: string) => request.split(/(?<=[.!?;])\s+/u).map(part => part.trim().replace(/^(?:and|or|but)\s+/iu, '')).filter(part => words(part).length > 0);
/** A text as its words only, so punctuation and spacing differences ("TOKEN, or KEY" / "TOKEN or KEY") do not matter. */
const wordKey = (text: string) => ` ${(normalize(text).match(/[\p{L}\p{N}_]+/gu) ?? []).join(' ')} `;

/**
 * The plan must cover the user's own words: each quote is part of the request (word for word, punctuation aside), no
 * quote takes over most of it, and every requirement word of the request appears in some quote. What is missing is
 * named as words, with the sentence they are in, so the model can add a requirement for that part.
 */
export function checkPlanCoverage(request: string, items: PlanItem[]): { ok: true } | { ok: false; message: string } {
  const text = normalize(request);
  if (!text) return { ok: true };
  const requestKey = wordKey(request);
  for (const [index, item] of items.entries()) {
    const quote = normalize(item.quote);
    const key = wordKey(item.quote);
    if (!key.trim() || !requestKey.includes(key)) return { ok: false, message: `Requirement ${index + 1} quotes words that are not in the user's request: "${oneLine(item.quote).slice(0, 120)}". Copy the user's words for that part.` };
    if (items.length === 1 && clauses(request).length > 1 && quote.length > text.length * PLAN_LIMITS.max_quote_share) {
      return { ok: false, message: 'Split the request into one requirement per thing it asks for (for example the feature, its test and its documentation), each quoting the user\'s words for that part.' };
    }
  }
  const covered = new Set(items.flatMap(item => words(item.quote)));
  const missing = new Set(words(request).filter(word => !covered.has(word)));
  if (!missing.size) return { ok: true };
  const parts = clauses(request).flatMap(part => {
    const named = [...new Set((oneLine(part).match(/[\p{L}\p{N}_-]{4,}/gu) ?? []).filter(word => missing.has(word.toLowerCase())))];
    return named.length ? [`${named.join(', ')} (in: "${oneLine(part).slice(0, 200)}")`] : [];
  });
  return { ok: false, message: `Your plan does not yet cover these words of the request: ${parts.join('; ')}. Add a requirement for that part, quoting the user's words, with the file you will change (or a skip_reason if nothing needs to change).` };
}

const cleanPath = (path: string) => path.trim().replace(/\\/gu, '/').replace(/^\.\//u, '');

export function itemStatus(item: PlanItem, changed: ReadonlySet<string>): PlanStatus {
  if (item.skip_reason?.trim()) return 'skipped';
  return changed.has(cleanPath(item.file)) ? 'changed' : 'open';
}

/** One line for tool results while the agent works; empty when there is no plan. */
export function checklistLine(items: PlanItem[] | undefined, changed: ReadonlySet<string>): string {
  if (!items?.length) return '';
  const open = items.filter(item => itemStatus(item, changed) === 'open');
  if (!open.length) return `Checklist: all ${items.length} requirement(s) have a change or a stated reason.`;
  const shown = open.slice(0, PLAN_LIMITS.open_items_shown).map(item => `"${item.quote.slice(0, 80)}" (planned: ${item.file})`).join('; ');
  return `Checklist: ${items.length - open.length} of ${items.length} requirement(s) have a change. Still open: ${shown}.`;
}

/** The lines that identify a failure, without timings, addresses or counts that change between identical runs. */
export function failureSignature(output: string): string {
  return output.split('\n')
    .filter(line => /error|exception|traceback|failed|assert|no such|not found|cannot|invalid/iu.test(line))
    .map(line => line.replace(/0x[0-9a-f]+/giu, '0x').replace(/\d+(?:\.\d+)?\s*(?:s|ms|seconds?)\b/giu, 'T').replace(/\s+/gu, ' ').trim())
    .slice(-8).join('\n');
}

// Run guard. Loops and error streaks follow Cline's safety model (sdk/packages/core/src/runtime/safety:
// loop-detection.ts soft 3 / hard 5 identical consecutive calls; mistake-tracker.ts 6 errors in a row, reset by any
// success), written here as Forge's own code. Stalls (the same failure again, many edits to one file) are not stopped:
// the model gets a progress report with the facts and chooses how to go on.
export const GUARD_LIMITS = { identical_notice: 3, identical_stop: 5, errors_stop: 6, same_failure_report: 3, file_edits_report: 6 };

function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortKeys);
  return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map(key => [key, sortKeys((value as Record<string, unknown>)[key])]));
}
/** Same tool and same arguments, whatever the key order. */
export function callSignature(name: string, input: unknown): string { return `${name}\0${JSON.stringify(sortKeys(input))}`; }

export class RunGuard {
  private lastCall = '';
  private identical = 0;
  private errors = 0;
  private readonly failures = new Map<string, { signature: string; count: number }>();
  private readonly edits = new Map<string, number>();
  private readonly reported = new Set<string>();
  reset(): void { this.lastCall = ''; this.identical = 0; this.errors = 0; this.failures.clear(); this.edits.clear(); this.reported.clear(); }
  /** Before a call: a note at the third identical call in a row, a stop at the fifth. */
  call(name: string, input: unknown): { notice?: string; stop?: string } {
    const signature = callSignature(name, input);
    this.identical = signature === this.lastCall ? this.identical + 1 : 1;
    this.lastCall = signature;
    if (this.identical >= GUARD_LIMITS.identical_stop) return { stop: `the agent made the same ${name} call ${this.identical} times in a row.` };
    if (this.identical === GUARD_LIMITS.identical_notice) return { notice: `You have made this exact ${name} call ${this.identical} times in a row. It will give the same result; try a different approach.` };
    return {};
  }
  /** After a call: errors in a row stop the turn at the limit; any success resets the count. */
  outcome(ok: boolean, latest = ''): { stop?: string } {
    this.errors = ok ? 0 : this.errors + 1;
    return this.errors >= GUARD_LIMITS.errors_stop ? { stop: `the agent ran into ${this.errors} errors in a row (latest: ${latest.slice(0, 160)}).` } : {};
  }
  /** A command result: how many times in a row it failed the same way (0 when it passed or failed differently from before). */
  commandResult(command: string, signature: string): number {
    if (!signature) { this.failures.delete(command); return 0; }
    const previous = this.failures.get(command);
    const count = previous?.signature === signature ? previous.count + 1 : 1;
    this.failures.set(command, { signature, count });
    return count;
  }
  edited(path: string): number { const count = (this.edits.get(path) ?? 0) + 1; this.edits.set(path, count); return count; }
  topEdits(): Array<[string, number]> { return [...this.edits].sort((a, b) => b[1] - a[1]).slice(0, 3); }
  /** Each stall is reported once, so the report is a prompt to decide, not noise. */
  firstReport(key: string): boolean { if (this.reported.has(key)) return false; this.reported.add(key); return true; }
}

/** The facts of a stall and three ways on; the model chooses one and says which. */
export function progressReport(facts: { failing?: { command: string; count: number; error: string }; edits: Array<[string, number]>; open: PlanItem[]; commandsLeft: number; siblings: string[] }): string {
  const lines = ['Progress check:'];
  if (facts.failing) lines.push(`- ${facts.failing.command.slice(0, 120)} has failed ${facts.failing.count} times in a row with the same error: ${facts.failing.error.split('\n').pop()?.slice(0, 160) ?? ''}`);
  if (facts.edits.length) lines.push(`- Edits since the plan: ${facts.edits.map(([path, count]) => `${path} ×${count}`).join(', ')}`);
  lines.push(facts.open.length ? `- Still open: ${facts.open.map(item => `"${item.quote.slice(0, 70)}"`).join('; ')}` : '- Every requirement has a change.');
  lines.push(`- Commands left in this request: ${facts.commandsLeft}`);
  lines.push(`Choose one and say which: (a) step back and change approach${facts.siblings.length ? `, comparing with how ${facts.siblings.join(', ')} is defined, registered and tested` : ''}; (b) ask the user with ask_user_question, naming the options you see; (c) stop and summarize what works, what still fails, and why.`);
  return lines.join('\n');
}

/**
 * A comment line that stands in for code left out, such as "# ... (rest of imports)" or "// ... existing code ...":
 * a comment marker followed by an ellipsis. Saved as-is it deletes or breaks the code it replaced, whatever the model or
 * language. A line already in the file is not a placeholder. Returns the first such line with its number in new_text.
 */
export function placeholderLine(newText: string, currentText: string): { line: number; text: string } | undefined {
  const existing = new Set(currentText.split('\n').map(line => line.trim()));
  const lines = newText.split('\n');
  const index = lines.findIndex(line => /^\s*(?:#|\/\/|\/\*|<!--|--|;|\*)\s*(?:\.{3}|…)/u.test(line) && !existing.has(line.trim()));
  return index < 0 ? undefined : { line: index + 1, text: (lines[index] ?? '').trim().slice(0, 120) };
}

/**
 * Commands whose latest run in this request failed. A different or narrower command passing later does not clear one;
 * only running the same command again does. "Command not found" (126/127) is a wrong path to retry, not a failing check,
 * unless it was the last command.
 */
export function unresolvedFailures(results: ReadonlyMap<string, number | null>, last?: string): Array<{ command: string; exitCode: number | null }> {
  return [...results].filter(([command, code]) => code !== 0 && (command === last || (code !== 126 && code !== 127))).map(([command, exitCode]) => ({ command, exitCode }));
}
