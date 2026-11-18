// Reads one TrueForge session and reports what the agent did and what went wrong, so every live run
// (scripted or by hand) gets the same checks. Read-only: it never changes the session or the workspace.
// Usage: pnpm run eval:session [session-id | --last] [--json] [--base-url http://127.0.0.1:8790]
import { pathToFileURL } from 'node:url';

const parse = text => { try { return JSON.parse(text); } catch { return undefined; } };
const refusalText = content => {
  const value = typeof content === 'string' ? parse(content) : content;
  return Array.isArray(value?.error) ? value.error.map(part => part.text ?? '').join(' ').trim() || 'error' : undefined;
};

/** Pure: events oldest first (as TrueForge stores them, `{ type, ... }`) and the session's turns. */
export function evaluateSession({ events, turns = [] }) {
  const calls = new Map();
  for (const event of events) {
    if (event.type !== 'model.message') continue;
    for (const call of event.tool_calls ?? []) calls.set(call.id, { id: call.id, name: call.function?.name ?? '?', args: parse(call.function?.arguments ?? '') ?? {}, model: event.model?.name });
  }
  const approvalsAsked = new Set(), approvalsAllowed = new Set();
  const results = new Map();
  for (const event of events) {
    if (event.type === 'tool.approval_required') for (const call of event.tool_calls ?? []) approvalsAsked.add(call.id);
    if (event.type === 'user.tool_approval' && event.approval?.status === 'allow') approvalsAllowed.add(event.tool_call_id);
    if (event.type === 'tool.response') results.set(event.tool_call_id, event.content);
  }
  const toolCounts = {};
  const refused = [], commands = [], staged = new Set(), read = new Set();
  const seen = new Map();
  for (const call of calls.values()) {
    toolCounts[call.name] = (toolCounts[call.name] ?? 0) + 1;
    const key = `${call.name} ${JSON.stringify(call.args)}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
    const content = results.get(call.id);
    const refusal = content === undefined ? undefined : refusalText(content);
    if (refusal) refused.push({ tool: call.name, message: refusal.slice(0, 200), approved: approvalsAllowed.has(call.id) });
    if (call.name === 'run_command' && !refusal) {
      const result = typeof content === 'string' ? parse(content) : content;
      commands.push({ command: String(call.args.command ?? ''), exitCode: result?.exit_code ?? null, timedOut: Boolean(result?.timed_out) });
    }
    if (call.name === 'propose_edit' && !refusal && call.args.path) staged.add(call.args.path);
    if (call.name === 'read_file' && !refusal && call.args.path) read.add(call.args.path);
  }
  const inputTokens = events.filter(event => event.type === 'model.message' && event.usage).map(event => event.usage.input_tokens);
  const models = [...new Set(events.filter(event => event.type === 'model.message' && event.model?.name).map(event => event.model.name))];
  const compactions = events.filter(event => event.type === 'thread.context_compaction_finished').map(event => ({ fromTokens: Math.round(event.trigger?.context_tokens ?? 0), durationMs: event.duration_ms }));
  const turnErrors = turns.filter(turn => turn.state?.status === 'error').map(turn => String(turn.state.message ?? '').split('\n')[0].slice(0, 160));
  const times = events.map(event => Date.parse(event.created_at)).filter(Number.isFinite);
  const report = {
    turns: turns.length, turnStatuses: turns.map(turn => turn.state?.status), models,
    durationSeconds: times.length ? Math.round((Math.max(...times) - Math.min(...times)) / 100) / 10 : 0,
    toolCalls: toolCounts, approvalsAsked: approvalsAsked.size, approvalsAllowed: approvalsAllowed.size,
    approvedThenRefused: refused.filter(item => item.approved).length, refused, commands,
    filesRead: [...read], filesStaged: [...staged],
    repeatedCalls: [...seen].filter(([, count]) => count > 1).map(([key, count]) => `${count}× ${key.slice(0, 120)}`),
    peakInputTokens: inputTokens.length ? Math.max(...inputTokens) : 0, compactions, turnErrors,
  };
  const flags = [];
  if (report.approvedThenRefused) flags.push(`${report.approvedThenRefused} approved call(s) were then refused by the editor tools`);
  if (refused.length) flags.push(`${refused.length} refused call(s): ${[...new Set(refused.map(item => item.message.split('.')[0]))].join(' | ')}`);
  const failing = commands.filter(command => command.exitCode !== 0 || command.timedOut);
  if (failing.length) flags.push(`${failing.length} of ${commands.length} command(s) failed: ${failing.map(command => `${command.command} → ${command.timedOut ? 'timed out' : `exit ${command.exitCode}`}`).join('; ')}`);
  if (report.repeatedCalls.length) flags.push(`identical calls repeated: ${report.repeatedCalls.join('; ')}`);
  if (turnErrors.some(message => /iteration limit/iu.test(message))) flags.push('the agent hit its step limit');
  const errorCounts = turnErrors.reduce((counts, message) => counts.set(message.slice(0, 100), (counts.get(message.slice(0, 100)) ?? 0) + 1), new Map());
  if (turnErrors.length) flags.push(`${turnErrors.length} turn(s) ended in an error: ${[...errorCounts].map(([message, count]) => `${count}× ${message}`).join(' | ')}`);
  if (models.length > 1) flags.push(`model changed during the session: ${models.join(' → ')}`);
  return { ...report, flags };
}

function print(id, report) {
  const line = (label, value) => console.log(`${label.padEnd(22)}${value}`);
  console.log(`Session ${id}`);
  line('Turns', `${report.turns} (${report.turnStatuses.join(', ') || 'none'}) in ${report.durationSeconds} s`);
  line('Models', report.models.join(' → ') || 'unknown');
  line('Tool calls', Object.entries(report.toolCalls).map(([name, count]) => `${name} ${count}`).join(', ') || 'none');
  line('Approvals', `${report.approvalsAsked} asked, ${report.approvalsAllowed} allowed, ${report.approvedThenRefused} allowed then refused`);
  line('Files read', report.filesRead.join(', ') || 'none');
  line('Files staged', report.filesStaged.join(', ') || 'none');
  line('Commands', report.commands.map(command => `${command.command} → ${command.timedOut ? 'timed out' : `exit ${command.exitCode}`}`).join('; ') || 'none');
  line('Peak input tokens', String(report.peakInputTokens));
  line('Compactions', report.compactions.map(item => `${item.fromTokens} tokens, ${(item.durationMs / 1000).toFixed(1)} s`).join('; ') || 'none');
  console.log(report.flags.length ? `\nProblems found:\n${report.flags.map(flag => `  - ${flag}`).join('\n')}` : '\nNo problems found by these checks.');
}

async function main() {
  const args = process.argv.slice(2);
  const option = name => { const index = args.indexOf(name); return index >= 0 ? args.splice(index, 2)[1] : undefined; };
  const json = args.includes('--json'); if (json) args.splice(args.indexOf('--json'), 1);
  const base = new URL(option('--base-url') ?? process.env.TRUEFORGE_URL ?? 'http://127.0.0.1:8790');
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) throw new Error('Use the local TrueForge URL.');
  const get = async path => { const response = await fetch(new URL(path, base)); if (!response.ok) throw new Error(`TrueForge ${response.status} for ${path}`); return response.json(); };
  let id = args[0];
  if (!id || id === '--last') id = (await get('/api/v1/sessions?limit=1')).data[0]?.id;
  if (!id) throw new Error('No sessions found. Pass a session id from the sidebar status badge.');
  const page = await get(`/api/v1/sessions/${encodeURIComponent(id)}/events?limit=500`);
  const events = page.data.map(item => item.event).sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  const turns = (await get(`/api/v1/sessions/${encodeURIComponent(id)}/turns?limit=25`)).data.reverse();
  const report = evaluateSession({ events, turns });
  if (page.data.length >= 500) report.flags.push('only the newest 500 events were read (TrueForge page limit)');
  if (json) console.log(JSON.stringify({ session: id, ...report }, null, 2)); else print(id, report);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
