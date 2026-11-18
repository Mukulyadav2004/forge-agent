import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { isHostMessage } from '../shared/messages.js';
import type { ComposerSelection } from '../shared/messages.js';
import { MenuProvider } from './components/common/Dropdown.js';
import type { HostState } from './components/chat/ChatView.js';
import { ChatView } from './components/chat/ChatView.js';
import { HistoryView } from './components/history/HistoryView.js';
import { post, saveDraft, savedDraft } from './vscode.js';

const INITIAL: HostState = {
  type: 'state', messages: [], busy: false, status: 'Ready', approval: false, inspectedFiles: [], activity: [],
  review: { proposals: [], busy: false, canUndo: false, message: '' }, chats: [], questions: [],
  models: { current: '', names: [], loading: false }, context: { used: 0, limit: 0 }, history: [],
};

export function App() {
  const [state, setState] = useState<HostState>(INITIAL);
  const [draft, setDraft] = useState(savedDraft);
  const [attached, setAttached] = useState<ComposerSelection[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [view, setView] = useState<'chat' | 'history'>('chat');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const awaitingAck = useRef(false);
  const scroll = useRef({ following: true, reviewWasHidden: true, version: 0 });
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const onMessage = (event: MessageEvent<unknown>) => {
      const data = event.data;
      if (!isHostMessage(data)) return;
      if (data.type === 'focus_composer') { setView('chat'); setTimeout(() => inputRef.current?.focus()); return; }
      if (data.type === 'attach_selection') { setAttached(data.selections); setView('chat'); setTimeout(() => inputRef.current?.focus()); return; }
      // Follow new output only when the reader is already at the bottom, so scrolling back to read is not interrupted.
      const scroller = document.getElementById('task-content');
      scroll.current.following = !scroller || scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 48;
      scroll.current.reviewWasHidden = (document.getElementById('review-panel') as HTMLElement | null)?.hidden ?? true;
      setState(data);
      setSubmitting(false);
      if (awaitingAck.current) {
        setDraft('');
        setAttached([]);
        saveDraft('');
      }
      awaitingAck.current = false;
      setVersion(value => value + 1);
    };
    window.addEventListener('message', onMessage);
    post({ type: 'ready' });
    return () => window.removeEventListener('message', onMessage);
  }, []);

  useLayoutEffect(() => {
    if (version === 0) return;
    const scroller = document.getElementById('task-content');
    const review = document.getElementById('review-panel');
    if (scroller && scroll.current.following) scroller.scrollTop = scroller.scrollHeight;
    else if (review && scroll.current.reviewWasHidden && !review.hidden) review.scrollIntoView({ block: 'nearest' });
  }, [version]);

  const stopping = state.busy || state.approval;
  useEffect(() => {
    if (!stopping) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Backspace' || !event.shiftKey || event.altKey || !(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      post({ type: 'cancel' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [stopping]);

  useEffect(() => {
    document.body.classList.toggle('busy', state.busy);
    document.body.classList.toggle('needs-model', !state.models.current);
  }, [state.busy, state.models.current]);

  const onDraftChange = useCallback((next: string) => { setDraft(next); saveDraft(next); }, []);
  const onRemoveSelection = useCallback((index: number) => {
    setAttached(current => current.filter((_, item) => item !== index));
    post({ type: 'clear_selection', index });
  }, []);
  const onSend = useCallback(() => {
    const text = draft.trim();
    if (!text) return;
    setSubmitting(true);
    awaitingAck.current = true;
    post({ type: 'send_message', text, ...(attached.length ? { selections: attached } : {}) });
  }, [draft, attached]);
  const onDone = useCallback(() => setView('chat'), []);

  const pending = submitting || state.busy || state.approval || state.review.busy || state.questions.length > 0;
  return (
    <MenuProvider>
      <ChatView
        attached={attached}
        draft={draft}
        hidden={view !== 'chat'}
        inputRef={inputRef}
        onDraftChange={onDraftChange}
        onRemoveSelection={onRemoveSelection}
        onSend={onSend}
        onShowHistory={() => setView('history')}
        pending={pending}
        state={state}
      />
      {view === 'history' && <HistoryView chats={state.chats} history={state.history} onDone={onDone} />}
    </MenuProvider>
  );
}
