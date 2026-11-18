import { ReviewCommandSchema, ReviewStateSchema } from '../edits/review.js';
import type { ReviewCommand, ReviewState } from '../edits/review.js';

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
}

export interface FileEvidence {
  path: string;
  startLine: number;
  endLine: number;
  origin: 'tool' | 'context';
}

/** One completed editor tool call, as shown in the sidebar's activity feed. Reasons are the agent's optional words.
 * `used` is the request's context budget spent after this call; a `request` entry marks a new user request and its budget.
 * `at` is how many chat messages existed when it happened, so the sidebar can place it in the conversation. */
export type ActivityEntry = { at?: number } & (
  | { kind: 'request'; limit: number }
  | { kind: 'search'; query: string; glob: string; matches: number; fileCount: number; files: string[]; truncated: boolean; reason?: string; used?: number }
  | { kind: 'open'; path: string; startLine: number; endLine: number; reason?: string; foundBy?: string; used?: number }
  | { kind: 'propose'; path: string; detail: string; reason?: string }
  | { kind: 'list'; glob: string; count: number; used?: number }
  | { kind: 'command'; command: string; cwd: string; exitCode: number | null; timedOut: boolean; cancelled: boolean; durationMs: number; reason?: string; used?: number }
  | { kind: 'context'; path: string; startLine: number; endLine: number; used?: number }
  /** An editor tool refused or failed; `message` is what the agent was told. */
  | { kind: 'refused'; tool: string; message: string }
  /** TrueForge summarised the conversation: size that triggered it, the threshold, and the size of the next model call afterwards. */
  | { kind: 'compaction'; contextTokens: number; thresholdTokens: number; done: boolean; durationMs?: number; afterTokens?: number });

function isActivityEntry(value: unknown): value is ActivityEntry {
  if (!isRecord(value) || (value.reason !== undefined && typeof value.reason !== 'string')) return false;
  if (value.used !== undefined && !(typeof value.used === 'number' && Number.isSafeInteger(value.used) && value.used >= 0)) return false;
  if (value.at !== undefined && !(typeof value.at === 'number' && Number.isSafeInteger(value.at) && value.at >= 0)) return false;
  const text = (key: string) => typeof value[key] === 'string';
  const count = (key: string) => typeof value[key] === 'number' && Number.isSafeInteger(value[key]);
  switch (value.kind) {
    case 'request': return count('limit');
    case 'search': return text('query') && text('glob') && count('matches') && count('fileCount') && typeof value.truncated === 'boolean' && Array.isArray(value.files) && value.files.every(file => typeof file === 'string');
    case 'open': return text('path') && count('startLine') && count('endLine') && (value.foundBy === undefined || text('foundBy'));
    case 'propose': return text('path') && text('detail');
    case 'list': return text('glob') && count('count');
    case 'command': return text('command') && text('cwd') && (value.exitCode === null || count('exitCode')) && typeof value.timedOut === 'boolean' && typeof value.cancelled === 'boolean' && count('durationMs');
    case 'context': return text('path') && count('startLine') && count('endLine');
    case 'refused': return text('tool') && text('message');
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
  | { type: "send_message"; text: string }
  | { type: "cancel" }
  | { type: "approve"; allow: boolean };

export type HostMessage = { type: "state"; messages: ChatMessage[]; busy: boolean; status: string; approval: boolean; inspectedFiles: FileEvidence[]; activity: ActivityEntry[]; review: ReviewState };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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
    (value.type === "ready" || value.type === "copy_mcp_connection" || value.type === "select_model" || value.type === "cancel" ||
      (value.type === "open_file" && typeof value.path === "string" && typeof value.line === "number" && Number.isSafeInteger(value.line) && value.line > 0) ||
      (value.type === 'review' && ReviewCommandSchema.safeParse(value.command).success) ||
      (value.type === "approve" && typeof value.allow === "boolean") ||
      (value.type === "send_message" && typeof value.text === "string"))
  );
}

export function isHostMessage(value: unknown): value is HostMessage {
  return (
    isRecord(value) &&
    value.type === "state" &&
    ReviewStateSchema.safeParse(value.review).success &&
    Array.isArray(value.activity) && value.activity.every(isActivityEntry) &&
    Array.isArray(value.inspectedFiles) && value.inspectedFiles.every(file => isRecord(file) && typeof file.path === "string" && typeof file.startLine === "number" && typeof file.endLine === "number" && (file.origin === 'tool' || file.origin === 'context')) &&
    typeof value.busy === "boolean" && typeof value.status === "string" && typeof value.approval === "boolean" && Array.isArray(value.messages) &&
    value.messages.every(isChatMessage)
  );
}
