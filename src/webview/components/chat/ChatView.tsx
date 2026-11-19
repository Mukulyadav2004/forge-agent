/*
 * Adapted from Cline's apps/vscode/webview-ui/src/components/chat/ChatView.tsx and
 * chat-view/components/layout/ChatLayout.tsx and TaskSection.tsx at eff43e19b267e171f597ab03733bfed25090f72d.
 * Copyright 2026 Cline Bot Inc. Licensed under Apache-2.0; see licenses/Cline-Apache-2.0.txt.
 */
import type { MouseEvent, RefObject } from 'react';
import { useEffect, useRef, useState } from 'react';
import type { ComposerSelection, HostMessage } from '../../../shared/messages.js';
import { post } from '../../vscode.js';
import { ChevronDownIcon, HistoryIcon, LinkIcon, PlusIcon } from '../common/Icons.js';
import { ReviewPanel } from '../review/ReviewPanel.js';
import { ActionButtons } from './ActionButtons.js';
import { ChatTextArea } from './ChatTextArea.js';
import { MessagesArea } from './MessagesArea.js';
import { OptionsButtons } from './OptionsButtons.js';
import { TaskHeader } from './TaskHeader.js';

export type HostState = Extract<HostMessage, { type: 'state' }>;

/** Opens relative links from model Markdown in the editor; anything with a scheme or absolute path stays inert. */
function openLink(event: MouseEvent<HTMLElement>) {
  if (!(event.target instanceof Element)) return;
  const link = event.target.closest('a');
  if (!link) return;
  event.preventDefault();
  const href = link.getAttribute('href') ?? '';
  if (!href || href.startsWith('#') || /^(?:[a-z][a-z0-9+.-]*:|\/\/|\/)/iu.test(href)) return;
  const match = /^(.*?)(?:#L(\d+))?$/u.exec(href);
  if (!match?.[1]) return;
  try { post({ type: 'open_file', path: decodeURIComponent(match[1]), line: Number(match[2] ?? 1) }); }
  catch { return; }
}

/**
 * Cline's bottom pinning: while the reader is at the bottom, content that grows later (streamed Markdown, diagrams,
 * the review panel) keeps the view pinned; once they scroll up, a button brings them back.
 */
function useStickToBottom(scrollerRef: RefObject<HTMLElement>) {
  const [atBottom, setAtBottom] = useState(true);
  const stick = useRef(true);
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const onScroll = () => {
      if (!scroller.clientHeight) return;
      stick.current = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 48;
      setAtBottom(stick.current);
    };
    const observer = new ResizeObserver(() => {
      if (!scroller.clientHeight) return;
      if (stick.current) scroller.scrollTop = scroller.scrollHeight;
      else onScroll();
    });
    for (const child of Array.from(scroller.children)) observer.observe(child);
    observer.observe(scroller);
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => { observer.disconnect(); scroller.removeEventListener('scroll', onScroll); };
  }, [scrollerRef]);
  const scrollToBottom = () => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    stick.current = true;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: reduced ? 'auto' : 'smooth' });
  };
  return { atBottom, scrollToBottom };
}

export function ChatView(props: {
  hidden: boolean;
  state: HostState;
  draft: string;
  onDraftChange: (draft: string) => void;
  attached: ComposerSelection[];
  onRemoveSelection: (index: number) => void;
  pending: boolean;
  onSend: () => void;
  onShowHistory: () => void;
  inputRef: RefObject<HTMLTextAreaElement>;
}) {
  const { state } = props;
  const scrollerRef = useRef<HTMLElement>(null);
  const { atBottom, scrollToBottom } = useStickToBottom(scrollerRef);
  const stopping = state.busy || state.approval;
  const firstRequest = state.messages.find(message => message.role === 'user')?.text;
  const activeChat = state.chats.find(chat => chat.active);
  const anyBusy = state.chats.some(chat => chat.busy);
  const lockNote = state.approval ? 'Paused until you approve or deny the request.' : state.busy ? 'Paused while the agent works, so files stay put. Preview still works.' : undefined;
  return (
    <div className="chat-view" hidden={props.hidden}>
      <header>
        <div className="nav-row">
          <span className="nav-title" title={activeChat?.title}>{state.chats.length > 1 && activeChat ? activeChat.title : 'Agent'}</span>
          <div className="header-actions">
            <button aria-label="New chat" className="icon-button" id="new-chat-button" onClick={() => post({ type: 'new_chat' })} title="New chat" type="button"><PlusIcon /></button>
            <button aria-label="History" className={anyBusy ? 'icon-button busy' : 'icon-button'} id="history-button" onClick={props.onShowHistory} title={anyBusy ? 'Agents and history (an agent is running)' : 'Agents and history'} type="button"><HistoryIcon /></button>
            <button aria-label="Copy MCP connection" className="icon-button" id="copy-mcp-button" onClick={() => post({ type: 'copy_mcp_connection' })} title="Copy MCP connection" type="button"><LinkIcon /></button>
          </div>
        </div>
        {firstRequest !== undefined && <TaskHeader context={state.context} usage={state.usage} onNewTask={() => post({ type: 'new_chat' })} text={firstRequest} />}
      </header>
      <main aria-label="Task workspace" id="task-content" onClick={openLink} ref={scrollerRef}>
        <MessagesArea activity={state.activity} busy={state.busy} complete={!state.busy} history={state.history} messages={state.messages} />
        <ReviewPanel disabled={state.busy || state.approval} lockNote={lockNote} onCommand={command => post({ type: 'review', command })} state={state.review} />
        {!atBottom && (
          <div className="scroll-to-bottom-anchor">
            <button aria-label="Scroll to bottom" className="scroll-to-bottom" onClick={scrollToBottom} title="Scroll to bottom" type="button"><ChevronDownIcon /></button>
          </div>
        )}
      </main>
      <ActionButtons approval={state.approval} approvalTools={state.approvalTools} busy={state.busy} />
      {state.questions.length > 0 && <OptionsButtons key={JSON.stringify(state.questions)} questions={state.questions} />}
      <ChatTextArea
        attached={props.attached}
        context={state.context}
        draft={props.draft}
        models={state.models}
        onDraftChange={props.onDraftChange}
        onRemoveSelection={props.onRemoveSelection}
        onSend={props.onSend}
        pending={props.pending}
        ref={props.inputRef}
        status={state.status}
        stopping={stopping}
      />
    </div>
  );
}
