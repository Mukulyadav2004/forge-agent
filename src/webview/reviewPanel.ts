import type { ReviewCommand, ReviewState } from '../edits/review.js';

export function renderReviewPanel(options: { container: HTMLElement; state: ReviewState; disabled: boolean; onCommand: (command: ReviewCommand) => void }): void {
  const { container, state } = options;
  container.hidden = state.proposals.length === 0 && !state.canUndo && !state.recoveryPath;
  const locked = options.disabled || state.busy || !!state.recoveryPath;
  const active = state.proposals.filter(proposal => proposal.status === 'pending' || proposal.status === 'conflict');
  const title = document.createElement('h2');
  title.textContent = 'Review changes';
  const message = document.createElement('p');
  message.className = state.recoveryPath ? 'review-error' : 'hint';
  message.setAttribute('role', 'status');
  message.textContent = state.message;
  const toolbar = document.createElement('div');
  toolbar.className = 'review-actions';
  function button(options: { text: string; command: ReviewCommand; disabled: boolean }): HTMLButtonElement {
    const element = document.createElement('button');
    element.type = 'button'; element.textContent = options.text; element.disabled = options.disabled;
    element.addEventListener('click', () => { if (!element.disabled) optionsOnCommand(options.command); });
    return element;
  }
  const optionsOnCommand = options.onCommand;
  toolbar.append(
    button({ text: 'Apply all', command: { action: 'apply_all' }, disabled: locked || !active.length || active.some(proposal => proposal.status === 'conflict') }),
    button({ text: 'Reject all', command: { action: 'reject_all' }, disabled: locked || !active.length }),
    button({ text: 'Undo last apply', command: { action: 'undo' }, disabled: locked || !state.canUndo }),
  );
  const list = document.createElement('div');
  list.className = 'proposal-list';
  for (const proposal of state.proposals) {
    const row = document.createElement('article');
    row.className = 'proposal-row'; row.dataset.proposalId = proposal.id;
    const name = document.createElement('h3'); name.textContent = proposal.path;
    const status = document.createElement('span'); status.className = 'proposal-status'; status.textContent = proposal.status;
    const explanation = document.createElement('p'); explanation.textContent = proposal.explanation;
    const actions = document.createElement('div'); actions.className = 'review-actions';
    actions.append(button({ text: 'Preview', command: { action: 'preview', id: proposal.id }, disabled: locked }));
    if (proposal.status === 'pending' || proposal.status === 'conflict') {
      actions.append(
        button({ text: 'Apply file', command: { action: 'apply', id: proposal.id }, disabled: locked || proposal.status === 'conflict' }),
        button({ text: 'Reject', command: { action: 'reject', id: proposal.id }, disabled: locked }),
      );
    }
    row.append(name, status, explanation, actions); list.append(row);
  }
  container.replaceChildren(title, message, toolbar, list);
}
