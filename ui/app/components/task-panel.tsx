"use client";

import { taskSummary, type Task } from "../lib/tasks";

// --- Task panel ---
// The list Claude Code keeps with its Task tools (TaskCreate and friends),
// docked above the composer with the plan and sub-agent panels and built the
// same way: one line collapsed, the full list open, done tasks struck through.
// It shows only once the agent has used those tools on this thread.
//
// Purely presentational: Chat owns the list and the open/closed flag.

const MARKS: Record<Task["status"], string> = {
  completed: "✓",
  in_progress: "▸",
  pending: "☐",
};

const LABELS: Record<Task["status"], string> = {
  completed: "done",
  in_progress: "in progress",
  pending: "pending",
};

export default function TaskPanel({
  tasks,
  open,
  onToggle,
}: {
  tasks: Task[];
  /** Expanded to the full list, rather than the one-line summary. */
  open: boolean;
  onToggle: () => void;
}) {
  if (!tasks.length) return null;

  const done = tasks.filter((t) => t.status === "completed").length;
  const active = tasks.some((t) => t.status === "in_progress");
  // A blocker still holds a task up only while it is listed and not done.
  const isOpen = (id: string) => tasks.some((t) => t.id === id && t.status !== "completed");

  return (
    <div className={`plan tasks${active ? " active" : ""}${open ? " open" : ""}`}>
      <button type="button" className="plan-bar" aria-expanded={open} onClick={onToggle}>
        <span className="plan-now">{taskSummary(tasks)}</span>
        <span className="plan-count">
          {done}/{tasks.length}
        </span>
        <span className="plan-chev" aria-hidden="true">
          &rsaquo;
        </span>
      </button>
      {open && (
        <ul className="plan-list">
          {tasks.map((t) => {
            const blockers = t.status === "completed" ? [] : t.blockedBy.filter(isOpen);
            return (
              <li key={t.id} className={`plan-item ${t.status}`}>
                <span className="plan-mark" aria-hidden="true">
                  {MARKS[t.status]}
                </span>
                <span className="task-subject">{t.subject}</span>
                {blockers.length > 0 && (
                  <span className="task-note">blocked by {blockers.map((b) => `#${b}`).join(", ")}</span>
                )}
                {/* The mark is aria-hidden; this says the same to a screen reader. */}
                <span className="task-sr">, {LABELS[t.status]}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
