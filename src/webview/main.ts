import { isHostMessage } from "../shared/messages.js";
import type { ChatMessage, WebviewMessage } from "../shared/messages.js";

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
let awaitingAck = false;
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

function renderMessages(messages: ChatMessage[]): void {
  if (!(conversation instanceof HTMLDivElement)) {
    return;
  }

  const fragment = document.createDocumentFragment();
  if (messages.length === 0) {
    const emptyState = document.createElement("p");
    emptyState.className = "empty-state";
    emptyState.textContent = "Your messages will appear here.";
    fragment.append(emptyState);
  }

  for (const message of messages) {
    const article = document.createElement("article");
    article.className = `message message-${message.role}`;
    const author = document.createElement("h2");
    author.textContent = message.role === "user" ? "You" : "Forge";
    const text = document.createElement("p");
    text.textContent = message.text;
    article.append(author, text);
    fragment.append(article);
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

  renderMessages(event.data.messages);
  if (awaitingAck && input instanceof HTMLTextAreaElement) {
    input.value = "";
    vscode.setState({ draft: "" });
  }
  awaitingAck = false;
  pending = event.data.busy || event.data.approval;
  if (status) status.textContent = event.data.status;
  if (cancel instanceof HTMLButtonElement) cancel.disabled = !event.data.busy && !event.data.approval;
  if (approve instanceof HTMLButtonElement) { approve.hidden = !event.data.approval; approve.disabled = event.data.busy; }
  if (deny instanceof HTMLButtonElement) { deny.hidden = !event.data.approval; deny.disabled = event.data.busy; }
  updateComposer();
});

updateComposer();
vscode.postMessage({ type: "ready" });
