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

export type WebviewMessage =
  | { type: "ready" }
  | { type: "copy_mcp_connection" }
  | { type: "select_model" }
  | { type: "open_file"; path: string; line: number }
  | { type: "send_message"; text: string }
  | { type: "cancel" }
  | { type: "approve"; allow: boolean };

export type HostMessage = { type: "state"; messages: ChatMessage[]; busy: boolean; status: string; approval: boolean; inspectedFiles: FileEvidence[] };

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
      (value.type === "approve" && typeof value.allow === "boolean") ||
      (value.type === "send_message" && typeof value.text === "string"))
  );
}

export function isHostMessage(value: unknown): value is HostMessage {
  return (
    isRecord(value) &&
    value.type === "state" &&
    Array.isArray(value.inspectedFiles) && value.inspectedFiles.every(file => isRecord(file) && typeof file.path === "string" && typeof file.startLine === "number" && typeof file.endLine === "number" && (file.origin === 'tool' || file.origin === 'context')) &&
    typeof value.busy === "boolean" && typeof value.status === "string" && typeof value.approval === "boolean" && Array.isArray(value.messages) &&
    value.messages.every(isChatMessage)
  );
}
