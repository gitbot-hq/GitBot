"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

/** px from the bottom that still counts as "at the bottom". Generous enough to
 *  absorb sub-pixel scrollTop rounding, rubber-band overscroll, and the band of
 *  the scroller the composer overlaps. */
const SLACK = 96;

/** The export is prerendered, where a layout effect would only warn. */
const useBeforePaint = typeof window === "undefined" ? useEffect : useLayoutEffect;

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
 * The design is a single boolean (`stick`) that only ever changes on a real
 * scroll event or an explicit `forceBottom`. It is deliberately *not*
 * recomputed before pinning: by the time new content has been appended it has
 * already pushed the reader out of the slack window, so measuring then would
 * break stickiness on the very first chunk.
 *
 * No flag or timer marks a programmatic scroll, because none is needed: a pin
 * lands at the bottom, so the scroll event it fires measures `here === stick`
 * and changes nothing. Only a human can make the two disagree. (The early
 * return in the handler is therefore a redundant-work filter, not the
 * mechanism — the mechanism is that `pin()` only ever runs while already
 * stuck, so it can never contradict the state it came from.)
 *
 * Content that grows without a React render (the composer getting taller, the
 * window resizing, the mobile keyboard opening) is caught by the observers
 * below; everything React-driven is caught by the layout effect, which re-pins
 * after every commit, before paint.
 */
export function useStickToBottom(ref: RefObject<HTMLElement | null>): StickToBottom {
  // Following the tail? A ref, not state: the append paths read it and must
  // not re-render, and during a streaming burst state would read stale.
  const stick = useRef(true);
  const [stuck, setStuck] = useState(true);

  const pin = useCallback(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [ref]);

  const scrollDown = useCallback(() => {
    if (stick.current) pin();
  }, [pin]);

  const forceBottom = useCallback(() => {
    stick.current = true;
    setStuck(true);
    pin();
  }, [pin]);

  const onScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const here = el.scrollHeight - el.scrollTop - el.clientHeight <= SLACK;
    // Pins agree with the state they came from, so they fall out here.
    if (here === stick.current) return;
    stick.current = here;
    setStuck(here);
  }, [ref]);

  // Every commit is a potential append — text revealed, a tool row, the
  // end-of-turn swap of the live bubble for history. Pinning in a layout
  // effect lands before paint, so there is no frame where the tail is off
  // screen and no race with a requestAnimationFrame.
  useBeforePaint(scrollDown);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    // The scroller shrinking moves the tail off screen without any content
    // changing: a growing composer eats into it, so does rotation.
    const observer = new ResizeObserver(scrollDown);
    observer.observe(el);

    // The on-screen keyboard shrinks the viewport; iOS Safari does not
    // reliably report that through window resize.
    const viewport = window.visualViewport;
    window.addEventListener("resize", scrollDown);
    viewport?.addEventListener("resize", scrollDown);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", scrollDown);
      viewport?.removeEventListener("resize", scrollDown);
    };
  }, [ref, scrollDown]);

  return { stuck, onScroll, forceBottom };
}
