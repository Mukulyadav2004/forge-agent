/*
 * Adapted from Cline's apps/vscode/webview-ui/src/components/chat/chat-view/components/layout/MessagesArea.tsx and
 * messages/ToolGroupRenderer.tsx at eff43e19b267e171f597ab03733bfed25090f72d.
 * Copyright 2026 Cline Bot Inc. Licensed under Apache-2.0; see licenses/Cline-Apache-2.0.txt.
 */
import type { ReactNode } from 'react';
import { Fragment, useState } from 'react';
import type { ActivityEntry, ChatMessage, TaskHistoryItem } from '../../../shared/messages.js';
import { plural, size } from '../../lib/format.js';
import { post } from '../../vscode.js';
import { ChevronRightIcon, LoaderIcon } from '../common/Icons.js';
import { WelcomeSection } from '../welcome/WelcomeSection.js';
import { ChatRow } from './ChatRow.js';
import type { ToolEntry } from './ToolRows.js';
import { ActivityRow, CommandRow, TodoRow } from './ToolRows.js';

const EXPLORING = new Set<ActivityEntry['kind']>(['search', 'open', 'list', 'context']);

/** Collapsed or expanded by the user, by group; groups start open. */
const openGroups = new Map<string, boolean>();

interface GroupRow { entry: ToolEntry; added: number; nested: boolean; children: GroupRow[] }
interface Group { key: string; at: number; rows: GroupRow[]; searches: Map<string, GroupRow>; paths: Set<string>; counts: Record<string, number>; added: number }
type Item =
  | { type: 'request'; key: string }
  | { type: 'card'; key: string; entry: ToolEntry; added: number; latestTodo: boolean }
  | { type: 'group'; key: string; group: Group };

function GroupRows({ rows }: { rows: GroupRow[] }) {
  return <>{rows.map((row, index) => (
    <ActivityRow added={row.added} card={false} entry={row.entry} key={index} nested={row.nested}>
      {row.children.length > 0 && <div className="activity-nested"><GroupRows rows={row.children} /></div>}
    </ActivityRow>
  ))}</>;
}

/** Cline's low-stakes tool group: one summary line, then each read, search and listing. */
function ToolGroup({ group }: { group: Group }) {
  const [, rerender] = useState(0);
  const count = (kind: string) => group.counts[kind] ?? 0;
  const parts = [
    ...(count('context') ? [`was given ${plural(count('context'), 'range')}`] : []),
    ...(count('open') ? [`read ${plural(group.paths.size, 'file')}`] : []),
    ...(count('search') ? [`searched ${plural(count('search'), 'time')}`] : []),
    ...(count('list') ? [`listed files ${plural(count('list'), 'time')}`] : []),
  ];
  return (
    <details
      className="activity-group"
      onToggle={event => { openGroups.set(group.key, event.currentTarget.open); rerender(value => value + 1); }}
      open={openGroups.get(group.key) ?? true}>
      <summary><ChevronRightIcon className="group-chevron" />{`Forge ${parts.join(', ')}${group.added ? ` · +${size(group.added)} chars` : ''}`}</summary>
      <div className="activity-list"><GroupRows rows={group.rows} /></div>
    </details>
  );
}

/**
 * The whole task as one scroll, oldest first: each message, then what happened after it.
 * Consecutive searches and reads collapse into one "Forge read … searched …" block; commands, staged edits,
 * refusals, compaction and to-do lists stand alone. A request line marks each user message.
 */
export function MessagesArea({ messages, activity, busy, complete, history }: { messages: ChatMessage[]; activity: ActivityEntry[]; busy: boolean; complete: boolean; history: TaskHistoryItem[] }) {
  const after = new Map<number, Item[]>();
  const place = (at: number, item: Item) => after.set(at, [...(after.get(at) ?? []), item]);
  let group: Group | undefined;
  let previousUsed = 0;
  const latestTodo = activity.map(entry => entry.kind).lastIndexOf('todo');
  activity.forEach((entry, index) => {
    const at = Math.min(entry.at ?? messages.length, messages.length);
    if (entry.kind === 'request') {
      group = undefined; previousUsed = 0;
      place(at, { type: 'request', key: `request-${index}` });
      return;
    }
    const added = 'used' in entry && entry.used !== undefined ? Math.max(0, entry.used - previousUsed) : 0;
    if ('used' in entry && entry.used !== undefined) previousUsed = entry.used;
    if (!EXPLORING.has(entry.kind)) {
      group = undefined;
      place(at, { type: 'card', key: `card-${index}`, entry, added, latestTodo: index === latestTodo });
      return;
    }
    if (!group || group.at !== at) {
      group = { key: `${at}:${JSON.stringify(entry)}`, at, rows: [], searches: new Map(), paths: new Set(), counts: {}, added: 0 };
      place(at, { type: 'group', key: `group-${index}`, group });
    }
    const parent = entry.kind === 'open' && entry.foundBy !== undefined ? group.searches.get(entry.foundBy) : undefined;
    const row: GroupRow = { entry, added, nested: parent !== undefined, children: [] };
    if (parent) parent.children.push(row);
    else group.rows.push(row);
    if (entry.kind === 'search') group.searches.set(entry.query, row);
    if (entry.kind === 'open' || entry.kind === 'context') group.paths.add(entry.path);
    group.counts[entry.kind] = (group.counts[entry.kind] ?? 0) + 1;
    group.added += added;
  });

  const render = (item: Item): ReactNode => {
    if (item.type === 'request') return <div className="activity-request" key={item.key}>New request</div>;
    if (item.type === 'group') return <ToolGroup group={item.group} key={item.key} />;
    if (item.entry.kind === 'command') return <CommandRow added={item.added} entry={item.entry} key={item.key} />;
    if (item.entry.kind === 'todo') return <TodoRow key={item.key} latest={item.latestTodo} todos={item.entry.todos} />;
    return <ActivityRow added={item.added} card entry={item.entry} key={item.key} nested={false} />;
  };

  const empty = messages.length === 0 && activity.length === 0;
  // Streaming assistant text shows progress by itself; otherwise the feed ends in a request or a finished tool.
  const tail = (after.get(messages.length) ?? []).filter(item => item.type !== 'request');
  const thinking = busy && (messages.at(-1)?.role !== 'assistant' || tail.length > 0);
  return (
    <div aria-busy={busy} aria-label="Conversation" aria-live="polite" aria-relevant="additions text" id="messages" role="log">
      {empty && !busy && <WelcomeSection history={history} onOpen={id => post({ type: 'open_history', id })} />}
      {(after.get(0) ?? []).map(render)}
      {messages.map((message, index) => (
        <Fragment key={message.id}>
          <ChatRow complete={complete} message={message} />
          {(after.get(index + 1) ?? []).map(render)}
        </Fragment>
      ))}
      {thinking && <div aria-hidden="true" className="thinking-row"><LoaderIcon className="animate-spin" />Thinking…</div>}
    </div>
  );
}
