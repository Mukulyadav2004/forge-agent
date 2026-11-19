import { classifyModelError, deleteRemoteSession, ForgeSession, listModelNames } from "../agent/ForgeSession";
import type { TrueForgeApi } from "@truefoundry/trueforge-sdk";
import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { isWebviewMessage } from "../shared/messages";
import type { ActivityEntry, AgentQuestion, ChatMessage, ComposerSelection, FileEvidence, HostMessage, ModelMenu, TokenUsage } from "../shared/messages";
import { isAgentQuestion } from "../shared/messages";
import type { EditService } from '../edits/EditService';
import type { ReviewCommand } from '../edits/review';
import { ReviewFeedback } from './ReviewFeedback';
import { describeApproval, StreamedToolCalls } from '../agent/approvalText';
import { estimateTokens, isArchitectureRequest, renderRestoredTranscript } from '../context/projectContext';
import { latestTodos } from './TaskHistory';
import type { StoredTask, TaskHistory } from './TaskHistory';

/** Adds one turn's TrueForge metrics to a chat's totals. A cost is kept only while every counted turn reported one. */
function addTurnMetrics(total: TokenUsage | undefined, metrics: TrueForgeApi.TurnMetrics | undefined): TokenUsage | undefined {
  if (!metrics || metrics.totalInputTokens === undefined || metrics.totalOutputTokens === undefined) return total;
  const sum = (key: 'cacheReadTokens' | 'cacheWriteTokens' | 'reasoningTokens', added: number | undefined) => {
    const value = total?.[key] === undefined && added === undefined ? undefined : (total?.[key] ?? 0) + (added ?? 0);
    return value === undefined ? {} : { [key]: value };
  };
  const cost = metrics.totalCostInUsd !== undefined && (!total || total.costUsd !== undefined) ? { costUsd: (total?.costUsd ?? 0) + metrics.totalCostInUsd } : {};
  return {
    inputTokens: (total?.inputTokens ?? 0) + metrics.totalInputTokens, outputTokens: (total?.outputTokens ?? 0) + metrics.totalOutputTokens,
    ...sum('cacheReadTokens', metrics.totalCacheReadTokens), ...sum('cacheWriteTokens', metrics.totalCacheWriteTokens), ...sum('reasoningTokens', metrics.totalReasoningTokens), ...cost,
  };
}

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
  /** Latest model input tokens, and the model's context window once TrueForge reports it. */
  contextTokens: number;
  contextWindow: number;
  /** Instruction files were already shown in this chat. */
  notedInstructions: boolean;
  /** Token totals of finished turns, and the running turn's latest metrics; TrueForge reports metrics per turn. */
  usage: TokenUsage | undefined;
  turnMetrics: TrueForgeApi.TurnMetrics | undefined;
  /** Tool name of each pending approval by tool call id, for the approve button's label. */
  approvalNames: Map<string, string>;
  createdAt: number;
  /** Set when the chat was reopened from history: the saved TrueForge session to reattach, and the transcript for a new session if it is gone. */
  restore?: { sessionId?: string; lastGoodTurnId?: string; model?: string; transcript: string };
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
  private pumping = false;
  private composerReady = false;
  private queuedComposer: Extract<HostMessage, { type: 'attach_selection' | 'focus_composer' }> | undefined;
  private readonly addSelectionCommand = vscode.commands.registerCommand('forgeAgent.addSelection', () => { void this.addSelection(); });
  /** Model names last read from local TrueForge, for the composer's model menu. */
  private modelNames: string[] = [];
  private contextTokens = 0;
  private contextWindow = 0;
  private modelsLoading = false;
  private modelsError: string | undefined;
  private readonly configListener = vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration('forgeAgent.baseUrl')) void this.refreshModels();
    else if (event.affectsConfiguration('forgeAgent.model')) this.publish();
  });

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly actions: {
      getEditorManifest: (namePrefix: string) => Promise<TrueForgeApi.RemoteMcpServerManifest>;
      openFile: (options: { path: string; line: number }) => Promise<void>;
      projectInstructions: () => Promise<{ text: string; files: Array<{ path: string; lines: number }> }>;
      architectureContext: () => Promise<string>;
      /** Resets the per-request character counter. `scope` limits staged edits to one file (Edit Selection). */
      beginRequest: (scope?: string) => void;
      edits: EditService;
      /** Saved chats for this workspace. Without it, chats live only until the window reloads. */
      history?: TaskHistory;
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
          void this.refreshModels();
        } else if (value.type === "copy_mcp_connection") {
          void vscode.commands.executeCommand("forgeAgent.copyMcp");
        } else if (value.type === "select_model") {
          void this.selectModel();
        } else if (value.type === "refresh_models") {
          void this.refreshModels();
        } else if (value.type === "set_model") {
          if (this.modelNames.includes(value.name)) void this.applyModel(value.name);
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
        } else if (value.type === "open_history") {
          void this.openHistory(value.id);
        } else if (value.type === "delete_history") {
          void this.deleteHistory(value.id);
        } else if (value.type === "spin_agents") {
          void this.spinAgents(value.text, value.count);
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
          if (chat) {
            const input: TrueForgeApi.UserToolApprovalInputEvent[] = chat.approvals.map(item => ({ ...item, approval: value.allow ? { status: "allow" } : { status: "deny", reason: "Declined in VS Code" } }));
            chat.approvals.splice(0, chat.approvals.length);
            this.jobs.unshift(() => this.run(chat, [], input));
            this.kick();
          }
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
    this.configListener.dispose();
    this.sync();
    this.saveChats();
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = undefined; }
    this.actions.history?.flushSync();
    for (const chat of this.chats) void chat.session?.cancel().catch(() => undefined);
    this.disposeView();
  }

  private blankChat(title: string): HeldChat {
    return {
      id: randomUUID(), title, session: undefined, busy: false, cancellationRequested: false, status: 'New chat ready',
      approvals: [], toolCalls: new StreamedToolCalls(), turnError: undefined, editScope: undefined, lastInput: undefined,
      messages: [], inspectedFiles: [], activity: [], heldSelections: [], questions: [], contextTokens: 0, contextWindow: 0, notedInstructions: false, createdAt: Date.now(),
      usage: undefined, turnMetrics: undefined, approvalNames: new Map(),
    };
  }

  private saveTimer: NodeJS.Timeout | undefined;
  /** What each chat looked like when last saved, so streaming does not rewrite unchanged chats. */
  private readonly savedFingerprints = new Map<string, string>();
  private scheduleSave(): void {
    if (!this.actions.history || this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = undefined; this.saveChats(); }, 500);
  }
  private fingerprint(chat: HeldChat): string {
    const last = chat.messages[chat.messages.length - 1];
    const lastActivity = chat.activity[chat.activity.length - 1];
    return [chat.title, chat.messages.length, last?.id, last?.text.length, chat.activity.length, lastActivity ? JSON.stringify(lastActivity).length : 0,
      chat.session?.id ?? chat.restore?.sessionId ?? '', chat.session?.lastTurnId ?? '', chat.contextTokens, chat.contextWindow].join('|');
  }
  /** Saves every open chat that has a conversation and changed since its last save. */
  private saveChats(): void {
    const history = this.actions.history;
    if (!history) return;
    for (const chat of this.chats) {
      if (!chat.messages.length) continue;
      const fingerprint = this.fingerprint(chat);
      if (this.savedFingerprints.get(chat.id) === fingerprint) continue;
      this.savedFingerprints.set(chat.id, fingerprint);
      const task: StoredTask = {
        version: 1, id: chat.id, title: chat.title, createdAt: chat.createdAt, updatedAt: Date.now(),
        model: chat.session?.model ?? chat.restore?.model,
        sessionId: chat.session?.id ?? chat.restore?.sessionId,
        lastGoodTurnId: chat.session?.lastTurnId ?? chat.restore?.lastGoodTurnId,
        messages: chat.messages, activity: chat.activity, inspectedFiles: chat.inspectedFiles, todos: latestTodos(chat.activity),
        contextTokens: chat.contextTokens, contextWindow: chat.contextWindow,
      };
      history.save(task);
    }
  }
  /** Reopens a saved chat. Its TrueForge session is reattached on the next message, or replaced by a new one that is given the transcript. */
  private async openHistory(id: string): Promise<void> {
    if (this.chats.some(chat => chat.id === id)) { this.selectChat(id); this.publish(); return; }
    const task = await this.actions.history?.get(id);
    if (!task) { this.status = 'That task is no longer in history.'; this.publish(); return; }
    if (this.chats.some(chat => chat.id === id)) { this.selectChat(id); this.publish(); return; }
    this.sync();
    const active = this.activeChat();
    const reuse = active && !active.messages.length && !active.busy && !active.approvals.length && !active.questions.length ? active : undefined;
    if (!reuse && this.chats.length >= 8) { void vscode.window.showInformationMessage('Eight chats are open. That is the limit for now.'); return; }
    const chat = this.blankChat((task.title.trim() || 'Restored task').slice(0, 80));
    chat.id = task.id;
    chat.createdAt = task.createdAt || task.updatedAt;
    chat.messages = task.messages;
    chat.activity = task.activity;
    chat.inspectedFiles = task.inspectedFiles;
    if (task.todos?.length && !latestTodos(chat.activity)) chat.activity.push({ kind: 'todo', todos: task.todos, at: chat.messages.length });
    chat.contextTokens = task.contextTokens || estimateTokens(task.messages.map(message => message.text).join('\n'));
    chat.contextWindow = task.contextWindow || 0;
    chat.notedInstructions = true;
    chat.restore = { sessionId: task.sessionId, lastGoodTurnId: task.lastGoodTurnId, model: task.model, transcript: renderRestoredTranscript(task.messages) };
    chat.status = 'Restored from history. Send a message to continue this task.';
    if (reuse) this.chats.splice(this.chats.indexOf(reuse), 1, chat);
    else this.chats.push(chat);
    this.savedFingerprints.set(chat.id, this.fingerprint(chat));
    this.bindChat(chat);
    this.publish();
  }
  /** Removes a saved chat, closing it if it is open and idle. */
  private async deleteHistory(id: string): Promise<void> {
    const open = this.chats.find(chat => chat.id === id);
    if (open && (open.busy || open.approvals.length || open.questions.length)) { this.status = 'Stop this task before deleting it from history.'; this.publish(); return; }
    if (open) {
      this.sync();
      const index = this.chats.indexOf(open);
      this.chats.splice(index, 1);
      if (!this.chats.length) this.chats.push(this.blankChat('Chat 1'));
      if (this.activeId === id) this.bindChat(this.chats[Math.min(index, this.chats.length - 1)]!);
    }
    this.savedFingerprints.delete(id);
    const sessionId = open?.session?.id ?? (await this.actions.history?.get(id))?.sessionId;
    await this.actions.history?.delete(id).catch(() => undefined);
    this.publish();
    if (sessionId) void deleteRemoteSession({ baseUrl: vscode.workspace.getConfiguration('forgeAgent').get<string>('baseUrl', 'http://127.0.0.1:8790'), sessionId });
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
    chat.contextTokens = this.contextTokens; chat.contextWindow = this.contextWindow;
  }

  /** Makes one stored chat the live one and restores its attached selections. */
  private bindChat(chat: HeldChat): void {
    this.activeId = chat.id;
    this.session = chat.session; this.busy = chat.busy; this.cancellationRequested = chat.cancellationRequested; this.status = chat.status;
    this.approvals = chat.approvals; this.toolCalls = chat.toolCalls; this.turnError = chat.turnError; this.editScope = chat.editScope;
    this.lastInput = chat.lastInput; this.messages = chat.messages; this.inspectedFiles = chat.inspectedFiles; this.activity = chat.activity; this.heldSelections = chat.heldSelections; this.questions = chat.questions;
    this.contextTokens = chat.contextTokens; this.contextWindow = chat.contextWindow;
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
      this.contextTokens = chat.contextTokens; this.contextWindow = chat.contextWindow;
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
  private async spinAgents(text: string, count?: number): Promise<void> {
    const reusable = this.activeChat();
    const reuse = Boolean(reusable && reusable.messages.length === 0 && !reusable.busy);
    const free = 8 - this.chats.length + (reuse ? 1 : 0);
    if (free < 2) { void vscode.window.showInformationMessage('Two agents need two free chats. Eight chats is the limit.'); return; }
    if (count !== undefined && count > free) { void vscode.window.showInformationMessage(`Only ${free} chats are free. Eight chats is the limit.`); return; }
    const picked = count !== undefined ? String(count) : await vscode.window.showQuickPick(['2', '3', '4'].filter(option => Number(option) <= free), { title: 'Spin agents', placeHolder: 'How many agents should run this command?' });
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
    if (command.action !== 'preview' && this.chats.some(chat => chat.busy || chat.approvals.length > 0 || chat.questions.length > 0)) { this.status = 'Finish or cancel the running agents before applying, rejecting or undoing changes.'; this.publish(); return; }
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
  private agentsRunning(): boolean {
    return this.pumping || this.jobs.length > 0 || this.chats.some(chat => chat.busy || chat.approvals.length > 0 || chat.questions.length > 0) || this.actions.edits.state.busy;
  }
  /** Reads the configured models from local TrueForge for the composer's model menu. */
  async refreshModels(): Promise<void> {
    if (this.modelsLoading) return;
    this.modelsLoading = true;
    this.publish();
    try {
      const config = vscode.workspace.getConfiguration("forgeAgent");
      this.modelNames = await listModelNames({ baseUrl: config.get<string>("baseUrl", "http://127.0.0.1:8790") });
      this.modelsError = this.modelNames.length ? undefined : "No models yet. Add a model provider in local TrueForge.";
    } catch (error: unknown) {
      this.modelsError = `Could not reach local TrueForge: ${error instanceof Error ? error.message : "unknown error"}`;
    } finally {
      this.modelsLoading = false;
      this.publish();
    }
  }
  /** Command palette fallback for Forge: Select Model; the composer uses its own menu. */
  async selectModel(): Promise<void> {
    if (this.agentsRunning()) {
      void vscode.window.showInformationMessage("Finish or cancel the running agents before selecting a model.");
      return;
    }
    try {
      const config = vscode.workspace.getConfiguration("forgeAgent");
      const names = await listModelNames({ baseUrl: config.get<string>("baseUrl", "http://127.0.0.1:8790") });
      if (!names.length) throw new Error("Add a model in local TrueForge first, then select it here.");
      this.modelNames = names;
      const name = await vscode.window.showQuickPick(names, { title: "Select a TrueForge model", placeHolder: "Models configured in your local TrueForge server" });
      if (!name) return;
      await this.applyModel(name);
    } catch (error: unknown) {
      this.status = error instanceof Error ? error.message : "Could not load TrueForge models.";
      this.publish();
      void vscode.window.showErrorMessage(this.status);
    }
  }
  /** Saves the model where forgeAgent.model is already set and starts a fresh task on it. */
  private async applyModel(name: string): Promise<void> {
    if (this.agentsRunning()) {
      void vscode.window.showInformationMessage("Finish or cancel the running agents before selecting a model.");
      return;
    }
    try {
      const config = vscode.workspace.getConfiguration("forgeAgent");
      const setting = config.inspect<string>("model");
      const target = setting?.workspaceFolderValue !== undefined ? vscode.ConfigurationTarget.WorkspaceFolder
        : setting?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
      await config.update("model", name, target);
      await this.actions.edits.newTask();
      this.reviewFeedback.clear();
      this.session = undefined; this.approvals = []; this.messages.length = 0; this.inspectedFiles.length = 0; this.activity.length = 0; this.toolCalls.clear();
      this.turnError = undefined; this.lastInput = undefined; this.heldSelections.length = 0; this.contextTokens = 0; this.contextWindow = 0;
      const active = this.activeChat();
      if (active) { active.contextTokens = 0; active.contextWindow = 0; active.notedInstructions = false; active.session = undefined; active.usage = undefined; active.turnMetrics = undefined; }
      // The cleared chat is a new task; a fresh id keeps the saved conversation it replaced in history.
      if (active) { active.id = randomUUID(); this.activeId = active.id; active.restore = undefined; active.createdAt = Date.now(); active.title = `Chat ${this.chats.indexOf(active) + 1}`; }
      this.queuedComposer = { type: 'attach_selection', selections: [] };
      this.flushComposer();
      this.status = `Model: ${name}`;
      this.publish();
    } catch (error: unknown) {
      this.status = error instanceof Error ? error.message : "Could not save the model setting.";
      this.publish();
      void vscode.window.showErrorMessage(this.status);
    }
  }
  private publish(): void {
    const models: ModelMenu = {
      current: vscode.workspace.getConfiguration("forgeAgent").get<string>("model", "").trim(),
      names: this.modelNames, loading: this.modelsLoading, ...(this.modelsError ? { error: this.modelsError } : {}),
    };
    const active = this.activeChat();
    const usage = active ? addTurnMetrics(active.usage, active.turnMetrics) : undefined;
    const approvalTools = this.approvals.map(item => active?.approvalNames.get(item.toolCallId) ?? '');
    const response: HostMessage = { type: "state", messages: this.messages, busy: this.busy, status: this.status, approval: this.approvals.length > 0, inspectedFiles: this.inspectedFiles, activity: this.activity, review: this.actions.edits.state, chats: this.chats.map(chat => ({ id: chat.id, title: chat.title, active: chat.id === this.activeId, busy: chat.busy })), questions: this.questions.map(({ toolCallId, question, options }) => ({ toolCallId, question, options })), models, context: { used: this.contextTokens, limit: this.contextWindow }, history: this.actions.history?.list() ?? [], ...(usage ? { usage } : {}), ...(approvalTools.length ? { approvalTools } : {}) };
    this.scheduleSave();
    void this.view?.webview.postMessage(response);
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
    const session = chat.session;
    chat.busy = true;
    chat.status = "Sending your answer…";
    this.show(chat);
    // The resumed turn uses the editor tools like any other, so it waits its turn and owns the activity feed meanwhile.
    this.jobs.unshift(async () => {
      if (chat.cancellationRequested) { chat.busy = false; this.show(chat); return; }
      this.owner = chat;
      try { await session.respond(events); }
      catch (error: unknown) {
        if (session.awaitingApproval && chat.questions.length === 0) chat.questions.push(...saved);
        chat.status = error instanceof Error ? error.message : "Could not send the answer.";
        chat.messages.push({ id: randomUUID(), role: "assistant", text: chat.status });
      } finally {
        this.owner = undefined;
        if (!chat.questions.length && !chat.approvals.length) await this.actions.edits.endTurn().catch(() => undefined);
        chat.busy = false;
        this.show(chat);
      }
    });
    this.kick();
  }
  private async cancel(): Promise<void> {
    const chat = this.activeChat();
    if (!chat) return;
    // A chat still waiting in the queue has not touched the editor; cancelling it must not discard the running agent's proposals.
    const inEditor = this.owner === chat || chat.approvals.length > 0 || chat.questions.length > 0 || chat.session?.awaitingApproval === true;
    chat.cancellationRequested = true;
    this.cancellationRequested = true;
    chat.approvals.splice(0, chat.approvals.length);
    chat.questions.splice(0, chat.questions.length);
    try {
      if (inEditor) {
        const discarded = this.actions.edits.cancel();
        const cancelled = chat.session?.cancel();
        await discarded; await cancelled;
        chat.status = "Cancellation requested. Pending proposals were discarded; applied batches remain available in Undo.";
      } else chat.status = 'Cancelled before this agent started.';
    }
    catch { chat.status = "Could not confirm cancellation. Check the local TrueForge server."; }
    this.show(chat);
    // A paused agent held the queue; the agents waiting behind it can start now.
    this.kick();
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
      if (!approvals) { this.actions.beginRequest(chat.editScope); chat.editScope = undefined; }
      const preparedInput: TrueForgeApi.CreateTurnSessionsStreamRequest['input'] = [];
      const feedback = input?.length && input.every(event => event.type === 'user.message') ? this.reviewFeedback.message() : undefined;
      if (feedback) preparedInput.push({ type: 'user.message', content: feedback });
      for (const event of input ?? []) {
        if (event.type === 'user.message' && typeof event.content === 'string' && isArchitectureRequest(event.content)) {
          const context = await this.actions.architectureContext();
          preparedInput.push({ ...event, content: context ? `${event.content}\n\n${context}` : event.content });
        } else preparedInput.push(event);
      }
      if (approvals && !chat.session) throw new Error('The approval session is no longer available. Start a new task.');
      if (!chat.session) {
        const config = vscode.workspace.getConfiguration("forgeAgent");
        const model = config.get<string>("model", "").trim();
        if (!model) throw new Error("Model not configured. Set forgeAgent.model after adding a model in local TrueForge.");
        const connector = config.get<string>("connector", "forge-editor");
        const editorManifest = connector ? await this.actions.getEditorManifest(connector) : undefined;
        const instructions = await this.actions.projectInstructions();
        if (!chat.notedInstructions) {
          chat.notedInstructions = true;
          for (const file of instructions.files) this.recordActivity({ kind: 'context', path: file.path, startLine: 1, endLine: file.lines });
        }
        const restore = chat.restore;
        chat.session = new ForgeSession({
          baseUrl: config.get<string>("baseUrl", "http://127.0.0.1:8790"), model, connector, editorManifest, projectInstructions: instructions.text, reasoningEffort: config.get<string>('reasoningEffort', ''),
          workspaceRoot: vscode.workspace.workspaceFolders?.find(folder => folder.uri.scheme === 'file')?.uri.fsPath,
          ...(restore?.sessionId ? { resume: { sessionId: restore.sessionId, lastGoodTurnId: restore.lastGoodTurnId } } : {}),
          ...(restore?.transcript ? { restoredTranscript: restore.transcript } : {}),
          onEvent: event => this.event(chat, event),
        });
      }
      chat.turnError = undefined;
      if (!approvals) chat.lastInput = preparedInput;
      if (approvals) await chat.session.approve(approvals);
      else await chat.session.send(preparedInput);
      await this.recover(chat);
      if (feedback && !chat.cancellationRequested) this.reviewFeedback.clear();
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
    if (chat.restore && chat.session?.id) {
      if (chat.restore.sessionId && chat.session.resumed === 'lost') chat.messages.push({ id: randomUUID(), role: 'assistant', text: '_The saved TrueForge session is no longer on the server. This task continues in a new session that was given the earlier conversation._' });
      chat.restore = undefined;
    }
    if (event.type === "model.message.delta" && event.toolCalls) chat.toolCalls.add(event.id, event.toolCalls);
    // Compaction comes from TrueForge, not from our tools: show it in the feed with sizes before and after.
    const compaction = [...chat.activity].reverse().find(entry => entry.kind === 'compaction');
    if (event.type === 'thread.context_compaction_started') this.recordActivity({ kind: 'compaction', contextTokens: Math.round(event.trigger.contextTokens), thresholdTokens: event.trigger.thresholdTokens, done: false });
    if (event.type === 'thread.context_compaction_finished' && compaction?.kind === 'compaction' && !compaction.done) { compaction.done = true; compaction.durationMs = Math.round(event.durationMs); }
    if ((event.type === 'model.message' || event.type === 'model.message.delta') && event.usage) chat.contextTokens = event.usage.inputTokens;
    if (chat.session?.contextWindow) chat.contextWindow = chat.session.contextWindow;
    if (event.type === 'model.message.delta' && event.usage && compaction?.kind === 'compaction' && compaction.done && compaction.afterTokens === undefined) compaction.afterTokens = event.usage.inputTokens;
    // Each turn reports its own running totals; a finished (or abandoned) turn's last report is added to the chat's totals.
    if (event.type === 'turn.created' && chat.turnMetrics) { chat.usage = addTurnMetrics(chat.usage, chat.turnMetrics); chat.turnMetrics = undefined; }
    if ((event.type === 'turn.update' || event.type === 'turn.done') && 'metrics' in event.state && event.state.metrics) chat.turnMetrics = event.state.metrics;
    if (event.type === 'turn.done') { chat.usage = addTurnMetrics(chat.usage, chat.turnMetrics); chat.turnMetrics = undefined; }
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
          chat.approvals.push({ type: "user.tool_approval", threadId: event.threadId, toolCallId: tool.id, approval: { status: "allow" } });
          if (call?.name) chat.approvalNames.set(tool.id, call.name.slice(0, 120));
          if (chat.approvalNames.size > 50) chat.approvalNames.delete(chat.approvalNames.keys().next().value as string);
          chat.messages.push({ id: randomUUID(), role: "assistant", text: describeApproval(call) });
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
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "out-webview", "webview", "main.css"));
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
  <div id="root"></div>
  <script type="module" nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
