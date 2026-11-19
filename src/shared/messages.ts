import { ReviewCommandSchema, ReviewStateSchema } from '../edits/review.js';
import type { ReviewCommand, ReviewState } from '../edits/review.js';

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
}

/** One multiple-choice question from TrueForge's ask_user_question tool. */
export interface AgentQuestion {
  toolCallId: string;
  question: string;
  options: string[];
}

/** One open agent chat in the sidebar. At most eight. `active` is the chat that receives Send. */
export interface ChatTab {
  id: string;
  title: string;
  active: boolean;
  /** True while this agent is waiting to start or running a turn. */
  busy: boolean;
}

export interface FileEvidence {
  path: string;
  startLine: number;
  endLine: number;
  origin: 'tool' | 'context';
}

/** One item of the agent's to-do list, written whole by the todo_write tool. */
export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
}

/** One saved task in the history view; the transcript itself stays on the extension side. */
export interface TaskHistoryItem {
  id: string;
  title: string;
  updatedAt: number;
  messageCount: number;
}

/** One editor selection attached to the composer. Ctrl+L can attach several. */
export interface ComposerSelection {
  path: string;
  startLine: number;
  endLine: number;
  text: string;
}

/** One completed editor tool call, as shown in the sidebar's activity feed. Reasons are the agent's optional words.
 * `used` is how many characters of tool output this request has added, so a row can show "+N chars". A `request` entry marks a new user request. The context window itself is the model's token count, not this character counter.
 * `at` is how many chat messages existed when it happened, so the sidebar can place it in the conversation. */
export type ActivityEntry = { at?: number } & (
  | { kind: 'request' }
  | { kind: 'search'; query: string; glob: string; matches: number; fileCount: number; files: string[]; truncated: boolean; reason?: string; used?: number }
  | { kind: 'open'; path: string; startLine: number; endLine: number; reason?: string; foundBy?: string; used?: number }
  | { kind: 'propose'; path: string; detail: string; reason?: string }
  | { kind: 'list'; glob: string; count: number; used?: number }
  | { kind: 'command'; command: string; cwd: string; exitCode: number | null; timedOut: boolean; cancelled: boolean; durationMs: number; reason?: string; used?: number }
  | { kind: 'context'; path: string; startLine: number; endLine: number; used?: number }
  /** An editor tool refused or failed; `message` is what the agent was told. */
  | { kind: 'refused'; tool: string; message: string }
  /** TrueForge summarised the conversation: size that triggered it, the threshold, and the size of the next model call afterwards. */
  | { kind: 'compaction'; contextTokens: number; thresholdTokens: number; done: boolean; durationMs?: number; afterTokens?: number }
  /** The agent replaced its to-do list; the latest entry is the current list. */
  | { kind: 'todo'; todos: TodoItem[] }
  /** One web_fetch call: the final URL after redirects, HTTP status and body size, or the error the agent was told. `truncated` means the model saw a shortened page. */
  | { kind: 'fetch'; url: string; status?: number; bytes?: number; contentType?: string; truncated?: boolean; error?: string; durationMs: number; reason?: string; used?: number });

/** Token totals TrueForge reports in each turn's metrics, summed over this chat's turns. `costUsd` is present only when TrueForge reports a cost. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  costUsd?: number;
}

function isTokenUsage(value: unknown): value is TokenUsage {
  if (!isRecord(value)) return false;
  const amount = (key: string) => typeof value[key] === 'number' && Number.isFinite(value[key]) && (value[key] as number) >= 0;
  const optional = (key: string) => value[key] === undefined || amount(key);
  return amount('inputTokens') && amount('outputTokens') && optional('cacheReadTokens') && optional('cacheWriteTokens') && optional('reasoningTokens') && optional('costUsd');
}

const TODO_STATUSES = new Set(['pending', 'in_progress', 'completed', 'cancelled']);
function isTodoItem(value: unknown): value is TodoItem {
  return isRecord(value) && typeof value.content === 'string' && value.content.length > 0 && value.content.length <= 500 && typeof value.status === 'string' && TODO_STATUSES.has(value.status);
}

function isTaskHistoryItem(value: unknown): value is TaskHistoryItem {
  return isRecord(value) && typeof value.id === 'string' && value.id.length > 0 && value.id.length <= 80
    && typeof value.title === 'string' && value.title.length <= 200
    && typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt)
    && typeof value.messageCount === 'number' && Number.isSafeInteger(value.messageCount) && value.messageCount >= 0;
}

function isActivityEntry(value: unknown): value is ActivityEntry {
  if (!isRecord(value) || (value.reason !== undefined && typeof value.reason !== 'string')) return false;
  if (value.used !== undefined && !(typeof value.used === 'number' && Number.isSafeInteger(value.used) && value.used >= 0)) return false;
  if (value.at !== undefined && !(typeof value.at === 'number' && Number.isSafeInteger(value.at) && value.at >= 0)) return false;
  const text = (key: string) => typeof value[key] === 'string';
  const count = (key: string) => typeof value[key] === 'number' && Number.isSafeInteger(value[key]);
  switch (value.kind) {
    case 'request': return true;
    case 'search': return text('query') && text('glob') && count('matches') && count('fileCount') && typeof value.truncated === 'boolean' && Array.isArray(value.files) && value.files.every(file => typeof file === 'string');
    case 'open': return text('path') && count('startLine') && count('endLine') && (value.foundBy === undefined || text('foundBy'));
    case 'propose': return text('path') && text('detail');
    case 'list': return text('glob') && count('count');
    case 'command': return text('command') && text('cwd') && (value.exitCode === null || count('exitCode')) && typeof value.timedOut === 'boolean' && typeof value.cancelled === 'boolean' && count('durationMs');
    case 'context': return text('path') && count('startLine') && count('endLine');
    case 'refused': return text('tool') && text('message');
    case 'compaction': return count('contextTokens') && count('thresholdTokens') && typeof value.done === 'boolean' && (value.durationMs === undefined || count('durationMs')) && (value.afterTokens === undefined || count('afterTokens'));
    case 'todo': return Array.isArray(value.todos) && value.todos.length <= 50 && value.todos.every(isTodoItem);
    case 'fetch': return text('url') && count('durationMs') && (value.status === undefined || count('status')) && (value.bytes === undefined || count('bytes'))
      && (value.contentType === undefined || text('contentType')) && (value.truncated === undefined || typeof value.truncated === 'boolean') && (value.error === undefined || text('error'));
    default: return false;
  }
}

/** Models configured in local TrueForge, for the composer's model menu. `current` is forgeAgent.model and may be outside `names`. */
export interface ModelMenu {
  current: string;
  names: string[];
  loading: boolean;
  error?: string;
}

export type WebviewMessage =
  | { type: "ready" }
  | { type: "copy_mcp_connection" }
  | { type: "select_model" }
  | { type: "set_model"; name: string }
  | { type: "refresh_models" }
  | { type: 'review'; command: ReviewCommand }
  | { type: "open_file"; path: string; line: number }
  | { type: "send_message"; text: string; selections?: ComposerSelection[] }
  | { type: "new_chat" }
  | { type: "select_chat"; id: string }
  | { type: "spin_agents"; text: string; count?: number }
  | { type: "add_selection" }
  | { type: "clear_selection"; index: number }
  | { type: "cancel" }
  | { type: "approve"; allow: boolean }
  | { type: "answer_question"; answers: { toolCallId: string; choice: string }[] }
  | { type: "open_history"; id: string }
  | { type: "delete_history"; id: string };

export type HostMessage =
  | { type: "state"; messages: ChatMessage[]; busy: boolean; status: string; approval: boolean; inspectedFiles: FileEvidence[]; activity: ActivityEntry[]; review: ReviewState; chats: ChatTab[]; questions: AgentQuestion[]; models: ModelMenu; context: { used: number; limit: number }; history: TaskHistoryItem[];
      /** Token totals for the active chat, once TrueForge has reported a turn's metrics. */
      usage?: TokenUsage;
      /** Tool names of the pending approvals, so the approve button can name the action. */
      approvalTools?: string[] }
  | { type: "attach_selection"; selections: ComposerSelection[] }
  | { type: "focus_composer" };

export function isComposerSelection(value: unknown): value is ComposerSelection {
  return isRecord(value)
    && typeof value.path === 'string' && value.path.length > 0 && value.path.length <= 1024 && !/[\r\n]/u.test(value.path)
    && typeof value.startLine === 'number' && Number.isSafeInteger(value.startLine) && value.startLine > 0
    && typeof value.endLine === 'number' && Number.isSafeInteger(value.endLine) && value.endLine >= value.startLine
    && typeof value.text === 'string' && value.text.length > 0 && value.text.length <= 20000;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isChoice(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 120 && !/[\r\n]/u.test(value);
}

export function isAgentQuestion(value: unknown): value is AgentQuestion {
  return isRecord(value) && typeof value.toolCallId === "string" && value.toolCallId.length > 0 && value.toolCallId.length <= 80
    && typeof value.question === "string" && value.question.length > 0 && value.question.length <= 500
    && Array.isArray(value.options) && value.options.length >= 2 && value.options.length <= 6 && value.options.every(isChoice);
}

function isChatTab(value: unknown): value is ChatTab {
  return isRecord(value) && typeof value.id === "string" && value.id.length > 0 && value.id.length <= 80
    && typeof value.title === "string" && value.title.length > 0 && value.title.length <= 80 && typeof value.active === "boolean" && typeof value.busy === "boolean";
}

function isChatMessage(value: unknown): value is ChatMessage {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    (value.role === "user" || value.role === "assistant") &&
    typeof value.text === "string"
  );
}

export function isWebviewMessage(value: unknown): value is WebviewMessage {
  return (
    isRecord(value) &&
    (value.type === "ready" || value.type === "copy_mcp_connection" || value.type === "select_model" || value.type === "refresh_models" || value.type === "cancel" || value.type === "add_selection" || value.type === "new_chat" ||
      (value.type === "set_model" && typeof value.name === "string" && value.name.length > 0 && value.name.length <= 200) ||
      ((value.type === "select_chat" || value.type === "open_history" || value.type === "delete_history") && typeof value.id === "string" && value.id.length > 0 && value.id.length <= 80) ||
      (value.type === "spin_agents" && typeof value.text === "string" && value.text.length <= 20000 && (value.count === undefined || (typeof value.count === "number" && Number.isSafeInteger(value.count) && value.count >= 2 && value.count <= 4))) ||
      (value.type === "open_file" && typeof value.path === "string" && typeof value.line === "number" && Number.isSafeInteger(value.line) && value.line > 0) ||
      (value.type === 'review' && ReviewCommandSchema.safeParse(value.command).success) ||
      (value.type === "approve" && typeof value.allow === "boolean") ||
      (value.type === "answer_question" && Array.isArray(value.answers) && value.answers.length > 0 && value.answers.length <= 4 && value.answers.every(answer => isRecord(answer) && typeof answer.toolCallId === "string" && answer.toolCallId.length > 0 && answer.toolCallId.length <= 80 && isChoice(answer.choice))) ||
      (value.type === "clear_selection" && typeof value.index === "number" && Number.isSafeInteger(value.index) && value.index >= 0) ||
      (value.type === "send_message" && typeof value.text === "string" && (value.selections === undefined || (Array.isArray(value.selections) && value.selections.length <= 8 && value.selections.every(isComposerSelection)))))
  );
}

export function isHostMessage(value: unknown): value is HostMessage {
  if (!isRecord(value)) return false;
  if (value.type === 'focus_composer') return true;
  if (value.type === 'attach_selection') return Array.isArray(value.selections) && value.selections.length <= 8 && value.selections.every(isComposerSelection);
  return (
    value.type === "state" &&
    ReviewStateSchema.safeParse(value.review).success &&
    Array.isArray(value.activity) && value.activity.every(isActivityEntry) &&
    Array.isArray(value.inspectedFiles) && value.inspectedFiles.every(file => isRecord(file) && typeof file.path === "string" && typeof file.startLine === "number" && typeof file.endLine === "number" && (file.origin === 'tool' || file.origin === 'context')) &&
    typeof value.busy === "boolean" && typeof value.status === "string" && typeof value.approval === "boolean" && Array.isArray(value.messages) &&
    value.messages.every(isChatMessage) && Array.isArray(value.chats) && value.chats.length <= 8 && value.chats.every(isChatTab) &&
    Array.isArray(value.questions) && value.questions.length <= 4 && value.questions.every(isAgentQuestion) &&
    isModelMenu(value.models) && isContextWindow(value.context) &&
    Array.isArray(value.history) && value.history.length <= 200 && value.history.every(isTaskHistoryItem) &&
    (value.usage === undefined || isTokenUsage(value.usage)) &&
    (value.approvalTools === undefined || (Array.isArray(value.approvalTools) && value.approvalTools.length <= 20 && value.approvalTools.every(name => typeof name === 'string' && name.length <= 120)))
  );
}

function isContextWindow(value: unknown): value is { used: number; limit: number } {
  return isRecord(value) && typeof value.used === 'number' && Number.isFinite(value.used) && value.used >= 0
    && typeof value.limit === 'number' && Number.isFinite(value.limit) && value.limit >= 0;
}

function isModelMenu(value: unknown): value is ModelMenu {
  return isRecord(value) && typeof value.current === "string" && typeof value.loading === "boolean"
    && Array.isArray(value.names) && value.names.every(name => typeof name === "string")
    && (value.error === undefined || typeof value.error === "string");
}
