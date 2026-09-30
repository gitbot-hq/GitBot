// npm run build, then: NODE_PATH=<directory containing playwright> node ui/scripts/analysis.test.mjs
// Isolated test data and a fake agent: this check never runs a paid coding agent.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";

const data = mkdtempSync(join(tmpdir(), "gitbot-analysis-"));
process.env.GITBOT_DATA_DIR = join(data, "state");
const require = createRequire(import.meta.url);
const store = require("../../dist/bot-store.js");
const common = require("../../dist/server-common.js");
const dispatch = require("../../dist/run-agent.js");
const realLaunch = dispatch.launchAgent;
const launched = [];
dispatch.launchAgent = session => { launched.push(session); };
const analysis = require("../../dist/analysis.js");
const { handleRequest } = require("../../dist/server.js");
const { uiFileFor, serveUiFile } = require("../../dist/static-ui.js");
const { chromium } = require("playwright");
const git = (...args) => execFileSync("git", ["-C", data, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
git("init", "-b", "main");
writeFileSync(join(data, "README.md"), "# Example repository\nA small branch-analysis demo.\n");
git("add", "README.md");
git("-c", "user.name=Demo", "-c", "user.email=demo@example.com", "commit", "-m", "Initial documentation");
const commit = git("rev-parse", "HEAD");
const bot = store.createBot({ name: "ShipGuard", agent: "codex", permissionMode: "auto-approve", instructions: "Review release readiness. Suggest fixes, but leave implementation to a human." });
const input = { repoPath: data, branch: "main", prompt: "Review the branch for release risks and suggest verification steps.", time: "09:00", enabled: true };
const saved = analysis.saveAnalysisSchedule(bot.id, input, data);
assert.ok(new Date(saved.nextRunAt) > new Date());
for (const patch of [{ time: "25:00" }, { enabled: "yes" }, { branch: "--help" }, { branch: "missing-branch" }, { prompt: " " }, { repoPath: "/missing-path" }]) {
  assert.throws(() => analysis.saveAnalysisSchedule(bot.id, { ...input, ...patch }, data));
}
function finish(session, type = "done") {
  session.status = type === "done" ? "done" : "error";
  common.emitEvent(session, type, type === "error" ? { message: "Demo agent failed" } : {});
}
const first = analysis.runAnalysis(bot.id, input, ["codex"], data);
const session = launched.at(-1);
assert.equal(session.mode, "plan"); // Codex's existing runner enforces a read-only sandbox for plan mode.
assert.equal(session.botPreset.analysis, true);
assert.equal(store.getThread(first.thread.id).analysis.commit, commit);
assert.equal(store.getThread(first.thread.id).runSessionId, first.sessionId);
assert.throws(() => analysis.runAnalysis(bot.id, input, ["codex"], data), /already running/);
finish(session);
assert.equal(store.getThread(first.thread.id).analysis.status, "done");
const claude = store.createBot({ name: "Reading only", agent: "claude-code", permissionMode: "auto-approve" });
analysis.runAnalysis(claude.id, input, ["claude-code"], data);
assert.deepEqual(launched.at(-1).botPreset.allowedTools, ["Read", "Glob", "Grep"]);
finish(launched.at(-1), "error");
assert.equal(analysis.getAnalysisSchedule(claude.id).lastError, "Demo agent failed");
const blocked = store.createBot({ name: "Setup pending", setupInstructions: "Install a tool" });
assert.throws(() => analysis.runAnalysis(blocked.id, input, ["claude-code"], data), /setup/);
assert.throws(() => analysis.runAnalysis(bot.id, input, [], data), /not installed/);
const schedulesFile = join(store.dataDir(), "analysis.json");
function dueAt(iso) {
  const items = JSON.parse(readFileSync(schedulesFile));
  items.find(item => item.botId === bot.id).nextRunAt = iso;
  writeFileSync(schedulesFile, JSON.stringify(items));
}
const due = new Date("2030-01-02T09:00:00");
dueAt(due.toISOString());
const count = launched.length;
analysis.tickAnalysisSchedules(["codex"], data, new Date(due.getTime() + 10000));
assert.equal(launched.length, count + 1);
analysis.tickAnalysisSchedules(["codex"], data, new Date(due.getTime() + 20000));
assert.equal(launched.length, count + 1);
finish(launched.at(-1));
dueAt(due.toISOString());
analysis.tickAnalysisSchedules(["codex"], data, new Date(due.getTime() + 120000));
assert.equal(launched.length, count + 1); // Skip missed runs.
assert.ok(new Date(analysis.getAnalysisSchedule(bot.id).nextRunAt) > due);
dueAt(new Date(Date.now() - 600000).toISOString());
const stop = analysis.startAnalysisScheduler(["codex"], data);
stop();
assert.equal(launched.length, count + 1); // Restart does not replay old schedules.
analysis.saveAnalysisSchedule(bot.id, { ...input, enabled: false }, data);
analysis.tickAnalysisSchedules(["codex"], data, due);
assert.equal(launched.length, count + 1);
assert.equal(analysis.getAnalysisSchedule(bot.id).nextRunAt, null);
const server = http.createServer((req, res) => {
  const file = uiFileFor(req.method, req.url);
  if (file) serveUiFile(req, res, file);
  else void handleRequest(req, res, ["codex", "claude-code"], data);
});
let browser;
try {
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const url = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
  await page.goto(url);
  await page.getByRole("button", { name: "Open ShipGuard profile", exact: true }).click();
  const panel = page.getByRole("region", { name: "Analysis for ShipGuard", exact: true });
  await panel.getByLabel("Analysis task", { exact: true }).fill("Review release readiness. Report risks without making changes.");
  await panel.getByLabel("Run daily", { exact: true }).check();
  await panel.getByLabel("Daily time", { exact: true }).fill("10:30");
  await panel.getByRole("button", { name: "Save schedule", exact: true }).click();
  await panel.getByRole("status").filter({ hasText: "Daily schedule saved" }).waitFor();
  await page.reload();
  await page.getByRole("button", { name: "Open ShipGuard profile", exact: true }).click();
  await panel.getByLabel("Analysis task", { exact: true }).waitFor();
  assert.equal(await panel.getByLabel("Run daily").isChecked(), true);
  assert.equal(await panel.getByLabel("Daily time").inputValue(), "10:30");
  const before = launched.length;
  await panel.getByRole("button", { name: "Run analysis now", exact: true }).click();
  await page.getByRole("region", { name: "Analysis for ShipGuard" }).waitFor({ state: "hidden" });
  assert.equal(launched.length, before + 1);
  assert.equal(launched.at(-1).mode, "plan");
  const live = launched.at(-1);
  const overlapping = await fetch(`${url}/bots/${bot.id}/analysis/run`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
  assert.equal(overlapping.status, 409);
  const chat = await fetch(`${url}/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ threadId: live.threadId, prompt: "Do more", permissionMode: "yolo" }) });
  assert.equal(chat.status, 409);
  finish(live);
  await page.reload();
  await page.getByRole("button", { name: "Open ShipGuard profile", exact: true }).click();
  await panel.getByRole("button", { name: "Open result thread", exact: true }).waitFor();
  assert.ok((await panel.innerText()).includes("Latest analysis · done"));
  await panel.getByLabel("Run daily").uncheck();
  await panel.getByRole("button", { name: "Save schedule", exact: true }).click();
  await panel.getByRole("status").filter({ hasText: "paused" }).waitFor();
  assert.equal(analysis.getAnalysisSchedule(bot.id).enabled, false);
  const invalid = await fetch(`${url}/bots/${bot.id}/analysis`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...input, time: "99:00" }) });
  assert.equal(invalid.status, 400);
  assert.equal(git("status", "--porcelain", "--untracked-files=no"), "");
  console.log("Analysis: validation, read-only setup, overlap guards, daily dispatch, missed runs, pause, restart, UI persistence and manual run verified.");
} finally {
  dispatch.launchAgent = realLaunch;
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  rmSync(data, { recursive: true, force: true });
}
