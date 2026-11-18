/*
 * Adapted from Cline's apps/vscode/webview-ui/src/components/history/HistoryView.tsx and HistoryViewItem.tsx
 * at eff43e19b267e171f597ab03733bfed25090f72d.
 * Copyright 2026 Cline Bot Inc. Licensed under Apache-2.0; see licenses/Cline-Apache-2.0.txt.
 */
import clsx from 'clsx';
import { useEffect, useRef, useState } from 'react';
import type { ChatTab, TaskHistoryItem } from '../../../shared/messages.js';
import { formatDate, plural } from '../../lib/format.js';
import { post } from '../../vscode.js';
import { CheckIcon, MessageIcon, SearchIcon, TrashIcon, XIcon } from '../common/Icons.js';

function isToday(timestamp: number): boolean {
  return new Date(timestamp).toDateString() === new Date().toDateString();
}

function HistoryViewItem({ item, onOpen }: { item: TaskHistoryItem; onOpen: () => void }) {
  return (
    <div className="history-item group flex cursor-pointer border-b border-accent/10 hover:bg-list-hover">
      <div
        className="relative flex min-w-0 grow flex-col gap-1 py-2 pl-3 pr-3"
        onClick={onOpen}
        onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpen(); } }}
        role="button"
        tabIndex={0}
        title={item.title}>
        <div className="flex items-center gap-2">
          <div className="line-clamp-2 min-w-0 flex-1 overflow-hidden whitespace-pre-wrap break-words">{item.title || 'Untitled task'}</div>
          <button
            aria-label={`Delete ${item.title || 'task'}`}
            className="icon-button history-delete opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
            onClick={event => { event.stopPropagation(); post({ type: 'delete_history', id: item.id }); }}
            title="Delete"
            type="button">
            <TrashIcon />
          </button>
        </div>
        <div className="flex w-full items-center justify-between text-xs text-description">
          <span className="uppercase">{formatDate(item.updatedAt)}</span>
          <span>{plural(item.messageCount, 'message')}</span>
        </div>
      </div>
    </div>
  );
}

/** Cline's history page, plus the open agent chats (with spinners while they run) above saved tasks. */
export function HistoryView({ chats, history, onDone }: { chats: ChatTab[]; history: TaskHistoryItem[]; onDone: () => void }) {
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => { searchRef.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onDone(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onDone]);
  const needle = query.trim().toLowerCase();
  const shownChats = chats.filter(chat => chat.title.toLowerCase().includes(needle));
  const results = history.filter(item => item.title.toLowerCase().includes(needle)).sort((a, b) => b.updatedAt - a.updatedAt);
  const groups = [
    { label: 'Today', items: results.filter(item => isToday(item.updatedAt)) },
    { label: 'Older', items: results.filter(item => !isToday(item.updatedAt)) },
  ].filter(group => group.items.length);
  return (
    <div aria-label="History" className="history-view flex h-full min-h-0 flex-col" role="region">
      <div className="view-header flex items-center justify-between px-3 py-2">
        <h2 className="m-0 text-base font-semibold">History</h2>
        <button className="btn btn-primary" onClick={onDone} type="button">Done</button>
      </div>
      <div className="px-3 pb-2">
        <div className="search-field flex items-center gap-1.5">
          <SearchIcon className="shrink-0 opacity-80" />
          <input
            aria-label="Search history"
            className="min-w-0 flex-1"
            onChange={event => setQuery(event.target.value)}
            onKeyDown={event => {
              if (event.key !== 'Enter') return;
              event.preventDefault();
              const chat = shownChats[0];
              const task = results[0];
              if (chat) post({ type: 'select_chat', id: chat.id });
              else if (task) post({ type: 'open_history', id: task.id });
              else return;
              onDone();
            }}
            placeholder="Search agents and history..."
            ref={searchRef}
            type="search"
            value={query}
          />
          {query && <button aria-label="Clear search" className="icon-button" onClick={() => setQuery('')} type="button"><XIcon /></button>}
        </div>
      </div>
      <div className="min-h-0 flex-grow overflow-y-auto">
        <div className="history-group-label">Agents</div>
        <div aria-label="Chats" id="chat-list" role="group">
          {shownChats.length === 0 && <div className="px-4 py-2 text-xs text-description">{needle ? 'No matching agents' : 'No agents yet'}</div>}
          {shownChats.map(chat => (
            <button
              aria-current={chat.active ? 'true' : undefined}
              className={clsx('chat-tab flex w-full items-center gap-2 border-b border-accent/10 px-3 py-2 text-left hover:bg-list-hover', chat.active && 'is-active', chat.busy && 'busy')}
              key={chat.id}
              onClick={() => { post({ type: 'select_chat', id: chat.id }); onDone(); }}
              title={chat.busy ? `${chat.title} (running)` : chat.title}
              type="button">
              <span aria-hidden="true" className="history-mark">{chat.busy ? <span className="spinner" /> : chat.active ? <CheckIcon /> : <MessageIcon />}</span>
              <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{chat.title}</span>
              {chat.busy && <span className="text-xs text-description">running</span>}
            </button>
          ))}
        </div>
        {groups.map(group => (
          <div key={group.label}>
            <div className="history-group-label">{group.label}</div>
            {group.items.map(item => <HistoryViewItem item={item} key={item.id} onOpen={() => { post({ type: 'open_history', id: item.id }); onDone(); }} />)}
          </div>
        ))}
        {!groups.length && <div className="px-4 py-3 text-xs text-description">{needle ? 'No matching tasks' : 'Saved tasks will appear here.'}</div>}
      </div>
    </div>
  );
}
