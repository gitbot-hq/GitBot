"use client";

import AnimatedActionIcon from "./animated-action-icon";
import { ChevronDownIcon } from "@animateicons/react/lucide/chevron-down-icon";
import { IconClock } from "@tabler/icons-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { listSchedules } from "../lib/api";
import type { ScheduleView } from "../lib/gitbot";
import { panelLabel } from "../lib/schedules";
import { useTabVisible } from "../lib/use-tab-visible";
import ScheduleCard, { scheduleCall, type CardAction } from "./schedule-card";

/**
 * The schedules on the open thread (and, on a Jarvis thread, the ones whose
 * notes go there: those it made on other threads, and its new-thread ones),
 * with pause or resume, run now, notify and delete. Renders nothing until
 * there is at least one (the dock's + still makes one for this thread). + Add
 * opens the new-schedule form for this thread. No model or effort: a schedule
 * has none, and a run's own thread shows what ran.
 */
export default function SchedulesPanel({
  threadId,
  version,
  onOpen,
  onShowAll,
  onAdd,
  onChanged,
  onError,
}: {
  /** Opens the new-schedule form for this thread. */
  onAdd?: () => void;
  threadId: string;
  /** The stream's schedules version (use-thread-sessions): a change re-reads. */
  version: number | undefined;
  /** Switches the hub to a thread, under its own bot. */
  onOpen: (botId: string, threadId: string) => void;
  /** Opens the Schedules view (offered when there is more than one card). */
  onShowAll?: () => void;
  /** A schedule changed here: the thread list's badges are re-read. */
  onChanged?: () => void;
  onError?: (message: string) => void;
}) {
  const [schedules, setSchedules] = useState<ScheduleView[]>([]);
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

  // Any schedule written anywhere (a run starting or ending, Jarvis or curl
  // changing one) is a schedules event: re-read, not on mount (read above).
  // A hidden tab skips it, and its return reads instead.
  const lastVersion = useRef(version);
  useEffect(() => {
    const before = lastVersion.current;
    lastVersion.current = version;
    // undefined → a number is the stream connecting, not a change.
    if (before === undefined || before === version) return;
    load();
  }, [version, load]);

  function act(id: string, action: CardAction) {
    setBusy(id);
    scheduleCall(id, action)
      .catch((e) => onError?.(e instanceof Error ? e.message : String(e)))
      .then(() => load())
      .finally(() => {
        if (live.current) setBusy(null);
        onChanged?.();
      });
  }

  if (schedules.length === 0) return null;

  return (
    <section className={open ? "schedules-panel open" : "schedules-panel"} aria-label="Schedules">
      <button type="button" className="schedules-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <IconClock size={14} aria-hidden="true" />
        {panelLabel(schedules.length)}
        <AnimatedActionIcon icon={ChevronDownIcon} size={14} aria-hidden="true" />
      </button>
      {onAdd && (
        <button type="button" className="schedule-link schedules-add" onClick={onAdd}>
          + Add
        </button>
      )}
      {open && (
        <div className="schedules-body">
          <ul className="schedules-list">
            {schedules.map((s) => (
              <ScheduleCard
                key={s.id}
                s={s}
                threadId={threadId}
                busy={busy === s.id}
                onAction={(action) => act(s.id, action)}
                onOpen={onOpen}
              />
            ))}
          </ul>
          {schedules.length > 1 && onShowAll && (
            <button type="button" className="schedule-link schedules-open-all" onClick={onShowAll}>
              Open in Schedules
            </button>
          )}
        </div>
      )}
    </section>
  );
}
