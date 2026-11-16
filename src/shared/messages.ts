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

/** One completed editor tool call, as shown in the sidebar's activity feed. Reasons are the agent's optional words. */
export type ActivityEntry =
  | { kind: 'search'; query: string; glob: string; matches: number; fileCount: number; files: string[]; truncated: boolean; reason?: string }
  | { kind: 'open'; path: string; startLine: number; endLine: number; reason?: string; foundBy?: string }
  | { kind: 'propose'; path: string; detail: string; reason?: string }
  | { kind: 'list'; glob: string; count: number }
  | { kind: 'context'; path: string; startLine: number; endLine: number };

function isActivityEntry(value: unknown): value is ActivityEntry {
  if (!isRecord(value) || (value.reason !== undefined && typeof value.reason !== 'string')) return false;
  const text = (key: string) => typeof value[key] === 'string';
  const count = (key: string) => typeof value[key] === 'number' && Number.isSafeInteger(value[key]);
  switch (value.kind) {
    case 'search': return text('query') && text('glob') && count('matches') && count('fileCount') && typeof value.truncated === 'boolean' && Array.isArray(value.files) && value.files.every(file => typeof file === 'string');
    case 'open': return text('path') && count('startLine') && count('endLine') && (value.foundBy === undefined || text('foundBy'));
    case 'propose': return text('path') && text('detail');
    case 'list': return text('glob') && count('count');
    case 'context': return text('path') && count('startLine') && count('endLine');
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
