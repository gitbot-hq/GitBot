/**
 * The decisions behind "follow the newest content, but only while the reader
 * is already at the tail". Pure arithmetic over the scroller's geometry, so
 * the behaviour can be tested without a DOM or a renderer; `use-stick-to-bottom`
 * is the React wiring that measures, applies and observes.
 *
 * The design is a single boolean (`stick`) that only ever changes on a real
 * scroll event or an explicit jump to the latest. It is deliberately *not*
 * recomputed before pinning: by the time new content has been appended it has
 * already pushed the reader out of the slack window, so measuring then would
 * break stickiness on the very first chunk.
 *
 * No flag or timer marks a programmatic scroll, because none is needed: a pin
 * is only ever emitted with `stick` already `true`, and it lands at the bottom,
 * so the scroll event it causes measures `atBottom === stick` and changes
 * nothing. Only a human can make the two disagree.
 */

/** px from the bottom that still counts as "at the bottom". Generous enough to
 *  absorb sub-pixel scrollTop rounding, rubber-band overscroll, and the band of
 *  the scroller the composer overlaps. */
export const SLACK = 96;

/** The three numbers every decision here is made from. */
export type ScrollMetrics = {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
};

/** Everything remembered between events. */
export type StickState = {
  /** Following the tail. */
  stick: boolean;
  /** Last scrollHeight acted on, so a commit that changed no height can be
   *  told from one that appended. 0 means "pin on the next commit regardless". */
  lastHeight: number;
};

/** A decision: the state that follows, and whether to pin to the bottom. */
export type StickStep = {
  state: StickState;
  pin: boolean;
};

export const INITIAL_STICK: StickState = { stick: true, lastHeight: 0 };

export function atBottom(m: ScrollMetrics): boolean {
  return m.scrollHeight - m.scrollTop - m.clientHeight <= SLACK;
}

/**
 * A render commit. Pinning on *every* commit would make the slack window
 * unescapable: the typewriter commits every 24ms, so a reader would have to
 * out-scroll SLACK within one frame or be yanked back. Pinning only when the
 * content actually grew restores the cadence this was ported from, where the
 * pin ran once per arriving chunk — revealing six more characters usually
 * changes no height at all, only wrapping onto a new line does.
 */
export function afterCommit(s: StickState, m: ScrollMetrics): StickStep {
  const grew = m.scrollHeight > s.lastHeight;
  return {
    state: { stick: s.stick, lastHeight: m.scrollHeight },
    pin: grew && s.stick,
  };
}

/**
 * The viewport moved under the content, or content gained height with no
 * commit to notice it — a taller composer, the plan panel opening, the mobile
 * keyboard, a late image, a card's reveal transition. Re-pin whatever the
 * height did, since the tail can move off screen with no growth at all.
 */
export function afterViewportChange(s: StickState, m: ScrollMetrics): StickStep {
  return {
    state: { stick: s.stick, lastHeight: m.scrollHeight },
    pin: s.stick,
  };
}

/** A scroll event. Only a human can disagree with where a pin just landed. */
export function afterScroll(s: StickState, m: ScrollMetrics): StickStep {
  return {
    state: { stick: atBottom(m), lastHeight: s.lastHeight },
    pin: false,
  };
}

/**
 * "Show me the latest" — opening a thread, sending, tapping the pill. These
 * run a beat before the content they mean to follow (the send that has not
 * rendered, the history still in flight), so the next commit is armed to pin
 * unconditionally rather than measure against a stale height.
 */
export function afterJumpToLatest(): StickStep {
  return { state: { stick: true, lastHeight: 0 }, pin: true };
}

/**
 * Arm the next commit. Used when the scroller is replaced: a new view starts
 * unmeasured, and the height left over from the last one would otherwise read
 * as a shrink and suppress the first pin.
 */
export function armNextCommit(s: StickState): StickState {
  return { stick: s.stick, lastHeight: 0 };
}
