import type { WebviewMessage } from '../shared/messages.js';

interface WebviewApi {
  postMessage(message: WebviewMessage): void;
  getState(): unknown;
  setState(state: { draft: string }): void;
}

declare function acquireVsCodeApi(): WebviewApi;

const api = acquireVsCodeApi();

export function post(message: WebviewMessage): void {
  api.postMessage(message);
}

export function savedDraft(): string {
  const state = api.getState();
  return typeof state === 'object' && state !== null && 'draft' in state && typeof state.draft === 'string' ? state.draft : '';
}

export function saveDraft(draft: string): void {
  api.setState({ draft });
}
