/*
 * Adapted from Cline's apps/vscode/webview-ui/src/components/chat/task-header/TaskHeader.tsx and ContextWindow.tsx
 * at eff43e19b267e171f597ab03733bfed25090f72d.
 * Copyright 2026 Cline Bot Inc. Licensed under Apache-2.0; see licenses/Cline-Apache-2.0.txt.
 */
import clsx from 'clsx';
import { useLayoutEffect, useRef, useState } from 'react';
import type { TokenUsage } from '../../../shared/messages.js';
import { formatLargeNumber } from '../../lib/format.js';
import { ChevronDownIcon, ChevronRightIcon, PlusIcon } from '../common/Icons.js';

/** Tokens in the model's last call against its context window, as Cline's progress bar. */
export function ContextWindow({ used, limit }: { used: number; limit: number }) {
  if (limit <= 0 && used <= 0) return null;
  const percentage = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
  const label = limit > 0
    ? `Context window: ${used.toLocaleString('en-US')} of ${limit.toLocaleString('en-US')} tokens (${Math.round(percentage)}%)`
    : `Context window: ${used.toLocaleString('en-US')} tokens`;
  return (
    <div className="context-window flex items-center gap-1.5 whitespace-nowrap text-xs" title={label}>
      <span title="Current tokens used in this request">{formatLargeNumber(used)}</span>
      <div aria-label="Context window usage progress" aria-valuemax={100} aria-valuemin={0} aria-valuenow={Math.round(percentage)} className="context-progress relative h-1 flex-1 overflow-hidden rounded-full" role="progressbar">
        <div className={clsx('h-full rounded-full', percentage > 85 ? 'bg-error' : percentage > 60 ? 'bg-warning' : 'bg-success')} style={{ width: `${percentage}%` }} />
      </div>
      <span title="Maximum context window size for this model">{limit > 0 ? formatLargeNumber(limit) : '?'}</span>
    </div>
  );
}

/** Cline's "Tokens: ↑ in ↓ out" figures, summed from TrueForge's turn metrics. Cost is shown only when TrueForge reported one. */
function UsageSummary({ usage }: { usage: TokenUsage }) {
  const details = [
    `Input tokens: ${usage.inputTokens.toLocaleString('en-US')}`,
    `Output tokens: ${usage.outputTokens.toLocaleString('en-US')}`,
    ...(usage.cacheReadTokens ? [`Cache reads: ${usage.cacheReadTokens.toLocaleString('en-US')}`] : []),
    ...(usage.cacheWriteTokens ? [`Cache writes: ${usage.cacheWriteTokens.toLocaleString('en-US')}`] : []),
    ...(usage.reasoningTokens ? [`Reasoning tokens: ${usage.reasoningTokens.toLocaleString('en-US')}`] : []),
    ...(usage.costUsd !== undefined ? [`Cost reported by TrueForge: $${usage.costUsd.toFixed(4)}`] : []),
  ].join('\n');
  return (
    <span aria-label={details.replace(/\n/gu, ', ')} className="task-usage inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-xs" role="note" title={details}>
      <span>{`↑ ${formatLargeNumber(usage.inputTokens)}`}</span>
      <span>{`↓ ${formatLargeNumber(usage.outputTokens)}`}</span>
      {usage.costUsd !== undefined && <span className="task-cost" id="price-tag">{`$${usage.costUsd.toFixed(4)}`}</span>}
    </span>
  );
}

/** The current task: its first request as a title, Cline's expandable details, token figures, and the context window. */
export function TaskHeader({ text, context, usage, onNewTask }: { text: string; context: { used: number; limit: number }; usage?: TokenUsage; onNewTask: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const [textExpanded, setTextExpanded] = useState(false);
  const textRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = textRef.current;
    if (element && expanded && !textExpanded) setOverflowing(element.scrollHeight > element.clientHeight);
  }, [text, expanded, textExpanded]);
  const clamped = overflowing && !textExpanded;
  const toggle = () => setExpanded(value => !value);
  return (
    <div className={clsx('task-header', expanded && 'is-expanded')}>
      <div className="flex items-start justify-between gap-1">
        <div
          aria-expanded={expanded}
          aria-label={expanded ? 'Collapse task header' : 'Expand task header'}
          className="flex min-w-0 grow cursor-pointer items-center gap-1"
          onClick={toggle}
          onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle(); } }}
          role="button"
          tabIndex={0}>
          {expanded ? <ChevronDownIcon className="shrink-0" /> : <ChevronRightIcon className="shrink-0" />}
          {!expanded && <span className="task-title min-w-0 grow basis-0 select-none overflow-hidden text-ellipsis whitespace-nowrap">{text}</span>}
          {expanded && <span className="task-title select-none font-semibold">Task</span>}
        </div>
        {usage && <UsageSummary usage={usage} />}
        <button aria-label="New task" className="icon-button shrink-0" onClick={onNewTask} title="Start a new task" type="button"><PlusIcon /></button>
      </div>
      {expanded && (
        <div
          className={clsx('task-text mt-1 whitespace-pre-wrap break-words px-0.5 text-sm', textExpanded ? 'max-h-[25vh] overflow-y-auto' : 'max-h-[4.5rem] overflow-hidden', clamped && 'cursor-pointer')}
          onClick={() => overflowing && setTextExpanded(true)}
          ref={textRef}
          style={clamped ? { WebkitMaskImage: 'linear-gradient(to bottom, black 60%, transparent 100%)', maskImage: 'linear-gradient(to bottom, black 60%, transparent 100%)' } : undefined}>
          {text}
        </div>
      )}
      {expanded && usage && (usage.cacheReadTokens || usage.cacheWriteTokens || usage.reasoningTokens) ? (
        <div className="task-usage-details mt-1 flex flex-wrap gap-x-3 px-0.5 text-xs">
          {usage.cacheReadTokens ? <span>{`Cache reads: ${formatLargeNumber(usage.cacheReadTokens)}`}</span> : null}
          {usage.cacheWriteTokens ? <span>{`Cache writes: ${formatLargeNumber(usage.cacheWriteTokens)}`}</span> : null}
          {usage.reasoningTokens ? <span>{`Reasoning: ${formatLargeNumber(usage.reasoningTokens)}`}</span> : null}
        </div>
      ) : null}
      <ContextWindow limit={context.limit} used={context.used} />
    </div>
  );
}
