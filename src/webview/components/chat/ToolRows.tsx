/*
 * Adapted from Cline's apps/vscode/webview-ui/src/components/chat/chat-view/components/messages/ToolGroupRenderer.tsx,
 * CommandOutputRow.tsx, CompactionRow.tsx and ChatRow.tsx (tool headers) at eff43e19b267e171f597ab03733bfed25090f72d.
 * Copyright 2026 Cline Bot Inc. Licensed under Apache-2.0; see licenses/Cline-Apache-2.0.txt.
 */
import clsx from 'clsx';
import type { ReactNode } from 'react';
import type { ActivityEntry, TodoItem } from '../../../shared/messages.js';
import { plural, size, where } from '../../lib/format.js';
import { post } from '../../vscode.js';
import { AlertIcon, CheckIcon, CircleDotIcon, CircleIcon, FileDiffIcon, FileTextIcon, FoldIcon, FolderIcon, ListTodoIcon, LoaderIcon, SearchIcon, TerminalIcon, XIcon } from '../common/Icons.js';

export type ToolEntry = Exclude<ActivityEntry, { kind: 'request' }>;

function SourceLink({ path, line, label }: { path: string; line: number; label: string }) {
  return <button className="source-reference" onClick={() => post({ type: 'open_file', path, line })} type="button">{label}</button>;
}

const ICONS: Record<ToolEntry['kind'], (props: { className?: string }) => ReactNode> = {
  search: SearchIcon, open: FileTextIcon, propose: FileDiffIcon, list: FolderIcon, command: TerminalIcon,
  context: FileTextIcon, refused: AlertIcon, compaction: FoldIcon, todo: ListTodoIcon,
};

/**
 * One completed tool call as one line of text, like Cline's tool group items. The row is inline text so it reads
 * as a sentence ("Compacted context …"); paths open the file; reasons are the agent's own words; `added` is what it cost.
 */
export function ActivityRow({ entry, added, nested, card, children }: { entry: ToolEntry; added: number; nested: boolean; card: boolean; children?: ReactNode }) {
  const notes: string[] = [];
  let kind: string;
  let main: ReactNode[];
  let failed = false;
  switch (entry.kind) {
    case 'search':
      kind = 'Searched';
      main = [`"${entry.query}" in ${where(entry.glob)}: ${plural(entry.matches, 'match', 'matches')} in ${plural(entry.fileCount, 'file')}${entry.truncated ? ' (limited)' : ''}`];
      break;
    case 'open':
      kind = 'Opened';
      main = [<SourceLink key="link" label={`${entry.path}:${entry.startLine}-${entry.endLine}`} line={entry.startLine} path={entry.path} />];
      if (entry.foundBy !== undefined && !nested) notes.push(`found by search "${entry.foundBy}"`);
      break;
    case 'propose':
      kind = 'Staged edit';
      main = [<SourceLink key="link" label={entry.path} line={1} path={entry.path} />, ` ${entry.detail}`];
      break;
    case 'list':
      kind = 'Listed';
      main = [`${where(entry.glob)}: ${plural(entry.count, 'file')}`];
      break;
    case 'context':
      kind = 'Given';
      main = [<SourceLink key="link" label={`${entry.path}:${entry.startLine}-${entry.endLine}`} line={entry.startLine} path={entry.path} />, ' with your request'];
      break;
    case 'refused':
      kind = 'Refused';
      main = [`${entry.tool}: ${entry.message}`];
      failed = true;
      break;
    case 'compaction':
      kind = entry.done ? 'Compacted' : 'Compacting';
      main = [`context ${size(entry.contextTokens)} tokens reached the ${size(entry.thresholdTokens)}-token threshold${entry.afterTokens !== undefined ? `; TrueForge summarised it to ${size(entry.afterTokens)} tokens` : entry.done ? '; TrueForge summarised it' : '…'}${entry.durationMs !== undefined ? ` in ${(entry.durationMs / 1000).toFixed(1)} s` : ''}`];
      notes.push('Earlier messages and file contents were replaced by a summary; the agent re-reads what it still needs.');
      break;
    case 'command':
    case 'todo':
      return null;
  }
  if ('reason' in entry && entry.reason) notes.push(entry.reason);
  if (added > 0) main.push(` (+${size(added)} chars)`);
  const Icon = entry.kind === 'compaction' && !entry.done ? LoaderIcon : ICONS[entry.kind];
  return (
    <div className={clsx('activity-row', `activity-${entry.kind}`, card && 'activity-card', failed && 'activity-failed')} title={entry.kind === 'search' && entry.files.length ? entry.files.join('\n') : undefined}>
      <Icon className={clsx('activity-icon', entry.kind === 'compaction' && !entry.done && 'animate-spin')} />
      <span className="activity-kind">{kind}</span>{' '}{main}
      {notes.map((note, index) => <span className="activity-note" key={index}>{note}</span>)}
      {children}
    </div>
  );
}

/** Cline's CommandOutputRow: a code box with a status dot, the command, and how it ended. */
export function CommandRow({ entry, added }: { entry: Extract<ToolEntry, { kind: 'command' }>; added: number }) {
  const failed = entry.cancelled || entry.timedOut || entry.exitCode !== 0;
  const ended = entry.cancelled ? 'cancelled' : entry.timedOut ? 'timed out' : `exit ${entry.exitCode ?? 'signal'}`;
  const command = entry.command.length > 200 ? `${entry.command.slice(0, 200)}…` : entry.command;
  return (
    <div className={clsx('activity-row activity-command activity-card', failed && 'activity-failed')}>
      <div className="command-header">
        <span aria-hidden="true" className={clsx('command-dot', failed ? 'bg-error' : 'bg-success')} />
        <TerminalIcon className="activity-icon" />
        <span className="activity-kind">Ran</span>{' '}
        <span className={failed ? 'text-error' : 'text-description'}>{`${entry.cwd === '.' ? '' : `in ${entry.cwd} · `}${ended} after ${(entry.durationMs / 1000).toFixed(1)} s`}</span>
        {added > 0 && <span className="text-description">{` (+${size(added)} chars)`}</span>}
      </div>
      <code className="command-text" title={entry.command}>{command}</code>
      {entry.reason && <span className="activity-note">{entry.reason}</span>}
    </div>
  );
}

const TODO_ICON: Record<TodoItem['status'], ReactNode> = {
  completed: <CheckIcon className="text-success" />,
  in_progress: <CircleDotIcon className="text-link" />,
  pending: <CircleIcon className="text-description" />,
  cancelled: <XIcon className="text-description" />,
};

/** The agent's to-do list, like Cline's focus-chain checklist. Older lists collapse to one line. */
export function TodoRow({ todos, latest }: { todos: TodoItem[]; latest: boolean }) {
  const done = todos.filter(todo => todo.status === 'completed').length;
  return (
    <div className={clsx('activity-row activity-todo activity-card', !latest && 'activity-todo-old')}>
      <ListTodoIcon className="activity-icon" />
      <span className="activity-kind">{latest ? 'To-do list' : 'Updated to-do list'}</span>{' '}
      <span className="text-description">{`${done}/${todos.length} done`}</span>
      {latest && (
        <ul className="todo-list">
          {todos.map((todo, index) => (
            <li className={clsx('todo-item', `todo-${todo.status}`)} key={index}>
              <span className="todo-icon">{TODO_ICON[todo.status]}</span>
              <span>{todo.content}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
