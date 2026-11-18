/*
 * Adapted from Cline's apps/vscode/webview-ui/src/components/chat/ChatTextArea.tsx and
 * chat-view/components/layout/InputSection.tsx at eff43e19b267e171f597ab03733bfed25090f72d.
 * Copyright 2026 Cline Bot Inc. Licensed under Apache-2.0; see licenses/Cline-Apache-2.0.txt.
 */
import clsx from 'clsx';
import { forwardRef, useLayoutEffect, useRef, useState } from 'react';
import type { ComposerSelection, ModelMenu } from '../../../shared/messages.js';
import { fileName, shortModel } from '../../lib/format.js';
import { post } from '../../vscode.js';
import { Dropdown, MenuItem, MenuNote } from '../common/Dropdown.js';
import { ChevronDownIcon, GridIcon, InfinityIcon, PaperclipIcon, SendIcon, XIcon } from '../common/Icons.js';

function chipName(selection: ComposerSelection): string {
  return `${fileName(selection.path)}:${selection.startLine}-${selection.endLine}`;
}

/** Cline's file thumbnails, as chips: one per attached editor selection. */
function SelectionChips({ attached, onRemove }: { attached: ComposerSelection[]; onRemove: (index: number) => void }) {
  if (!attached.length) return null;
  return (
    <div className="composer-context" id="composer-context">
      {attached.map((selection, index) => (
        <div className="context-chip" key={`${selection.path}:${selection.startLine}:${selection.endLine}:${index}`} title={`${selection.path}:${selection.startLine}-${selection.endLine}`}>
          <span className="chip-type">{(/\.([^./\\]+)$/u.exec(selection.path)?.[1] ?? '').slice(0, 3).toUpperCase()}</span>
          <span className="chip-label">{chipName(selection)}</span>
          <button aria-label={`Remove ${chipName(selection)}`} onClick={() => onRemove(index)} title="Remove selection" type="button"><XIcon /></button>
        </div>
      ))}
    </div>
  );
}

/** The model picker: models from local TrueForge grouped by provider; picking one sets forgeAgent.model. */
function ModelDropdown({ models }: { models: ModelMenu }) {
  const [filter, setFilter] = useState('');
  const query = filter.trim().toLowerCase();
  const names = models.names.filter(name => name.toLowerCase().includes(query));
  const providers = new Map<string, string[]>();
  for (const name of names) {
    const provider = name.includes('/') ? name.slice(0, name.indexOf('/')) : 'other';
    providers.set(provider, [...(providers.get(provider) ?? []), name]);
  }
  return (
    <Dropdown
      button={{
        'aria-label': 'Select model',
        className: clsx('model-display dropdown', !models.current && 'unset'),
        title: models.current ? `Model: ${models.current}` : 'Choose a model from local TrueForge',
        onClick: () => { if (!models.names.length && !models.loading) post({ type: 'refresh_models' }); },
      }}
      buttonContent={<><span className="model-label" id="model-label">{models.current ? shortModel(models.current) : 'Select model'}</span><ChevronDownIcon className="chevron" /></>}
      id="model"
      menuLabel="Models"
      menuRole="listbox"
      onOpen={() => setFilter('')}>
      {close => <>
        {models.names.length > 6 && (
          <input
            aria-label="Search models"
            className="menu-search"
            onChange={event => setFilter(event.target.value)}
            onKeyDown={event => {
              if (event.key !== 'Enter') return;
              event.preventDefault();
              const first = names[0];
              close(true);
              if (first && first !== models.current) post({ type: 'set_model', name: first });
            }}
            placeholder="Search models"
            type="search"
            value={filter}
          />
        )}
        <div className="menu-list">
          {[...providers].map(([provider, group]) => (
            <div key={provider} role="group" aria-label={provider}>
              <MenuNote className="menu-heading" text={provider} />
              {group.map(name => (
                <MenuItem close={close} key={name} label={shortModel(name)} onPick={() => { if (name !== models.current) post({ type: 'set_model', name }); }} role="option" selected={name === models.current} />
              ))}
            </div>
          ))}
          {models.loading && !models.names.length ? <MenuNote text="Loading models from TrueForge…" />
            : models.error ? <MenuNote className="menu-note menu-error" text={models.error} />
              : !names.length ? <MenuNote text={query ? 'No matching models' : 'No models configured'} /> : null}
        </div>
        <div className="menu-footer">
          <MenuItem close={close} label={models.loading ? 'Refreshing…' : 'Refresh models'} onPick={() => post({ type: 'refresh_models' })} role="menuitem" />
        </div>
      </>}
    </Dropdown>
  );
}

/** Runs the draft in two to four parallel agent chats. */
function SpinDropdown({ draft }: { draft: string }) {
  const text = draft.trim();
  return (
    <Dropdown
      button={{ 'aria-label': 'Spin agents', className: 'icon-button', title: 'Run this message with several agents' }}
      buttonContent={<GridIcon />}
      id="spin"
      menuClassName="menu-start"
      menuLabel="Spin agents"
      menuRole="menu">
      {close => <>
        <MenuNote className="menu-heading" text="Run this message in parallel" />
        {[2, 3, 4].map(count => (
          <MenuItem close={close} disabled={!text} key={count} label={`${count} agents`} onPick={() => post({ type: 'spin_agents', text, count })} role="menuitem" />
        ))}
        {!text && <MenuNote text="Type a message first, then pick how many agents run it." />}
      </>}
    </Dropdown>
  );
}

/** The model's context use as a small ring: tokens in the last call out of the model's window. */
function ContextRing({ context }: { context: { used: number; limit: number } }) {
  const { used, limit } = context;
  const ratio = limit > 0 ? Math.min(1, used / limit) : 0;
  const length = 2 * Math.PI * 6;
  const label = limit > 0
    ? `Context window: ${used.toLocaleString('en-US')} of ${limit.toLocaleString('en-US')} tokens (${Math.round(ratio * 100)}%)`
    : used > 0 ? `Context window: ${used.toLocaleString('en-US')} tokens` : 'Context window: empty until the model reports usage';
  return (
    <span aria-label={label} className="context-meter" id="context-meter" role="img" title={label}>
      <svg aria-hidden="true" height="16" viewBox="0 0 16 16" width="16">
        <circle className="meter-track" cx="8" cy="8" r="6" />
        <circle className="meter-value" cx="8" cy="8" r="6" style={{ strokeDasharray: length, strokeDashoffset: length * (1 - ratio) }} />
      </svg>
    </span>
  );
}

export interface ChatTextAreaProps {
  draft: string;
  onDraftChange: (draft: string) => void;
  attached: ComposerSelection[];
  onRemoveSelection: (index: number) => void;
  pending: boolean;
  stopping: boolean;
  status: string;
  models: ModelMenu;
  context: { used: number; limit: number };
  onSend: () => void;
}

export const ChatTextArea = forwardRef<HTMLTextAreaElement, ChatTextAreaProps>(function ChatTextArea(props, ref) {
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  /** Grows the composer with its text up to the CSS max-height, then scrolls inside it. */
  useLayoutEffect(() => {
    const fit = () => {
      const input = inputRef.current;
      if (!input) return;
      const max = parseFloat(getComputedStyle(input).maxHeight) || Infinity;
      input.style.height = 'auto';
      input.style.height = `${Math.min(input.scrollHeight, max)}px`;
      input.style.overflowY = input.scrollHeight > max ? 'auto' : 'hidden';
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [props.draft]);

  const sendDisabled = props.pending || props.draft.trim().length === 0;
  return (
    <form
      className="chat-textarea"
      id="message-form"
      onSubmit={event => {
        event.preventDefault();
        if (props.pending || props.draft.trim().length === 0) return;
        props.onSend();
      }}
      ref={formRef}>
      <label className="sr-only" htmlFor="message-input">Message</label>
      <div className="status-line"><span aria-hidden="true" className="status-dot" /><span id="status" role="status" title={props.status}>{props.status}</span></div>
      <div className="composer">
        <SelectionChips attached={props.attached} onRemove={props.onRemoveSelection} />
        <div className="textarea-wrap">
          <textarea
            disabled={props.pending}
            id="message-input"
            onChange={event => props.onDraftChange(event.target.value)}
            onKeyDown={event => {
              // Enter sends; Shift+Enter keeps the browser default and inserts a new line.
              // Ctrl/Cmd+Enter still sends. Enter during IME composition confirms text and must not send.
              if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
              if (event.shiftKey && !event.ctrlKey && !event.metaKey) return;
              event.preventDefault();
              formRef.current?.requestSubmit();
            }}
            placeholder="Plan, search, build anything"
            ref={element => {
              inputRef.current = element;
              if (typeof ref === 'function') ref(element);
              else if (ref) ref.current = element;
            }}
            rows={2}
            spellCheck={false}
            title="Enter sends, Shift+Enter adds a new line"
            value={props.draft}
          />
          {props.stopping ? (
            <button aria-label="Stop" className="send is-stop" id="send-button" onClick={() => post({ type: 'cancel' })} title="Stop" type="button">
              <svg aria-hidden="true" className="icon-stop" viewBox="0 0 16 16"><rect height="13.5" rx="2.25" width="13.5" x="1.25" y="1.25" /></svg>
            </button>
          ) : (
            <button aria-label="Send" className="send" disabled={sendDisabled} id="send-button" title="Send" type="submit">
              <SendIcon />
            </button>
          )}
        </div>
        <div className="composer-actions">
          <div className="composer-tools">
            <button aria-label="Attach selection" className="icon-button" onClick={() => post({ type: 'add_selection' })} title="Attach the editor selection (Ctrl+L)" type="button"><PaperclipIcon /></button>
            <SpinDropdown draft={props.draft} />
            <ModelDropdown models={props.models} />
          </div>
          <div className="composer-end">
            <ContextRing context={props.context} />
            <span className="mode-pill" title="Forge runs the TrueForge agent"><InfinityIcon />Agent</span>
          </div>
        </div>
      </div>
    </form>
  );
});
