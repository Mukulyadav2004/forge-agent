/*
 * Adapted from Cline's apps/vscode/webview-ui/src/components/chat/chat-view/components/layout/ActionButtons.tsx
 * at eff43e19b267e171f597ab03733bfed25090f72d.
 * Copyright 2026 Cline Bot Inc. Licensed under Apache-2.0; see licenses/Cline-Apache-2.0.txt.
 */
import clsx from 'clsx';
import { post } from '../../vscode.js';

/**
 * Cline's footer buttons. Approval shows a primary Approve and a secondary Deny; a running turn shows Cancel.
 * Cancel stays in the page (disabled) while idle so callers can always ask whether a request is running.
 */
export function ActionButtons({ approval, busy }: { approval: boolean; busy: boolean }) {
  const stopping = busy || approval;
  return (
    <div aria-label="Current request" className="action-buttons flex gap-1.5" hidden={!stopping} id="run-actions" role="group">
      <button className="btn btn-primary flex-1" disabled={busy} hidden={!approval} id="approve-button" onClick={() => post({ type: 'approve', allow: true })} type="button">Approve</button>
      <button className="btn btn-secondary flex-1" disabled={busy} hidden={!approval} id="deny-button" onClick={() => post({ type: 'approve', allow: false })} type="button">Deny</button>
      <button className={clsx('btn btn-secondary', approval ? 'flex-none' : 'flex-1')} disabled={!stopping} id="cancel-button" onClick={() => post({ type: 'cancel' })} title={stopShortcut().title} type="button">Cancel</button>
    </div>
  );
}

export function stopShortcut(): { keys: string; title: string } {
  const mac = /\bMac/i.test(navigator.platform) || /\bMac/i.test(navigator.userAgent);
  return mac ? { keys: '⇧⌘⌫', title: 'Cancel (Shift+Command+Backspace)' } : { keys: 'Ctrl+Shift+⌫', title: 'Cancel (Ctrl+Shift+Backspace)' };
}
