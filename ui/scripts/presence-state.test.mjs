import assert from "node:assert/strict";
import test from "node:test";
import { presenceState } from "../app/lib/presence-state.ts";

const at = (over) => presenceState({ visible: true, focused: true, idle: false, threadId: "X", ...over });

test("presenceState: on screen and focused on a thread is watching it", () => {
  assert.deepEqual(at({}), { state: "watching", thread: "X" });
});

test("presenceState: beside a focused window (side by side) is glancing at it", () => {
  assert.deepEqual(at({ focused: false }), { state: "glancing", thread: "X" });
});

test("presenceState: focused with no thread on screen (or a covered one) is present", () => {
  assert.deepEqual(at({ threadId: null }), { state: "present", thread: null });
});

test("presenceState: hidden, idle, or unfocused on no thread is away", () => {
  assert.deepEqual(at({ visible: false }), { state: "away", thread: null });
  assert.deepEqual(at({ idle: true }), { state: "away", thread: null });
  assert.deepEqual(at({ idle: true, focused: false }), { state: "away", thread: null });
  assert.deepEqual(at({ focused: false, threadId: null }), { state: "away", thread: null });
});
