import { test, after, afterEach, before } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "events";
import { mkdtempSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createBot, createThread, getThread, JARVIS_BOT_ID, jarvisDir, setRunningFor } from "../src/bot-store";
import { recoverInterruptedChildren } from "../src/restart-recovery";
import { coalesce } from "../ui/app/lib/coalesce";
import { latestLine, watchJarvisActivity } from "../src/attention";
import { startChildThread } from "../src/jarvis";
import { addProject } from "../src/project-index";
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
import { startTurn, agentRunners } from "../src/turns";
import { pendingByJarvis, type ChildApproval } from "../ui/app/lib/approvals";
import {
  attentionRows,
  attentionTitle,
  hasNews,
  needsYouCount,
  needsYouLabel,
} from "../ui/app/lib/attention";

const ALL_AGENTS = ["claude-code", "opencode", "codex"];

// --- A stub at the agent seam: turns start and stay running until a test ends them ---

const realRunners = { ...agentRunners };
let runs: SessionStore[] = [];
let unwatch: () => void = () => {};
before(() => {
  for (const agent of Object.keys(agentRunners) as SessionStore["agent"][]) {
    agentRunners[agent] = async (store) => { runs.push(store); };
  }
  unwatch = watchJarvisActivity();
});
afterEach(() => {
  for (const s of runs) sessions.delete(s.gitbotId);
  runs = [];
});
after(() => {
  unwatch();
  Object.assign(agentRunners, realRunners);
});

const tick = () => new Promise((r) => setImmediate(r));
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

/** Runs a turn on a thread and ends it with the given reply. */
async function turn(threadId: string, reply: string, status: SessionStore["status"] = "done") {
  const started = startTurn({ threadId, prompt: "hello" }, ALL_AGENTS);
  assert.ok(started.ok, JSON.stringify(started));
  const store = runs[runs.length - 1];
  await tick();
  // Starting the turn is an edit (the thread moves up the list); ending it is not.
  const startedAt = getThread(threadId)!.updatedAt;
  await pause(2);
  emitEvent(store, "assistant", { content: reply });
  store.status = status;
  notifyPermissionsChanged();
  await tick();
  assert.equal(getThread(threadId)!.updatedAt, startedAt);
  return store;
}

// --- The unread rule (pure) ---

test("has news exactly while the last activity is later than the last view", () => {
  assert.equal(hasNews({}), false);
  assert.equal(hasNews({ lastSeenAt: "2026-10-01T10:00:00.000Z" }), false);
  assert.equal(hasNews({ lastActivityAt: "2026-10-01T10:00:00.000Z" }), true);
  assert.equal(hasNews({ lastActivityAt: "2026-10-01T10:00:01.000Z", lastSeenAt: "2026-10-01T10:00:00.000Z" }), true);
  assert.equal(hasNews({ lastActivityAt: "2026-10-01T10:00:00.000Z", lastSeenAt: "2026-10-01T10:00:00.000Z" }), false);
  assert.equal(hasNews({ lastActivityAt: "2026-10-01T09:00:00.000Z", lastSeenAt: "2026-10-01T10:00:00.000Z" }), false);
});

test("a preview is the opening line of what the turn said", () => {
  assert.equal(latestLine("## Done\n\nPR Validator passed."), "Done");
  assert.equal(latestLine("\n\n- **All green** on Trophy"), "All green on Trophy");
  assert.equal(latestLine(""), "");
  assert.equal(latestLine("x".repeat(300)).length, 140);
  // Fences and rules are skipped; a heading marker goes, with or without a space.
  assert.equal(latestLine("```ts\nconst a = 1;\n```"), "const a = 1;");
  assert.equal(latestLine("---\n***\n___\n- - -\nTests pass."), "Tests pass.");
  assert.equal(latestLine("~~~\n#Summary"), "Summary");
  assert.equal(latestLine("```\n```\n---"), "");
});

test("quiet refreshes coalesce: one per burst, one trailing run while one is in flight", async () => {
  let runs = 0;
  let release: () => void = () => {};
  const refresh = coalesce(() => {
    runs++;
    return new Promise<void>((r) => { release = r; });
  }, 10);
  // A burst (visibilitychange and focus together, a status change) is one run.
  refresh(); refresh(); refresh();
  await pause(25);
  assert.equal(runs, 1);
  // Calls while it is in flight make exactly one more run, after it ends.
  refresh(); await pause(15); refresh(); await pause(15);
  assert.equal(runs, 1);
  release();
  await pause(25);
  assert.equal(runs, 2);
  release();
  await pause(25);
  assert.equal(runs, 2);
});

// --- UI derivation from a fixed snapshot (pure) ---

test("markers, sort, Jarvis count and tab title come from a fixed snapshot", () => {
  const snapshot = {
    permissions: [
      { sessionId: "child-b", toolUseID: "t2" },
      { sessionId: "child-c", toolUseID: "t7" },
      { sessionId: "own", toolUseID: "t9" },
    ],
    sessions: [
      { gitbotId: "child-b", threadId: "cb", reportTo: "J2" },
      { gitbotId: "child-c", threadId: "cc", reportTo: "J3" },
      { gitbotId: "own", threadId: "ou", reportTo: null },
    ],
  };
  const pending = pendingByJarvis(snapshot);
  const approval = (id: string, tool: string, outcome?: ChildApproval["outcome"]): ChildApproval => ({
    id, childThreadId: "cb", childBotId: "b", bot: "PR Validator", tool, askedAt: "2026-10-01T10:00:00.000Z", ...(outcome ? { outcome } : {}),
  });
  // In the server's order (newest first).
  const threads = [
    { id: "J1", title: "Release", preview: "Shipped 1.2", lastActivityAt: "2026-10-01T10:05:00.000Z", lastSeenAt: "2026-10-01T10:00:00.000Z" },
    { id: "J2", title: "Tests", preview: "run the tests", approvals: [approval("t1", "npm ci", "approved"), approval("t2", "npm test")] },
    { id: "J4", title: "Docs", preview: "All read", lastActivityAt: "2026-10-01T09:00:00.000Z", lastSeenAt: "2026-10-01T10:00:00.000Z" },
    { id: "J3", title: "Lint", preview: "lint it", approvals: [] },
  ];

  const rows = attentionRows(threads, pending);
  // Needs-you first, each group in the list's order.
  assert.deepEqual(rows.map((r) => [r.thread.id, r.needsYou, r.hasNews]), [
    ["J2", true, false],
    ["J3", true, false],
    ["J1", false, true],
    ["J4", false, false],
  ]);
  // The preview: the waiting approval, else the thread's latest line.
  assert.deepEqual(rows.map((r) => r.preview), [
    "PR Validator needs permission to run `npm test`",
    "A child is waiting on your approval",
    "Shipped 1.2",
    "All read",
  ]);
  // The open thread, being looked at, shows no news.
  assert.equal(attentionRows(threads, pending, "J1").find((r) => r.thread.id === "J1")!.hasNews, false);
  // Before the stream is heard from, nothing needs you.
  assert.deepEqual(attentionRows(threads, null).map((r) => r.thread.id), ["J1", "J2", "J4", "J3"]);

  // Jarvis in the Bots panel, and the tab title.
  assert.equal(needsYouCount(pending), 2);
  assert.equal(needsYouCount(null), 0);
  assert.equal(needsYouLabel(2), "2 need you");
  assert.equal(needsYouLabel(1), "1 needs you");
  assert.equal(needsYouLabel(0), null);
  const base = "GitBot | Git workflows, simplified";
  assert.equal(attentionTitle(base, 2), `(2) ${base}`);
  assert.equal(attentionTitle(`(2) ${base}`, 1), `(1) ${base}`);
  assert.equal(attentionTitle(`(1) ${base}`, 0), base);
  assert.equal(attentionTitle(`(1) ● Working · ${base}`, 3), `(3) ● Working · ${base}`);
});

// --- Server: the snapshot, the stamp, the seen endpoint ---

test("the session snapshot carries each session's thread id", async () => {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "gitbot-proj-")));
  const added = addProject(folder);
  assert.ok(added.ok);
  const jarvis = createThread(JARVIS_BOT_ID, jarvisDir(), undefined, "chat", "claude-code");
  const started = startChildThread(jarvis.id, { agent: "claude-code", project: added.project.id, message: "run the tests" }, ALL_AGENTS);
  assert.ok(started.ok, JSON.stringify(started));
  const child = runs[runs.length - 1];
  child.pendingPermissions.set("tu-a", { resolve: () => {}, input: { command: "npm test" }, toolName: "Bash", toolUseID: "tu-a" });
  notifyPermissionsChanged();
  await tick();
  const summary = buildSessionsDump().find((s) => s.gitbotId === child.gitbotId);
  assert.equal(summary?.threadId, started.threadId);
  assert.equal(summary?.reportTo, jarvis.id);
  // Which is what turns the approval into "needs you" on its Jarvis thread.
  assert.equal(needsYouCount(pendingByJarvis({ permissions: buildPermissionsDump(), sessions: buildSessionsDump() })), 1);
  child.pendingPermissions.clear();
});

test("a Jarvis turn's end stamps lastActivityAt and the preview, not updatedAt", async () => {
  const jarvis = createThread(JARVIS_BOT_ID, jarvisDir(), undefined, "chat", "claude-code");
  await turn(jarvis.id, "Started PR Validator on Trophy.\nI'll report back.");
  const before = getThread(jarvis.id)!;
  assert.ok(before.lastActivityAt);
  assert.equal(before.preview, "Started PR Validator on Trophy.");
  assert.equal(hasNews(before), true);

  await pause(5);
  await turn(jarvis.id, "PR Validator passed.", "error");
  const afterTurn = getThread(jarvis.id)!;
  assert.ok(afterTurn.lastActivityAt! > before.lastActivityAt!);
  assert.equal(afterTurn.preview, "PR Validator passed.");
  // (turn() checks the end left updatedAt alone.)
});

test("a plain bot's turn is not stamped", async () => {
  const bot = createBot({ name: "Plain", agent: "claude-code" });
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "gitbot-plain-")));
  const plain = createThread(bot.id, folder, undefined, "chat", "claude-code");
  await turn(plain.id, "done");
  assert.equal(getThread(plain.id)!.lastActivityAt, undefined);
});

test("a turn our shutdown killed is not news", async () => {
  const jarvis = createThread(JARVIS_BOT_ID, jarvisDir(), undefined, "chat", "claude-code");
  setShuttingDown(true);
  try {
    await turn(jarvis.id, "half a thought", "error");
  } finally {
    setShuttingDown(false);
  }
  assert.equal(getThread(jarvis.id)!.lastActivityAt, undefined);
});

test("a child a restart interrupted is news on its Jarvis thread", () => {
  const jarvis = createThread(JARVIS_BOT_ID, jarvisDir(), undefined, "chat", "claude-code");
  const bot = createBot({ name: "Interrupted", agent: "claude-code" });
  const child = createThread(bot.id, realpathSync(mkdtempSync(join(tmpdir(), "gitbot-int-"))), undefined, "chat", "claude-code");
  setRunningFor(child.id, jarvis.id);
  const listedAt = getThread(jarvis.id)!.updatedAt;
  // (An earlier test may leave its own child marked too.)
  assert.ok(recoverInterruptedChildren(() => false).includes(child.id));
  const after = getThread(jarvis.id)!;
  assert.ok(after.lastActivityAt);
  assert.equal(hasNews(after), true);
  assert.equal(after.updatedAt, listedAt);
});

test("seen clears has news, keeps the list order, and a client cannot forge either stamp", async () => {
  const jarvis = createThread(JARVIS_BOT_ID, jarvisDir(), undefined, "chat", "claude-code");
  await turn(jarvis.id, "Report: all green.");
  const stamped = getThread(jarvis.id)!;
  assert.equal(hasNews(stamped), true);

  const seen = await request("POST", `/threads/${jarvis.id}/seen`);
  assert.equal(seen.status, 200);
  assert.ok(seen.body.thread.lastSeenAt);
  assert.equal(hasNews(seen.body.thread), false);
  // Viewing is not an edit: the thread keeps its place in the list.
  assert.equal(seen.body.thread.updatedAt, stamped.updatedAt);
  // Read from another device: the thread list says the same.
  const listed = (await request("GET", `/threads?botId=${JARVIS_BOT_ID}`)).body.threads.find((t: any) => t.id === jarvis.id);
  assert.equal(hasNews(listed), false);

  // A later turn is news again.
  await pause(5);
  await turn(jarvis.id, "One more thing.");
  assert.equal(hasNews(getThread(jarvis.id)!), true);

  // PATCH cannot set either stamp.
  await request("PATCH", `/threads/${jarvis.id}`, { lastSeenAt: "2999-01-01T00:00:00.000Z", lastActivityAt: "2000-01-01T00:00:00.000Z" });
  const patched = getThread(jarvis.id)!;
  assert.notEqual(patched.lastSeenAt, "2999-01-01T00:00:00.000Z");
  assert.notEqual(patched.lastActivityAt, "2000-01-01T00:00:00.000Z");
  assert.equal(hasNews(patched), true);

  assert.equal((await request("POST", "/threads/nope/seen")).status, 404);
});
