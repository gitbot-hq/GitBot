"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import {
  INITIAL_STICK,
  afterCommit,
  afterJumpToLatest,
  afterScroll,
  afterViewportChange,
  armNextCommit,
  type ScrollMetrics,
  type StickState,
  type StickStep,
} from "./stick-to-bottom";

/** The export is prerendered, where a layout effect would only warn. */
const useBeforePaint = typeof window === "undefined" ? useEffect : useLayoutEffect;

/** No resetKey can equal this, so the first commit always arms. */
const UNSET = Symbol("unset");

export type StickToBottom = {
  /** Render mirror of the internal flag: the reader is following the tail. */
  stuck: boolean;
  /** Attach to the scroller's `onScroll`. */
  onScroll: () => void;
  /** Go to the tail whatever the reader was doing — for the moments that mean
   *  "show me the latest": opening a thread, sending, tapping the pill. */
  forceBottom: () => void;
};

/**
 * Keeps a scroller pinned to its newest content, but only while the reader is
 * already there. Scroll up mid-turn and the conversation stays where you put
 * it; the caller shows a "jump to latest" affordance off `stuck`.
 *
 * The decisions live in `./stick-to-bottom`, which is pure and tested. This is
 * the wiring: measure the element, apply what comes back, and arrange for the
 * moments the reader cannot see coming to be noticed at all.
 *
 * `resetKey` re-attaches the observers. The caller unmounts and recreates its
 * scroller — a thread-less chat renders a different element — so a hook that
 * only ever attached on mount would bind to nothing on a cold load and to a
 * detached node after a thread switch.
 */
export function useStickToBottom(
  ref: RefObject<HTMLElement | null>,
  resetKey?: string | boolean,
): StickToBottom {
  // A ref, not state: the append paths read it and must not re-render, and
  // during a streaming burst state would read stale.
  const state = useRef<StickState>(INITIAL_STICK);
  const [stuck, setStuck] = useState(INITIAL_STICK.stick);

  const measure = useCallback((el: HTMLElement): ScrollMetrics => ({
    scrollHeight: el.scrollHeight,
    scrollTop: el.scrollTop,
    clientHeight: el.clientHeight,
  }), []);

  const apply = useCallback((el: HTMLElement | null, step: StickStep) => {
    const changed = step.state.stick !== state.current.stick;
    state.current = step.state;
    if (step.pin && el) el.scrollTop = el.scrollHeight;
    if (changed) setStuck(step.state.stick);
  }, []);

  /** Height that appeared with no commit to notice it. */
  const onViewportChange = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    apply(el, afterViewportChange(state.current, measure(el)));
  }, [ref, apply, measure]);

  const onCommit = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    apply(el, afterCommit(state.current, measure(el)));
  }, [ref, apply, measure]);

  // Intentionally not gated on the element: the state must land even when the
  // scroller is absent, so the view that replaces it starts out following.
  const forceBottom = useCallback(() => {
    apply(ref.current, afterJumpToLatest());
  }, [ref, apply]);

  const onScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    apply(el, afterScroll(state.current, measure(el)));
  }, [ref, apply, measure]);

  /**
   * Controls inside the transcript transition on hover — `.act-row` carries
   * seven properties through `--transition-control`, `.file-chip` another —
   * and every one of them bubbles a `transitionend` to the scroller. Letting
   * those through would snap a reader parked in the slack band to the bottom
   * just for mousing over a tool card. Only the card's reveal changes height,
   * and `grid-template-rows` is the one property of it that does.
   */
  const onTransitionEnd = useCallback((e: Event) => {
    if ((e as TransitionEvent).propertyName === "grid-template-rows") onViewportChange();
  }, [onViewportChange]);

  // Arming is folded into the commit effect rather than sitting in one of its
  // own above it: the two must run in that order, and a single effect makes
  // that structural instead of a property of the declaration order here.
  const armedFor = useRef<unknown>(UNSET);
  useBeforePaint(() => {
    if (armedFor.current !== resetKey) {
      armedFor.current = resetKey;
      state.current = armNextCommit(state.current);
    }
    onCommit();
  });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    // Catches the scroller's own box shrinking — a taller composer, the plan
    // panel opening, rotation. It cannot see content grow: `.chat-body` is
    // `flex: 1` in a column, so its border box is set by the layout, not by
    // what is inside it.
    const observer = new ResizeObserver(onViewportChange);
    observer.observe(el);

    // ...so content that gains height without a React commit is caught by the
    // events it fires instead. Observing a child box would not do: the
    // scroller is a flex column whose newest content is its *last* child, and
    // the set of children turns over on every commit.
    //   load          — a markdown image arriving late (capture: `load` does
    //                   not bubble, but it does reach ancestors capturing).
    //   transitionend — a tool card's 280ms grid-template-rows reveal, and
    //                   only that: see `onTransitionEnd`.
    el.addEventListener("load", onViewportChange, { capture: true });
    el.addEventListener("transitionend", onTransitionEnd);

    // The on-screen keyboard shrinks the viewport; iOS Safari does not
    // reliably report that through window resize.
    const viewport = window.visualViewport;
    window.addEventListener("resize", onViewportChange);
    viewport?.addEventListener("resize", onViewportChange);

    // A web font swapping in reflows every line of the transcript at once.
    let alive = true;
    document.fonts?.ready.then(() => { if (alive) onViewportChange(); });

    return () => {
      alive = false;
      observer.disconnect();
      el.removeEventListener("load", onViewportChange, { capture: true });
      el.removeEventListener("transitionend", onTransitionEnd);
      window.removeEventListener("resize", onViewportChange);
      viewport?.removeEventListener("resize", onViewportChange);
    };
  }, [ref, onViewportChange, onTransitionEnd, resetKey]);

  return { stuck, onScroll, forceBottom };
}
