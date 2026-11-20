import { isHostMessage } from "../shared/messages.js";
import type { ActivityEntry, AgentQuestion, ChatMessage, ChatTab, ComposerSelection, WebviewMessage } from "../shared/messages.js";
import { renderDiagrams, renderMarkdown } from './markdown.js';
import { renderReviewPanel } from './reviewPanel.js';

interface WebviewApi {
  postMessage(message: WebviewMessage): void;
  getState(): unknown;
  setState(state: { draft: string }): void;
}

declare function acquireVsCodeApi(): WebviewApi;

const vscode = acquireVsCodeApi();
const form = document.getElementById("message-form");
const input = document.getElementById("message-input");
const sendButton = document.getElementById("send-button");
const conversation = document.getElementById("messages");

if (
  !(form instanceof HTMLFormElement) ||
  !(input instanceof HTMLTextAreaElement) ||
  !(sendButton instanceof HTMLButtonElement) ||
  !(conversation instanceof HTMLDivElement)
) {
  throw new Error("The Forge Agent sidebar is missing a required element.");
}

let pending = false;
let attached: ComposerSelection[] = [];

function chipName(selection: ComposerSelection): string {
  const name = selection.path.split(/[\\/]/u).pop() || selection.path;
  return `${name}:${selection.startLine}-${selection.endLine}`;
}

function renderAttachment(): void {
  const box = document.getElementById('composer-context');
  if (!(box instanceof HTMLElement)) return;
  box.replaceChildren();
  box.hidden = attached.length === 0;
  attached.forEach((selection, index) => {
    const chip = document.createElement('div');
    chip.className = 'context-chip';
    chip.title = `${selection.path}:${selection.startLine}-${selection.endLine}`;
    const label = document.createElement('span');
    label.textContent = chipName(selection);
    const type = document.createElement('span');
    type.className = 'chip-type';
    type.textContent = (/\.([^./\\]+)$/u.exec(selection.path)?.[1] ?? '').slice(0, 3).toUpperCase();
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.title = 'Remove selection';
    remove.setAttribute('aria-label', `Remove ${chipName(selection)}`);
    remove.textContent = '×';
    remove.addEventListener('click', () => {
      attached = attached.filter((_, item) => item !== index);
      renderAttachment();
      vscode.postMessage({ type: 'clear_selection', index });
    });
    chip.append(type, label, remove);
    box.append(chip);
  });
}

let renderedChats = '';

/** Fills the composer ring from the latest request: characters read, out of that request's limit. */
let questionKey = "";
function renderQuestions(questions: AgentQuestion[]): void {
  const box = document.getElementById("agent-questions");
  if (!(box instanceof HTMLElement)) return;
  const key = JSON.stringify(questions);
  if (key === questionKey) return;
  questionKey = key;
  box.replaceChildren();
  box.hidden = questions.length === 0;
  if (!questions.length) return;
  const picked = new Map<string, string>();
  const submit = document.createElement("button");
  submit.type = "button";
  submit.className = "question-send";
  submit.textContent = "Send answer";
  submit.disabled = true;
  for (const [index, question] of questions.entries()) {
    const card = document.createElement("fieldset");
    card.className = "question-card";
    const legend = document.createElement("legend");
    legend.textContent = questions.length > 1 ? `Question ${index + 1}` : "Question";
    const prompt = document.createElement("p");
    prompt.textContent = question.question;
    card.append(legend, prompt);
    question.options.forEach((option, optionIndex) => {
      const choice = document.createElement("button");
      choice.type = "button";
      choice.className = "choice";
      choice.textContent = `${String.fromCharCode(65 + optionIndex)}. ${option}`;
      choice.setAttribute("role", "radio");
      choice.setAttribute("aria-checked", "false");
      choice.addEventListener("click", () => {
        picked.set(question.toolCallId, option);
        card.querySelectorAll(".choice").forEach(button => button.setAttribute("aria-checked", button === choice ? "true" : "false"));
        submit.disabled = picked.size !== questions.length;
      });
      card.append(choice);
    });
    box.append(card);
  }
  submit.addEventListener("click", () => {
    submit.disabled = true;
    vscode.postMessage({ type: "answer_question", answers: [...picked].map(([toolCallId, choice]) => ({ toolCallId, choice })) });
  });
  box.append(submit);
}

function renderContextMeter(activity: ActivityEntry[]): void {
  const meter = document.getElementById('context-meter');
  const value = meter?.querySelector('.meter-value');
  if (!(meter instanceof HTMLElement) || !(value instanceof SVGCircleElement)) return;
  let limit = 0;
  let used = 0;
  for (const entry of activity) {
    if (entry.kind === 'request') { limit = entry.limit; used = 0; }
    else if ('used' in entry && entry.used !== undefined) used = entry.used;
  }
  const ratio = limit > 0 ? Math.min(1, used / limit) : 0;
  const length = 2 * Math.PI * 6;
  value.style.strokeDasharray = String(length);
  value.style.strokeDashoffset = String(length * (1 - ratio));
  const label = limit > 0
    ? `Context window: ${used.toLocaleString('en-US')} of ${limit.toLocaleString('en-US')} characters (${Math.round(ratio * 100)}%)`
    : 'Context window: empty until the next request';
  meter.title = label;
  meter.setAttribute('aria-label', label);
}

function renderChats(chats: ChatTab[]): void {
  const list = document.getElementById('chat-list');
  if (!(list instanceof HTMLElement)) return;
  const key = chats.map(chat => `${chat.id}:${chat.title}:${chat.active}:${chat.busy}`).join('|');
  if (key === renderedChats) return;
  renderedChats = key;
  list.replaceChildren();
  for (const chat of chats) {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = chat.busy ? 'chat-tab busy' : 'chat-tab';
    tab.textContent = chat.title;
    tab.title = chat.title;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', chat.active ? 'true' : 'false');
    tab.addEventListener('click', () => vscode.postMessage({ type: 'select_chat', id: chat.id }));
    list.append(tab);
  }
}

document.getElementById('new-chat-button')?.addEventListener('click', () => vscode.postMessage({ type: 'new_chat' }));
document.getElementById('spin-agents-button')?.addEventListener('click', () => {
  const draft = input instanceof HTMLTextAreaElement ? input.value : '';
  vscode.postMessage({ type: 'spin_agents', text: draft });
});
document.getElementById('add-selection-button')?.addEventListener('click', () => {
  vscode.postMessage({ type: 'add_selection' });
});
document.getElementById("copy-mcp-button")?.addEventListener("click", () => {
  vscode.postMessage({ type: "copy_mcp_connection" });
});
document.getElementById("select-model-button")?.addEventListener("click", () => {
  vscode.postMessage({ type: "select_model" });
});
let awaitingAck = false;
let renderedReview = '';
const status = document.getElementById("status");
const cancel = document.getElementById("cancel-button");
const approve = document.getElementById("approve-button");
const deny = document.getElementById("deny-button");
cancel?.addEventListener("click", () => vscode.postMessage({ type: "cancel" }));
approve?.addEventListener("click", () => vscode.postMessage({ type: "approve", allow: true }));
deny?.addEventListener("click", () => vscode.postMessage({ type: "approve", allow: false }));
const savedState = vscode.getState();
if (
  typeof savedState === "object" &&
  savedState !== null &&
  "draft" in savedState &&
  typeof savedState.draft === "string"
) {
  input.value = savedState.draft;
}

function updateComposer(): void {
  if (input instanceof HTMLTextAreaElement && sendButton instanceof HTMLButtonElement) {
    input.disabled = pending;
    sendButton.disabled = pending || input.value.trim().length === 0;
  }
}

const renderedMessages = new Map<string, { text: string; thinking: string; article: HTMLElement; body: HTMLElement; thought?: HTMLDetailsElement }>();

/** A chat message element, reused while its text is unchanged so Markdown and diagrams are not rebuilt on every update. */
function messageElement(message: ChatMessage, complete: boolean): HTMLElement {
  let cached = renderedMessages.get(message.id);
  if (!cached) {
    const article = document.createElement("article");
    article.className = `message message-${message.role}`;
    const author = document.createElement("h2");
    author.className = 'message-author';
    author.textContent = message.role === "user" ? "You" : "Forge";
    const body = document.createElement("div");
    body.className = message.role === 'assistant' ? 'markdown-body' : 'user-text';
    article.append(author, body);
    cached = { text: '', thinking: '', article, body };
    renderedMessages.set(message.id, cached);
  }
  // The model's reasoning, collapsed above the reply, as plain text (never Markdown or HTML).
  if (message.role === 'assistant' && message.thinking && cached.thinking !== message.thinking) {
    if (!cached.thought) {
      cached.thought = document.createElement('details');
      cached.thought.className = 'thinking';
      const summary = document.createElement('summary');
      summary.textContent = 'Thinking';
      const text = document.createElement('div');
      text.className = 'thinking-text';
      cached.thought.append(summary, text);
      cached.body.before(cached.thought);
    }
    const text = cached.thought.querySelector('.thinking-text');
    if (text) text.textContent = message.thinking;
    cached.thinking = message.thinking;
  }
  if (cached.text !== message.text) {
    if (message.role === 'assistant') renderMarkdown({ container: cached.body, text: message.text });
    else cached.body.textContent = message.text;
    cached.text = message.text;
  }
  if (complete && message.role === 'assistant') void renderDiagrams(cached.body);
  return cached.article;
}

const plural = (count: number, word: string, many = `${word}s`) => `${count} ${count === 1 ? word : many}`;
const where = (glob: string) => !glob || glob === '**/*' ? 'codebase' : glob;
const size = (characters: number) => characters < 1000 ? `${characters}` : characters < 10000 ? `${(characters / 1000).toFixed(1)}k` : `${Math.round(characters / 1000)}k`;
const sourceLink = (path: string, line: number, label: string) => {
  const button = document.createElement('button');
  button.className = 'source-reference';
  button.textContent = label;
  button.addEventListener('click', () => vscode.postMessage({ type: 'open_file', path, line }));
  return button;
};

/** One line for one completed tool call. Paths open the file; reasons are the agent's own words; `added` is the context it cost. */
function activityRow(entry: Exclude<ActivityEntry, { kind: 'request' }>, added: number, nested: boolean): HTMLElement {
  const row = document.createElement('div');
  row.className = `activity-row activity-${entry.kind}`;
  const kind = document.createElement('span');
  kind.className = 'activity-kind';
  const notes: string[] = [];
  let main: (string | HTMLElement)[];
  switch (entry.kind) {
    case 'search':
      kind.textContent = 'Searched';
      main = [`"${entry.query}" in ${where(entry.glob)}: ${plural(entry.matches, 'match', 'matches')} in ${plural(entry.fileCount, 'file')}${entry.truncated ? ' (limited)' : ''}`];
      if (entry.files.length) row.title = entry.files.join('\n');
      break;
    case 'open':
      kind.textContent = 'Opened';
      main = [sourceLink(entry.path, entry.startLine, `${entry.path}:${entry.startLine}-${entry.endLine}`)];
      if (entry.foundBy !== undefined && !nested) notes.push(`found by search "${entry.foundBy}"`);
      break;
    case 'propose':
      kind.textContent = 'Edit';
      main = [sourceLink(entry.path, 1, entry.path), ` ${entry.detail}`];
      break;
    case 'list':
      kind.textContent = 'Listed';
      main = [`${where(entry.glob)}: ${plural(entry.count, 'file')}`];
      break;
    case 'command': {
      kind.textContent = 'Ran';
      const code = document.createElement('code');
      code.textContent = entry.command.length > 200 ? `${entry.command.slice(0, 200)}…` : entry.command;
      code.title = entry.command;
      const ended = entry.cancelled ? 'cancelled' : entry.timedOut ? 'timed out' : `exit ${entry.exitCode ?? 'signal'}`;
      main = [code, `${entry.cwd === '.' ? '' : `in ${entry.cwd} · `}${ended} after ${(entry.durationMs / 1000).toFixed(1)} s`];
      if (entry.cancelled || entry.timedOut || entry.exitCode !== 0) row.classList.add('activity-failed');
      break;
    }
    case 'refused':
      kind.textContent = 'Refused';
      main = [`${entry.tool}: ${entry.message}`];
      row.classList.add('activity-failed');
      break;
    case 'compaction':
      kind.textContent = entry.done ? 'Compacted' : 'Compacting';
      main = [`context ${size(entry.contextTokens)} tokens reached the ${size(entry.thresholdTokens)}-token threshold${entry.afterTokens !== undefined ? `; TrueForge summarised it to ${size(entry.afterTokens)} tokens` : entry.done ? '; TrueForge summarised it' : '…'}${entry.durationMs !== undefined ? ` in ${(entry.durationMs / 1000).toFixed(1)} s` : ''}`];
      notes.push('Earlier messages and file contents were replaced by a summary; the agent re-reads what it still needs.');
      break;
    case 'context':
      kind.textContent = 'Given';
      main = [sourceLink(entry.path, entry.startLine, `${entry.path}:${entry.startLine}-${entry.endLine}`), ' with your request'];
      break;    case 'plan': {
      // The agent's plan: each requirement in the user's words, the file it chose, and the existing code it copies.
      kind.textContent = entry.stage === 'start' ? 'Plan' : 'Checklist';
      const open = entry.items.filter(item => item.status === 'open').length;
      main = [entry.stage === 'start' ? `${plural(entry.items.length, 'requirement')}, each with the file the agent chose` : open ? `${open} of ${entry.items.length} requirement(s) still without a change` : `all ${entry.items.length} requirement(s) done`];
      if (entry.stage === 'end' && open) row.classList.add('activity-failed');
      const list = document.createElement('ul');
      list.className = 'plan-items';
      for (const item of entry.items) {
        const li = document.createElement('li');
        li.className = `plan-item plan-${item.status}`;
        const mark = { planned: '•', changed: '✓', skipped: '–', open: '○' }[item.status];
        li.append(`${mark} "${item.quote}" → `, sourceLink(item.file, 1, item.file), item.sibling ? ` (like ${item.sibling})` : '', item.note ? ` — ${item.note}` : '');
        list.append(li);
      }
      main.push(list);
      // What the last command really returned, so the outcome is visible whatever the summary says.
      if (entry.lastCommand) { notes.push(entry.lastCommand); if (!/→ exit 0$/u.test(entry.lastCommand)) row.classList.add('activity-failed'); }
      break;
    }
  }
  if ('reason' in entry && entry.reason) notes.push(entry.reason);
  if (added > 0) main.push(` (+${size(added)} chars)`);
  row.append(kind, ' ', ...main);
  for (const text of notes) {
    const note = document.createElement('span');
    note.className = 'activity-note';
    note.textContent = text;
    row.append(note);
  }
  return row;
}

/** Collapsed or expanded by the user, by group; groups start open. */
const openGroups = new Map<string, boolean>();
const EXPLORING = new Set<ActivityEntry['kind']>(['search', 'open', 'list', 'context']);

/**
 * The whole task as one scroll, oldest first: each message, then what happened after it.
 * Consecutive searches and reads collapse into one "Forge read … searched …" block; commands, staged edits,
 * refusals and compaction stand alone. A request line shows that request's context budget.
 */
function renderTimeline(options: { messages: ChatMessage[]; activity: ActivityEntry[]; complete: boolean; working?: boolean }): void {
  if (!(conversation instanceof HTMLDivElement)) return;
  const liveIds = new Set(options.messages.map(message => message.id));
  for (const id of renderedMessages.keys()) if (!liveIds.has(id)) renderedMessages.delete(id);
  const after = new Map<number, HTMLElement[]>(); // elements shown after that many messages
  const place = (at: number, element: HTMLElement) => after.set(at, [...(after.get(at) ?? []), element]);
  const spent = new Map<number, number>();
  let request = -1;
  options.activity.forEach((entry, index) => {
    if (entry.kind === 'request') request = index;
    else if ('used' in entry && entry.used !== undefined) spent.set(request, entry.used);
  });
  interface Group { at: number; list: HTMLElement; summary: HTMLElement; searches: Map<string, HTMLElement>; paths: Set<string>; counts: Record<string, number>; added: number }
  const groups: Group[] = [];
  let group: Group | undefined;
  let previousUsed = 0;
  options.activity.forEach((entry, index) => {
    const at = Math.min(entry.at ?? options.messages.length, options.messages.length);
    if (entry.kind === 'request') {
      group = undefined; previousUsed = 0;
      const line = document.createElement('div');
      line.className = 'activity-request';
      // The budget is enforced in characters (the same for every model); tokens are shown beside it: an estimate
      // (characters ÷ 4) and, once known, the input tokens TrueForge reported for the latest model call.
      const chars = spent.get(index) ?? 0;
      line.textContent = `New request · context ${size(chars)} of ${size(entry.limit)} chars${chars ? ` (≈ ${size(Math.round(chars / 4))} tokens)` : ''}${entry.inputTokens ? ` · model input ${size(entry.inputTokens)} tokens` : ''}`;
      line.title = 'Characters that Forge\'s tools returned in this request; the budget is enforced in characters, the same for every model. ≈ tokens is characters ÷ 4. Model input is the token count TrueForge reported for the latest model call.';
      place(at, line);
      return;
    }
    const added = 'used' in entry && entry.used !== undefined ? Math.max(0, entry.used - previousUsed) : 0;
    if ('used' in entry && entry.used !== undefined) previousUsed = entry.used;
    if (!EXPLORING.has(entry.kind)) {
      group = undefined;
      const card = activityRow(entry, added, false);
      card.classList.add('activity-card');
      place(at, card);
      return;
    }
    if (!group || group.at !== at) {
      const details = document.createElement('details');
      details.className = 'activity-group';
      const key = `${at}:${JSON.stringify(entry)}`;
      details.open = openGroups.get(key) ?? true;
      details.addEventListener('toggle', () => openGroups.set(key, details.open));
      const summary = document.createElement('summary');
      const list = document.createElement('div');
      list.className = 'activity-list';
      details.append(summary, list);
      group = { at, list, summary, searches: new Map(), paths: new Set(), counts: {}, added: 0 };
      groups.push(group);
      place(at, details);
    }
    const parent = entry.kind === 'open' && entry.foundBy !== undefined ? group.searches.get(entry.foundBy) : undefined;
    const row = activityRow(entry, added, parent !== undefined);
    if (parent) {
      let nested = parent.querySelector<HTMLElement>(':scope > .activity-nested');
      if (!nested) { nested = document.createElement('div'); nested.className = 'activity-nested'; parent.append(nested); }
      nested.append(row);
    } else group.list.append(row);
    if (entry.kind === 'search') group.searches.set(entry.query, row);
    if (entry.kind === 'open' || entry.kind === 'context') group.paths.add(entry.path);
    group.counts[entry.kind] = (group.counts[entry.kind] ?? 0) + 1;
    group.added += added;
  });
  for (const item of groups) {
    const count = (kind: string) => item.counts[kind] ?? 0;
    const parts = [
      ...(count('context') ? [`was given ${plural(count('context'), 'range')}`] : []),
      ...(count('open') ? [`read ${plural(item.paths.size, 'file')}`] : []),
      ...(count('search') ? [`searched ${plural(count('search'), 'time')}`] : []),
      ...(count('list') ? [`listed files ${plural(count('list'), 'time')}`] : []),
    ];
    item.summary.textContent = `Forge ${parts.join(', ')}${item.added ? ` · +${size(item.added)} chars` : ''}`;
  }
  const fragment = document.createDocumentFragment();
  if (options.messages.length === 0 && options.activity.length === 0) {
    const emptyState = document.createElement("p");
    emptyState.className = "empty-state";
    emptyState.textContent = "Your messages will appear here.";
    fragment.append(emptyState);
  }
  fragment.append(...(after.get(0) ?? []));
  options.messages.forEach((message, index) => fragment.append(messageElement(message, options.complete), ...(after.get(index + 1) ?? [])));
  // While the agent works (not while it waits for the user), the end of the conversation says so, as Cline does.
  if (options.working) {
    const working = document.createElement('p');
    working.className = 'thinking-indicator';
    working.setAttribute('role', 'status');
    working.textContent = 'Thinking';
    fragment.append(working);
  }
  conversation.replaceChildren(fragment);
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!(input instanceof HTMLTextAreaElement) || pending) {
    return;
  }

  const text = input.value.trim();
  if (text.length === 0) {
    return;
  }

  pending = true;
  awaitingAck = true;
  updateComposer();
  vscode.postMessage({ type: "send_message", text, ...(attached.length ? { selections: attached } : {}) });
});

conversation.addEventListener('click', event => {
  if (!(event.target instanceof Element)) return;
  const link = event.target.closest('a');
  if (!link) return;
  event.preventDefault();
  const href = link.getAttribute('href') ?? '';
  if (!href || href.startsWith('#') || /^(?:[a-z][a-z0-9+.-]*:|\/\/|\/)/iu.test(href)) return;
  const match = /^(.*?)(?:#L(\d+))?$/u.exec(href);
  if (!match?.[1]) return;
  try { vscode.postMessage({ type: 'open_file', path: decodeURIComponent(match[1]), line: Number(match[2] ?? 1) }); }
  catch { return; }
});

input.addEventListener("input", () => {
  if (input instanceof HTMLTextAreaElement) {
    vscode.setState({ draft: input.value });
    updateComposer();
  }
});

input.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && form instanceof HTMLFormElement) {
    event.preventDefault();
    form.requestSubmit();
  }
});

window.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (!isHostMessage(event.data)) {
    return;
  }
  if (event.data.type === 'focus_composer') {
    if (input instanceof HTMLTextAreaElement) input.focus();
    return;
  }
  if (event.data.type === 'attach_selection') {
    attached = event.data.selections;
    renderAttachment();
    if (input instanceof HTMLTextAreaElement) input.focus();
    return;
  }

  // Follow new output only when the reader is already at the bottom, so scrolling back to read is not interrupted.
  const scroller = document.getElementById('task-content');
  const following = !scroller || scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 48;
  renderChats(event.data.chats);
  renderQuestions(event.data.questions);
  renderContextMeter(event.data.activity);
  renderTimeline({ messages: event.data.messages, activity: event.data.activity, complete: !event.data.busy, working: event.data.busy && !event.data.approval && event.data.questions.length === 0 });
  const reviewPanel = document.getElementById('review-panel');
  const reviewWasHidden = reviewPanel?.hidden ?? true;
  // A paused turn waits on the user, so review stays open: an edit's approval is decided here, hunk by hunk.
  const reviewDisabled = event.data.busy;
  const lockNote = event.data.approval ? 'The agent is waiting: keep or reject hunks here, then Approve or Deny below.' : event.data.busy ? 'Paused while the agent works, so files stay put. Preview still works.' : undefined;
  const reviewKey = JSON.stringify({ state: event.data.review, disabled: reviewDisabled, lockNote });
  if (reviewPanel instanceof HTMLElement && reviewKey !== renderedReview) {
    renderReviewPanel({ container: reviewPanel, state: event.data.review, disabled: reviewDisabled, lockNote, onCommand: command => vscode.postMessage({ type: 'review', command }) });
    renderedReview = reviewKey;
  }
  if (scroller && following) scroller.scrollTop = scroller.scrollHeight;
  else if (reviewPanel && reviewWasHidden && !reviewPanel.hidden) reviewPanel.scrollIntoView({ block: 'nearest' });
  if (awaitingAck && input instanceof HTMLTextAreaElement) {
    input.value = "";
    attached = [];
    renderAttachment();
    vscode.setState({ draft: "" });
  }
  awaitingAck = false;
  pending = event.data.busy || event.data.approval || event.data.review.busy || event.data.questions.length > 0;
  if (status) status.textContent = event.data.status;
  if (cancel instanceof HTMLButtonElement) cancel.disabled = !event.data.busy && !event.data.approval;
  if (approve instanceof HTMLButtonElement) { approve.hidden = !event.data.approval; approve.disabled = event.data.busy; }
  if (deny instanceof HTMLButtonElement) { deny.hidden = !event.data.approval; deny.disabled = event.data.busy; }
  updateComposer();
});

updateComposer();
vscode.postMessage({ type: "ready" });
