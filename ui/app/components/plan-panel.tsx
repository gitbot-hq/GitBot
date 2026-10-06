"use client";

import type { TodoItem } from "../lib/gitbot";

// --- Plan panel ---
// The agent's own todo list, mirrored above the composer so the step it is on
// is always in view. TodoWrite always writes the whole plan, so each call
// simply replaces what the panel shows; there is nothing to merge or diff.
// Collapsed to one line by default, and the line itself is the cue — it
// changes as the agent moves through the list.
//
// Purely presentational: Chat owns the list and the open/closed flag, because
// both belong to the thread's lifetime, not to this card's.

const PLAN_MARKS: Record<string, string> = {
  completed: "\u2713",
  in_progress: "\u25b8",
  pending: "\u2610",
};

export default function PlanPanel({
  todos,
  open,
  onToggle,
}: {
  /** The whole plan as last written, or null when the thread has none yet. */
  todos: TodoItem[] | null;
  /** Expanded to the full list, rather than the one-line summary. */
  open: boolean;
  onToggle: () => void;
}) {
  // Hidden until a thread has todos — and it stays once every item is done.
  if (!todos || !todos.length) return null;

  let done = 0;
  let current: TodoItem | null = null;
  let firstPending: TodoItem | null = null;
  for (const t of todos) {
    if (t.status === "completed") done++;
    else if (t.status === "in_progress" && !current) current = t;
    else if (t.status === "pending" && !firstPending) firstPending = t;
  }
  const shown = current || firstPending;

  return (
    <div className={`plan${current ? " active" : ""}${open ? " open" : ""}`}>
      <button
        type="button"
        className="plan-bar"
        aria-expanded={open}
        onClick={onToggle}
      >
        {/* activeForm is the present-continuous wording the tool asks for,
            which is exactly what a status line wants; content is the fallback. */}
        <span className="plan-now">
          {shown ? shown.activeForm || shown.content : "Plan complete"}
        </span>
        <span className="plan-count">
          {done}/{todos.length}
        </span>
        <span className="plan-chev" aria-hidden="true">
          &rsaquo;
        </span>
      </button>
      {open && (
        <ul className="plan-list">
          {todos.map((t, i) => (
            <li key={i} className={`plan-item ${t.status}`}>
              <span className="plan-mark" aria-hidden="true">
                {PLAN_MARKS[t.status] || PLAN_MARKS.pending}
              </span>
              <span>{t.content}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
