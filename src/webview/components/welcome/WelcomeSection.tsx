/*
 * Adapted from Cline's apps/vscode/webview-ui/src/components/chat/chat-view/components/layout/WelcomeSection.tsx
 * and history/HistoryPreview.tsx at eff43e19b267e171f597ab03733bfed25090f72d.
 * Copyright 2026 Cline Bot Inc. Licensed under Apache-2.0; see licenses/Cline-Apache-2.0.txt.
 */
import type { TaskHistoryItem } from '../../../shared/messages.js';
import { formatDate } from '../../lib/format.js';
import { HistoryIcon } from '../common/Icons.js';

function ForgeLogo() {
  return (
    <svg aria-hidden="true" className="welcome-logo" fill="none" height="48" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" viewBox="0 0 24 24" width="48">
      <path d="M4 15h10l3-3h3v3l-3 3H7a3 3 0 0 1-3-3Z" />
      <path d="M9 18v3M14 18v3M7 21h10M8 12V7l4-4 4 4v5" />
    </svg>
  );
}

const TIPS = [
  'Ask about the codebase: Forge searches and reads files before it answers.',
  'Select code and press Ctrl+L to attach it to your message.',
  'Proposed edits wait for your review: apply or reject each file or hunk.',
];

/** The empty task: Cline's welcome header, a few tips, and recent tasks from history. */
export function WelcomeSection({ history, onOpen }: { history: TaskHistoryItem[]; onOpen: (id: string) => void }) {
  const recent = [...history].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 3);
  return (
    <section aria-label="Welcome" className="welcome-section empty-state flex flex-col items-center gap-3 px-3 py-4 text-center">
      <ForgeLogo />
      <p className="welcome-title m-0 text-lg font-semibold text-foreground">What can I do for you?</p>
      <p className="m-0 text-sm text-description">Your messages will appear here.</p>
      <ul className="welcome-tips m-0 flex w-full flex-col gap-1.5 p-0 text-left text-xs text-description">
        {TIPS.map(tip => <li className="list-none rounded-xs bg-muted px-2.5 py-1.5" key={tip}>{tip}</li>)}
      </ul>
      {recent.length > 0 && (
        <div className="w-full text-left">
          <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-description">
            <HistoryIcon /> Recent tasks
          </div>
          {recent.map(item => (
            <button className="history-preview-item mb-1 flex w-full flex-col gap-0.5 rounded-xs bg-muted px-2.5 py-1.5 text-left hover:bg-list-hover" key={item.id} onClick={() => onOpen(item.id)} type="button">
              <span className="text-xs uppercase text-description">{formatDate(item.updatedAt)}</span>
              <span className="line-clamp-2 text-sm text-foreground">{item.title}</span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
