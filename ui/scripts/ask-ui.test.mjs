import assert from "node:assert/strict";
import test from "node:test";
import { askDetail, askStatus, askSummary, flattenAnswers, shorten } from "../app/lib/ask-ui.ts";

const LAYOUT = "Which layout should we use?";
const SCOPE = "What should the thread do before I push the branch to origin?";
const one = { questions: [{ header: "Layout", question: LAYOUT }] };
const two = { questions: [{ header: "Layout", question: LAYOUT }, { header: "Scope", question: SCOPE }] };

test("shorten keeps short text, cuts long text on a word with an ellipsis", () => {
  assert.equal(shorten("Option A", 40), "Option A");
  assert.equal(shorten("  spaced   out  ", 40), "spaced out");
  const cut = shorten("The plan-panel work has 3 blocking issues from the review and now a merge conflict", 40);
  assert.ok(cut.length <= 40, cut);
  assert.ok(cut.endsWith("…"), cut);
  assert.ok(!cut.includes(" …"), cut);
  // One long word: cut mid-word rather than not at all.
  assert.equal(shorten("x".repeat(50), 10), `${"x".repeat(9)}…`);
});

test("collapsed: the question, then the answer", () => {
  assert.equal(
    askSummary({ ...one, answers: { [LAYOUT]: "Option A (Recommended)" }, state: "answered" }, false),
    `${LAYOUT} → Option A (Recommended)`,
  );
});

test("collapsed: several questions show the first plus how many more", () => {
  const s = askSummary({ ...two, answers: { [LAYOUT]: "A", [SCOPE]: "Fix all" }, state: "answered" }, false);
  assert.equal(s, `${LAYOUT} → A (+1 more)`);
});

test("collapsed: long question and answer are each shortened", () => {
  const q = "When a to-do or task panel and the subagent panel are both active, how should they appear?";
  const a = "Stack separately, each its own collapsible panel above the box (Recommended)";
  const s = askSummary({ questions: [{ header: "L", question: q }], answers: { [q]: a }, state: "answered" }, false);
  const [left, right] = s.split(" → ");
  assert.ok(left.length <= 60 && left.endsWith("…"), left);
  assert.ok(right.length <= 40 && right.endsWith("…"), right);
});

test("states: waiting while its card is up, otherwise no answer", () => {
  assert.equal(askSummary(one, true), `${LAYOUT} → waiting for your answer`);
  assert.equal(askSummary(one, false), `${LAYOUT} → no answer`);
  assert.equal(askSummary({ ...one, state: "none" }, true), `${LAYOUT} → no answer`);
  assert.equal(askStatus({ ...one, state: "answered", answers: {} }, false), "none");
  assert.equal(askStatus({ ...one, state: "answered", answers: { [LAYOUT]: "A" } }, true), "answered");
});

test("expanded: every question in full with its full answer", () => {
  const long = "Stack separately, each its own collapsible panel above the message box, stacked";
  assert.deepEqual(askDetail({ ...two, answers: { [LAYOUT]: long }, state: "answered" }, false), [
    { question: LAYOUT, answer: long, answered: true },
    { question: SCOPE, answer: "no answer", answered: false },
  ]);
  assert.deepEqual(askDetail(one, true), [{ question: LAYOUT, answer: "waiting for your answer", answered: false }]);
});

test("the client's answers flatten to the server's format (multi-select comma-joined)", () => {
  assert.deepEqual(flattenAnswers({ [LAYOUT]: ["A", " typed words "], [SCOPE]: ["  "] }), { [LAYOUT]: "A, typed words" });
});
