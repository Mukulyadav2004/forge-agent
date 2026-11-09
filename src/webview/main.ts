import { isHostMessage } from "../shared/messages.js";
import type { ChatMessage, WebviewMessage } from "../shared/messages.js";
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
  const reviewKey = JSON.stringify({ state: event.data.review, disabled: reviewDisabled });
  if (reviewPanel instanceof HTMLElement && reviewKey !== renderedReview) {
    renderReviewPanel({ container: reviewPanel, state: event.data.review, disabled: reviewDisabled, onCommand: command => vscode.postMessage({ type: 'review', command }) });
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
