/*
 * Adapted from Cline's apps/vscode/webview-ui/src/components/chat/ChatRow.tsx, UserMessage.tsx and MarkdownRow.tsx
 * at eff43e19b267e171f597ab03733bfed25090f72d.
 * Copyright 2026 Cline Bot Inc. Licensed under Apache-2.0; see licenses/Cline-Apache-2.0.txt.
 */
import { memo, useEffect, useLayoutEffect, useRef } from 'react';
import type { ChatMessage } from '../../../shared/messages.js';
import { renderDiagrams, renderMarkdown } from '../../lib/markdown.js';

/** Assistant Markdown, rebuilt only when its text changes; diagrams render once the turn is complete. */
const MarkdownRow = memo(function MarkdownRow({ text, complete }: { text: string; complete: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (ref.current) renderMarkdown({ container: ref.current, text });
  }, [text]);
  useEffect(() => {
    if (complete && ref.current) void renderDiagrams(ref.current);
  }, [complete, text]);
  return <div className="markdown-body inline-markdown-block" ref={ref} />;
});

/** Cline's user bubble: badge background, pre-line text. Text is set as a React text node, never as HTML. */
function UserMessage({ text }: { text: string }) {
  return (
    <div className="user-bubble my-1 rounded-xs p-2.5 text-badge-foreground" style={{ backgroundColor: 'var(--vscode-badge-background)' }}>
      <span className="user-text block text-sm">{text}</span>
    </div>
  );
}

export const ChatRow = memo(function ChatRow({ message, complete }: { message: ChatMessage; complete: boolean }) {
  return (
    <article className={`message message-${message.role}`}>
      <h2 className="message-author sr-only">{message.role === 'user' ? 'You' : 'Forge'}</h2>
      {message.role === 'user' ? <UserMessage text={message.text} /> : <MarkdownRow complete={complete} text={message.text} />}
    </article>
  );
});
