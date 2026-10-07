"use client";

import { subagentSummary, type Subagent } from "../lib/subagents";

// --- Subagent panel ---
// The sub-agents the thread has run, docked above the composer next to the
// plan panel and built the same way: one line collapsed, the full list open.
// Finished ones stay for the whole thread, struck through; failed and stopped
// carry their own mark so they never read as done.
//
// Purely presentational: Chat owns the list and the open/closed flag.

const MARKS: Record<Subagent["status"], string> = {
  running: "▸",
  completed: "✓",
  failed: "✕",
  stopped: "■",
};

const LABELS: Record<Subagent["status"], string> = {
  running: "running",
  completed: "done",
  failed: "failed",
  stopped: "stopped",
};

export default function SubagentPanel({
  subagents,
  open,
  onToggle,
}: {
  subagents: Subagent[];
  /** Expanded to the full list, rather than the one-line summary. */
  open: boolean;
  onToggle: () => void;
}) {
  // Hidden until the thread has run a sub-agent.
  if (!subagents.length) return null;

  const running = subagents.filter((s) => s.status === "running").length;
  const ended = subagents.length - running;

  return (
    <div className={`plan subagents${running ? " active" : ""}${open ? " open" : ""}`}>
      <button type="button" className="plan-bar" aria-expanded={open} onClick={onToggle}>
        <span className="plan-now">{subagentSummary(subagents)}</span>
        <span className="plan-count">
          {ended}/{subagents.length}
        </span>
        <span className="plan-chev" aria-hidden="true">
          &rsaquo;
        </span>
      </button>
      {open && (
        <ul className="plan-list">
          {subagents.map((s) => (
            <li key={s.taskId} className={`plan-item subagent-${s.status}`}>
              <span className="plan-mark" aria-hidden="true">
                {MARKS[s.status]}
              </span>
              <span className="subagent-desc">{s.description}</span>
              {s.type && <span className="subagent-type">{s.type}</span>}
              {/* Failed and stopped say so on screen; running and done only to
                  a screen reader, since the mark and the strike carry them. */}
              {s.status === "failed" || s.status === "stopped" ? (
                <span className="subagent-state">{LABELS[s.status]}</span>
              ) : (
                <span className="subagent-sr">, {LABELS[s.status]}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
