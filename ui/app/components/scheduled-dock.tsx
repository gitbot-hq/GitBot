"use client";

import AnimatedActionIcon from "./animated-action-icon";
import { ChevronDownIcon } from "@animateicons/react/lucide/chevron-down-icon";
import { IconAlertTriangle, IconClock } from "@tabler/icons-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { listSchedules } from "../lib/api";
import type { ScheduleView } from "../lib/gitbot";
import {
  DOCK_EMPTY,
  DOCK_HINT,
  dockGroups,
  recentText,
  rowTarget,
  rowText,
  runGlyph,
  runTarget,
  type RowTarget,
} from "../lib/schedule-dock";

/**
 * The Scheduled dock at the bottom of the bots rail: every schedule across
 * bots and threads, as Needs attention, Up next and Recent. Read-only here:
 * a row opens the thread it runs on. No model or effort: a schedule has none.
 */
export default function ScheduledDock({
  open,
  onToggle,
  refreshKey,
  onOpen,
}: {
  open: boolean;
  onToggle: () => void;
  /** Bumped on the thread list's quiet refreshes (a schedules event, tab
   *  return, a turn starting or ending): re-read. */
  refreshKey: unknown;
  /** Opens a thread under its bot. */
  onOpen: (botId: string, threadId: string) => void;
}) {
  const [list, setList] = useState<ScheduleView[] | null>(null);
  const [serverNow, setServerNow] = useState<number>(() => Date.now());
  const live = useRef(true);

  const load = useCallback(() => {
    if (document.visibilityState === "hidden") return;
    listSchedules().then(
      (r) => {
        if (!live.current) return;
        setList(r.schedules);
        const at = Date.parse(r.now);
        setServerNow(Number.isFinite(at) ? at : Date.now());
      },
      () => {},
    );
  }, []);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  // On mount and on each quiet refresh. A tab return is one of those
  // (app-shell's useTabVisible), so the dock has no listener of its own.
  useEffect(() => {
    load();
  }, [load, refreshKey]);

  const now = serverNow;
  const groups = list ? dockGroups(list, now) : null;
  const empty = list !== null && list.length === 0;

  function go(target: RowTarget) {
    if (target) onOpen(target.botId, target.threadId);
  }

  function row(s: ScheduleView, attention: boolean) {
    const text = rowText(s, now);
    const target = rowTarget(s);
    const Icon = attention ? IconAlertTriangle : IconClock;
    return (
      <li key={s.id}>
        <button
          type="button"
          className={`dock-row${attention ? " attention" : ""}`}
          title={text.tooltip}
          aria-label={text.tooltip}
          aria-disabled={target ? undefined : true}
          onClick={() => go(target)}
        >
          <Icon size={14} aria-hidden="true" className="dock-row-icon" />
          <span className="dock-row-copy">
            <span className="dock-row-head">
              <span className="dock-row-title">{text.title}</span>
              {text.time && <span className="dock-row-time">{text.time}</span>}
            </span>
            <span className="dock-row-line">{text.line}</span>
          </span>
        </button>
      </li>
    );
  }

  return (
    <section className={`scheduled-dock${open ? " open" : ""}`} aria-label="Scheduled">
      <button type="button" className="dock-head" aria-expanded={open} onClick={onToggle}>
        <IconClock size={16} aria-hidden="true" />
        <span className="dock-head-title">Scheduled</span>
        <AnimatedActionIcon icon={ChevronDownIcon} size={14} aria-hidden="true" />
      </button>
      {open && (
        <div className="dock-body">
          {empty && (
            <div className="dock-empty">
              <p>{DOCK_EMPTY}</p>
              <p className="dock-hint">{DOCK_HINT}</p>
            </div>
          )}
          {groups && groups.attention.length > 0 && (
            <div className="dock-group">
              <h3 className="bot-section-title">Needs attention</h3>
              <ul className="dock-list">{groups.attention.map((s) => row(s, true))}</ul>
            </div>
          )}
          {groups && (groups.upNext.length > 0 || groups.pausedCount > 0) && (
            <div className="dock-group">
              <h3 className="bot-section-title">Up next</h3>
              <ul className="dock-list">{groups.upNext.map((s) => row(s, false))}</ul>
              {(groups.more > 0 || groups.pausedCount > 0) && (
                <p className="dock-note">
                  {[groups.more > 0 ? `+${groups.more} more` : "", groups.pausedCount > 0 ? `${groups.pausedCount} paused` : ""]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              )}
            </div>
          )}
          {groups && groups.recent.length > 0 && (
            <div className="dock-group">
              <h3 className="bot-section-title">Recent</h3>
              <ul className="dock-list">
                {groups.recent.map((r, i) => {
                  const text = recentText(r, now);
                  const glyph = runGlyph(r.run);
                  const target = runTarget(r.run);
                  return (
                    <li key={`${r.schedule.id}-${r.run.at}-${i}`}>
                      <button
                        type="button"
                        className="dock-row recent"
                        title={text.tooltip}
                        aria-label={text.tooltip}
                        aria-disabled={target ? undefined : true}
                        onClick={() => go(target)}
                      >
                        <span className={`dock-glyph ${glyph.kind}`} aria-hidden="true">{glyph.glyph}</span>
                        <span className="dock-row-copy">
                          <span className="dock-row-head">
                            <span className="dock-row-title">{text.title}</span>
                            <span className="dock-row-time">{text.time}</span>
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
