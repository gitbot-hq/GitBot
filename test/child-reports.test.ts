import { test, after, afterEach, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { basename, join } from "path";
import { createThread, getThread, JARVIS_BOT_ID, jarvisDir, updateThread } from "../src/bot-store";
import { startChildThread } from "../src/jarvis";
import { addProject } from "../src/project-index";
import { capReport, formatReport, lastAssistantMessage, REPORT_CAP, watchChildReports } from "../src/reports";
import { emitEvent, notifyPermissionsChanged, sessions, type SessionStore, type StoredEvent } from "../src/server-common";
import { agentRunners, startTurn } from "../src/turns";
import { parseReport } from "../ui/app/lib/report";

const ALL_AGENTS = ["claude-code", "opencode", "codex"];

// --- A stub at the agent seam: turns start and stay running until a test ends them ---

const realRunners = { ...agentRunners };
let runs: SessionStore[] = [];
let unwatch = () => {};
before(() => {
  for (const agent of Object.keys(agentRunners) as SessionStore["agent"][]) {
    agentRunners[agent] = async (store) => { runs.push(store); };
  }
  unwatch = watchChildReports(ALL_AGENTS);
});
afterEach(() => {
  for (const s of runs) sessions.delete(s.gitbotId);
  runs = [];
});
after(() => {
  unwatch();
  Object.assign(agentRunners, realRunners);
});

const ev = (type: string, extra: Record<string, unknown> = {}): StoredEvent => ({ seq: 0, type, ...extra });
const turnEnd = () => new Promise((r) => setImmediate(r));

/** A Jarvis thread with a running child, as start_thread leaves them. */
function jarvisWithChild() {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "gitbot-proj-")));
  const added = addProject(folder);
  assert.ok(added.ok);
  const jarvis = createThread(JARVIS_BOT_ID, jarvisDir(), undefined, "chat", "claude-code");
  updateThread(jarvis.id, { title: "Make two files", titleIsAuto: false, preview: "make two files" });
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

test("a report that finds Jarvis mid-turn is dropped, and the server says so", async () => {
  const { jarvis, childThread, child } = jarvisWithChild();
  // Jarvis's own turn is still running.
  const own = startTurn({ threadId: jarvis.id, prompt: "and another thing" }, ALL_AGENTS);
  assert.ok(own.ok);
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.join(" ")); };
  try {
    await end(child, "done", [["assistant", { content: "done" }]]);
  } finally {
    console.warn = warn;
  }
  assert.equal(jarvisRuns(jarvis.id).length, 1, "only Jarvis's own turn ran");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], new RegExp(`dropped: thread ${childThread.id} .*Jarvis thread ${jarvis.id} refused .*409`));
});
