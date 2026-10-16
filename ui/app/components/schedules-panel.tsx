"use client";

import AnimatedActionIcon from "./animated-action-icon";
import { ChevronDownIcon } from "@animateicons/react/lucide/chevron-down-icon";
import { IconClock } from "@tabler/icons-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { deleteSchedule, getThread, listSchedules, patchSchedule, runScheduleNow } from "../lib/api";
import { JARVIS_BOT_ID, type Schedule, type ScheduleNotify } from "../lib/gitbot";
import {
  createdByText,
  fullTime,
  lastRuns,
  NOTIFY_OPTIONS,
  panelLabel,
  runText,
  scheduleActions,
  scheduleState,
  shortTime,
  statusText,
  targetText,
} from "../lib/schedules";
import { useTabVisible } from "../lib/use-tab-visible";

/** How often the list is re-read while the thread's turn runs. */
const POLL_MS = 3000;

/**
 * The schedules on the open thread (and, on a Jarvis thread, the ones whose
 * notes go there: those it made on other threads, and its new-thread ones),
 * with pause or resume, run now, notify and delete. Renders nothing until
 * there is at least one. Creating and editing a schedule's words and times is
 * Jarvis's or the API's, not this panel's. No model or effort: a schedule
 * has none, and a run's own thread shows what ran.
 */
export default function SchedulesPanel({
  threadId,
  working,
  onOpen,
  onChanged,
  onError,
}: {
  threadId: string;
  /** True while the open thread's turn is running. */
  working: boolean;
  /** Switches the hub to a thread, under its own bot. */
  onOpen: (botId: string, threadId: string) => void;
  /** A schedule changed here: the thread list's badges are re-read. */
  onChanged?: () => void;
  onError?: (message: string) => void;
}) {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [open, setOpen] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const live = useRef(true);

  const load = useCallback(() => {
    if (document.visibilityState === "hidden") return Promise.resolve();
    return listSchedules({ threadId }).then(
      ({ schedules: list }) => {
        if (live.current) setSchedules(list);
      },
      () => {},
    );
  }, [threadId]);

  // Once on mount (the panel is keyed by thread), and on coming back to the tab.
  useEffect(() => {
    live.current = true;
    load();
    return () => {
      live.current = false;
    };
  }, [load]);
  useTabVisible(load);

  // A run starts and ends with the thread's turn: poll while it runs, and
  // read once more when it ends.
  useEffect(() => {
    if (!working) return;
    const timer = setInterval(load, POLL_MS);
    return () => {
      clearInterval(timer);
      load();
    };
  }, [working, load]);

  function act(id: string, action: () => Promise<unknown>) {
    setBusy(id);
    action()
      .catch((e) => onError?.(e instanceof Error ? e.message : String(e)))
      .then(() => load())
      .finally(() => {
        if (live.current) setBusy(null);
        onChanged?.();
      });
  }

  function openRun(id: string) {
    getThread(id).then(
      ({ thread }) => onOpen(thread.botId, thread.id),
      () => onError?.("That thread has been deleted"),
    );
  }

  if (schedules.length === 0) return null;

  return (
    <section className={open ? "schedules-panel open" : "schedules-panel"} aria-label="Schedules">
      <button type="button" className="schedules-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <IconClock size={14} aria-hidden="true" />
        {panelLabel(schedules.length)}
        <AnimatedActionIcon icon={ChevronDownIcon} size={14} aria-hidden="true" />
      </button>
      {open && (
        <ul className="schedules-list">
          {schedules.map((s) => {
            const state = scheduleState(s);
            const can = scheduleActions(s);
            const where = targetText(s, threadId);
            const runs = lastRuns(s);
            const by = s.createdBy;
            const disabled = busy === s.id;
            return (
              <li key={s.id} className={`schedule schedule-${state}`}>
                <div className="schedule-head">
                  <b className="schedule-name">{s.name}</b>
                  <span className="schedule-when">{s.describe ?? s.when.kind}</span>
                </div>
                <div
                  className="schedule-status"
                  title={s.nextRunAt && state === "active" ? fullTime(s.nextRunAt) : undefined}
                >
                  {statusText(s)}
                </div>
                <div className="schedule-meta">
                  {where && <span>{where}</span>}
                  {by?.kind === "jarvis" && by.threadId !== threadId ? (
                    <button type="button" className="schedule-link" onClick={() => onOpen(JARVIS_BOT_ID, by.threadId)}>
                      {createdByText(s)}
                    </button>
                  ) : (
                    <span>{createdByText(s)}{by?.kind === "jarvis" ? " in this thread" : ""}</span>
                  )}
                  {can.notify ? (
                    <label className="schedule-notify">
                      notify{" "}
                      <select
                        value={s.notify}
                        disabled={disabled}
                        onChange={(e) => {
                          const notify = e.target.value as ScheduleNotify;
                          act(s.id, () => patchSchedule(s.id, { notify }));
                        }}
                      >
                        {NOTIFY_OPTIONS.map((o) => (
                          <option key={o.value} value={o.value}>{o.label}</option>
                        ))}
                      </select>
                    </label>
                  ) : (
                    <span>notify {s.notify}</span>
                  )}
                </div>
                {runs.length > 0 && (
                  <ol className="schedule-runs" aria-label={`Last runs of ${s.name}`}>
                    {runs.map((r, i) => (
                      <li key={`${r.at}-${i}`}>
                        <span className="schedule-run-at" title={fullTime(r.at)}>{shortTime(r.at)}</span>{" "}
                        {r.threadId && r.threadId !== threadId ? (
                          <button type="button" className="schedule-link" onClick={() => openRun(r.threadId!)}>
                            {runText(r)}
                          </button>
                        ) : (
                          <span>{runText(r)}</span>
                        )}
                      </li>
                    ))}
                  </ol>
                )}
                <div className="schedule-actions">
                  {can.pause && (
                    <button type="button" disabled={disabled} onClick={() => act(s.id, () => patchSchedule(s.id, { enabled: false }))}>
                      Pause
                    </button>
                  )}
                  {can.resume && (
                    <button type="button" disabled={disabled} onClick={() => act(s.id, () => patchSchedule(s.id, { enabled: true }))}>
                      Resume
                    </button>
                  )}
                  {can.runNow && (
                    <button type="button" disabled={disabled} onClick={() => act(s.id, () => runScheduleNow(s.id))}>
                      Run now
                    </button>
                  )}
                  <button
                    type="button"
                    className="schedule-delete"
                    disabled={disabled}
                    onClick={() => {
                      if (!confirm(`Delete the schedule "${s.name}"? Its runs' threads are kept.`)) return;
                      act(s.id, () => deleteSchedule(s.id));
                    }}
                  >
                    Delete
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
