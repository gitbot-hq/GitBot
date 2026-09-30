"use client";

import { useState } from "react";
import type { RunFinding, RunRecord } from "../lib/gitbot";

const PAGE = 10;

function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function folder(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function where(f: RunFinding): string | null {
  if (!f.file) return null;
  return f.line ? `${f.file}:${f.line}` : f.file;
}

function counts(run: RunRecord) {
  const fresh = run.findings.filter((f) => f.status === "new").length;
  return {
    fresh,
    recurring: run.findings.length - fresh,
    resolved: run.resolved.length,
  };
}

function FindingRow({ f, status }: { f: RunFinding; status: "new" | "recurring" | "resolved" }) {
  const loc = where(f);
  return (
    <li className={`run-finding ${status}`}>
      <span className="run-pill">{status === "new" ? "New" : status === "recurring" ? "Recurring" : "Resolved"}</span>
      <span className="run-finding-body">
        <span className="run-finding-title">
          {f.title}
          {f.severity ? <span className="run-sev"> · {f.severity}</span> : null}
        </span>
        {loc ? <code className="run-loc" title={loc}>{loc}</code> : null}
      </span>
    </li>
  );
}

// Run history for a bot that keeps a run record: one row per run, newest
// first, with what changed against the run before it. Expanding a row shows
// the files it looked at and every finding with its file and line; the
// thread link opens the full conversation.
export default function RunHistory({
  runs,
  threadIds,
  onOpenThread,
}: {
  runs: RunRecord[];
  threadIds: Set<string>;
  onOpenThread?: (threadId: string) => void;
}) {
  const [open, setOpen] = useState<string | null>(runs[0]?.id ?? null);
  const [shown, setShown] = useState(PAGE);

  if (!runs.length) {
    return (
      <p className="run-empty">
        No runs recorded yet. A run shows up here when the bot finishes one.
      </p>
    );
  }

  return (
    <ol className="run-list">
      {runs.slice(0, shown).map((run) => {
        const c = counts(run);
        const isOpen = open === run.id;
        const threadAlive = threadIds.has(run.threadId);
        return (
          <li key={run.id} className={isOpen ? "run-item open" : "run-item"}>
            <button
              type="button"
              className="run-row"
              aria-expanded={isOpen}
              onClick={() => setOpen(isOpen ? null : run.id)}
            >
              <span className="run-row-top">
                <span className="run-when">{when(run.createdAt)}</span>
                <span className="run-where" title={run.repoPath}>
                  {folder(run.repoPath)}
                  {run.branch ? ` · ${run.branch}` : ""}
                </span>
              </span>
              <span className="run-counts">
                <span className="new">{c.fresh} new</span>
                <span className="recurring">{c.recurring} recurring</span>
                <span className="resolved">{c.resolved} resolved</span>
                {!run.previousRunId ? <span className="first">first run</span> : null}
              </span>
              {run.summary ? <span className="run-summary">{run.summary}</span> : null}
            </button>
            {isOpen && (
              <div className="run-detail">
                {run.changedFiles.length > 0 && (
                  <section>
                    <h4>Changed files · {run.changedFiles.length}</h4>
                    <ul className="run-files">
                      {run.changedFiles.map((f) => (
                        <li key={f}><code title={f}>{f}</code></li>
                      ))}
                    </ul>
                  </section>
                )}
                <section>
                  <h4>Findings · {run.findings.length}</h4>
                  {run.findings.length ? (
                    <ul className="run-findings">
                      {run.findings.map((f) => (
                        <FindingRow key={f.key} f={f} status={f.status ?? "new"} />
                      ))}
                    </ul>
                  ) : (
                    <p className="run-none">Nothing reported.</p>
                  )}
                </section>
                {run.resolved.length > 0 && (
                  <section>
                    <h4>Resolved since the previous run · {run.resolved.length}</h4>
                    <ul className="run-findings">
                      {run.resolved.map((f) => (
                        <FindingRow key={f.key} f={f} status="resolved" />
                      ))}
                    </ul>
                  </section>
                )}
                <div className="run-acts">
                  {threadAlive && onOpenThread ? (
                    <button type="button" className="btn-secondary" onClick={() => onOpenThread(run.threadId)}>
                      Open thread
                    </button>
                  ) : (
                    <span className="run-none">Thread deleted</span>
                  )}
                  {run.head ? <code className="run-head-sha" title={run.head}>{run.head.slice(0, 7)}</code> : null}
                </div>
              </div>
            )}
          </li>
        );
      })}
      {runs.length > shown && (
        <li>
          <button type="button" className="btn-ghost run-more" onClick={() => setShown((n) => n + PAGE)}>
            Show {Math.min(PAGE, runs.length - shown)} more
          </button>
        </li>
      )}
    </ol>
  );
}
