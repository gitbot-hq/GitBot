import { test, after, afterEach, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "crypto";
import { EventEmitter } from "events";
import { mkdtempSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { basename, join } from "path";
import { createThread, deleteThread, getThread, JARVIS_BOT_ID, jarvisDir, updateThread } from "../src/bot-store";
import { watchDeferredTurns } from "../src/deferred-turns";
import { startChildThread } from "../src/jarvis";
import { addProject } from "../src/project-index";
import { capReport, deliverQueuedReports, formatReport, lastAssistantMessage, REPORT_CAP, watchChildReports } from "../src/reports";
import {
  emitEvent,
  notifyPermissionsChanged,
  onTurnEnd,
  permissionsEmitter,
  sessions,
  type IRequest,
  type IResponse,
  type SessionStore,
  type StoredEvent,
  type SessionSummaryItem,
} from "../src/server-common";
import { handleRequest } from "../src/server";
import { formatMessage } from "../src/start-claude-code";
import { agentRunners, startTurn } from "../src/turns";
import { parseReport } from "../ui/app/lib/report";
import { hasNews } from "../ui/app/lib/attention";

const ALL_AGENTS = ["claude-code", "opencode", "codex"];

// --- A stub at the agent seam: turns start and stay running until a test ends them ---

const realRunners = { ...agentRunners };
let runs: SessionStore[] = [];
let unwatch: Array<() => void> = [];
/** What a test sees between the report watcher and the deferred drain, in start()'s order. */
let probe: (store: SessionStore) => void = () => {};
/** Called as each turn starts, before it runs. */
let onRun: (store: SessionStore) => void = () => {};
before(() => {
  for (const agent of Object.keys(agentRunners) as SessionStore["agent"][]) {
    agentRunners[agent] = async (store) => { onRun(store); runs.push(store); };
  }
  // As start() wires them: reports first, the deferred drain last.
  unwatch = [watchChildReports(ALL_AGENTS), onTurnEnd((store) => probe(store)), watchDeferredTurns(ALL_AGENTS)];
});
afterEach(() => {
  for (const s of runs) sessions.delete(s.gitbotId);
  runs = [];
  probe = () => {};
  onRun = () => {};
});
after(() => {
  for (const u of unwatch) u();
  Object.assign(agentRunners, realRunners);
});

const ev = (type: string, extra: Record<string, unknown> = {}): StoredEvent => ({ seq: 0, type, ...extra });
const turnEnd = () => new Promise((r) => setImmediate(r));

/**
 * A Jarvis thread with a running child, as start_thread leaves them. With
 * jarvisRunning, Jarvis's own turn (the one that called start_thread) is
 * still running too.
 */
function jarvisWithChild({ jarvisRunning = false } = {}) {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "gitbot-proj-")));
  const added = addProject(folder);
  assert.ok(added.ok);
  const jarvis = createThread(JARVIS_BOT_ID, jarvisDir(), undefined, "chat", "claude-code");
  updateThread(jarvis.id, { title: "Make two files", titleIsAuto: false, preview: "make two files" });
  if (jarvisRunning) {
    // Bound to its agent session, as a Jarvis thread is after its first turn:
    // its next turn reuses the same store.
    updateThread(jarvis.id, { sdkSessionId: randomUUID() });
    assert.ok(startTurn({ threadId: jarvis.id, prompt: "make two files" }, ALL_AGENTS).ok);
  }
  const started = startChildThread(jarvis.id, { agent: "claude-code", project: added.project.id, message: "create a.txt" }, ALL_AGENTS);
  assert.ok(started.ok, JSON.stringify(started));
  const child = runs[runs.length - 1];
  return { jarvis: getThread(jarvis.id)!, childThread: getThread(started.threadId)!, child, folder };
}

/** Ends a run the way every harness does: status off running, then notify. */
async function end(store: SessionStore, status: "done" | "error", events: Array<[string, Record<string, unknown>]> = []) {
  for (const [type, data] of events) emitEvent(store, type, data);
  store.status = status;
  notifyPermissionsChanged();
  await turnEnd();
}

const jarvisRuns = (jarvisId: string) => runs.filter((s) => s.threadId === jarvisId);

// --- Extraction, cap, format ---

test("the report is the last top-level assistant message; sub-agent output is ignored", () => {
  const events = [
    ev("user_prompt", { prompt: "do it" }),
    ev("assistant", { content: "Looking." }),
    ev("tool_use", { tool_name: "Task" }),
    ev("assistant", { content: "Created a.txt with 'one'." }),
    ev("assistant", { content: "sub-agent chatter", parent_tool_use_id: "toolu_1" }),
    ev("result", {}),
  ];
  assert.equal(lastAssistantMessage(events), "Created a.txt with 'one'.");
  assert.equal(lastAssistantMessage([ev("assistant", { content: "inner", parent_tool_use_id: "t" })]), "");
});

test("a long report is capped at about 4,000 characters with a truncation note", () => {
  assert.equal(capReport("short"), "short");
  const long = "x".repeat(REPORT_CAP + 500);
  const capped = capReport(long);
  assert.ok(capped.startsWith("x".repeat(REPORT_CAP)));
  assert.ok(capped.length < REPORT_CAP + 200);
  assert.match(capped, /\[report truncated: 500 more characters; the rest is in the child's thread\]$/);
});

test("the report format: a header line, then the message", () => {
  assert.equal(
    formatReport("Claude Code", "trophy", "t-123", "done", "All set."),
    "[Claude Code · trophy · thread t-123 · done]\nAll set.",
  );
  assert.equal(formatReport("Codex", "trophy", "t-1", "error", ""), "[Codex · trophy · thread t-1 · error]\n(no message)");
});

test("parseReport reads the header the server writes, and nothing else", () => {
  const text = formatReport("PR Validator", "my · app", "0b6a-42", "error", "It broke.\n\nDetails.");
  assert.deepEqual(parseReport(text), {
    bot: "PR Validator", project: "my · app", threadId: "0b6a-42", status: "error", message: "It broke.\n\nDetails.",
  });
  assert.equal(parseReport("make a.txt"), null);
  assert.equal(parseReport("see [Claude Code · x · thread 1 · done]"), null);
  assert.equal(parseReport("[Claude Code · x · thread 1 · finished]\nhi"), null);
});

// --- Waking Jarvis ---

test("a child's turn end starts exactly one Jarvis turn with the report", async () => {
  const { jarvis, childThread, child, folder } = jarvisWithChild();
  await end(child, "done", [
    ["assistant", { content: "Created a.txt with 'one'." }],
    ["assistant", { content: "sub-agent says hi", parent_tool_use_id: "toolu_9" }],
  ]);
  const woke = jarvisRuns(jarvis.id);
  assert.equal(woke.length, 1);
  const prompt = woke[0].events.find((e) => e.type === "user_prompt")?.prompt;
  assert.equal(prompt, `[Claude Code · ${basename(folder)} · thread ${childThread.id} · done]\nCreated a.txt with 'one'.`);
  // Later notifies of the ended turn wake no one again.
  notifyPermissionsChanged();
  await turnEnd();
  assert.equal(jarvisRuns(jarvis.id).length, 1);
});

test("an errored child wakes Jarvis too, with its error when it said nothing", async () => {
  const { jarvis, childThread, child } = jarvisWithChild();
  await end(child, "error", [["error", { message: "Claude process exited unexpectedly" }]]);
  const woke = jarvisRuns(jarvis.id);
  assert.equal(woke.length, 1);
  assert.match(String(woke[0].events[0].prompt), new RegExp(`· thread ${childThread.id} · error\\]\\nClaude process exited unexpectedly$`));
});

test("a report turn leaves the Jarvis thread's preview and title alone", async () => {
  const { jarvis, child } = jarvisWithChild();
  await end(child, "done", [["assistant", { content: "Done: created a.txt" }]]);
  assert.equal(jarvisRuns(jarvis.id).length, 1);
  const after = getThread(jarvis.id)!;
  assert.equal(after.preview, "make two files");
  assert.equal(after.title, "Make two files");
});

test("a thread without reportTo wakes nothing", async () => {
  const { jarvis } = jarvisWithChild();
  // A thread the user started, ending through the same path.
  const plain = createThread("builtin-claude-code", jarvisDir(), undefined, "chat", "claude-code");
  const turn = startTurn({ threadId: plain.id, prompt: "hi there" }, ALL_AGENTS);
  assert.ok(turn.ok);
  const before = runs.length;
  await end(sessions.get(turn.sessionId)!, "done", [["assistant", { content: "hello" }]]);
  assert.equal(runs.length, before);
  assert.equal(jarvisRuns(jarvis.id).length, 0);
});

test("a stopped child does not wake Jarvis", async () => {
  const { jarvis, child } = jarvisWithChild();
  // codex and opencode stop on "done", claude-code on "error": neither wakes.
  await end(child, "done", [["assistant", { content: "halfway" }], ["aborted", { message: "Request aborted by user" }]]);
  assert.equal(jarvisRuns(jarvis.id).length, 0);
});

test("a report that finds Jarvis mid-turn is queued, then delivered once after Jarvis's turn ends and after the broadcast", async (t) => {
  // Jarvis's own turn, the one that started the child, is still running.
  const { jarvis, childThread, child, folder } = jarvisWithChild({ jarvisRunning: true });
  const jarvisTurn = jarvisRuns(jarvis.id)[0];
  const logs: string[] = [];
  t.mock.method(console, "log", (...args: unknown[]) => { logs.push(args.join(" ")); });
  const warnings = t.mock.method(console, "warn", () => {});

  await end(child, "done", [["assistant", { content: "Created a.txt" }]]);
  assert.equal(jarvisRuns(jarvis.id).length, 1, "only Jarvis's own turn: the report waits");
  assert.equal(warnings.mock.callCount(), 0, "nothing is dropped");
  assert.ok(logs.includes(`[report] queued: thread ${childThread.id} → Jarvis thread ${jarvis.id} (Jarvis is mid-turn)`), logs.join("\n"));
  const queued = getThread(jarvis.id)!.queuedReports;
  assert.equal(queued?.length, 1);
  assert.equal(queued![0].childThreadId, childThread.id);
  const prompt = `[Claude Code · ${basename(folder)} · thread ${childThread.id} · done]\nCreated a.txt`;
  assert.equal(queued![0].prompt, prompt);

  // Jarvis's turn ends. Record the order: the turn-end listeners, the
  // sessions broadcast for that end, and the report turn's start.
  const order: string[] = [];
  probe = (store) => { if (store === jarvisTurn) order.push(`listener (Jarvis turn ${jarvisTurn.turn})`); };
  const onUpdate = (_p: unknown, dump: SessionSummaryItem[]) => {
    const mine = dump.find((d) => d.threadId === jarvis.id);
    order.push(`broadcast (Jarvis ${mine?.status})`);
  };
  permissionsEmitter.on("update", onUpdate);
  t.after(() => { permissionsEmitter.off("update", onUpdate); });
  onRun = (store) => { if (store.threadId === jarvis.id) order.push("report turn runs"); };

  jarvisTurn.status = "done";
  notifyPermissionsChanged();
  await turnEnd();
  assert.equal(jarvisRuns(jarvis.id).length, 1, "not inside the listener pass");
  await turnEnd();
  const woke = jarvisRuns(jarvis.id);
  assert.equal(woke.length, 2, "the report turn started");
  assert.equal(woke[1], jarvisTurn, "on the session that just ended");
  assert.equal(woke[1].turn, 2);
  assert.equal(woke[1].events.find((e) => e.type === "user_prompt")?.prompt, prompt);
  // The report turn's own start is broadcast before it runs, as any turn's is.
  assert.deepEqual(order, ["listener (Jarvis turn 1)", "broadcast (Jarvis done)", "broadcast (Jarvis running)", "report turn runs"]);
  assert.equal(getThread(jarvis.id)!.queuedReports, undefined, "cleared");
  assert.ok(logs.some((l) => l.startsWith(`[report] thread ${childThread.id} reported to Jarvis thread ${jarvis.id}`)));

  // Delivered once: the report turn's own end starts nothing more.
  await end(woke[1], "done", [["assistant", { content: "Noted." }]]);
  await turnEnd();
  assert.equal(jarvisRuns(jarvis.id).length, 2);
  assert.equal(warnings.mock.callCount(), 0);
});

test("a queued report waits for the user's turn if the user got in first", async (t) => {
  t.mock.method(console, "log", () => {});
  const { jarvis, child } = jarvisWithChild({ jarvisRunning: true });
  await end(child, "done", [["assistant", { content: "done" }]]);
  const jarvisTurn = jarvisRuns(jarvis.id)[0];
  // Jarvis ends, and the user's message starts before the drain runs.
  jarvisTurn.status = "done";
  notifyPermissionsChanged();
  const typed = startTurn({ threadId: jarvis.id, prompt: "and one more thing" }, ALL_AGENTS);
  assert.ok(typed.ok, JSON.stringify(typed));
  await turnEnd();
  await turnEnd();
  assert.equal(jarvisRuns(jarvis.id).length, 2, "Jarvis's turn and the user's: no report turn yet");
  assert.equal(getThread(jarvis.id)!.queuedReports?.length, 1, "still queued");
  // The user's turn ends: now the report starts, once.
  await end(jarvisTurn, "done");
  await turnEnd();
  const woke = jarvisRuns(jarvis.id);
  assert.equal(woke.length, 3);
  assert.match(String(woke[2].events.find((e) => e.type === "user_prompt")?.prompt), /^\[Claude Code · /);
  assert.equal(getThread(jarvis.id)!.queuedReports, undefined);
});

test("two reports queued behind one Jarvis turn are delivered one per turn end, oldest first", async (t) => {
  t.mock.method(console, "log", () => {});
  const { jarvis, childThread, child } = jarvisWithChild({ jarvisRunning: true });
  await end(child, "done", [["assistant", { content: "first" }]]);
  // Still in the same Jarvis turn, it hands the child more work, which also finishes.
  const second = startTurn({ threadId: childThread.id, prompt: "more", reportable: true }, ALL_AGENTS);
  assert.ok(second.ok, JSON.stringify(second));
  await end(sessions.get(second.sessionId)!, "done", [["assistant", { content: "second" }]]);
  assert.equal(getThread(jarvis.id)!.queuedReports?.length, 2);

  const jarvisTurn = jarvisRuns(jarvis.id)[0];
  await end(jarvisTurn, "done");
  await turnEnd();
  assert.equal(jarvisRuns(jarvis.id).length, 2);
  assert.match(String(jarvisTurn.events[0].prompt), /\nfirst$/);
  assert.equal(getThread(jarvis.id)!.queuedReports?.length, 1);
  await end(jarvisTurn, "done");
  await turnEnd();
  assert.equal(jarvisRuns(jarvis.id).length, 3);
  assert.match(String(jarvisTurn.events[0].prompt), /\nsecond$/);
  assert.equal(getThread(jarvis.id)!.queuedReports, undefined);
});

test("a report never jumps ahead of an older queued one, even when Jarvis's end and the child's come in one batch", async (t) => {
  t.mock.method(console, "log", () => {});
  const { jarvis, childThread, child } = jarvisWithChild({ jarvisRunning: true });
  await end(child, "done", [["assistant", { content: "first" }]]);
  assert.equal(getThread(jarvis.id)!.queuedReports?.length, 1);
  // Jarvis hands the child more work, then Jarvis's turn and the child's end together.
  const second = startTurn({ threadId: childThread.id, prompt: "more", reportable: true }, ALL_AGENTS);
  assert.ok(second.ok, JSON.stringify(second));
  const childAgain = sessions.get(second.sessionId)!;
  const jarvisTurn = jarvisRuns(jarvis.id)[0];
  emitEvent(childAgain, "assistant", { content: "second" });
  jarvisTurn.status = "done";
  childAgain.status = "done";
  notifyPermissionsChanged();
  await turnEnd();
  await turnEnd();
  // Jarvis was free when the second report came, yet it went behind the first.
  assert.equal(jarvisRuns(jarvis.id).length, 2, "one report turn at a time");
  assert.match(String(jarvisTurn.events[0].prompt), /\nfirst$/);
  assert.equal(getThread(jarvis.id)!.queuedReports?.length, 1);
  await end(jarvisTurn, "done");
  await turnEnd();
  assert.match(String(jarvisTurn.events[0].prompt), /\nsecond$/);
  assert.equal(getThread(jarvis.id)!.queuedReports, undefined);
});

test("a report queued behind older ones on an idle Jarvis is never stuck: the drain starts the oldest", async (t) => {
  t.mock.method(console, "log", () => {});
  const { jarvis, childThread, child } = jarvisWithChild();
  // An older report left queued on an idle Jarvis, with no drain due (say, one a start kept).
  updateThread(jarvis.id, { queuedReports: [{ childThreadId: childThread.id, prompt: "[Claude Code · x · thread old · done]\nolder", at: new Date(0).toISOString() }] });
  await end(child, "done", [["assistant", { content: "newer" }]]);
  await turnEnd();
  const woke = jarvisRuns(jarvis.id);
  assert.equal(woke.length, 1, "the oldest started");
  assert.match(String(woke[0].events[0].prompt), /\nolder$/);
  assert.equal(getThread(jarvis.id)!.queuedReports?.length, 1, "the newer one waits behind it");
  await end(woke[0], "done");
  await turnEnd();
  const next = jarvisRuns(jarvis.id);
  assert.equal(next.length, 2);
  assert.match(String(next[1].events[0].prompt), /\nnewer$/);
  assert.equal(getThread(jarvis.id)!.queuedReports, undefined);
});

test("a queued report whose Jarvis can't run now (Claude Code missing at startup) is kept for a later start", async (t) => {
  t.mock.method(console, "log", () => {});
  const warnings: string[] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => { warnings.push(args.join(" ")); });
  const { jarvis, child } = jarvisWithChild({ jarvisRunning: true });
  await end(child, "done", [["assistant", { content: "hi" }]]);
  for (const s of runs) sessions.delete(s.gitbotId);
  runs = [];
  // The restart found no Claude Code CLI.
  assert.equal(deliverQueuedReports(["codex"]), 0);
  assert.equal(getThread(jarvis.id)!.queuedReports?.length, 1, "kept");
  assert.ok(warnings.some((w) => w.startsWith("[report] kept:")), warnings.join("\n"));
  // The next start has it.
  assert.equal(deliverQueuedReports(ALL_AGENTS), 1);
  assert.equal(getThread(jarvis.id)!.queuedReports, undefined);
});

test("a queued report dropped at delivery gives the child its unread dot back; a malformed entry never blocks the rest", async (t) => {
  t.mock.method(console, "log", () => {});
  const warnings: string[] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => { warnings.push(args.join(" ")); });
  const { jarvis, childThread, child } = jarvisWithChild({ jarvisRunning: true });
  await end(child, "done", [["assistant", { content: "hi" }]]);
  assert.equal(hasNews(getThread(childThread.id)!), false, "seen while queued");
  // A hand-edited threads.json: junk ahead of the real entry, and the real one emptied.
  const real = getThread(jarvis.id)!.queuedReports![0];
  updateThread(jarvis.id, { queuedReports: [null as any, { ...real, childThreadId: "gone", prompt: "" }, { childThreadId: 7 } as any, real] });
  for (const s of runs) sessions.delete(s.gitbotId);
  runs = [];
  assert.doesNotThrow(() => assert.equal(deliverQueuedReports(ALL_AGENTS), 1));
  assert.equal(runs.length, 1, "the good one started");
  assert.equal(getThread(jarvis.id)!.queuedReports, undefined, "the junk is gone");
  assert.equal(warnings.filter((w) => w.startsWith("[report] dropped:")).length, 3);
  // Two of them were dropped as malformed (no child to tell); the real one started, so the child stays seen.
  assert.equal(hasNews(getThread(childThread.id)!), false);
});

test("a queued report that can't be delivered is dropped, and its child is news again", async (t) => {
  t.mock.method(console, "log", () => {});
  const warnings: string[] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => { warnings.push(args.join(" ")); });
  const { jarvis, childThread, child } = jarvisWithChild({ jarvisRunning: true });
  await end(child, "done", [["assistant", { content: "hi" }]]);
  assert.equal(hasNews(getThread(childThread.id)!), false, "seen while queued");
  // Its prompt lost (a hand-edited threads.json): Jarvis can never be told.
  updateThread(jarvis.id, { queuedReports: [{ ...getThread(jarvis.id)!.queuedReports![0], prompt: "" }] });
  for (const s of runs) sessions.delete(s.gitbotId);
  runs = [];
  assert.equal(deliverQueuedReports(ALL_AGENTS), 0);
  assert.equal(getThread(jarvis.id)!.queuedReports, undefined);
  assert.ok(warnings.some((w) => w.startsWith("[report] dropped:")), warnings.join("\n"));
  assert.equal(hasNews(getThread(childThread.id)!), true, "its dot is back");
});

test("a queued report survives a restart and is delivered at startup", async (t) => {
  t.mock.method(console, "log", () => {});
  const { jarvis, childThread, child } = jarvisWithChild({ jarvisRunning: true });
  await end(child, "done", [["assistant", { content: "Created a.txt" }]]);
  assert.equal(getThread(jarvis.id)!.queuedReports?.length, 1);
  // The restart: every session is gone; the queue is on the stored thread.
  for (const s of runs) sessions.delete(s.gitbotId);
  runs = [];
  assert.equal(deliverQueuedReports(ALL_AGENTS), 1);
  const woke = jarvisRuns(jarvis.id);
  assert.equal(woke.length, 1);
  assert.match(String(woke[0].events.find((e) => e.type === "user_prompt")?.prompt), new RegExp(`thread ${childThread.id} · done\\]\\nCreated a.txt$`));
  assert.equal(getThread(jarvis.id)!.queuedReports, undefined, "cleared");
  // Once: a second pass, or the report turn's own end, delivers nothing more.
  assert.equal(deliverQueuedReports(ALL_AGENTS), 0);
  await end(woke[0], "done");
  await turnEnd();
  assert.equal(jarvisRuns(jarvis.id).length, 1);
});

test("a queued report for a deleted Jarvis thread is dropped with a log line", async (t) => {
  t.mock.method(console, "log", () => {});
  const warnings: string[] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => { warnings.push(args.join(" ")); });
  const { jarvis, childThread, child } = jarvisWithChild({ jarvisRunning: true });
  await end(child, "done", [["assistant", { content: "done" }]]);
  assert.equal(getThread(jarvis.id)!.queuedReports?.length, 1);

  const res = await request("DELETE", `/threads/${jarvis.id}`);
  assert.equal(res.status, 200);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], new RegExp(`^\\[report\\] dropped: thread ${childThread.id}'s queued report, its Jarvis thread ${jarvis.id} was deleted$`));

  // Its turn still ends; the drain finds nothing to start, and nothing throws.
  const errors = t.mock.method(console, "error", () => {});
  await end(jarvisRuns(jarvis.id)[0], "done");
  await turnEnd();
  assert.equal(jarvisRuns(jarvis.id).length, 1);
  assert.equal(errors.mock.callCount(), 0);
  assert.equal(deliverQueuedReports(ALL_AGENTS), 0);
});

test("a report Jarvis refuses for any reason but being mid-turn is still dropped, not queued", async (t) => {
  const warnings: string[] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => { warnings.push(args.join(" ")); });
  const { jarvis, childThread, child } = jarvisWithChild();
  // Its Jarvis thread is gone (a 404): waiting would only be refused again.
  assert.ok(deleteThread(jarvis.id));
  await end(child, "done", [["assistant", { content: "done" }]]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], new RegExp(`^\\[report\\] dropped: thread ${childThread.id} finished, but Jarvis thread ${jarvis.id} refused its report \\(404 `));
  assert.equal(jarvisRuns(jarvis.id).length, 0);
});

test("a stop that is still in flight when the child's turn ends does not wake Jarvis", async () => {
  const { jarvis, child } = jarvisWithChild();
  child.abortController = new AbortController();
  const res = await post(`/sessions/${child.gitbotId}/abort`);
  assert.equal(res.status, 200);
  assert.ok(child.abortController.signal.aborted);
  // The agent ends the turn as "done" first; its "aborted" event lands later.
  await end(child, "done", [["assistant", { content: "halfway" }]]);
  await new Promise((r) => setTimeout(r, 20));
  emitEvent(child, "aborted", { message: "Request aborted by user" });
  await turnEnd();
  assert.equal(jarvisRuns(jarvis.id).length, 0);
});

test("only a turn Jarvis started reports; one the user types into the child does not", async () => {
  const { jarvis, childThread, child } = jarvisWithChild();
  await end(child, "done", [["assistant", { content: "Created a.txt" }]]);
  assert.equal(jarvisRuns(jarvis.id).length, 1);
  // The user now types into the child thread.
  const typed = startTurn({ threadId: childThread.id, prompt: "also add c.txt" }, ALL_AGENTS);
  assert.ok(typed.ok, JSON.stringify(typed));
  await end(sessions.get(typed.sessionId)!, "done", [["assistant", { content: "Added c.txt" }]]);
  assert.equal(jarvisRuns(jarvis.id).length, 1);
});

test("the report reads the turn as it ended, even if a new turn swaps the store's events", async () => {
  const { jarvis, childThread, child } = jarvisWithChild();
  emitEvent(child, "assistant", { content: "Created a.txt with 'one'." });
  child.status = "done";
  notifyPermissionsChanged();
  // A new turn on the same store, before the turn-end listeners run.
  child.events = [];
  child.reportable = false;
  child.threadId = undefined;
  await turnEnd();
  const woke = jarvisRuns(jarvis.id);
  assert.equal(woke.length, 1);
  assert.match(String(woke[0].events[0].prompt), new RegExp(`thread ${childThread.id} · done\\]\\nCreated a.txt with 'one'.$`));
});

test("claude-code events keep a sub-agent's parent_tool_use_id, so its words are not the report", () => {
  const sdk = (content: unknown[], parent: string | null) =>
    ({ type: "assistant", parent_tool_use_id: parent, message: { content } }) as any;
  const asEvents = (msg: any): StoredEvent[] => {
    const out = formatMessage(msg);
    return (Array.isArray(out) ? out : out ? [out] : []).map((e) => ({ seq: 0, ...e }) as StoredEvent);
  };
  const events = [
    ...asEvents(sdk([{ type: "text", text: "Delegating." }, { type: "tool_use", name: "Task", input: {} }], null)),
    ...asEvents(sdk([{ type: "text", text: "Done: a.txt" }], null)),
    ...asEvents(sdk([{ type: "text", text: "sub-agent: wrote it" }, { type: "tool_use", name: "Write", input: {} }], "toolu_7")),
  ];
  assert.equal(events.length, 5);
  assert.equal(events[2].parent_tool_use_id, undefined);
  assert.equal(events[3].parent_tool_use_id, "toolu_7");
  assert.equal(events[4].parent_tool_use_id, "toolu_7");
  assert.equal(lastAssistantMessage(events), "Done: a.txt");
});

const post = (url: string) => request("POST", url);

async function request(method: string, url: string): Promise<{ status: number; body: any }> {
  const req = Object.assign(new EventEmitter(), { method, url, headers: {} }) as unknown as IRequest;
  let status = 0;
  let out = "";
  const res: IResponse = {
    headersSent: false,
    writableEnded: false,
    writeHead(code) { status = code; },
    write() {},
    end(chunk) { out = chunk ?? ""; },
  };
  await handleRequest(req, res, ALL_AGENTS, tmpdir());
  return { status, body: JSON.parse(out || "{}") };
}
