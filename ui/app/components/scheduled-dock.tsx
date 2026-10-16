"use client";

import AnimatedActionIcon from "./animated-action-icon";
import { ChevronDownIcon } from "@animateicons/react/lucide/chevron-down-icon";
import { IconAlertTriangle, IconClock, IconDots } from "@tabler/icons-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { listSchedules, patchSchedule, runScheduleNow } from "../lib/api";
import type { ScheduleView } from "../lib/gitbot";
import { moveMenuFocus } from "./share-dropdown";
import {
  attentionCounts,
  attentionKeys,
  attentionLabel,
  DOCK_EMPTY,
  DOCK_HINT,
  dockGroups,
  newAttentionIds,
  recentText,
  rowMenuItems,
  rowTarget,
  rowText,
  runGlyph,
  scheduleAttentionText,
  runTarget,
  type RowMenuItem,
  type RowTarget,
} from "../lib/schedule-dock";

/** Attention items already seen this tab session (auto-open fires once per new one). */
const SEEN_KEY = "gitbot.scheduledAttentionSeen";
const SEEN_MAX = 200;

function readSeen(): Set<string> {
  try {
    const raw = sessionStorage.getItem(SEEN_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

function writeSeen(seen: Set<string>): void {
  try {
    sessionStorage.setItem(SEEN_KEY, JSON.stringify([...seen].slice(-SEEN_MAX)));
  } catch {
    // private mode
  }
}

/**
 * The Scheduled dock at the bottom of the bots rail: every schedule across
 * bots and threads, as Needs attention, Up next and Recent. A row opens the
 * thread it runs on (or, with none yet, its card in the Schedules view); its ⋯ menu runs, pauses or resumes it (a schedules
 * event re-reads the list). No model or effort: a schedule has none.
 */
export default function ScheduledDock({
  open,
  onToggle,
  refreshKey,
  attentionCount,
  onOpen,
  onShowAll,
  onAutoOpen,
  onError,
}: {
  open: boolean;
  onToggle: () => void;
  /** The stream's count (use-thread-sessions); the list's own when absent. */
  attentionCount?: number;
  /** A new attention item arrived while the dock was collapsed. */
  onAutoOpen: () => void;
  onError: (message: string) => void;
  /** Bumped on the thread list's quiet refreshes (a schedules event, tab
   *  return, a turn starting or ending): re-read. */
  refreshKey: unknown;
  /** Opens a thread under its bot. */
  onOpen: (botId: string, threadId: string) => void;
  /** Opens the Schedules view, at one schedule's card when given. */
  onShowAll: (scheduleId?: string) => void;
}) {
  const [list, setList] = useState<ScheduleView[] | null>(null);
  const [serverNow, setServerNow] = useState<number>(() => Date.now());
  const live = useRef(true);
  const seen = useRef<Set<string> | null>(null);
  const openRef = useRef(open);
  openRef.current = open;
  const autoOpen = useRef(onAutoOpen);
  autoOpen.current = onAutoOpen;
  const [menu, setMenu] = useState<{ id: string; bottom: number; right: number } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const menuId = useId();
  const menuRef = useRef<HTMLDivElement>(null);
  const menuButton = useRef<HTMLButtonElement | null>(null);

  const load = useCallback(() => {
    if (document.visibilityState === "hidden") return;
    listSchedules().then(
      (r) => {
        if (!live.current) return;
        setList(r.schedules);
        // A new attention item expands a collapsed dock, once; it never collapses it.
        seen.current ??= readSeen();
        const fresh = newAttentionIds(attentionKeys(r.schedules), seen.current);
        if (fresh.length > 0) {
          for (const k of fresh) seen.current.add(k);
          writeSeen(seen.current);
          if (!openRef.current) autoOpen.current();
        }
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
  // The count from the stream (the newest); the tone from the list.
  const counts = list ? attentionCounts(list) : { paused: 0, failed: 0 };
  const label = attentionLabel(counts);
  const total = attentionCount ?? counts.paused + counts.failed;
  const chip = total > 0 ? { count: total, tone: label?.tone ?? "honey", text: scheduleAttentionText(total)! } : null;

  function go(target: RowTarget) {
    if (target) onOpen(target.botId, target.threadId);
  }

  // The menu: focus its first item on open; Escape closes it back to its ⋯.
  useEffect(() => {
    if (!menu) return;
    const frame = requestAnimationFrame(() => menuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus());
    function escape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeMenu();
    }
    document.addEventListener("keydown", escape);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", escape);
    };
  }, [menu]);

  function closeMenu() {
    setMenu(null);
    menuButton.current?.focus();
  }

  function toggleMenu(id: string, button: HTMLButtonElement) {
    if (menu?.id === id) return closeMenu();
    menuButton.current = button;
    // Fixed, in a portal: the dock clips its overflow. It opens upward, the
    // dock being at the bottom of the rail.
    const r = button.getBoundingClientRect();
    setMenu({ id, bottom: window.innerHeight - r.top + 4, right: Math.max(8, window.innerWidth - r.right) });
  }

  function choose(s: ScheduleView, item: RowMenuItem) {
    closeMenu();
    if (item.action === "open") return go(rowTarget(s));
    const action =
      item.action === "run" ? () => runScheduleNow(s.id)
      : () => patchSchedule(s.id, { enabled: item.action === "resume" });
    setBusy(s.id);
    action()
      .catch((e) => onError(e instanceof Error ? e.message : String(e)))
      .finally(() => {
        if (live.current) setBusy(null);
      });
  }

  function row(s: ScheduleView, attention: boolean) {
    const text = rowText(s, now);
    const target = rowTarget(s);
    const Icon = attention ? IconAlertTriangle : IconClock;
    const items = rowMenuItems(s, undefined, now);
    const menuOpen = menu?.id === s.id;
    return (
      <li key={s.id} className={`dock-item${menuOpen ? " menu-open" : ""}`}>
        <button
          type="button"
          className={`dock-row${attention ? " attention" : ""}`}
          title={text.tooltip}
          aria-label={text.tooltip}
          onClick={() => (target ? go(target) : onShowAll(s.id))}
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
        {items.length > 0 && (
          <button
            type="button"
            className="dock-row-more"
            aria-label={`${s.name}: actions`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-controls={menuOpen ? menuId : undefined}
            disabled={busy === s.id}
            onClick={(e) => toggleMenu(s.id, e.currentTarget)}
          >
            <IconDots size={16} aria-hidden="true" />
          </button>
        )}
        {menuOpen &&
          createPortal(
            <>
              <div
                ref={menuRef}
                id={menuId}
                className="chat-options-menu dock-menu"
                role="menu"
                aria-label={`${s.name} actions`}
                style={{ position: "fixed", top: "auto", bottom: menu.bottom, right: menu.right }}
                onKeyDown={moveMenuFocus}
              >
                {items.map((item) => (
                  <button key={item.action} type="button" role="menuitem" onClick={() => choose(s, item)}>
                    <span className="chat-menu-label">{item.label}</span>
                  </button>
                ))}
              </div>
              <button type="button" className="menu-scrim" onClick={closeMenu} aria-label="Close menu" tabIndex={-1} />
            </>,
            document.body,
          )}
      </li>
    );
  }

  return (
    <section className={`scheduled-dock${open ? " open" : ""}`} aria-label="Scheduled">
      <button type="button" className="dock-head" aria-expanded={open} onClick={onToggle}>
        <IconClock size={16} aria-hidden="true" />
        <span className="dock-head-title">Scheduled</span>
        {chip && (
          <span className={`dock-count ${chip.tone}`} role="img" aria-label={chip.text}>
            {chip.count}
          </span>
        )}
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
                  {groups.more > 0 && (
                    <button type="button" className="schedule-link" onClick={() => onShowAll()}>
                      +{groups.more} more
                    </button>
                  )}
                  {groups.more > 0 && groups.pausedCount > 0 && " · "}
                  {groups.pausedCount > 0 && (
                    <button type="button" className="schedule-link" onClick={() => onShowAll()}>
                      {groups.pausedCount} paused
                    </button>
                  )}
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
          {list && list.length > 0 && (
            <button type="button" className="schedule-link dock-see-all" onClick={() => onShowAll()}>
              See all schedules →
            </button>
          )}
        </div>
      )}
    </section>
  );
}
