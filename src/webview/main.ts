import { isHostMessage } from "../shared/messages.js";
import type { ActivityEntry, ChatMessage, WebviewMessage } from "../shared/messages.js";
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

const renderedMessages = new Map<string, { text: string; article: HTMLElement; body: HTMLElement }>();

function renderMessages(options: { messages: ChatMessage[]; complete: boolean }): void {
  if (!(conversation instanceof HTMLDivElement)) {
    return;
  }

  const fragment = document.createDocumentFragment();
  if (options.messages.length === 0) {
    const emptyState = document.createElement("p");
    emptyState.className = "empty-state";
    emptyState.textContent = "Your messages will appear here.";
    fragment.append(emptyState);
  }

  const liveIds = new Set(options.messages.map(message => message.id));
  for (const id of renderedMessages.keys()) if (!liveIds.has(id)) renderedMessages.delete(id);
  for (const message of options.messages) {
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
      cached = { text: '', article, body };
      renderedMessages.set(message.id, cached);
    }
    if (cached.text !== message.text) {
      if (message.role === 'assistant') renderMarkdown({ container: cached.body, text: message.text });
      else cached.body.textContent = message.text;
      cached.text = message.text;
    }
    if (options.complete && message.role === 'assistant') void renderDiagrams(cached.body);
    fragment.append(cached.article);
  }

  conversation.replaceChildren(fragment);
  conversation.scrollTop = conversation.scrollHeight;
}

let renderedActivity = '';
const plural = (count: number, word: string, many = `${word}s`) => `${count} ${count === 1 ? word : many}`;
const where = (glob: string) => !glob || glob === '**/*' ? 'codebase' : glob;
const size = (characters: number) => characters < 1000 ? `${characters}` : characters < 10000 ? `${(characters / 1000).toFixed(1)}k` : `${Math.round(characters / 1000)}k`;

/** One row per completed editor tool call, oldest first; a file opened from a search is nested under it. Paths open the file; reasons are the agent's own words.
 * Each read, search or listing shows the characters it added; the header shows the current request's context budget. */
function renderActivity(entries: ActivityEntry[]): void {
  const feed = document.getElementById('activity-feed');
  const list = document.getElementById('activity-list');
  const count = document.getElementById('activity-count');
  const key = JSON.stringify(entries);
  if (!feed || !list || key === renderedActivity) return;
  renderedActivity = key;
  feed.hidden = entries.length === 0;
  const tally = (kind: ActivityEntry['kind']) => entries.filter(entry => entry.kind === kind).length;
  const lastRequest = entries.map(entry => entry.kind).lastIndexOf('request');
  const request = entries[lastRequest];
  const spent = entries.slice(lastRequest + 1).reduce((used, entry) => 'used' in entry && entry.used !== undefined ? entry.used : used, 0);
  const budget = request?.kind === 'request' ? `context ${size(spent)} of ${size(request.limit)} chars` : `context ${size(spent)} chars`;
  if (count) count.textContent = `(${[plural(tally('search'), 'search', 'searches'), plural(tally('open'), 'read'), plural(tally('propose'), 'proposal'), ...(tally('command') ? [plural(tally('command'), 'command')] : [])].join(', ')} · ${budget})`;
  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 24;
  const link = (path: string, line: number, label: string) => {
    const button = document.createElement('button');
    button.className = 'source-reference';
    button.textContent = label;
    button.addEventListener('click', () => vscode.postMessage({ type: 'open_file', path, line }));
    return button;
  };
  const searches = new Map<string, HTMLElement>();
  const rows: HTMLElement[] = [];
  let previousUsed = 0;
  for (const entry of entries) {
    const row = document.createElement('li');
    row.className = `activity-row activity-${entry.kind}`;
    const kind = document.createElement('span');
    kind.className = 'activity-kind';
    const notes: string[] = [];
    let main: (string | HTMLElement)[];
    switch (entry.kind) {
      case 'request':
        kind.textContent = 'New request';
        main = [`context budget ${size(entry.limit)} characters`];
        searches.clear(); previousUsed = 0;
        break;
      case 'search':
        kind.textContent = 'Searched';
        main = [`"${entry.query}" in ${where(entry.glob)}: ${plural(entry.matches, 'match', 'matches')} in ${plural(entry.fileCount, 'file')}${entry.truncated ? ' (limited)' : ''}`];
        if (entry.files.length) row.title = entry.files.join('\n');
        break;
      case 'open':
        kind.textContent = 'Opened';
        main = [link(entry.path, entry.startLine, `${entry.path}:${entry.startLine}-${entry.endLine}`)];
        if (entry.foundBy !== undefined && !searches.has(entry.foundBy)) notes.push(`found by search "${entry.foundBy}"`);
        break;
      case 'propose':
        kind.textContent = 'Proposed';
        main = [link(entry.path, 1, entry.path), ` ${entry.detail}`];
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
        main = [code, `${entry.cwd === '.' ? '' : ` in ${entry.cwd}`}: ${ended} after ${(entry.durationMs / 1000).toFixed(1)} s`];
        break;
      }
      case 'refused':
        kind.textContent = 'Refused';
        main = [`${entry.tool}: ${entry.message}`];
        break;
      case 'compaction':
        kind.textContent = entry.done ? 'Compacted' : 'Compacting';
        main = [`context ${size(entry.contextTokens)} tokens reached the ${size(entry.thresholdTokens)}-token threshold${entry.afterTokens !== undefined ? `; TrueForge summarised it to ${size(entry.afterTokens)} tokens` : entry.done ? '; TrueForge summarised it' : '…'}${entry.durationMs !== undefined ? ` in ${(entry.durationMs / 1000).toFixed(1)} s` : ''}`];
        notes.push('Earlier messages and file contents were replaced by a summary; the agent re-reads what it still needs.');
        break;
      case 'context':
        kind.textContent = 'Given';
        main = [link(entry.path, entry.startLine, `${entry.path}:${entry.startLine}-${entry.endLine}`), ' with your request'];
        break;
    }
    if ('reason' in entry && entry.reason) notes.push(entry.reason);
    if ('used' in entry && entry.used !== undefined) { if (entry.used > previousUsed) main.push(` (+${size(entry.used - previousUsed)} chars)`); previousUsed = entry.used; }
    row.append(kind, ' ', ...main);
    for (const text of notes) {
      const note = document.createElement('span');
      note.className = 'activity-note';
      note.textContent = text;
      row.append(note);
    }
    const parent = entry.kind === 'open' && entry.foundBy !== undefined ? searches.get(entry.foundBy) : undefined;
    if (parent) {
      let nested = parent.querySelector('ul');
      if (!nested) parent.append(nested = document.createElement('ul'));
      nested.append(row);
    } else rows.push(row);
    if (entry.kind === 'search') searches.set(entry.query, row);
  }
  list.replaceChildren(...rows);
  if (atBottom) list.scrollTop = list.scrollHeight;
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
  vscode.postMessage({ type: "send_message", text });
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

  renderMessages({ messages: event.data.messages, complete: !event.data.busy });
  const reviewPanel = document.getElementById('review-panel');
  const reviewDisabled = event.data.busy || event.data.approval;
  const lockNote = event.data.approval ? 'Paused until you approve or deny the request above.' : event.data.busy ? 'Paused while the agent works, so files stay put. Preview still works.' : undefined;
  const reviewKey = JSON.stringify({ state: event.data.review, disabled: reviewDisabled, lockNote });
  if (reviewPanel instanceof HTMLElement && reviewKey !== renderedReview) {
    renderReviewPanel({ container: reviewPanel, state: event.data.review, disabled: reviewDisabled, lockNote, onCommand: command => vscode.postMessage({ type: 'review', command }) });
    renderedReview = reviewKey;
  }
  const evidence = document.getElementById('file-evidence');
  const evidenceList = document.getElementById('file-evidence-list');
  if (evidence && evidenceList) {
    evidence.hidden = event.data.inspectedFiles.length === 0;
    const items = event.data.inspectedFiles.map(file => {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.className = 'source-reference';
      button.textContent = `${file.path}:${file.startLine}-${file.endLine}${file.origin === 'context' ? ' · supplied context' : ''}`;
      button.addEventListener('click', () => vscode.postMessage({ type: 'open_file', path: file.path, line: file.startLine }));
      item.append(button);
      return item;
    });
    evidenceList.replaceChildren(...items);
  }
  renderActivity(event.data.activity);
  if (awaitingAck && input instanceof HTMLTextAreaElement) {
    input.value = "";
    vscode.setState({ draft: "" });
  }
  awaitingAck = false;
  pending = event.data.busy || event.data.approval || event.data.review.busy;
  if (status) status.textContent = event.data.status;
  if (cancel instanceof HTMLButtonElement) cancel.disabled = !event.data.busy && !event.data.approval;
  if (approve instanceof HTMLButtonElement) { approve.hidden = !event.data.approval; approve.disabled = event.data.busy; }
  if (deny instanceof HTMLButtonElement) { deny.hidden = !event.data.approval; deny.disabled = event.data.busy; }
  updateComposer();
});

updateComposer();
vscode.postMessage({ type: "ready" });
