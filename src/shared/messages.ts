import { ReviewCommandSchema, ReviewStateSchema } from '../edits/review.js';
import type { ReviewCommand, ReviewState } from '../edits/review.js';

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** The model's streamed reasoning for this reply (TrueForge reasoningContent), shown collapsed; plain text, bounded. */
  thinking?: string;
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

/** One editor selection attached to the composer. Ctrl+L can attach several. */
export interface ComposerSelection {
  path: string;
  startLine: number;
  endLine: number;
  text: string;
}

/** One completed editor tool call, as shown in the sidebar's activity feed. Reasons are the agent's optional words.
 * `used` is the request's context budget spent after this call; a `request` entry marks a new user request and its budget.
 * `at` is how many chat messages existed when it happened, so the sidebar can place it in the conversation. */
export type ActivityEntry = { at?: number } & (
  | { kind: 'request'; limit: number; inputTokens?: number }
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
  /** Code Mode: a command the agent ran in TrueForge's sandbox (exec), with its stated intent. It runs outside the workspace. */
  | { kind: 'sandbox'; command: string; intent?: string }
  /** The agent's plan (plan_task) when made, and the checklist when the turn ends: each requirement, its file and status. */
  | { kind: 'plan'; stage: 'start' | 'end'; items: PlanRow[]; lastCommand?: string });

export interface PlanRow { quote: string; change?: string; file: string; sibling?: string; status: 'planned' | 'changed' | 'skipped' | 'open'; note?: string }
const PLAN_STATUSES = new Set(['planned', 'changed', 'skipped', 'open']);
function isPlanRow(value: unknown): value is PlanRow {
  return isRecord(value) && typeof value.quote === 'string' && value.quote.length <= 400 && (value.change === undefined || (typeof value.change === 'string' && value.change.length <= 400)) && typeof value.file === 'string' && value.file.length <= 500
    && (value.sibling === undefined || (typeof value.sibling === 'string' && value.sibling.length <= 200)) && typeof value.status === 'string' && PLAN_STATUSES.has(value.status)
    && (value.note === undefined || (typeof value.note === 'string' && value.note.length <= 400));
}

function isActivityEntry(value: unknown): value is ActivityEntry {
  if (!isRecord(value) || (value.reason !== undefined && typeof value.reason !== 'string')) return false;
  if (value.used !== undefined && !(typeof value.used === 'number' && Number.isSafeInteger(value.used) && value.used >= 0)) return false;
  if (value.at !== undefined && !(typeof value.at === 'number' && Number.isSafeInteger(value.at) && value.at >= 0)) return false;
  const text = (key: string) => typeof value[key] === 'string';
  const count = (key: string) => typeof value[key] === 'number' && Number.isSafeInteger(value[key]);
  switch (value.kind) {
    case 'request': return count('limit') && (value.inputTokens === undefined || count('inputTokens'));
    case 'search': return text('query') && text('glob') && count('matches') && count('fileCount') && typeof value.truncated === 'boolean' && Array.isArray(value.files) && value.files.every(file => typeof file === 'string');
    case 'open': return text('path') && count('startLine') && count('endLine') && (value.foundBy === undefined || text('foundBy'));
    case 'propose': return text('path') && text('detail');
    case 'list': return text('glob') && count('count');
    case 'command': return text('command') && text('cwd') && (value.exitCode === null || count('exitCode')) && typeof value.timedOut === 'boolean' && typeof value.cancelled === 'boolean' && count('durationMs');
    case 'context': return text('path') && count('startLine') && count('endLine');
    case 'refused': return text('tool') && text('message');
    case 'plan': return (value.stage === 'start' || value.stage === 'end') && Array.isArray(value.items) && value.items.length <= 12 && value.items.every(isPlanRow) && (value.lastCommand === undefined || (text('lastCommand') && String(value.lastCommand).length <= 300));
    case 'sandbox': return text('command') && (value.intent === undefined || text('intent'));
    case 'compaction': return count('contextTokens') && count('thresholdTokens') && typeof value.done === 'boolean' && (value.durationMs === undefined || count('durationMs')) && (value.afterTokens === undefined || count('afterTokens'));
    default: return false;
  }
}

export type WebviewMessage =
  | { type: "ready" }
  | { type: "copy_mcp_connection" }
  | { type: "select_model" }
  | { type: 'review'; command: ReviewCommand }
  | { type: "open_file"; path: string; line: number }
  | { type: "send_message"; text: string; selections?: ComposerSelection[] }
  | { type: "new_chat" }
  | { type: "select_chat"; id: string }
  | { type: "spin_agents"; text: string }
  | { type: "add_selection" }
  | { type: "clear_selection"; index: number }
  | { type: "cancel" }
  | { type: "approve"; allow: boolean }
  | { type: "answer_question"; answers: { toolCallId: string; choice: string }[] };

export type HostMessage =
  | { type: "state"; messages: ChatMessage[]; busy: boolean; status: string; approval: boolean; inspectedFiles: FileEvidence[]; activity: ActivityEntry[]; review: ReviewState; chats: ChatTab[]; questions: AgentQuestion[] }
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
    typeof value.text === "string" &&
    (value.thinking === undefined || (typeof value.thinking === "string" && value.thinking.length <= 20000))
  );
}

export function isWebviewMessage(value: unknown): value is WebviewMessage {
  return (
    isRecord(value) &&
    (value.type === "ready" || value.type === "copy_mcp_connection" || value.type === "select_model" || value.type === "cancel" || value.type === "add_selection" || value.type === "new_chat" ||
      (value.type === "select_chat" && typeof value.id === "string" && value.id.length > 0 && value.id.length <= 80) ||
      (value.type === "spin_agents" && typeof value.text === "string" && value.text.length <= 20000) ||
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
    Array.isArray(value.questions) && value.questions.length <= 4 && value.questions.every(isAgentQuestion)
  );
}
