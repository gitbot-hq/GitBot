import { test } from "node:test";
import assert from "node:assert/strict";
import {
  INITIAL_STICK,
  SLACK,
  afterCommit,
  afterJumpToLatest,
  afterScroll,
  afterViewportChange,
  armNextCommit,
  type ScrollMetrics,
  type StickStep,
} from "../ui/app/lib/stick-to-bottom";

// The chat follows the newest content only while the reader is already at the
// tail. The decisions are pure arithmetic over the scroller's geometry, so the
// browser's half of the loop is modelled here: it holds the three numbers and
// clamps a scrollTop past the end, which is all a pin depends on.
//
// Not covered here, because it is wiring rather than decision: that the hook
// attaches its ResizeObserver and its load/transitionend/resize listeners at
// all, and that the arming effect is ordered before the commit effect.

function reader(clientHeight = 500, scrollHeight = 500) {
  let state = INITIAL_STICK;
  const m: ScrollMetrics = { scrollHeight, scrollTop: 0, clientHeight };
  const clamp = (v: number) => Math.max(0, Math.min(v, m.scrollHeight - m.clientHeight));

  function apply(step: StickStep) {
    state = step.state;
    if (step.pin) m.scrollTop = clamp(m.scrollHeight);
  }

  return {
    get stuck() { return state.stick; },
    get scrollTop() { return m.scrollTop; },
    get fromBottom() { return m.scrollHeight - m.scrollTop - m.clientHeight; },

    /** A React commit, having appended `grow` px. 0 = a commit that revealed
     *  characters without wrapping a line, which is most of them. */
    commit(grow = 0) { m.scrollHeight += grow; apply(afterCommit(state, m)); },
    /** Height that appears with no commit: a late image, a card's reveal. */
    growSilently(px: number) { m.scrollHeight += px; },
    /** A delegated load/transitionend, or the ResizeObserver firing. */
    noticeViewport() { apply(afterViewportChange(state, m)); },
    /** The scroller's box shrinking — composer or plan panel growing. */
    shrinkViewport(px: number) { m.clientHeight -= px; apply(afterViewportChange(state, m)); },
    growViewport(px: number) { m.clientHeight += px; apply(afterViewportChange(state, m)); },

    /** A human scroll, and the event it fires. */
    userScrollBy(px: number) { m.scrollTop = clamp(m.scrollTop + px); apply(afterScroll(state, m)); },
    userScrollTo(v: number) { m.scrollTop = clamp(v); apply(afterScroll(state, m)); },
    /** The scroll event a programmatic pin causes, with nobody touching it. */
    scrollEvent() { apply(afterScroll(state, m)); },

    jumpToLatest() { apply(afterJumpToLatest()); },
    /** The scroller is replaced: a thread switch, or the thread-less chat. */
    swapScroller(height: number) {
      state = armNextCommit(state);
      m.scrollHeight = height;
      m.scrollTop = 0;
    },
  };
}

/** Stream a reply in, a commit at a time. */
function stream(r: ReturnType<typeof reader>, chunks = 40) {
  for (let n = 0; n < chunks; n++) r.commit(50);
}

test("streaming content keeps the tail pinned", () => {
  const r = reader();
  stream(r);
  assert.equal(r.fromBottom, 0);
});

test("scrolling up stops the follow and holds position", () => {
  const r = reader();
  stream(r, 20);
  assert.equal(r.stuck, true);

  r.userScrollBy(-200);
  assert.equal(r.stuck, false, "the pill should be offered");

  const held = r.scrollTop;
  stream(r, 20);
  assert.equal(r.scrollTop, held, "position must not be yanked");
});

test("a programmatic pin never un-sticks the reader", () => {
  const r = reader();
  for (let n = 0; n < 10; n++) {
    r.commit(50);
    r.scrollEvent();
  }
  assert.equal(r.stuck, true, "a pin must not read as a user scroll");
  assert.equal(r.fromBottom, 0);
});

test("a nudge inside the slack window still counts as the tail", () => {
  const r = reader();
  stream(r, 20);
  r.userScrollBy(-(SLACK - 56));
  assert.equal(r.stuck, true, "a small nudge should keep following");
  r.commit(50);
  assert.equal(r.fromBottom, 0, "and should re-pin");
});

test("jump to latest returns from anywhere and resumes following", () => {
  const r = reader();
  stream(r, 20);
  r.userScrollTo(0);
  assert.equal(r.stuck, false);

  r.jumpToLatest();
  assert.equal(r.fromBottom, 0, "should land on the tail");
  assert.equal(r.stuck, true, "pill should disappear");

  r.commit(500);
  assert.equal(r.fromBottom, 0, "and keep following after");
});

test("the scroller shrinking (composer grows / keyboard) re-pins", () => {
  const r = reader();
  stream(r, 20);
  r.shrinkViewport(100);
  assert.equal(r.fromBottom, 0, "the tail must stay visible");
});

test("the scroller shrinking does NOT drag a scrolled-up reader down", () => {
  const r = reader();
  stream(r, 20);
  r.userScrollTo(100);
  const held = r.scrollTop;
  r.shrinkViewport(100);
  assert.equal(r.scrollTop, held, "position must be respected");
});

test("the end-of-turn swap to history keeps the tail", () => {
  const r = reader();
  stream(r, 20);
  // The live bubble becomes history plus a RunSummary and an actions row.
  r.commit(220);
  assert.equal(r.fromBottom, 0, "the swap must not strand the reader");
});

test("a new thread's shorter transcript still pins", () => {
  const r = reader();
  stream(r, 40);
  // Switching to a short thread: the height left over from the long one must
  // not read as a shrink and suppress the first pin.
  r.swapScroller(900);
  r.commit();
  assert.equal(r.fromBottom, 0, "stale height must not block the pin");
});

test("a slow scroll escapes the tail while the typewriter commits", () => {
  const r = reader();
  stream(r, 40);

  // 24ms commits that reveal characters without wrapping a line, against a
  // reader easing away 20px at a time.
  let moved = 0;
  for (let n = 0; n < 12; n++) {
    r.userScrollBy(-20);
    moved += 20;
    r.commit();
  }
  assert.ok(moved > SLACK, "the reader moved further than the slack window");
  assert.equal(r.stuck, false, "so they must have escaped");
  assert.ok(r.fromBottom > SLACK, "and must not have been yanked back");
});

test("but content arriving still re-pins a reader inside the slack", () => {
  const r = reader();
  stream(r, 40);
  r.userScrollBy(-30);
  r.commit();
  r.commit(50); // a line wraps in
  assert.equal(r.fromBottom, 0, "still following");
});

test("a late markdown image re-pins", () => {
  const r = reader();
  stream(r, 10);
  r.growSilently(300);
  assert.ok(r.fromBottom > 0, "the tail drifted off");
  r.noticeViewport();
  assert.equal(r.fromBottom, 0, "the load event must bring it back");
});

test("a tool card's reveal transition re-pins", () => {
  const r = reader();
  stream(r, 10);
  r.growSilently(400);
  r.noticeViewport();
  assert.equal(r.fromBottom, 0);
});

test("neither drags a reader who has scrolled away", () => {
  const r = reader();
  stream(r, 20);
  r.userScrollTo(100);
  const held = r.scrollTop;
  r.growSilently(300);
  r.noticeViewport();
  assert.equal(r.scrollTop, held, "position must be respected");
});

test("expanding the plan panel does not strand a reader at the tail", () => {
  const r = reader();
  stream(r, 20);
  // .plan-list opens inside .composer, a flex sibling, so .chat-body (flex: 1)
  // loses exactly that height.
  r.shrinkViewport(240);
  assert.equal(r.fromBottom, 0, "the tail must stay visible");
});

test("collapsing the plan panel again keeps following", () => {
  const r = reader();
  stream(r, 20);
  r.shrinkViewport(240);
  r.growViewport(240);
  assert.equal(r.fromBottom, 0);
  r.commit(50);
  assert.equal(r.fromBottom, 0, "and still follows new content");
});
