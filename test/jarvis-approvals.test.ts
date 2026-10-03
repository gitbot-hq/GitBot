import { test, after, afterEach, before } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "events";
import { mkdtempSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createThread, deleteThread, getThread, JARVIS_BOT_ID, jarvisDir, setThreadApprovals, type ChildApproval as StoredApproval } from "../src/bot-store";
import { startChildThread } from "../src/jarvis";
import { addProject } from "../src/project-index";
import { watchChildReports } from "../src/reports";
import { approvalLabel, watchChildApprovals } from "../src/child-approvals";
import {
  buildPermissionsDump,
  buildSessionsDump,
  emitEvent,
  notifyPermissionsChanged,
  sessions,
  setShuttingDown,
  type IRequest,
  type IResponse,
  type SessionStore,
} from "../src/server-common";
import { handleRequest } from "../src/server";
import { agentRunners } from "../src/turns";
import { approvalRows, pendingByJarvis, placeApprovals, type ChildApproval } from "../ui/app/lib/approvals";

const ALL_AGENTS = ["claude-code", "opencode", "codex"];

// --- A stub at the agent seam: turns start and stay running until a test ends them ---

const realRunners = { ...agentRunners };
let runs: SessionStore[] = [];
let unwatch: Array<() => void> = [];
before(() => {
  for (const agent of Object.keys(agentRunners) as SessionStore["agent"][]) {
    agentRunners[agent] = async (store) => { runs.push(store); };
  }
  unwatch = [watchChildReports(ALL_AGENTS), watchChildApprovals()];
});
afterEach(() => {
  for (const s of runs) sessions.delete(s.gitbotId);
  runs = [];
});
after(() => {
  for (const u of unwatch) u();
  Object.assign(agentRunners, realRunners);
});

const tick = () => new Promise((r) => setImmediate(r));

function jarvisWithChild() {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "gitbot-proj-")));
  const added = addProject(folder);
  assert.ok(added.ok);
  const jarvis = createThread(JARVIS_BOT_ID, jarvisDir(), undefined, "chat", "claude-code");
  const started = startChildThread(jarvis.id, { agent: "claude-code", project: added.project.id, message: "run the tests" }, ALL_AGENTS);
  assert.ok(started.ok, JSON.stringify(started));
  return { jarvis, childId: started.threadId, child: runs[runs.length - 1] };
}

function jarvisWithChildOn(jarvisId: string) {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "gitbot-proj-")));
  const added = addProject(folder);
  assert.ok(added.ok);
  const started = startChildThread(jarvisId, { agent: "claude-code", project: added.project.id, message: "go" }, ALL_AGENTS);
  assert.ok(started.ok, JSON.stringify(started));
  return { child: runs[runs.length - 1] };
}

/** The child asks for an approval, as the claude-code harness does. */
function ask(store: SessionStore, toolUseID: string, toolName: string, input: unknown) {
  store.pendingPermissions.set(toolUseID, { resolve: () => {}, input, toolName, toolUseID });
  notifyPermissionsChanged();
}

async function request(method: string, url: string, body?: unknown): Promise<{ status: number; body: any }> {
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
  const done = handleRequest(req, res, ALL_AGENTS, tmpdir());
  setImmediate(() => {
    if (body !== undefined) (req as unknown as EventEmitter).emit("data", JSON.stringify(body));
    (req as unknown as EventEmitter).emit("end");
  });
  await done;
  return { status, body: JSON.parse(out || "{}") };
}

const jarvisRuns = (jarvisId: string) => runs.filter((s) => s.threadId === jarvisId);

// --- Row state from a fixed approvals snapshot (pure) ---

test("approval rows take their state from a fixed snapshot and the stored answers", () => {
  const snapshot = {
    permissions: [
      { sessionId: "child-a", toolUseID: "t2" },
      { sessionId: "user-own", toolUseID: "t9" },
      { sessionId: "child-b", toolUseID: "t5" },
    ],
    sessions: [
      { gitbotId: "child-a", threadId: "ta", reportTo: "J1" },
      { gitbotId: "user-own", threadId: "tu", reportTo: null },
      { gitbotId: "child-b", threadId: "tb", reportTo: "J2" },
      { gitbotId: "jarvis", threadId: "J1", reportTo: null },
    ],
  };
  const pending = pendingByJarvis(snapshot);
  // Only a Jarvis-owned child's approvals, under the Jarvis thread it reports to.
  assert.deepEqual(pending, { J1: ["t2"], J2: ["t5"] });

  const row = (id: string, outcome?: ChildApproval["outcome"]): ChildApproval => ({
    id, childThreadId: "ta", childBotId: "b", bot: "PR Validator", tool: "npm test", askedAt: "2026-10-03T10:00:00.000Z", ...(outcome ? { outcome } : {}),
  });
  const log = [row("t1", "approved"), row("t2"), row("t3", "denied"), row("t4")];
  const rows = approvalRows(log, pending.J1);
  // Stacked in the order asked, each with its own state.
  assert.deepEqual(rows.map((r) => [r.id, r.state]), [
    ["t1", "approved"], ["t2", "pending"], ["t3", "denied"], ["t4", "dropped"],
  ]);
  // Before the stream is first heard from, an unanswered row is neither
  // pending (no Review) nor dropped: unknown, shown neutral.
  assert.deepEqual(approvalRows(log, null).map((r) => r.state), ["approved", "unknown", "denied", "unknown"]);
});

test("rows sit among the messages by time, not by turn count", () => {
  const at = (hhmm: string) => `2026-10-03T${hhmm}:00.000Z`;
  // user, Jarvis, (a turn that showed nothing is simply absent), report, Jarvis, live user (no transcript time yet).
  const times = [at("10:00"), at("10:01"), at("10:20"), at("10:21"), undefined];
  const r = (id: string, t: string) => ({ id, askedAt: at(t) });
  const { before, trailing } = placeApprovals(times, [r("late", "10:30"), r("b", "10:12"), r("a", "10:05"), r("early", "09:00")]);
  assert.deepEqual([...before].map(([i, rows]) => [i, rows.map((x) => x.id)]), [
    [0, ["early"]],
    [2, ["a", "b"]], // after Jarvis's 10:01 reply, before the 10:20 report, in the order asked
  ]);
  assert.deepEqual(trailing.map((x) => x.id), ["late"]);
});

test("an approval's label is its command, its file, or its tool", () => {
  assert.equal(approvalLabel("Bash", { command: "npm test\necho more" }), "npm test");
  assert.equal(approvalLabel("Edit", { file_path: "/x/src/a.ts", old_string: "a" }), "Edit /x/src/a.ts");
  assert.equal(approvalLabel("WebFetch", { url: "https://e.com" }), "WebFetch");
  assert.equal(approvalLabel("Bash", { command: "x".repeat(300) }).length, 120);
});

// --- Live: rows on the Jarvis thread, and no wake ---

test("a child's approval puts a row in its Jarvis thread and starts no Jarvis turn", async () => {
  const { jarvis, childId, child } = jarvisWithChild();
  const turnsBefore = getThread(jarvis.id)!.messageCount;
  const t0 = Date.now();

  ask(child, "tu-1", "Bash", { command: "npm test" });
  await tick();

  const rows = getThread(jarvis.id)!.approvals ?? [];
  assert.equal(rows.length, 1);
  assert.deepEqual(
    { id: rows[0].id, childThreadId: rows[0].childThreadId, tool: rows[0].tool, outcome: rows[0].outcome },
    { id: "tu-1", childThreadId: childId, tool: "npm test", outcome: undefined },
  );
  const asked = Date.parse(rows[0].askedAt);
  assert.ok(asked >= t0 - 1 && asked <= Date.now(), rows[0].askedAt);
  assert.equal(rows[0].childBotId, getThread(childId)!.botId);
  // Jarvis is not woken: no turn on its thread, and its turn count is unchanged.
  assert.equal(jarvisRuns(jarvis.id).length, 0);
  assert.equal(getThread(jarvis.id)!.messageCount, turnsBefore);
  // The snapshot carries it, under its Jarvis thread.
  assert.deepEqual(pendingByJarvis({ permissions: buildPermissionsDump(), sessions: buildSessionsDump() }), { [jarvis.id]: ["tu-1"] });

  // Answered: the row says how, in place. Still no Jarvis turn.
  const allowed = await request("POST", `/sessions/${child.gitbotId}/permission`, { toolUseID: "tu-1", approved: true });
  assert.equal(allowed.status, 200);
  await tick();
  assert.equal(getThread(jarvis.id)!.approvals![0].outcome, "approved");

  // A second approval stacks under it; denied.
  ask(child, "tu-2", "Edit", { file_path: "/p/a.ts" });
  await tick();
  await request("POST", `/sessions/${child.gitbotId}/permission`, { toolUseID: "tu-2", approved: false });
  await tick();
  assert.deepEqual(getThread(jarvis.id)!.approvals!.map((r) => [r.id, r.tool, r.outcome]), [
    ["tu-1", "npm test", "approved"],
    ["tu-2", "Edit /p/a.ts", "denied"],
  ]);
  assert.equal(jarvisRuns(jarvis.id).length, 0);
});

test("an approval left unanswered when its turn ends is marked dropped", async () => {
  const { jarvis, child } = jarvisWithChild();
  ask(child, "tu-3", "Bash", { command: "rm -rf build" });
  await tick();
  child.pendingPermissions.clear();
  emitEvent(child, "assistant", { content: "gave up" });
  child.status = "done";
  notifyPermissionsChanged();
  await tick();
  assert.equal(getThread(jarvis.id)!.approvals![0].outcome, "dropped");
});

test("a shutdown leaves a pending approval unanswered, not dropped", async () => {
  const { jarvis, child } = jarvisWithChild();
  ask(child, "tu-sd", "Bash", { command: "npm test" });
  await tick();
  setShuttingDown(true);
  try {
    child.pendingPermissions.clear();
    child.status = "error";
    notifyPermissionsChanged();
    await tick();
    assert.equal(getThread(jarvis.id)!.approvals![0].outcome, undefined);
  } finally {
    setShuttingDown(false);
  }
});

test("Allow all approves the waiting approvals, and their rows say so", async () => {
  const { jarvis, child } = jarvisWithChild();
  ask(child, "tu-aa1", "Bash", { command: "npm test" });
  ask(child, "tu-aa2", "Bash", { command: "npm run lint" });
  await tick();
  const res = await request("PATCH", `/sessions/${child.gitbotId}`, { permissionMode: "yolo" });
  assert.equal(res.status, 200);
  await tick();
  assert.equal(child.pendingPermissions.size, 0);
  assert.deepEqual(getThread(jarvis.id)!.approvals!.map((r) => [r.id, r.outcome]), [
    ["tu-aa1", "approved"],
    ["tu-aa2", "approved"],
  ]);
  assert.equal(jarvisRuns(jarvis.id).length, 0);
});

test("a waiting approval whose child thread cannot be read is not marked dropped", async () => {
  const { jarvis, childId, child } = jarvisWithChild();
  ask(child, "tu-del", "Bash", { command: "npm test" });
  await tick();
  // The child thread goes away mid-approval; the approval is still waiting.
  deleteThread(childId);
  ask(child, "tu-del2", "Bash", { command: "ls" });
  await tick();
  assert.equal(getThread(jarvis.id)!.approvals![0].outcome, undefined);
  // And its later answer is still recorded.
  await request("POST", `/sessions/${child.gitbotId}/permission`, { toolUseID: "tu-del", approved: true });
  await tick();
  assert.equal(getThread(jarvis.id)!.approvals![0].outcome, "approved");
});

test("the cap evicts only answered rows, oldest first, and a no-op edit writes nothing", () => {
  const jarvis = createThread(JARVIS_BOT_ID, jarvisDir(), undefined, "chat", "claude-code");
  const row = (i: number, outcome?: StoredApproval["outcome"]): StoredApproval => ({
    id: `c${i}`, childThreadId: "x", childBotId: "b", bot: "B", tool: "t", askedAt: new Date(i).toISOString(), ...(outcome ? { outcome } : {}),
  });
  // One waiting row first, then 201 answered ones; a sync-added row trips the cap.
  const rows = [row(0), ...Array.from({ length: 201 }, (_, i) => row(i + 1, "approved"))];
  setThreadApprovals(jarvis.id, () => rows);
  const before = getThread(jarvis.id)!.updatedAt;
  setThreadApprovals(jarvis.id, (r) => r);
  assert.equal(getThread(jarvis.id)!.updatedAt, before);
  return (async () => {
    const { child } = jarvisWithChildOn(jarvis.id);
    ask(child, "tu-cap", "Bash", { command: "npm test" });
    await tick();
    const kept = getThread(jarvis.id)!.approvals!;
    assert.equal(kept.filter((r) => r.outcome).length, 200);
    assert.ok(kept.some((r) => r.id === "c0"), "the waiting row stays");
    assert.ok(!kept.some((r) => r.id === "c1"), "the oldest answered row goes");
    assert.ok(kept.some((r) => r.id === "tu-cap"));
  })();
});

test("a user's own thread asking for approval leaves Jarvis threads alone", async () => {
  const { jarvis } = jarvisWithChild();
  const own = createThread(getThread(runs[0].threadId!)!.botId, jarvisDir());
  const store = { ...runs[0], gitbotId: "own-session", threadId: own.id, reportable: false, reportOwner: undefined, pendingPermissions: new Map() } as SessionStore;
  sessions.set(store.gitbotId, store);
  runs.push(store);
  ask(store, "tu-own", "Bash", { command: "ls" });
  await tick();
  assert.equal(getThread(jarvis.id)!.approvals, undefined);
});

// --- Across a reload ---

test("rows survive a reload: the Jarvis thread as the UI fetches it carries them", async () => {
  const { jarvis, child } = jarvisWithChild();
  ask(child, "tu-4", "Bash", { command: "npm test" });
  await tick();
  await request("POST", `/sessions/${child.gitbotId}/permission`, { toolUseID: "tu-4", approved: true });
  ask(child, "tu-5", "Bash", { command: "npm run build" });
  await tick();

  // A reload reads the thread afresh, and the stream once more.
  const { body } = await request("GET", `/threads/${jarvis.id}`);
  const pending = pendingByJarvis({ permissions: buildPermissionsDump(), sessions: buildSessionsDump() });
  assert.deepEqual(approvalRows(body.thread.approvals, pending[jarvis.id] ?? []).map((r) => [r.tool, r.state]), [
    ["npm test", "approved"],
    ["npm run build", "pending"],
  ]);

  // A client cannot rewrite them.
  await request("PATCH", `/threads/${jarvis.id}`, { approvals: [] });
  assert.equal(getThread(jarvis.id)!.approvals!.length, 2);
});
