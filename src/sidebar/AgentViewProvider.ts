import { classifyModelError, ForgeSession, listModelNames } from "../agent/ForgeSession";
import type { TrueForgeApi } from "@truefoundry/trueforge-sdk";
import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { isWebviewMessage } from "../shared/messages";
import type { ActivityEntry, AgentQuestion, ChatMessage, ComposerSelection, FileEvidence, HostMessage } from "../shared/messages";
import { isAgentQuestion } from "../shared/messages";
import { isArchitectureRequest } from '../context/projectContext';
import type { EditService } from '../edits/EditService';
import type { ReviewCommand } from '../edits/review';
import { ReviewFeedback } from './ReviewFeedback';
import { describeApproval, StreamedToolCalls } from '../agent/approvalText';
import type { PendingToolCall } from '../agent/approvalText';

/** One sidebar chat. The live fields on the provider always point at the active chat. */
interface HeldChat {
  id: string;
  title: string;
  session: ForgeSession | undefined;
  busy: boolean;
  cancellationRequested: boolean;
  status: string;
  approvals: TrueForgeApi.UserToolApprovalInputEvent[];
  toolCalls: StreamedToolCalls;
  turnError: string | undefined;
  editScope: string | undefined;
  lastInput: TrueForgeApi.CreateTurnSessionsStreamRequest['input'] | undefined;
  messages: ChatMessage[];
  inspectedFiles: FileEvidence[];
  activity: ActivityEntry[];
  heldSelections: ComposerSelection[];
  questions: Array<AgentQuestion & { threadId: string }>;
}

export class AgentViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewType = "forgeAgent.chat";

  private session: ForgeSession | undefined;
  private busy = false;
  private cancellationRequested = false;
  private status = "Set forgeAgent.model in Settings to connect to local TrueForge.";
  private approvals: TrueForgeApi.UserToolApprovalInputEvent[] = [];
  /** Recent streamed tool calls; an approval event names only the call id, so its prompt is built from here. */
  private toolCalls = new StreamedToolCalls();
  /** The last failed turn's model error, and the user input that turn answered, so it can be retried. */
  private turnError: string | undefined;
  private editScope: string | undefined;
  private lastInput: TrueForgeApi.CreateTurnSessionsStreamRequest['input'] | undefined;
  private messages: ChatMessage[] = [];
  private inspectedFiles: FileEvidence[] = [];
  private activity: ActivityEntry[] = [];
  private readonly reviewFeedback = new ReviewFeedback();
  private view: vscode.WebviewView | undefined;
  private viewDisposables: vscode.Disposable[] = [];
  /** Selection chips survive a webview reload until the user removes them or sends. At most eight, like a short Cursor context list. */
  private heldSelections: ComposerSelection[] = [];
  private questions: Array<AgentQuestion & { threadId: string }> = [];
  /** Open chats, at most eight. Only one runs at a time because edits and the context budget are shared. */
  private readonly chats: HeldChat[] = [];
  private activeId = '';
  /** The agent whose turn is inside the editor right now. Tool activity is recorded on this chat. */
  private owner: HeldChat | undefined;
  /** Agents waiting for the editor. One turn uses the shared files and context budget at a time. */
  private readonly jobs: Array<() => Promise<void>> = [];
  /** The call behind each approval, and decisions made without the user: Edit Selection staging (allow) or an edit the editor could not build (deny with its error). */
  private readonly approvalCalls = new Map<string, PendingToolCall>();
  private readonly presetDecisions = new Map<string, TrueForgeApi.UserToolApprovalInputEvent['approval'] | null>(); // null: the user decides
  private pumping = false;
  private composerReady = false;
  private queuedComposer: Extract<HostMessage, { type: 'attach_selection' | 'focus_composer' }> | undefined;
  private readonly addSelectionCommand = vscode.commands.registerCommand('forgeAgent.addSelection', () => { void this.addSelection(); });

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly actions: {
      getEditorManifest: (namePrefix: string) => Promise<TrueForgeApi.RemoteMcpServerManifest>;
      openFile: (options: { path: string; line: number }) => Promise<void>;
      architectureContext: () => Promise<string>;
      projectOverview: () => Promise<string>;
      prepareEdit: (argumentsJson: string) => Promise<{ status: 'review' | 'stage' } | { status: 'invalid'; message: string }>;
      settleEdits: (allow: boolean) => Promise<void>;
      /** Starts a fresh context budget for a new user request; `scope` limits staged edits to one file (Edit Selection). */
      beginRequest: (scope?: string) => void;
      edits: EditService;
    },
  ) {
    const first = this.blankChat('Chat 1');
    this.chats.push(first);
    this.bindChat(first);
  }

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

        if (value.type === "ready") {
          this.composerReady = true;
          if (!this.queuedComposer && this.heldSelections.length) this.queuedComposer = { type: 'attach_selection', selections: [...this.heldSelections] };
          this.flushComposer();
        } else if (value.type === "copy_mcp_connection") {
          void vscode.commands.executeCommand("forgeAgent.copyMcp");
        } else if (value.type === "select_model") {
          void this.selectModel();
        } else if (value.type === 'review') {
          void this.review(value.command);
        } else if (value.type === "open_file") {
          void this.actions.openFile(value).catch((error: unknown) => vscode.window.showErrorMessage(error instanceof Error ? error.message : "Could not open source file."));
        } else if (value.type === "add_selection") {
          void this.addSelection();
        } else if (value.type === "clear_selection") {
          if (value.index < this.heldSelections.length) this.heldSelections.splice(value.index, 1);
          this.queuedComposer = undefined;
        } else if (value.type === "new_chat") {
          void this.newTask();
        } else if (value.type === "select_chat") {
          this.selectChat(value.id);
        } else if (value.type === "spin_agents") {
          void this.spinAgents(value.text);
        } else if (value.type === "send_message") {
          const chat = this.activeChat();
          const text = value.text.trim();
          const selections = value.selections ?? [];
          if (chat && text && !chat.busy && !chat.approvals.length && !chat.questions.length) {
            if (/^(?:Chat|Agent) \d+$/u.test(chat.title)) chat.title = text.replace(/\s+/gu, ' ').slice(0, 42);
            this.heldSelections.length = 0;
            this.queuedComposer = undefined;
            const blocks = selections.map(item => `File: ${item.path}\nSelected lines ${item.startLine}-${item.endLine}:\n${item.text}`);
            const shown = selections.map(item => `${item.path}:${item.startLine}-${item.endLine}`);
            chat.messages.push({ id: randomUUID(), role: "user", text: shown.length ? `${text}\n\n${shown.join('\n')}` : text });
            this.enqueue(chat, [{ type: "user.message", content: blocks.length ? `${text}\n\n${blocks.join('\n\n')}` : text }]);
          }
        } else if (value.type === "answer_question") {
          const chat = this.activeChat();
          if (chat) void this.submitAnswers(chat, value.answers);
        } else if (value.type === "cancel") {
          void this.cancel();
        } else if (value.type === "approve" && !this.busy && this.approvals.length) {
          const chat = this.activeChat();
          if (chat) void this.decide(chat, value.allow);
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
    this.addSelectionCommand.dispose();
    this.sync();
    for (const chat of this.chats) void chat.session?.cancel().catch(() => undefined);
    this.disposeView();
  }

  private blankChat(title: string): HeldChat {
    return {
      // Without a model a new chat cannot run, so its status says how to connect instead of "ready".
      id: randomUUID(), title, session: undefined, busy: false, cancellationRequested: false,
      status: vscode.workspace.getConfiguration('forgeAgent').get<string>('model', '').trim() ? 'New chat ready' : 'Set forgeAgent.model in Settings to connect to local TrueForge.',
      approvals: [], toolCalls: new StreamedToolCalls(), turnError: undefined, editScope: undefined, lastInput: undefined,
      messages: [], inspectedFiles: [], activity: [], heldSelections: [], questions: [],
    };
  }

  private activeChat(): HeldChat | undefined {
    return this.chats.find(chat => chat.id === this.activeId);
  }

  /** Copies the live fields back onto the active chat before another chat is shown. */
  private sync(): void {
    const chat = this.activeChat();
    if (!chat) return;
    chat.session = this.session; chat.busy = this.busy; chat.cancellationRequested = this.cancellationRequested; chat.status = this.status;
    chat.approvals = this.approvals; chat.toolCalls = this.toolCalls; chat.turnError = this.turnError; chat.editScope = this.editScope;
    chat.lastInput = this.lastInput; chat.messages = this.messages; chat.inspectedFiles = this.inspectedFiles; chat.activity = this.activity; chat.heldSelections = this.heldSelections; chat.questions = this.questions;
  }

  /** Makes one stored chat the live one and restores its attached selections. */
  private bindChat(chat: HeldChat): void {
    this.activeId = chat.id;
    this.session = chat.session; this.busy = chat.busy; this.cancellationRequested = chat.cancellationRequested; this.status = chat.status;
    this.approvals = chat.approvals; this.toolCalls = chat.toolCalls; this.turnError = chat.turnError; this.editScope = chat.editScope;
    this.lastInput = chat.lastInput; this.messages = chat.messages; this.inspectedFiles = chat.inspectedFiles; this.activity = chat.activity; this.heldSelections = chat.heldSelections; this.questions = chat.questions;
    this.queuedComposer = { type: 'attach_selection', selections: [...chat.heldSelections] };
    this.flushComposer();
  }

  private selectChat(id: string): void {
    if (id === this.activeId) return;
    const chat = this.chats.find(item => item.id === id);
    if (!chat) return;
    this.sync();
    this.bindChat(chat);
  }

  /** Copies one agent's fields onto the live view when that agent is the one on screen. */
  private show(chat: HeldChat): void {
    if (chat.id === this.activeId) {
      this.session = chat.session; this.busy = chat.busy; this.cancellationRequested = chat.cancellationRequested; this.status = chat.status;
      this.approvals = chat.approvals; this.toolCalls = chat.toolCalls; this.turnError = chat.turnError; this.editScope = chat.editScope;
      this.lastInput = chat.lastInput; this.messages = chat.messages; this.inspectedFiles = chat.inspectedFiles; this.activity = chat.activity; this.heldSelections = chat.heldSelections; this.questions = chat.questions;
    }
    this.publish();
  }

  /** Runs this agent's turn when the editor is free. Other agents keep their own transcripts and wait. */
  private enqueue(chat: HeldChat, input: TrueForgeApi.CreateTurnSessionsStreamRequest['input'], approvals?: TrueForgeApi.UserToolApprovalInputEvent[]): void {
    chat.cancellationRequested = false;
    chat.busy = true;
    chat.status = 'Waiting to start';
    this.jobs.push(() => this.run(chat, input, approvals));
    this.show(chat);
    this.kick();
  }

  private kick(): void {
    if (this.pumping || this.chats.some(chat => chat.approvals.length > 0 || chat.questions.length > 0)) return;
    const job = this.jobs.shift();
    if (!job) return;
    this.pumping = true;
    void job().finally(() => { this.pumping = false; this.kick(); });
  }

  /** Starts several agents with one command. Each agent is its own chat. */
  private async spinAgents(text: string): Promise<void> {
    const reusable = this.activeChat();
    const reuse = Boolean(reusable && reusable.messages.length === 0 && !reusable.busy);
    const free = 8 - this.chats.length + (reuse ? 1 : 0);
    if (free < 2) { void vscode.window.showInformationMessage('Two agents need two free chats. Eight chats is the limit.'); return; }
    const picked = await vscode.window.showQuickPick(['2', '3', '4'].filter(count => Number(count) <= free), { title: 'Spin agents', placeHolder: 'How many agents should run this command?' });
    if (!picked) return;
    const command = text.trim() || (await vscode.window.showInputBox({ prompt: 'Command for every agent', placeHolder: 'What should each agent do?' }))?.trim();
    if (!command) return;
    const targets: HeldChat[] = [];
    if (reuse && reusable) targets.push(reusable);
    while (targets.length < Number(picked)) {
      const chat = this.blankChat('Agent');
      this.chats.push(chat);
      targets.push(chat);
    }
    const base = command.replace(/\s+/gu, ' ').slice(0, 36);
    targets.forEach((chat, index) => { chat.title = `${base} (${index + 1})`; });
    for (const chat of targets) {
      chat.messages.push({ id: randomUUID(), role: 'user', text: command });
      this.enqueue(chat, [{ type: 'user.message', content: command }]);
    }
  }

  /** Ctrl+L: open the agent and add the current editor selection. A new range is kept beside the ones already attached. */
  async addSelection(): Promise<void> {
    await vscode.commands.executeCommand('forgeAgent.open');
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) {
      this.queuedComposer = { type: 'focus_composer' };
      this.status = 'Agent ready. Select code and press Ctrl+L to attach it. You can attach up to 8.';
      this.flushComposer();
      this.publish();
      return;
    }
    const range = new vscode.Range(editor.selection.start, editor.selection.end);
    const text = editor.document.getText(range);
    if (text.length > 20000) { await vscode.window.showInformationMessage('Select a smaller section (at most 20,000 characters).'); return; }
    const startLine = range.start.line + 1;
    const endLine = range.end.line + (range.end.character === 0 ? 0 : 1);
    if (endLine < startLine) { await vscode.window.showInformationMessage('Select some code first.'); return; }
    const selection: ComposerSelection = { path: vscode.workspace.asRelativePath(editor.document.uri), startLine, endLine, text };
    const same = this.heldSelections.findIndex(item => item.path === selection.path && item.startLine === selection.startLine && item.endLine === selection.endLine);
    if (same >= 0) this.heldSelections[same] = selection;
    else if (this.heldSelections.length >= 8) { await vscode.window.showInformationMessage('Eight selections are already attached. Remove one before adding another.'); return; }
    else this.heldSelections.push(selection);
    this.queuedComposer = { type: 'attach_selection', selections: [...this.heldSelections] };
    this.status = `Attached ${this.heldSelections.length} selection${this.heldSelections.length === 1 ? '' : 's'}. Type what to do, then send.`;
    this.flushComposer();
    this.publish();
  }

  private flushComposer(): void {
    if (!this.composerReady || !this.queuedComposer || !this.view) return;
    void this.view.webview.postMessage(this.queuedComposer);
    this.queuedComposer = undefined;
  }

  async editSelection(): Promise<void> {
    if (this.busy || this.approvals.length || this.questions.length || this.actions.edits.state.busy) return;
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) { await vscode.window.showInformationMessage("Select some code first."); return; }
    const selection = editor.selection;
    const document = editor.document;
    const version = document.version;
    const selectedText = document.getText(selection);
    if (selectedText.length > 20000) { await vscode.window.showInformationMessage('Select a smaller section (at most 20,000 characters).'); return; }
    const instruction = await vscode.window.showInputBox({ prompt: "What should Forge change in this selection?" });
    if (!instruction?.trim()) return;
    if (this.busy || this.approvals.length || this.questions.length || this.actions.edits.state.busy) return;
    if (document.version !== version) { await vscode.window.showInformationMessage('This file changed while entering your instruction. Select it again.'); return; }
    const text = `${instruction}
File: ${vscode.workspace.asRelativePath(document.uri)}
Selected lines ${selection.start.line + 1}-${selection.end.line + (selection.end.character === 0 ? 0 : 1)}:
${selectedText}`;
    const chat = this.activeChat();
    if (!chat || chat.busy || chat.approvals.length) return;
    chat.messages.push({ id: randomUUID(), role: "user", text });
    await vscode.commands.executeCommand("forgeAgent.open");
    // The user chose one file; the editor tools refuse edits to any other file for this request.
    chat.editScope = vscode.workspace.asRelativePath(document.uri, false);
    this.enqueue(chat, [{ type: "user.message", content: text }]);
  }
  async newTask(): Promise<void> {
    this.sync();
    if (this.chats.length >= 8) { void vscode.window.showInformationMessage('Eight chats are open. That is the limit for now.'); return; }
    const chat = this.blankChat(`Chat ${this.chats.length + 1}`);
    this.chats.push(chat);
    this.bindChat(chat);
    this.publish();
  }
  refreshReview(): void { this.publish(); }
  async review(command: ReviewCommand): Promise<void> {
    if (command.action !== 'preview' && this.chats.some(chat => chat.busy || chat.questions.length > 0)) { this.status = 'Finish or cancel the running agents before applying, rejecting or undoing changes.'; this.publish(); return; }
    const before = this.actions.edits.state;
    let succeeded = false;
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
        case 'undo_request': await this.actions.edits.undoRequest(); break;
      }
      this.status = this.actions.edits.state.message;
      succeeded = true;
    } catch (error) { this.status = error instanceof Error ? error.message : 'Review operation failed.'; }
    this.reviewFeedback.record({ command, before, after: this.actions.edits.state, succeeded, message: this.status });
    if (command.action !== 'preview') this.status += ' Editor state will be sent with your next message.';
    this.publish();
  }
  /** Adds a completed tool call to the feed; an opened file names the most recent search that returned it. */
  recordActivity(entry: ActivityEntry): void {
    const chat = this.owner ?? this.activeChat();
    if (!chat) return;
    if (entry.kind === 'open') {
      const path = entry.path;
      const search = [...chat.activity].reverse().find(item => item.kind === 'search' && item.files.includes(path));
      if (search?.kind === 'search') entry.foundBy = search.query;
    }
    chat.activity.push({ ...entry, at: chat.messages.length });
    if (chat.activity.length > 200) chat.activity.shift();
    if (entry.kind === 'open' || entry.kind === 'context') {
      const file: FileEvidence = { path: entry.path, startLine: entry.startLine, endLine: entry.endLine, origin: entry.kind === 'open' ? 'tool' : 'context' };
      if (!chat.inspectedFiles.some(existing => existing.path === file.path && existing.startLine === file.startLine && existing.endLine === file.endLine && existing.origin === file.origin)) chat.inspectedFiles.push(file);
    }
    this.show(chat);
  }
  async selectModel(): Promise<void> {
    if (this.pumping || this.jobs.length > 0 || this.chats.some(chat => chat.busy || chat.approvals.length > 0 || chat.questions.length > 0) || this.actions.edits.state.busy) {
      void vscode.window.showInformationMessage("Finish or cancel the running agents before selecting a model.");
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
      await this.actions.edits.newTask();
      this.reviewFeedback.clear();
      this.session = undefined; this.approvals = []; this.messages.length = 0; this.inspectedFiles.length = 0; this.activity.length = 0; this.toolCalls.clear();
      this.turnError = undefined; this.lastInput = undefined; this.heldSelections.length = 0;
      this.queuedComposer = { type: 'attach_selection', selections: [] };
      this.flushComposer();
      this.status = `Model: ${name}`;
      this.publish();
    } catch (error: unknown) {
      this.status = error instanceof Error ? error.message : "Could not load TrueForge models.";
      this.publish();
      void vscode.window.showErrorMessage(this.status);
    }
  }
  private publish(): void {
    const response: HostMessage = { type: "state", messages: this.messages, busy: this.busy, status: this.status, approval: this.approvals.length > 0, inspectedFiles: this.inspectedFiles, activity: this.activity, review: this.actions.edits.state, chats: this.chats.map(chat => ({ id: chat.id, title: chat.title, active: chat.id === this.activeId, busy: chat.busy })), questions: this.questions.map(({ toolCallId, question, options }) => ({ toolCallId, question, options })) };
    void this.view?.webview.postMessage(response);
  }
  /**
   * A turn paused on propose_edit approvals: stage each edit so its hunks are reviewed before the user decides.
   * When every waiting approval was decided without the user (Edit Selection or an invalid call), the turn resumes at once.
   */
  private async prepareApprovals(chat: HeldChat): Promise<void> {
    for (const item of chat.approvals) {
      const call = this.approvalCalls.get(item.toolCallId);
      if (call?.name !== 'propose_edit' || this.presetDecisions.has(item.toolCallId)) continue;
      const prepared = await this.actions.prepareEdit(call.arguments);
      if (prepared.status === 'stage') this.presetDecisions.set(item.toolCallId, { status: 'allow' });
      else if (prepared.status === 'invalid') this.presetDecisions.set(item.toolCallId, { status: 'deny', reason: `The editor could not build this edit, so it was not shown to the user: ${prepared.message}` });
      else {
        this.presetDecisions.set(item.toolCallId, null);
        chat.messages.push({ id: randomUUID(), role: 'assistant', text: describeApproval(call, { saveOnApprove: true }) });
      }
    }
    if (chat.approvals.length && chat.approvals.every(item => this.presetDecisions.get(item.toolCallId))) this.queueDecision(chat, true);
  }
  /** Approve or Deny: settle the reviewed edits first (save the hunks the user kept, or discard them), then resume the turn. */
  private async decide(chat: HeldChat, allow: boolean): Promise<void> {
    // Taken at once, so a second click cannot send the same decision twice; busy keeps review and the buttons still while saving.
    const items = chat.approvals.splice(0, chat.approvals.length);
    const reviewing = items.some(item => this.approvalCalls.get(item.toolCallId)?.name === 'propose_edit' && !this.presetDecisions.get(item.toolCallId));
    if (reviewing) {
      chat.busy = true;
      chat.status = allow ? 'Saving the hunks you kept…' : 'Discarding the reviewed edits…';
      this.show(chat);
      try { await this.actions.settleEdits(allow); } catch (error) { chat.status = error instanceof Error ? error.message : 'Saving failed.'; }
      chat.busy = false;
    }
    this.queueDecision(chat, allow, items);
  }
  private queueDecision(chat: HeldChat, allow: boolean, items = chat.approvals.splice(0, chat.approvals.length)): void {
    const input: TrueForgeApi.UserToolApprovalInputEvent[] = items.map(item => {
      const preset = this.presetDecisions.get(item.toolCallId);
      const edit = this.approvalCalls.get(item.toolCallId)?.name === 'propose_edit';
      this.presetDecisions.delete(item.toolCallId);
      this.approvalCalls.delete(item.toolCallId);
      return { ...item, approval: preset ?? (allow ? { status: 'allow' } : { status: 'deny', reason: edit ? 'The user reviewed the diff and declined this edit. Nothing was saved. Ask what they want instead, or propose a different change.' : 'Declined in VS Code' }) };
    });
    this.jobs.unshift(() => this.run(chat, [], input));
    this.kick();
    this.show(chat);
  }
  /** Sends the picked options back to the paused TrueForge turn. */
  private async submitAnswers(chat: HeldChat, answers: { toolCallId: string; choice: string }[]): Promise<void> {
    if (!chat.session || chat.questions.length === 0 || answers.length !== chat.questions.length) return;
    const events: { type: "user.tool_response"; threadId: string; toolCallId: string; content: string }[] = [];
    for (const question of chat.questions) {
      const choice = answers.find(answer => answer.toolCallId === question.toolCallId)?.choice;
      if (!choice || !question.options.includes(choice)) return;
      events.push({ type: "user.tool_response", threadId: question.threadId, toolCallId: question.toolCallId, content: choice });
    }
    const saved = chat.questions.splice(0, chat.questions.length);
    chat.busy = true;
    chat.status = "Sending your answer…";
    this.show(chat);
    try { await chat.session.respond(events); }
    catch (error: unknown) {
      if (chat.session.awaitingApproval && chat.questions.length === 0) chat.questions.push(...saved);
      chat.status = error instanceof Error ? error.message : "Could not send the answer.";
      chat.messages.push({ id: randomUUID(), role: "assistant", text: chat.status });
    } finally {
      if (!chat.questions.length && !chat.approvals.length) await this.actions.edits.endTurn().catch(() => undefined);
      chat.busy = false;
      this.show(chat);
      this.kick();
    }
  }
  private async cancel(): Promise<void> {
    const chat = this.activeChat();
    if (!chat) return;
    chat.cancellationRequested = true;
    this.cancellationRequested = true;
    chat.approvals.splice(0, chat.approvals.length);
    chat.questions.splice(0, chat.questions.length);
    try {
      const discarded = this.actions.edits.cancel();
      const cancelled = chat.session?.cancel();
      await discarded; await cancelled;
      // With save on approve, edits approved before Cancel are already on disk: name them and offer one-click Undo.
      const saved = this.actions.edits.state.requestSaved ?? [];
      chat.status = saved.length
        ? `Cancelled. Pending edits were discarded. ${saved.length} file(s) you approved earlier in this request stay saved: ${saved.join(', ')}. Use Undo this request in Review changes to restore them.`
        : "Cancellation requested. Pending proposals were discarded; applied batches remain available in Undo.";
      if (saved.length) chat.messages.push({ id: randomUUID(), role: 'assistant', text: `**Cancelled.** Files you approved earlier in this request stay saved: ${saved.map(path => `\`${path}\``).join(', ')}. Click **Undo this request** in Review changes to restore them; nothing else was written.` });
    }
    catch { chat.status = "Could not confirm cancellation. Check the local TrueForge server."; }
    this.show(chat);
  }
  /** A model error ends the turn with status "error": retry a transient one twice (2 s, 4 s), then continue once on forgeAgent.fallbackModel. Files are never written here. */
  private async recover(chat: HeldChat): Promise<void> {
    const fallback = vscode.workspace.getConfiguration('forgeAgent').get<string>('fallbackModel', '').trim();
    const delays = [2, 4];
    let attempt = 0, switched = false;
    while (chat.turnError && chat.session && chat.lastInput && !chat.cancellationRequested && !chat.session.awaitingApproval) {
      const { transient, summary, stepLimit, retryAfterSeconds } = classifyModelError(chat.turnError);
      const say = (text: string) => { chat.messages.push({ id: randomUUID(), role: 'assistant', text }); chat.status = text.replace(/\*\*/gu, ''); this.show(chat); };
      if (stepLimit) { say(`**The agent used all its steps** before finishing (${summary}). Anything it staged is still in Review changes and no files were written. Send \"continue\" to let it carry on, or narrow the request.`); return; }
      // Wait as long as the provider asked (up to a minute); a longer wait goes straight to the fallback model.
      const asked = retryAfterSeconds !== undefined ? (retryAfterSeconds <= 60 ? retryAfterSeconds + 1 : undefined) : delays[attempt];
      const seconds = transient && attempt < delays.length ? asked : undefined;
      if (seconds !== undefined) {
        attempt++;
        say(`**Model error** on \`${chat.session.model}\`: ${summary}\n\nRetrying in ${seconds} s${retryAfterSeconds !== undefined ? ', as the provider asked' : ''} (attempt ${attempt} of ${delays.length}). No files were changed.`);
        for (let waited = 0; waited < seconds * 1000 && !chat.cancellationRequested; waited += 100) await new Promise(resolve => setTimeout(resolve, 100));
        if (chat.cancellationRequested) return;
      } else if (fallback && fallback !== chat.session.model) {
        say(`**Model error** on \`${chat.session.model}\`: ${summary}\n\nSwitching to the fallback model \`${fallback}\` and repeating your request. No files were changed.`);
        await chat.session.switchModel(fallback);
        attempt = delays.length; switched = true; // the fallback gets one attempt; a second failure ends with a clear error
      } else {
        say(`**The request failed** on \`${chat.session.model}\`: ${summary}\n\n${transient && attempt ? 'Retries did not help. ' : ''}${switched ? 'The fallback model also failed. ' : fallback ? '' : 'Set forgeAgent.fallbackModel to a second configured model for automatic takeover. '}No files were changed; check the model and its provider in TrueForge, then send again.`);
        return;
      }
      chat.turnError = undefined;
      await chat.session.send(chat.lastInput, { retry: true });
    }
  }
  private async run(chat: HeldChat, input: TrueForgeApi.CreateTurnSessionsStreamRequest['input'], approvals?: TrueForgeApi.UserToolApprovalInputEvent[]): Promise<void> {
    if (chat.cancellationRequested && !approvals) { chat.busy = false; chat.status = 'Cancelled before this agent started.'; this.show(chat); return; }
    this.owner = chat;
    chat.cancellationRequested = false;
    chat.busy = true;
    chat.status = 'Connecting to TrueForge…';
    this.show(chat);
    try {
      this.actions.edits.beginTurn();
      const selectionScoped = Boolean(chat.editScope);
      if (!approvals) { this.actions.beginRequest(chat.editScope); chat.editScope = undefined; }
      // The first request of a chat gets the project overview (tree and test setup) once; Edit Selection stays on its selection.
      let overview = !approvals && !chat.session && !selectionScoped ? await this.actions.projectOverview() : '';
      const preparedInput: TrueForgeApi.CreateTurnSessionsStreamRequest['input'] = [];
      const feedback = input?.length && input.every(event => event.type === 'user.message') ? this.reviewFeedback.message() : undefined;
      if (feedback) preparedInput.push({ type: 'user.message', content: feedback });
      for (const event of input ?? []) {
        if (event.type === 'user.message' && typeof event.content === 'string' && isArchitectureRequest(event.content)) {
          const context = await this.actions.architectureContext();
          preparedInput.push({ ...event, content: [event.content, overview, context].filter(Boolean).join('\n\n') });
          overview = '';
        } else if (event.type === 'user.message' && typeof event.content === 'string' && overview) {
          preparedInput.push({ ...event, content: `${event.content}\n\n${overview}` });
          overview = '';
        } else preparedInput.push(event);
      }
      if (approvals && !chat.session) throw new Error('The approval session is no longer available. Start a new task.');
      if (!chat.session) {
        const config = vscode.workspace.getConfiguration("forgeAgent");
        const model = config.get<string>("model", "").trim();
        if (!model) throw new Error("Model not configured. Set forgeAgent.model after adding a model in local TrueForge.");
        const connector = config.get<string>("connector", "forge-editor");
        const editorManifest = connector ? await this.actions.getEditorManifest(connector) : undefined;
        chat.session = new ForgeSession({ baseUrl: config.get<string>("baseUrl", "http://127.0.0.1:8790"), model, connector, editorManifest, reasoningEffort: config.get<string>('reasoningEffort', ''), approveEdits: config.get<boolean>('saveOnApprove', true), onEvent: event => this.event(chat, event) });
      }
      chat.turnError = undefined;
      if (!approvals) chat.lastInput = preparedInput;
      if (approvals) await chat.session.approve(approvals);
      else await chat.session.send(preparedInput);
      await this.recover(chat);
      if (feedback && !chat.cancellationRequested) this.reviewFeedback.clear();
      await this.prepareApprovals(chat);
    } catch (error: unknown) {
      if (approvals && chat.session?.awaitingApproval && !chat.cancellationRequested) chat.approvals = approvals;
      // A failed create must not retain settings that the user has corrected.
      if (!chat.session?.id) chat.session = undefined;
      chat.status = error instanceof Error ? error.message : "TrueForge request failed.";
      chat.messages.push({ id: randomUUID(), role: "assistant", text: chat.status });
    } finally {
      this.owner = undefined;
      // A turn paused for approval is still running; otherwise show one diff now that staging has finished.
      if (!chat.approvals.length && !chat.questions.length) await this.actions.edits.endTurn().catch(() => undefined);
      chat.busy = false;
      this.show(chat);
    }
  }
  private event(chat: HeldChat, event: TrueForgeApi.TurnStreamingEvent): void {
    chat.status = `Session ${chat.session?.id ?? "starting"} · ${event.type}`;
    if (event.type === "model.message.delta" && event.toolCalls) chat.toolCalls.add(event.id, event.toolCalls);
    // Compaction comes from TrueForge, not from our tools: show it in the feed with sizes before and after.
    const compaction = [...chat.activity].reverse().find(entry => entry.kind === 'compaction');
    if (event.type === 'thread.context_compaction_started') this.recordActivity({ kind: 'compaction', contextTokens: Math.round(event.trigger.contextTokens), thresholdTokens: event.trigger.thresholdTokens, done: false });
    if (event.type === 'thread.context_compaction_finished' && compaction?.kind === 'compaction' && !compaction.done) { compaction.done = true; compaction.durationMs = Math.round(event.durationMs); }
    if (event.type === 'model.message.delta' && event.usage && compaction?.kind === 'compaction' && compaction.done && compaction.afterTokens === undefined) compaction.afterTokens = event.usage.inputTokens;
    if (event.type === "model.message" && event.toolCalls) chat.toolCalls.remember(event.id, event.toolCalls);
    if (event.type === "model.message" && event.threadId === "main" && typeof event.content === "string" && event.content) {
      const existing = chat.messages.find(message => message.id === event.id && message.role === "assistant");
      if (existing) existing.text = event.content;
      else chat.messages.push({ id: event.id, role: "assistant", text: event.content });
    }
    if (event.type === "model.message.delta" && event.threadId === "main" && event.content) {
      const existing = chat.messages.find(message => message.id === event.id && message.role === "assistant");
      if (existing) existing.text += event.content;
      else chat.messages.push({ id: event.id, role: "assistant", text: event.content });
    }
    if (event.type === "tool.response_required") {
      let added = 0;
      for (const ref of event.toolCalls) {
        const call = chat.toolCalls.find(ref.sourceEventId, ref.id);
        let body: { question?: unknown; options?: unknown } | undefined;
        try {
          const parsed: unknown = JSON.parse(call?.name === "ask_user_question" ? call.arguments || "{}" : "");
          body = parsed !== null && typeof parsed === "object" ? parsed as { question?: unknown; options?: unknown } : undefined;
        } catch { body = undefined; }
        const candidate = { toolCallId: ref.id, question: body?.question, options: body?.options };
        if (!isAgentQuestion(candidate) || chat.questions.some(item => item.toolCallId === ref.id) || chat.questions.length >= 4) continue;
        chat.questions.push({ toolCallId: candidate.toolCallId, question: candidate.question, options: candidate.options, threadId: event.threadId });
        chat.messages.push({ id: randomUUID(), role: "assistant", text: candidate.question });
        added += 1;
      }
      if (added > 0) chat.status = "Choose an answer";
      else if (chat.questions.length === 0) chat.status = "The agent asked a question this panel could not read. Cancel and try again.";
    }
    if (event.type === "tool.approval_required") {
      for (const tool of event.toolCalls) {
        if (!chat.approvals.some(item => item.threadId === event.threadId && item.toolCallId === tool.id)) {
          const call = chat.toolCalls.find(tool.sourceEventId, tool.id);
          if (call) this.approvalCalls.set(tool.id, call);
          chat.approvals.push({ type: "user.tool_approval", threadId: event.threadId, toolCallId: tool.id, approval: { status: "allow" } });
          // An edit's card waits until its diff is staged for review (prepareApprovals); Edit Selection never shows one.
          if (call?.name !== 'propose_edit') chat.messages.push({ id: randomUUID(), role: "assistant", text: describeApproval(call) });
        }
      }
    }
    if (event.type === "turn.done" && event.state.status === "error") { chat.turnError = event.state.message; chat.status = `Model error: ${classifyModelError(event.state.message).summary}`; }
    this.show(chat);
  }

  private disposeView(): void {
    for (const disposable of this.viewDisposables) {
      disposable.dispose();
    }
    this.viewDisposables = [];
    this.view = undefined;
    this.composerReady = false;
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
    <button id="new-chat-button" class="ghost" type="button" title="New chat" aria-label="New chat">+</button>
    <div id="chat-list" role="tablist" aria-label="Chats"></div>
    <p class="description">Your editor, connected to local TrueForge.</p>
    <button id="copy-mcp-button" class="ghost" type="button">Copy MCP connection</button>
    <span class="badge" id="status" role="status">Ready</span>
  </header>
  <main id="task-content" aria-label="Task workspace">
  <div id="messages" role="log" aria-label="Conversation" aria-live="polite" aria-relevant="additions text">
    <p class="empty-state">Your messages will appear here.</p>
  </div>
  <section id="review-panel" role="region" aria-label="Proposed changes" hidden></section>
  </main>
  <div id="run-actions" role="group" aria-label="Current request"><button id="cancel-button" type="button" disabled>Cancel</button> <button id="approve-button" type="button" hidden>Approve</button> <button id="deny-button" type="button" hidden>Deny</button></div>
  <section id="agent-questions" aria-label="Agent questions" hidden></section>
  <form id="message-form">
    <label for="message-input">Message</label>
    <div class="composer">
      <div id="composer-context" hidden></div>
      <textarea id="message-input" rows="4" placeholder="Ask Forge, or attach a selection with Ctrl+L" spellcheck="false" title="Ctrl+Enter sends"></textarea>
      <div class="composer-actions">
        <div class="composer-tools">
          <span class="mode-pill" title="Forge runs the TrueForge agent">Agent</span>
          <button id="select-model-button" class="ghost pill" type="button">Select model</button>
          <button id="add-selection-button" class="ghost pill" type="button" title="Attach the editor selection (Ctrl+L)">Selection</button>
          <button id="spin-agents-button" class="ghost pill" type="button" title="Start several agents with this command">Spin</button>
        </div>
        <div class="composer-end">
          <span id="context-meter" role="img" title="Context window" aria-label="Context window empty">
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><circle class="meter-track" cx="8" cy="8" r="6"></circle><circle class="meter-value" cx="8" cy="8" r="6"></circle></svg>
          </span>
          <button id="send-button" class="send" type="submit" disabled aria-label="Send">&#8593;</button>
        </div>
      </div>
    </div>
  </form>
  <script type="module" nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
