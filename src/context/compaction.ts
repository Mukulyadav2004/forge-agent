import type { ChatMessage } from '../shared/messages';

/**
 * OpenCode's automatic compaction policy (packages/core/src/session/compaction.ts).
 * It compacts once free space drops below the larger of 15% of the window and 16,000 tokens,
 * keeps the newest ~15,000 tokens verbatim, and summarizes the rest with a structured template.
 * TrueForge's RuntimeConfig accepts only `enabled` and an input-token trigger, so the trigger carries the reserve.
 * The verbatim tail and the summary prompt stay in TrueForge's hands; the keep budget here sizes restored transcripts.
 */
export const COMPACTION_RESERVE_RATIO = 0.15;
export const COMPACTION_RESERVE_MIN = 16_000;
export const COMPACTION_KEEP_TOKENS = 15_000;
/** Characters kept, from the start and end, of a long message in a restored transcript. */
export const TRANSCRIPT_CLIP = 2_000;
/** Prompt text runs about 4 characters per token; dense code can run higher, so OpenCode allows 15% error. */
export const ESTIMATE_ERROR = 0.15;

/** OpenCode's chars/4 token estimate. */
export function estimateTokens(text: string): number {
  return Math.max(0, Math.round(text.length / 4));
}

/**
 * Input-token trigger for a known context window: the window minus OpenCode's reserve.
 * Windows under 32,000 tokens cannot give up 16,000, so they keep only the 15% share, as OpenCode does.
 * An unknown window returns undefined and TrueForge falls back to 80% of the window, or 50,000 tokens.
 */
export function compactionTriggerTokens(contextLength: number | undefined): number | undefined {
  if (contextLength === undefined || !Number.isFinite(contextLength) || contextLength <= 0) return undefined;
  const window = Math.floor(contextLength);
  const reserve = Math.max(Math.floor(window * COMPACTION_RESERVE_RATIO), window >= 2 * COMPACTION_RESERVE_MIN ? COMPACTION_RESERVE_MIN : 0);
  const trigger = window - reserve;
  return trigger > 0 ? trigger : undefined;
}

/** `value` cut to TRANSCRIPT_CLIP characters from its start and end, never splitting a surrogate pair. */
export function clipText(value: string, limit = TRANSCRIPT_CLIP): string {
  if (value.length <= limit) return value;
  const chars = Array.from(value);
  if (chars.length <= limit) return value;
  const half = Math.floor(limit / 2);
  return `${chars.slice(0, half).join('')}\n[… ${chars.length - limit} characters omitted …]\n${chars.slice(-half).join('')}`;
}

/**
 * The visible conversation of a saved chat, for a new TrueForge session when the old one is gone.
 * Newest messages are kept within COMPACTION_KEEP_TOKENS; each long message is clipped from the middle.
 */
export function renderRestoredTranscript(messages: readonly ChatMessage[], keepTokens = COMPACTION_KEEP_TOKENS): string {
  const kept: string[] = [];
  let used = 0;
  let omitted = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!message?.text.trim()) continue;
    const block = `<${message.role}>\n${clipText(message.text.trim())}\n</${message.role}>`;
    const cost = estimateTokens(block);
    if (used + cost > keepTokens) { omitted = index + 1; break; }
    kept.unshift(block);
    used += cost;
  }
  if (!kept.length) return '';
  return [
    'Earlier conversation in this task, restored from the editor\'s saved history because the previous TrueForge session is no longer available.',
    'It is a record of what was said, not of the current files: proposals in it may have been accepted, rejected or undone since. Read files again before editing.',
    omitted ? `(${omitted} older message${omitted === 1 ? '' : 's'} omitted.)` : '',
    `<restored_conversation>\n${kept.join('\n')}\n</restored_conversation>`,
  ].filter(Boolean).join('\n');
}
