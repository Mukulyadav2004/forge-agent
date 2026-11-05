import { ForgeSession } from "../agent/ForgeSession";
import type { TrueForgeApi } from "@truefoundry/trueforge-sdk";
import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { isWebviewMessage } from "../shared/messages";
import type { ChatMessage, HostMessage } from "../shared/messages";

export class AgentViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewType = "forgeAgent.chat";

  private session: ForgeSession | undefined;
  private busy = false;
  private status = "Set forgeAgent.model in Settings to connect to local TrueForge.";
  private approvals: TrueForgeApi.UserToolApprovalInputEvent[] = [];
  private assistant: ChatMessage | undefined;
  private readonly messages: ChatMessage[] = [];
  private view: vscode.WebviewView | undefined;
  private viewDisposables: vscode.Disposable[] = [];

  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.disposeView();
    this.view = view;

    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, "media"),
        vscode.Uri.joinPath(this.extensionUri, "out-webview"),
      ],
    };

    this.viewDisposables.push(
      view.webview.onDidReceiveMessage((value: unknown) => {
        if (!isWebviewMessage(value)) {
          return;
        }

        if (value.type === "send_message" && !this.busy && !this.approvals.length) {
          const text = value.text.trim();
          if (text) { this.messages.push({ id: randomUUID(), role: "user", text }); void this.run([{ type: "user.message", content: text }]); }
        } else if (value.type === "cancel") {
          void this.cancel();
        } else if (value.type === "approve" && !this.busy && this.approvals.length) {
          const input: TrueForgeApi.UserToolApprovalInputEvent[] = this.approvals.map(item => ({ ...item, approval: value.allow ? { status: "allow" } : { status: "deny", reason: "Declined in VS Code" } }));
          this.approvals = [];
          void this.run(input);
        }
        this.publish();
      }),
      view.onDidDispose(() => {
        if (this.view === view) {
          this.disposeView();
        }
      })
    );

    view.webview.html = this.getHtml(view.webview);
  }

  dispose(): void {
    void this.session?.cancel().catch(() => undefined);
    this.disposeView();
  }

  async editSelection(): Promise<void> {
    if (this.busy || this.approvals.length) return;
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) { await vscode.window.showInformationMessage("Select some code first."); return; }
    const instruction = await vscode.window.showInputBox({ prompt: "What should Forge change in this selection?" });
    if (!instruction?.trim()) return;
    const text = `${instruction}
File: ${vscode.workspace.asRelativePath(editor.document.uri)}
Selected lines ${editor.selection.start.line + 1}-${editor.selection.end.line + 1}:
${editor.document.getText(editor.selection).slice(0, 20000)}`;
    this.messages.push({ id: randomUUID(), role: "user", text });
    await vscode.commands.executeCommand("forgeAgent.open");
    await this.run([{ type: "user.message", content: text }]);
  }
  newTask(): void {
    if (this.busy) { void vscode.window.showInformationMessage("Cancel the running turn before starting a new task."); return; }
    this.session = undefined; this.approvals = []; this.messages.length = 0; this.status = "New task ready"; this.publish();
  }
  private publish(): void {
    const response: HostMessage = { type: "state", messages: this.messages, busy: this.busy, status: this.status, approval: this.approvals.length > 0 };
    void this.view?.webview.postMessage(response);
  }
  private async cancel(): Promise<void> {
    this.approvals = [];
    try { await this.session?.cancel(); this.status = "Cancellation requested. No editor files were changed."; }
    catch { this.status = "Could not confirm cancellation. Check the local TrueForge server."; }
    this.publish();
  }
  private async run(input: TrueForgeApi.CreateTurnSessionsStreamRequest['input']): Promise<void> {
    this.busy = true; this.assistant = undefined; this.status = "Connecting to TrueForge…"; this.publish();
    try {
      if (!this.session) {
        const config = vscode.workspace.getConfiguration("forgeAgent");
        const model = config.get<string>("model", "").trim();
        if (!model) throw new Error("Model not configured. Set forgeAgent.model after adding a model in local TrueForge.");
        this.session = new ForgeSession({ baseUrl: config.get<string>("baseUrl", "http://127.0.0.1:8790"), model, connector: config.get<string>("connector", "forge-editor"), onEvent: event => this.event(event) });
      }
      await this.session.send(input);
    } catch (error: unknown) {
      this.status = error instanceof Error ? error.message : "TrueForge request failed.";
      this.messages.push({ id: randomUUID(), role: "assistant", text: this.status });
    } finally { this.busy = false; this.publish(); }
  }
  private event(event: TrueForgeApi.TurnStreamingEvent): void {
    this.status = `Session ${this.session?.id ?? "starting"} · ${event.type}`;
    if (event.type === "model.message" && event.threadId === "main" && typeof event.content === "string" && !this.assistant) {
      this.assistant = { id: randomUUID(), role: "assistant", text: event.content }; this.messages.push(this.assistant);
    }
    if (event.type === "model.message.delta" && event.threadId === "main" && event.content) {
      if (!this.assistant) { this.assistant = { id: randomUUID(), role: "assistant", text: "" }; this.messages.push(this.assistant); }
      this.assistant.text += event.content;
    }
    if (event.type === "tool.approval_required") {
      this.approvals = event.toolCalls.map(tool => ({ type: "user.tool_approval", threadId: event.threadId, toolCallId: tool.id, approval: { status: "allow" } }));
      this.messages.push({ id: randomUUID(), role: "assistant", text: "TrueForge requests permission to open a proposed diff. No file will be written. Approve or deny below." });
    }
    if (event.type === "turn.done" && event.state.status === "error") this.status = event.state.message;
    this.publish();
  }

  private disposeView(): void {
    for (const disposable of this.viewDisposables) {
      disposable.dispose();
    }
    this.viewDisposables = [];
    this.view = undefined;
  }

  private getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "out-webview", "webview", "main.js")
    );
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "sidebar.css"));
    const nonce = randomUUID().replace(/-/g, "");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src ${webview.cspSource} 'nonce-${nonce}';">
  <link rel="stylesheet" href="${styleUri}">
  <title>Forge Agent</title>
</head>
<body>
  <header>
    <h1>Forge Agent</h1>
    <p class="description">Your editor, connected to local TrueForge.</p>
    <span class="badge" id="status" role="status">Ready</span>
    <div><button id="cancel-button" type="button" disabled>Cancel</button> <button id="approve-button" type="button" hidden>Approve preview</button> <button id="deny-button" type="button" hidden>Deny</button></div>
  </header>
  <div id="messages" role="log" aria-label="Conversation" aria-live="polite" aria-relevant="additions text">
    <p class="empty-state">Your messages will appear here.</p>
  </div>
  <form id="message-form">
    <label for="message-input">Message</label>
    <textarea id="message-input" rows="4" placeholder="Try: Hello Forge!" spellcheck="false"></textarea>
    <div class="composer-actions">
      <span class="hint">⌘ / Ctrl + Enter to send</span>
      <button id="send-button" type="submit" disabled>Send</button>
    </div>
  </form>
  <script type="module" nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
