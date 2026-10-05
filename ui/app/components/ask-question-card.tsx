"use client";

import { useMemo, useState } from "react";
import { IconCheck, IconHelpCircle } from "@tabler/icons-react";
import type { AskAnswers, AskQuestion } from "../lib/gitbot";

// The bot asking the user something, as a card in the conversation. It stands
// where a plain approval card would: the agent is stopped until this is
// answered, so it reads as a question and not as a permission to grant.
//
// The questions arrive already parsed, on the permission_request event. The
// only AskUserQuestion parser is the server's (src/ask-user-question.ts); this
// file knows how to *ask* them and nothing about the tool's input shape.
//
// Chosen option labels and the free-text "Other" are held apart, and joined
// only when the answer is sent. Keeping them separate is what lets a
// multi-select carry both two options and some typed words without the text
// box having to find and replace its own earlier value on every keystroke.

/**
 * Every question has something chosen. The tool offers "Other" on every
 * question, so there is always a way to answer; an empty "Other" box is not
 * an answer, and `pick` drops it before it gets here.
 */
function isComplete(questions: AskQuestion[], answers: AskAnswers): boolean {
  return questions.every((q) => (answers[q.question] ?? []).length > 0);
}

/** Add or remove one value, honouring single- vs multi-select. */
function pick(answers: AskAnswers, q: AskQuestion, value: string, on: boolean): AskAnswers {
  const current = answers[q.question] ?? [];
  if (!q.multiSelect) {
    const next = { ...answers };
    if (on && value) next[q.question] = [value];
    else delete next[q.question];
    return next;
  }
  const without = current.filter((v) => v !== value);
  const list = on && value ? [...without, value] : without;
  const next = { ...answers };
  if (list.length) next[q.question] = list;
  else delete next[q.question];
  return next;
}

type Props = {
  questions: AskQuestion[];
  /** An answer is on its way to the server; the card stops taking input. */
  busy?: boolean;
  onSubmit: (answers: AskAnswers) => void;
  /** Answer nothing. The agent is told the user declined, and carries on. */
  onDecline: () => void;
};

/** The tool promises every question a free-text escape hatch, and tells the
 *  model not to write one of its own. We are the ones who owe it. */
const OTHER = "Other";

export default function AskQuestionCard({ questions, busy, onSubmit, onDecline }: Props) {
  const [picked, setPicked] = useState<AskAnswers>({});
  const [otherOn, setOtherOn] = useState<Record<string, boolean>>({});
  const [otherText, setOtherText] = useState<Record<string, string>>({});

  const answers = useMemo(() => {
    const out: AskAnswers = {};
    for (const q of questions) {
      const typed = otherOn[q.question] ? (otherText[q.question] ?? "").trim() : "";
      const list = [...(picked[q.question] ?? []), ...(typed ? [typed] : [])];
      if (list.length) out[q.question] = list;
    }
    return out;
  }, [questions, picked, otherOn, otherText]);

  const ready = isComplete(questions, answers) && !busy;

  function choose(q: AskQuestion, label: string, on: boolean) {
    if (busy) return;
    setPicked((prev) => pick(prev, q, label, on));
    // One answer means one answer: picking an option puts the typed one away.
    if (on && !q.multiSelect) setOtherOn((prev) => ({ ...prev, [q.question]: false }));
  }

  function toggleOther(q: AskQuestion, on: boolean) {
    if (busy) return;
    setOtherOn((prev) => ({ ...prev, [q.question]: on }));
    if (on && !q.multiSelect) setPicked((prev) => pick(prev, q, "", false));
  }

  return (
    <div className="ask-card">
      <div className="ask-card-head">
        <IconHelpCircle size={17} aria-hidden="true" />
        <b>{questions.length > 1 ? `${questions.length} questions for you` : "A question for you"}</b>
      </div>

      {questions.map((q) => {
        const chosen = picked[q.question] ?? [];
        const other = !!otherOn[q.question];
        const role = q.multiSelect ? "checkbox" : "radio";
        return (
          <div key={q.question} className="ask-question">
            <div className="ask-question-head">
              <span className="ask-chip">{q.header}</span>
              {q.multiSelect && <span className="ask-hint">Pick any</span>}
            </div>
            <p className="ask-question-text">{q.question}</p>

            <div
              className="ask-options"
              role={q.multiSelect ? "group" : "radiogroup"}
              aria-label={q.question}
            >
              {q.options.map((opt) => {
                const on = chosen.indexOf(opt.label) !== -1;
                return (
                  <button
                    key={opt.label}
                    type="button"
                    role={role}
                    aria-checked={on}
                    disabled={busy}
                    className={`ask-option${on ? " is-chosen" : ""}`}
                    onClick={() => choose(q, opt.label, q.multiSelect ? !on : true)}
                  >
                    <span className="ask-option-mark" aria-hidden="true">
                      {on && <IconCheck size={13} />}
                    </span>
                    <span className="ask-option-copy">
                      <strong>{opt.label}</strong>
                      {opt.description && <small>{opt.description}</small>}
                    </span>
                  </button>
                );
              })}

              <button
                type="button"
                role={role}
                aria-checked={other}
                disabled={busy}
                className={`ask-option ask-option-other${other ? " is-chosen" : ""}`}
                onClick={() => toggleOther(q, !other)}
              >
                <span className="ask-option-mark" aria-hidden="true">
                  {other && <IconCheck size={13} />}
                </span>
                <span className="ask-option-copy">
                  <strong>{OTHER}</strong>
                  <small>Say it in your own words.</small>
                </span>
              </button>
            </div>

            {other && (
              <textarea
                className="ask-other-input"
                rows={2}
                autoFocus
                disabled={busy}
                placeholder="Your answer…"
                aria-label={`Your own answer to: ${q.question}`}
                value={otherText[q.question] ?? ""}
                onChange={(e) =>
                  setOtherText((prev) => ({ ...prev, [q.question]: e.target.value }))
                }
              />
            )}
          </div>
        );
      })}

      <div className="ask-acts">
        <button
          type="button"
          className="btn-primary"
          disabled={!ready}
          onClick={() => onSubmit(answers)}
        >
          {busy ? "Sending…" : "Send answer"}
        </button>
        <button type="button" className="btn-secondary" disabled={busy} onClick={onDecline}>
          Skip
        </button>
      </div>
    </div>
  );
}

/** What was answered, once it has been sent: the card's read-only afterlife. */
export function AskAnswerNote({ questions, answers }: { questions: AskQuestion[]; answers: AskAnswers }) {
  const said = questions
    .map((q) => ({ header: q.header, value: (answers[q.question] ?? []).join(", ") }))
    .filter((a) => a.value);
  if (!said.length) return <p className="perm-note">Declined to answer</p>;
  return (
    <p className="perm-note ask-note">
      {said.map((a) => (
        <span key={a.header} className="ask-note-item">
          <span className="ask-chip">{a.header}</span>
          {a.value}
        </span>
      ))}
    </p>
  );
}
