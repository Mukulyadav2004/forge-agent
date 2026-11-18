/*
 * Adapted from Cline's apps/vscode/webview-ui/src/components/chat/OptionsButtons.tsx at
 * eff43e19b267e171f597ab03733bfed25090f72d.
 * Copyright 2026 Cline Bot Inc. Licensed under Apache-2.0; see licenses/Cline-Apache-2.0.txt.
 */
import clsx from 'clsx';
import { useState } from 'react';
import type { AgentQuestion } from '../../../shared/messages.js';
import { post } from '../../vscode.js';

/** The agent's ask_user_question choices. Every question needs one pick, then Send answer replies to all of them. */
export function OptionsButtons({ questions }: { questions: AgentQuestion[] }) {
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [sent, setSent] = useState(false);
  const complete = questions.every(question => picked[question.toolCallId] !== undefined);
  return (
    <section aria-label="Agent questions" className="agent-questions flex flex-col gap-2" id="agent-questions">
      {questions.map((question, index) => (
        <fieldset className="question-card" key={question.toolCallId}>
          <legend>{questions.length > 1 ? `Question ${index + 1}` : 'Question'}</legend>
          <p className="question-text">{question.question}</p>
          <div className="flex flex-col gap-2" role="radiogroup">
            {question.options.map((option, optionIndex) => {
              const selected = picked[question.toolCallId] === option;
              return (
                <button
                  aria-checked={selected}
                  className={clsx('options-button choice', selected && 'is-selected')}
                  disabled={sent}
                  key={option}
                  onClick={() => setPicked(current => ({ ...current, [question.toolCallId]: option }))}
                  role="radio"
                  type="button">
                  {`${String.fromCharCode(65 + optionIndex)}. ${option}`}
                </button>
              );
            })}
          </div>
        </fieldset>
      ))}
      <button
        className="btn btn-primary question-send self-end"
        disabled={!complete || sent}
        onClick={() => {
          setSent(true);
          post({ type: 'answer_question', answers: questions.map(question => ({ toolCallId: question.toolCallId, choice: picked[question.toolCallId] ?? '' })) });
        }}
        type="button">
        Send answer
      </button>
    </section>
  );
}
