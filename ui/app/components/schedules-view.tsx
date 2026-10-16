"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { listSchedules } from "../lib/api";
import type { ScheduleView } from "../lib/gitbot";
import { DOCK_EMPTY, DOCK_HINT, endedText, SCHEDULE_GONE, viewGroups } from "../lib/schedule-dock";
import { panelLabel } from "../lib/schedules";
import { PanelBack } from "./panel-controls";
import ScheduleCard, { scheduleCall, type CardAction } from "./schedule-card";

/**
 * Centres a card in the view's own scroller (the overlay around the pane),
 * moving nothing else. Not scrollIntoView: during the slide-in that also
 * scrolls the tray behind, and the chat stays shifted after the view closes.
 * The card is looked up inside the view: the thread's panel under it draws
 * the same card.
 */
function centreCard(root: HTMLElement | null, id: string): void {
  const card = root?.querySelector<HTMLElement>(`[data-schedule-id="${CSS.escape(id)}"]`);
  const scroller = root?.parentElement;
  if (!card || !scroller) return;
  const c = card.getBoundingClientRect();
  const v = scroller.getBoundingClientRect();
  // Both move with the slide's transform, so their difference is layout only.
  scroller.scrollTop += c.top - v.top - Math.max(0, (scroller.clientHeight - c.height) / 2);
}

/** How long a deep-linked card stays drawn out. */
const HIGHLIGHT_MS = 4000;

/**
 * Every schedule, over the chat: Needs attention, Active, Paused, and Ended
 * (collapsed), each a full ScheduleCard. Opened from the dock, the collapsed
 * rail's clock, and `/?schedules` or `/?schedule=<id>` (scrolled to that
 * card). Escape and Back close it. It re-reads on each schedules event
 * (`refreshKey`) and after its own actions. No model or effort.
 */
export default function SchedulesView({
  focusId,
  active,
  refreshKey,
  onBack,
  onOpen,
  onError,
}: {
  /** The card a deep link asked for. */
  focusId?: string;
  /** Nothing else (a modal, Learn more) is on top: Escape is ours. */
  active: boolean;
  refreshKey: unknown;
  onBack: () => void;
  /** Opens a thread under its bot (closing the view). */
  onOpen: (botId: string, threadId: string) => void;
  onError: (message: string) => void;
}) {
  const [list, setList] = useState<ScheduleView[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [showEnded, setShowEnded] = useState(false);
  const [highlight, setHighlight] = useState<string | null>(null);
  const live = useRef(true);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const focusDone = useRef(false);

  const load = useCallback(() => {
    if (document.visibilityState === "hidden") return Promise.resolve();
    return listSchedules().then(
      (r) => {
        if (live.current) setList(r.schedules);
      },
      (e) => onError(e instanceof Error ? e.message : String(e)),
    );
    // onError is the shell's toast, stable enough; a new one needs no re-read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  useEffect(() => {
    load();
  }, [load, refreshKey]);

  // The heading takes focus on open, so the keyboard starts in the view.
  useEffect(() => {
    const frame = requestAnimationFrame(() => headingRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, []);

  // Escape closes the view. Caught first (window, capture) and stopped, as
  // the mobile drawer does, so nothing behind it (the chat's stop-the-turn,
  // a dock menu) also takes it. A modal or Learn more on top keeps its own.
  useEffect(() => {
    if (!active) return;
    function escape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onBack();
    }
    window.addEventListener("keydown", escape, true);
    return () => window.removeEventListener("keydown", escape, true);
  }, [active, onBack]);

  // A deep link: once the list is in, scroll to its card and draw it out,
  // or say it is gone. Ended ones open their group first.
  useEffect(() => {
    if (!list || !focusId || focusDone.current) return;
    focusDone.current = true;
    const s = list.find((x) => x.id === focusId);
    if (!s) {
      onError(SCHEDULE_GONE);
      return;
    }
    if (s.state === "ended" && !s.attention) setShowEnded(true);
    setHighlight(s.id);
    requestAnimationFrame(() => requestAnimationFrame(() => centreCard(rootRef.current, s.id)));
    // Not cleared by a re-read (this effect runs again on each new list).
    window.setTimeout(() => live.current && setHighlight(null), HIGHLIGHT_MS);
  }, [list, focusId, onError]);

  function act(id: string, action: CardAction) {
    setBusy(id);
    scheduleCall(id, action)
      .catch((e) => onError(e instanceof Error ? e.message : String(e)))
      .then(() => load())
      .finally(() => {
        if (live.current) setBusy(null);
      });
  }

  const groups = list ? viewGroups(list) : null;

  function group(title: string, items: ScheduleView[]) {
    if (items.length === 0) return null;
    return (
      <section className="schedules-group" aria-label={title}>
        <h3 className="bot-section-title">{title}</h3>
        <ul className="schedules-list">
          {items.map((s) => (
            <ScheduleCard
              key={s.id}
              s={s}
              busy={busy === s.id}
              highlight={highlight === s.id}
              onAction={(action) => act(s.id, action)}
              onOpen={onOpen}
            />
          ))}
        </ul>
      </section>
    );
  }

  return (
    <div ref={rootRef} className="profile-pane schedules-pane" aria-label="Schedules">
      <PanelBack onClick={onBack} />
      <div className="profile-pane-inner">
        <header className="schedules-view-head">
          <h2 ref={headingRef} tabIndex={-1}>Schedules</h2>
          {list && list.length > 0 && <span className="schedules-view-count">{panelLabel(list.length)}</span>}
        </header>
        {list === null && <p className="schedules-view-note">Loading…</p>}
        {list?.length === 0 && (
          <div className="schedules-view-empty">
            <p>{DOCK_EMPTY}</p>
            <p className="dock-hint">{DOCK_HINT}</p>
          </div>
        )}
        {groups && (
          <>
            {group("Needs attention", groups.attention)}
            {group("Active", groups.active)}
            {group("Paused", groups.paused)}
            {groups.ended.length > 0 && (
              <section className="schedules-group" aria-label="Ended">
                <button
                  type="button"
                  className="schedule-link schedules-ended-toggle"
                  aria-expanded={showEnded}
                  onClick={() => setShowEnded((v) => !v)}
                >
                  {showEnded ? "Ended" : endedText(groups.ended.length)}
                </button>
                {showEnded && (
                  <ul className="schedules-list">
                    {groups.ended.map((s) => (
                      <ScheduleCard
                        key={s.id}
                        s={s}
                        busy={busy === s.id}
                        highlight={highlight === s.id}
                        onAction={(action) => act(s.id, action)}
                        onOpen={onOpen}
                      />
                    ))}
                  </ul>
                )}
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}
