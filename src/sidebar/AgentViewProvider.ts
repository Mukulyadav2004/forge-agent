import { ForgeSession, listModelNames } from "../agent/ForgeSession";
import type { TrueForgeApi } from "@truefoundry/trueforge-sdk";
import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { isWebviewMessage } from "../shared/messages";
import type { ChatMessage, FileEvidence, HostMessage } from "../shared/messages";
import { isArchitectureRequest } from '../context/projectContext';
import type { EditService } from '../edits/EditService';
import type { ReviewCommand } from '../edits/review';

export class AgentViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewType = "forgeAgent.chat";

  private session: ForgeSession | undefined;
  private busy = false;
  private status = "Set forgeAgent.model in Settings to connect to local TrueForge.";
  private approvals: TrueForgeApi.UserToolApprovalInputEvent[] = [];
  private readonly messages: ChatMessage[] = [];
  private readonly inspectedFiles: FileEvidence[] = [];
  private view: vscode.WebviewView | undefined;
  private viewDisposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly actions: {
      getEditorManifest: (namePrefix: string) => Promise<TrueForgeApi.RemoteMcpServerManifest>;
      openFile: (options: { path: string; line: number }) => Promise<void>;
      architectureContext: () => Promise<string>;
      edits: EditService;
    },
  ) {}

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

        if (value.type === "copy_mcp_connection") {
          void vscode.commands.executeCommand("forgeAgent.copyMcp");
        } else if (value.type === "select_model") {
          void this.selectModel();
        } else if (value.type === 'review') {
          void this.review(value.command);
        } else if (value.type === "open_file") {
          void this.actions.openFile(value).catch((error: unknown) => vscode.window.showErrorMessage(error instanceof Error ? error.message : "Could not open source file."));
        } else if (value.type === "send_message" && !this.busy && !this.approvals.length) {
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
    if (this.busy || this.approvals.length || this.actions.edits.state.busy) return;
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) { await vscode.window.showInformationMessage("Select some code first."); return; }
    const selection = editor.selection;
    const document = editor.document;
    const version = document.version;
    const selectedText = document.getText(selection);
    if (selectedText.length > 20000) { await vscode.window.showInformationMessage('Select a smaller section (at most 20,000 characters).'); return; }
    const instruction = await vscode.window.showInputBox({ prompt: "What should Forge change in this selection?" });
    if (!instruction?.trim()) return;
    if (this.busy || this.approvals.length || this.actions.edits.state.busy) return;
    if (document.version !== version) { await vscode.window.showInformationMessage('This file changed while entering your instruction. Select it again.'); return; }
    const text = `${instruction}
File: ${vscode.workspace.asRelativePath(document.uri)}
Selected lines ${selection.start.line + 1}-${selection.end.line + (selection.end.character === 0 ? 0 : 1)}:
${selectedText}`;
    this.messages.push({ id: randomUUID(), role: "user", text });
    await vscode.commands.executeCommand("forgeAgent.open");
    await this.run([{ type: "user.message", content: text }]);
  }
  async newTask(): Promise<void> {
    if (this.busy || this.actions.edits.state.busy) { void vscode.window.showInformationMessage("Finish or cancel the current operation before starting a new task."); return; }
    this.busy = true; this.publish();
    try {
      await this.actions.edits.newTask();
      this.session = undefined; this.approvals = []; this.messages.length = 0; this.inspectedFiles.length = 0; this.status = "New task ready";
    } catch (error) { this.status = error instanceof Error ? error.message : 'Could not start a new task.'; }
    this.busy = false; this.publish();
  }
  refreshReview(): void { this.publish(); }
  async review(command: ReviewCommand): Promise<void> {
    if (this.busy || this.approvals.length) { this.status = 'Finish or cancel the agent turn before reviewing changes.'; this.publish(); return; }
    try {
      switch (command.action) {
        case 'preview': await this.actions.edits.preview(command.id); break;
        case 'apply': await this.actions.edits.apply(command.id); break;
        case 'reject': await this.actions.edits.reject(command.id); break;
        case 'apply_hunk': await this.actions.edits.applyHunk(command); break;
        case 'reject_hunk': await this.actions.edits.rejectHunk(command); break;
        case 'apply_all': await this.actions.edits.apply(); break;
        case 'reject_all': await this.actions.edits.reject(); break;
        case 'undo': await this.actions.edits.undo(); break;
      }
      this.status = this.actions.edits.state.message;
    } catch (error) { this.status = error instanceof Error ? error.message : 'Review operation failed.'; }
    this.publish();
  }
  recordInspection(file: FileEvidence): void {
    if (!this.inspectedFiles.some(existing => existing.path === file.path && existing.startLine === file.startLine && existing.endLine === file.endLine && existing.origin === file.origin)) this.inspectedFiles.push(file);
    this.publish();
  }
  async selectModel(): Promise<void> {
    if (this.busy || this.approvals.length || this.actions.edits.state.busy) {
      void vscode.window.showInformationMessage("Finish or cancel the current task before selecting a model.");
      return;
    }
    try {
      const config = vscode.workspace.getConfiguration("forgeAgent");
      const names = await listModelNames({ baseUrl: config.get<string>("baseUrl", "http://127.0.0.1:8790") });
      if (!names.length) throw new Error("Add a model in local TrueForge first, then select it here.");
      const name = await vscode.window.showQuickPick(names, { title: "Select a TrueForge model", placeHolder: "Models configured in your local TrueForge server" });
      if (!name) return;
      const setting = config.inspect<string>("model");
      const target = setting?.workspaceFolderValue !== undefined ? vscode.ConfigurationTarget.WorkspaceFolder
        : setting?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
      await config.update("model", name, target);
      await this.newTask();
      this.status = `Model: ${name}`;
      this.publish();
    } catch (error: unknown) {
      this.status = error instanceof Error ? error.message : "Could not load TrueForge models.";
      this.publish();
      void vscode.window.showErrorMessage(this.status);
    }
  }
  private publish(): void {
    const response: HostMessage = { type: "state", messages: this.messages, busy: this.busy, status: this.status, approval: this.approvals.length > 0, inspectedFiles: this.inspectedFiles, review: this.actions.edits.state };
    void this.view?.webview.postMessage(response);
  }
  private async cancel(): Promise<void> {
    this.approvals = [];
    try {
      const discarded = this.actions.edits.cancel();
      const cancelled = this.session?.cancel();
      await discarded; await cancelled;
      this.status = "Cancellation requested. Pending proposals were discarded; applied batches remain available in Undo.";
    }
    catch { this.status = "Could not confirm cancellation. Check the local TrueForge server."; }
    this.publish();
  }
  private async run(input: TrueForgeApi.CreateTurnSessionsStreamRequest['input']): Promise<void> {
    this.busy = true; this.status = "Connecting to TrueForge…"; this.publish();
    try {
      this.actions.edits.beginTurn();
      const preparedInput: TrueForgeApi.CreateTurnSessionsStreamRequest['input'] = [];
      for (const event of input ?? []) {
        if (event.type === 'user.message' && typeof event.content === 'string' && isArchitectureRequest(event.content)) {
          const context = await this.actions.architectureContext();
          preparedInput.push({ ...event, content: context ? `${event.content}\n\n${context}` : event.content });
        } else preparedInput.push(event);
      }
      if (!this.session) {
        const config = vscode.workspace.getConfiguration("forgeAgent");
        const model = config.get<string>("model", "").trim();
        if (!model) throw new Error("Model not configured. Set forgeAgent.model after adding a model in local TrueForge.");
        const connector = config.get<string>("connector", "forge-editor");
        const editorManifest = connector ? await this.actions.getEditorManifest(connector) : undefined;
        this.session = new ForgeSession({ baseUrl: config.get<string>("baseUrl", "http://127.0.0.1:8790"), model, connector, editorManifest, reasoningEffort: config.get<string>('reasoningEffort', ''), onEvent: event => this.event(event) });
      }
      await this.session.send(preparedInput);
    } catch (error: unknown) {
      // A failed create must not retain settings that the user has corrected.
      if (!this.session?.id) this.session = undefined;
      this.status = error instanceof Error ? error.message : "TrueForge request failed.";
      this.messages.push({ id: randomUUID(), role: "assistant", text: this.status });
    } finally { this.busy = false; this.publish(); }
  }
  private event(event: TrueForgeApi.TurnStreamingEvent): void {
    this.status = `Session ${this.session?.id ?? "starting"} · ${event.type}`;
    if (event.type === "model.message" && event.threadId === "main" && typeof event.content === "string" && event.content) {
      const existing = this.messages.find(message => message.id === event.id && message.role === "assistant");
      if (existing) existing.text = event.content;
      else this.messages.push({ id: event.id, role: "assistant", text: event.content });
    }
    if (event.type === "model.message.delta" && event.threadId === "main" && event.content) {
      const existing = this.messages.find(message => message.id === event.id && message.role === "assistant");
      if (existing) existing.text += event.content;
      else this.messages.push({ id: event.id, role: "assistant", text: event.content });
    }
    if (event.type === "tool.approval_required") {
      this.approvals = event.toolCalls.map(tool => ({ type: "user.tool_approval", threadId: event.threadId, toolCallId: tool.id, approval: { status: "allow" } }));
      this.messages.push({ id: randomUUID(), role: "assistant", text: "Allow TrueForge to stage a proposed diff? This does not write files. You can apply or reject the proposal after reviewing it." });
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
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'nonce-${nonce}';">
  <link rel="stylesheet" href="${styleUri}">
  <title>Forge Agent</title>
</head>
<body>
  <header>
    <h1>Forge Agent</h1>
    <p class="description">Your editor, connected to local TrueForge.</p>
    <button id="copy-mcp-button" type="button">Copy MCP connection</button>
    <button id="select-model-button" type="button">Select model</button>
    <span class="badge" id="status" role="status">Ready</span>
    <div><button id="cancel-button" type="button" disabled>Cancel</button> <button id="approve-button" type="button" hidden>Approve preview</button> <button id="deny-button" type="button" hidden>Deny</button></div>
  </header>
  <details id="file-evidence" hidden><summary>Files inspected</summary><ul id="file-evidence-list"></ul></details>
  <section id="review-panel" role="region" aria-label="Proposed changes" hidden></section>
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
