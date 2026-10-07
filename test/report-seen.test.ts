import { test, after, afterEach, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createThread, getThread, JARVIS_BOT_ID, jarvisDir } from "../src/bot-store";
import { watchThreadActivity } from "../src/attention";
import { startChildThread } from "../src/jarvis";
import { addProject } from "../src/project-index";
import { watchChildReports } from "../src/reports";
import { emitEvent, notifyPermissionsChanged, sessions, type SessionStore } from "../src/server-common";
import { agentRunners, startTurn } from "../src/turns";
import { hasNews, keepLaterSeen } from "../ui/app/lib/attention";

// A thread Jarvis started counts as seen once its report has been delivered
// to Jarvis: the user reads the result there, so the child's own dot would
// only pile up.

const ALL_AGENTS = ["claude-code", "opencode", "codex"];

const realRunners = { ...agentRunners };
let runs: SessionStore[] = [];
before(() => {
  for (const agent of Object.keys(agentRunners) as SessionStore["agent"][]) {
    agentRunners[agent] = async (store) => { runs.push(store); };
  }
});
afterEach(() => {
  for (const s of runs) sessions.delete(s.gitbotId);
  runs = [];
});
after(() => { Object.assign(agentRunners, realRunners); });

const tick = () => new Promise((r) => setImmediate(r));

/** The two turn-end listeners, registered in the given order for one test. */
function watch(order: "server" | "reversed"): () => void {
  const reports = () => watchChildReports(ALL_AGENTS);
  const activity = () => watchThreadActivity();
  const unwatch = order === "server" ? [reports(), activity()] : [activity(), reports()];
  return () => unwatch.forEach((u) => u());
}

function jarvisWithChild() {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "gitbot-seen-")));
  const added = addProject(folder);
  assert.ok(added.ok);
  const jarvis = createThread(JARVIS_BOT_ID, jarvisDir(), undefined, "chat", "claude-code");
  const started = startChildThread(jarvis.id, { agent: "claude-code", project: added.project.id, message: "work" }, ALL_AGENTS);
  assert.ok(started.ok, JSON.stringify(started));
  return { jarvis, childId: started.threadId, child: runs[runs.length - 1] };
}

async function end(store: SessionStore, status: "done" | "error") {
  emitEvent(store, "assistant", { content: "result" });
  store.status = status;
  notifyPermissionsChanged();
  await tick();
}

const reportsTo = (jarvisId: string) => runs.filter((s) => s.threadId === jarvisId);

for (const order of ["server", "reversed"] as const) {
  test(`a child whose report reached Jarvis is seen (${order} listener order)`, async () => {
    const unwatch = watch(order);
    try {
      for (const status of ["done", "error"] as const) {
        const { jarvis, childId, child } = jarvisWithChild();
        await end(child, status);
        assert.equal(reportsTo(jarvis.id).length, 1, "the report was delivered");
        const after = getThread(childId)!;
        assert.ok(after.lastActivityAt, "the turn's end is stamped");
        assert.equal(after.lastOutcome, status === "done" ? "done" : "failed");
        assert.equal(hasNews(after), false, `${status}: seen once Jarvis has it`);
        // The report's turn on Jarvis ends in its own time; finish it.
        await end(reportsTo(jarvis.id)[0], "done");
      }
    } finally {
      unwatch();
    }
  });
}

test("a report Jarvis refused leaves the child unseen", async () => {
  const unwatch = watch("server");
  try {
    // The real flow: Jarvis starts the child mid-turn; the child ends before
    // that turn does, so Jarvis refuses its report (deliverReport).
    const folder = realpathSync(mkdtempSync(join(tmpdir(), "gitbot-seen-")));
    const added = addProject(folder);
    assert.ok(added.ok);
    const jarvis = createThread(JARVIS_BOT_ID, jarvisDir(), undefined, "chat", "claude-code");
    const jarvisTurn = startTurn({ threadId: jarvis.id, prompt: "start one" }, ALL_AGENTS);
    assert.ok(jarvisTurn.ok, JSON.stringify(jarvisTurn));
    const started = startChildThread(jarvis.id, { agent: "claude-code", project: added.project.id, message: "work" }, ALL_AGENTS);
    assert.ok(started.ok, JSON.stringify(started));
    await end(runs[runs.length - 1], "done");
    assert.equal(reportsTo(jarvis.id).length, 1, "only Jarvis's own turn: no report turn");
    assert.equal(hasNews(getThread(started.threadId)!), true);
  } finally {
    unwatch();
  }
});

test("a stopped child makes no report, so it stays unseen", async () => {
  const unwatch = watch("server");
  try {
    const { jarvis, childId, child } = jarvisWithChild();
    child.abortRequested = true;
    emitEvent(child, "aborted", { message: "Aborted by user" });
    await end(child, "error");
    assert.equal(reportsTo(jarvis.id).length, 0);
    const after = getThread(childId)!;
    assert.equal(after.lastOutcome, "stopped");
    assert.equal(hasNews(after), true);
  } finally {
    unwatch();
  }
});

// --- The thread list: a re-read must not undo a seen mark ---

test("a re-read thread list keeps the later lastSeenAt this page holds", () => {
  const local = [
    { id: "a", lastSeenAt: "2026-10-07T10:05:00.000Z" },
    { id: "b", lastSeenAt: "2026-10-07T10:00:00.000Z" },
    { id: "c" },
  ];
  const loaded = [
    // Read before "a" was marked seen here: its older mark must not win.
    { id: "a", lastSeenAt: "2026-10-07T10:00:00.000Z", lastActivityAt: "2026-10-07T10:01:00.000Z" },
    // Seen since on another device: the server's later mark wins.
    { id: "b", lastSeenAt: "2026-10-07T10:09:00.000Z" },
    { id: "c", lastSeenAt: "2026-10-07T10:02:00.000Z" },
    { id: "d" },
  ];
  const merged = keepLaterSeen(loaded, local);
  assert.deepEqual(merged.map((t) => t.lastSeenAt), [
    "2026-10-07T10:05:00.000Z",
    "2026-10-07T10:09:00.000Z",
    "2026-10-07T10:02:00.000Z",
    undefined,
  ]);
  assert.equal(hasNews(merged[0]), false, "the cleared dot stays cleared");
  // Everything else the read brought is kept.
  assert.equal(merged[0].lastActivityAt, "2026-10-07T10:01:00.000Z");
});
