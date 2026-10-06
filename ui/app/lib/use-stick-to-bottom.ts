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
 * No flag or timer marks a programmatic scroll, because none is needed: `pin()`
 * only ever runs with `stick` already `true`, and it lands at the bottom, so
 * the scroll event it fires measures `here === stick` and changes nothing. Only
 * a human can make the two disagree. (The early return in the handler is
 * therefore a redundant-work filter, not the mechanism.)
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
  // Following the tail? A ref, not state: the append paths read it and must
  // not re-render, and during a streaming burst state would read stale.
  const stick = useRef(true);
  const [stuck, setStuck] = useState(true);
  // Last scrollHeight we acted on, so a commit that changed no height can be
  // told from one that appended. 0 means "pin on the next commit regardless".
  const lastHeight = useRef(0);

  const pin = useCallback(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [ref]);

  /** The viewport moved under the content: re-pin whatever the height did. */
  const scrollDown = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    lastHeight.current = el.scrollHeight;
    if (stick.current) pin();
  }, [ref, pin]);

  /**
   * The commit path. Pinning on *every* commit would make the slack window
   * unescapable: the typewriter commits every 24ms, so a reader would have to
   * out-scroll SLACK within one frame or be yanked back. Pinning only when the
   * content actually grew restores the cadence this was ported from, where the
   * pin ran once per arriving chunk — revealing six more characters usually
   * changes no height at all, only wrapping onto a new line does.
   */
  const followGrowth = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const height = el.scrollHeight;
    const grew = height > lastHeight.current;
    lastHeight.current = height;
    if (grew && stick.current) pin();
  }, [ref, pin]);

  const forceBottom = useCallback(() => {
    stick.current = true;
    setStuck(true);
    pin();
    // These moments run a beat before the content they mean to follow — the
    // send that has not rendered, the history still in flight. Arm the next
    // commit to pin unconditionally rather than measure against a stale height.
    lastHeight.current = 0;
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

  // Declared first so it lands before `followGrowth` on the commit that swaps
  // the scroller: a new view starts unmeasured, and the height left over from
  // the last one would otherwise read as a shrink and suppress the first pin.
  useBeforePaint(() => { lastHeight.current = 0; }, [resetKey]);

  useBeforePaint(followGrowth);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    // Catches the scroller's own box shrinking — a taller composer, the plan
    // panel opening, rotation. It cannot see content grow: `.chat-body` is
    // `flex: 1` in a column, so its border box is set by the layout, not by
    // what is inside it.
    const observer = new ResizeObserver(scrollDown);
    observer.observe(el);

    // ...so content that gains height without a React commit is caught by the
    // events it fires instead. Observing a child box would not do: the
    // scroller is a flex column whose newest content is its *last* child, and
    // the set of children turns over on every commit.
    //   load         — a markdown image arriving late (capture: `load` does
    //                  not bubble, but it does reach ancestors capturing).
    //   transitionend — a tool card's 280ms grid-template-rows reveal.
    el.addEventListener("load", scrollDown, { capture: true });
    el.addEventListener("transitionend", scrollDown);

    // The on-screen keyboard shrinks the viewport; iOS Safari does not
    // reliably report that through window resize.
    const viewport = window.visualViewport;
    window.addEventListener("resize", scrollDown);
    viewport?.addEventListener("resize", scrollDown);

    // A web font swapping in reflows every line of the transcript at once.
    let alive = true;
    document.fonts?.ready.then(() => { if (alive) scrollDown(); });

    return () => {
      alive = false;
      observer.disconnect();
      el.removeEventListener("load", scrollDown, { capture: true });
      el.removeEventListener("transitionend", scrollDown);
      window.removeEventListener("resize", scrollDown);
      viewport?.removeEventListener("resize", scrollDown);
    };
  }, [ref, scrollDown, resetKey]);

  return { stuck, onScroll, forceBottom };
}
