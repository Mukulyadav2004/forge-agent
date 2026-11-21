import { diffLines } from 'diff';

/** A tool call as the model sent it, remembered so its approval prompt can say exactly what it will do. */
export interface PendingToolCall { name: string; arguments: string }

/**
 * With deferred tool loading the model reaches an editor tool through TrueForge's call_tool, whose arguments are
 * { mcp_server, tool_name, input }. Approvals and edit staging read the underlying tool's name and arguments.
 */
export function unwrapDeferredCall(call: PendingToolCall): PendingToolCall {
  if (call.name !== 'call_tool') return call;
  let parsed: unknown;
  try { parsed = JSON.parse(call.arguments); } catch { return call; }
  if (typeof parsed !== 'object' || parsed === null) return call;
  const { tool_name: name, input } = parsed as { tool_name?: unknown; input?: unknown };
  if (typeof name !== 'string' || !name || (input !== undefined && (typeof input !== 'object' || input === null || Array.isArray(input)))) return call;
  return { name, arguments: JSON.stringify(input ?? {}) };
}

/** Rebuilds streamed tool calls: TrueForge sends a call as deltas, the first naming it and later ones adding argument text by index. */
export class StreamedToolCalls {
  private readonly calls = new Map<string, PendingToolCall & { id?: string }>();
  private readonly complete = new Map<string, PendingToolCall>();
  add(messageId: string, parts: readonly { index: number; id?: string; function?: { name?: string; arguments?: string } }[]): void {
    for (const part of parts) {
      const key = `${messageId}:${part.index}`;
      const call = this.calls.get(key) ?? { name: '', arguments: '' };
      this.calls.set(key, { id: part.id ?? call.id, name: call.name + (part.function?.name ?? ''), arguments: (call.arguments + (part.function?.arguments ?? '')).slice(0, 1_000_000) });
      if (this.calls.size > 100) this.calls.delete(this.calls.keys().next().value as string);
    }
  }
  /** The finished model message has the full name and arguments. Prefer it over streamed fragments. */
  remember(messageId: string, calls: readonly { id: string; function: { name: string; arguments: string }; toolInfo: { type: string; name: string } }[]): void {
    for (const call of calls) {
      const name = call.toolInfo.type === "truefoundry-system" ? call.toolInfo.name : call.function.name;
      this.complete.set(`${messageId}:${call.id}`, { name, arguments: call.function.arguments.slice(0, 1_000_000) });
    }
  }
  /** An approval names the call id and the message that produced it. */
  find(sourceEventId: string, id: string): PendingToolCall | undefined {
    const finished = this.complete.get(`${sourceEventId}:${id}`);
    if (finished) return unwrapDeferredCall(finished);
    for (const [key, call] of this.calls) if (key.startsWith(`${sourceEventId}:`) && call.id === id) return unwrapDeferredCall({ name: call.name, arguments: call.arguments });
    return undefined;
  }
  clear(): void { this.calls.clear(); this.complete.clear(); }
}

const clip = (text: string, limit: number) => text.length > limit ? `${text.slice(0, limit)}…` : text;
const signed = (text: string, sign: string) => text === '' ? [] : text.replace(/\n$/u, '').split('\n').map(line => `${sign} ${line.length > 200 ? `${line.slice(0, 200)}…` : line}`);
const CONTEXT_LINES = 3;
/** Old and new text compared line by line: only changed lines get "-" or "+"; unchanged lines keep a space and long unchanged runs shrink to nearby context. */
function comparedLines(removed: string, added: string): string[] {
  const withEnd = (text: string) => text === '' || text.endsWith('\n') ? text : `${text}\n`;
  const changes = diffLines(withEnd(removed), withEnd(added), { timeout: 150, maxEditLength: 2000 });
  // Too complex to compare within the time limit: show every old line removed and every new line added, as before.
  if (!changes) return [...signed(removed, '-'), ...signed(added, '+')];
  return changes.flatMap((change, index) => {
    if (change.added) return signed(change.value, '+');
    if (change.removed) return signed(change.value, '-');
    const same = signed(change.value, ' ');
    const first = index === 0, last = index === changes.length - 1;
    const keep = (first ? 0 : CONTEXT_LINES) + (last ? 0 : CONTEXT_LINES);
    if (same.length <= keep + 1) return same;
    const head = first ? [] : same.slice(0, CONTEXT_LINES), tail = last ? [] : same.slice(-CONTEXT_LINES);
    return [...head, `  … ${same.length - head.length - tail.length} unchanged line(s)`, ...tail];
  });
}
/** A bounded diff block of the proposed text, so the user sees the edit before approving it. */
function previewBlock(options: { removed?: string; added: string; label: string }): string {
  const all = options.removed === undefined ? signed(options.added, '+') : comparedLines(options.removed, options.added);
  const shown = all.slice(0, 40);
  const body = [...shown, ...(all.length > shown.length ? [`… ${all.length - shown.length} more line(s) not shown`] : [])].join('\n');
  const fence = '`'.repeat(Math.max(3, ...(body.match(/`+/gu) ?? []).map(run => run.length + 1)));
  return `\n\n${options.label}\n\n${fence}diff\n${body || '(no lines)'}\n${fence}`;
}
const lineCount = (text: string) => text === '' ? 0 : text.replace(/\n$/u, '').split('\n').length;

/** Markdown shown in the chat when TrueForge pauses for approval. Built only from the call's own arguments. */
export function describeApproval(call: PendingToolCall | undefined, options: { saveOnApprove?: boolean } = {}): string {
  if (!call) return '**Approve this tool call?** Its details were not received, so deny it unless you expected it.';
  let args: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(call.arguments);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
  } catch { /* unparsable arguments are shown raw below */ }
  const text = (key: string) => typeof args[key] === 'string' ? args[key] : undefined;
  const number = (key: string) => typeof args[key] === 'number' ? args[key] : undefined;
  const command = text('command');
  if (call.name === 'run_command' && command !== undefined) {
    // Show the whole command; a fence longer than any backtick run inside it keeps it intact.
    const fence = '`'.repeat(Math.max(3, ...(command.match(/`+/gu) ?? []).map(run => run.length + 1)));
    const reason = clip((text('reason') ?? '').trim(), 300) || 'none given';
    return `**Approve running a command?**\n\n${fence}sh\n${command}\n${fence}\n\n- Folder: \`${text('cwd') ?? '.'}\` (inside the workspace)\n- Stops after: ${number('timeout_seconds') ?? 60} s\n- Agent's reason: ${reason}\n\nIt runs with your permissions and can change files; Forge cannot undo what a command does. Deny it if you are unsure.`;
  }
  if (call.name === 'write_file' && text('path') !== undefined) {
    const content = text('content') ?? '';
    const why = clip((text('explanation') ?? '').trim(), 300) || 'none given';
    const preview = previewBlock({ added: content, label: 'New file content:' });
    return options.saveOnApprove
      ? `**Review this new file, then approve to create it**\n\n- File: \`${text('path')}\` (new, ${lineCount(content)} line(s))\n- Agent's reason: ${why}${preview}\n\n**Approve** creates the file so the agent can use it; **Deny** discards it. Nothing is written before you approve, and **Undo last apply** removes it again.`
      : `**Approve staging a new file?**\n\n- File: \`${text('path')}\` (new, ${lineCount(content)} line(s))\n- Agent's reason: ${why}${preview}\n\nApproving only stages it for review. Nothing is written until you accept it.`;
  }
  if (call.name !== 'propose_edit' || text('path') === undefined) return `**Approve \`${call.name}\`?**\n\nArguments: \`${clip(call.arguments, 300).replace(/`/gu, "'")}\``;
  const start = number('start_line'), end = number('end_line'), insert = number('insert_line'), oldText = text('old_text');
  const added = lineCount(text('new_text') ?? '');
  const change = oldText !== undefined ? `replace one matched passage of ${lineCount(oldText)} line(s) with ${added} line(s)`
    : insert !== undefined ? `insert ${added} line(s) at line ${insert}`
    : start !== undefined ? `replace lines ${start}–${end ?? start} with ${added} line(s)`
    : `replace the whole file (${added} line(s))`;
  const reason = clip((text('explanation') ?? '').trim(), 300) || 'none given';
  // Same checks as propose_edit in EditorBridge: a call that fails them stages nothing.
  const invalid = oldText !== undefined ? undefined
    : (start === undefined) !== (end === undefined) ? 'it gives only one of start_line and end_line'
    : start !== undefined && insert !== undefined ? 'it asks both to replace lines and to insert' : undefined;
  const note = invalid ? `\n\n**The editor will refuse this call:** ${invalid}. Nothing will be staged either way; approving returns the exact error so the agent can correct the call, while denying only says it was declined.` : '';
  const newText = text('new_text') ?? '';
  const preview = oldText !== undefined ? previewBlock({ removed: oldText, added: newText, label: 'Proposed change:' })
    : insert !== undefined ? previewBlock({ added: newText, label: `Lines inserted at line ${insert}:` })
    : start !== undefined ? previewBlock({ added: newText, label: `Lines ${start}–${end ?? start} become:` })
    : previewBlock({ added: newText, label: 'New file content:' });
  if (options.saveOnApprove) {
    // The edit is already staged: Review changes holds its hunks and the editor shows the diff.
    return `**Review this edit, then approve to save it**\n\n- File: \`${text('path')}\`\n- Change: ${change}\n- Agent's reason: ${reason}${preview}\n\nIn **Review changes** below, keep or drop each hunk (Reject hunk drops it). **Approve** saves every hunk you did not reject, so the agent can test it; **Deny** discards the edit. Nothing is written before you approve, and **Undo last apply** restores the saved files.`;
  }
  return `**Approve staging an edit?**\n\n- File: \`${text('path')}\`\n- Change: ${change}\n- Agent's reason: ${reason}${note}${preview}\n\nApproving only stages a diff for review. Nothing is written until you accept it.`;
}
