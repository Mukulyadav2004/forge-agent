export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
}

export type WebviewMessage =
  | { type: "ready" }
  | { type: "send_message"; text: string }
  | { type: "cancel" }
  | { type: "approve"; allow: boolean };

export type HostMessage = { type: "state"; messages: ChatMessage[]; busy: boolean; status: string; approval: boolean };

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
    (value.type === "ready" || value.type === "cancel" || (value.type === "approve" && typeof value.allow === "boolean") ||
      (value.type === "send_message" && typeof value.text === "string"))
  );
}

export function isHostMessage(value: unknown): value is HostMessage {
  return (
    isRecord(value) &&
    value.type === "state" &&
    typeof value.busy === "boolean" && typeof value.status === "string" && typeof value.approval === "boolean" && Array.isArray(value.messages) &&
    value.messages.every(isChatMessage)
  );
}
