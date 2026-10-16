"use client";

import { useEffect, useId, useState } from "react";
import { getThreads } from "../lib/api";
import { JARVIS_BOT_ID, type Bot, type ThreadFull } from "../lib/gitbot";
import { pickerGroups, type FormTarget } from "../lib/schedule-when";

/**
 * The schedule form's "Where": a searchable list of every thread (all bots,
 * from GET /threads), grouped by bot, newest activity first. Setup threads
 * are never offered. (A new thread each run is the form's other Where choice.)
 */
export default function ThreadPicker({
  bots,
  value,
  onChange,
}: {
  bots: readonly Bot[];
  value: FormTarget | null;
  onChange: (target: FormTarget) => void;
}) {
  const [threads, setThreads] = useState<ThreadFull[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const name = useId();

  useEffect(() => {
    let live = true;
    getThreads().then(
      (r) => live && setThreads(r.threads),
      (e) => live && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, []);

  const groups = threads ? pickerGroups(threads, bots, query, JARVIS_BOT_ID) : [];

  return (
    <div className="thread-picker">
      <input
        type="search"
        className="thread-picker-search"
        placeholder="Search threads"
        aria-label="Search threads"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          // Enter never reaches the form: it picks the match when there is exactly one.
          if (e.key !== "Enter") return;
          e.preventDefault();
          const matches = groups.flatMap((g) => g.threads);
          if (matches.length === 1) onChange(matches[0]);
        }}
      />
      <div className="thread-picker-list" role="radiogroup" aria-label="Thread">
        {error && <p className="schedule-form-error">{error}</p>}
        {!threads && !error && <p className="schedules-view-note">Loading…</p>}
        {threads && groups.length === 0 && <p className="schedules-view-note">No threads match.</p>}
        {groups.map((g) => (
          <div key={g.botId} className="thread-picker-group">
            <h4 className="bot-section-title">{g.botName}</h4>
            {g.threads.map((t) => (
              <label key={t.threadId} className={`thread-picker-row${value?.threadId === t.threadId ? " selected" : ""}`}>
                <input type="radio" name={name} checked={value?.threadId === t.threadId} onChange={() => onChange(t)} />
                <span>{t.title}</span>
              </label>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
