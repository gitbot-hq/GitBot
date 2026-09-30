// npm run build, then run with Playwright installed (or provided through NODE_PATH):
// node ui/scripts/rename-thread.test.mjs
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";

const data = mkdtempSync(join(tmpdir(), "gitbot-rename-"));
process.env.GITBOT_DATA_DIR = data;
const require = createRequire(import.meta.url);
const { createBot, createThread, getThread, touchThread, updateThread } = require("../../dist/bot-store.js");
const { handleRequest } = require("../../dist/server.js");
const { uiFileFor, serveUiFile } = require("../../dist/static-ui.js");
const { chromium } = require("playwright");
const bot = createBot({ name: "Docs Keeper", instructions: "Review documentation.", permissionMode: "ask-permissions" });
const thread = createThread(bot.id, data);
updateThread(thread.id, { title: "hi", titleIsAuto: true });
const server = http.createServer((req, res) => {
  const file = uiFileFor(req.method, req.url);
  if (file) serveUiFile(req, res, file);
  else void handleRequest(req, res, [], data);
});
let browser;
try {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.addInitScript(() => localStorage.setItem("gitbot-v2-threads-width", "360"));
  await page.goto(url);
  const row = page.locator(`[data-thread-id="${thread.id}"]`);
  await row.locator(".thread-open").dblclick();
  const input = page.getByRole("textbox", { name: "Thread name", exact: true });
  await input.fill("Documentation review");
  await mkdir("output/rename-threads", { recursive: true });
  await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
  await page.locator(".page").screenshot({ path: "output/rename-threads/editing.png" });
  const saved = page.waitForResponse(response => response.request().method() === "PATCH" && response.url().endsWith(`/threads/${thread.id}`));
  await input.press("Enter");
  assert.equal((await saved).status(), 200);
  await row.getByRole("button", { name: "Documentation review", exact: true }).waitFor();
  assert.equal(getThread(thread.id).titleIsAuto, false);
  assert.equal(getThread(thread.id).repoPath, thread.repoPath);
  await page.reload();
  await row.getByRole("button", { name: "Documentation review", exact: true }).waitFor();
  // Exercise the same bookkeeping a later chat turn calls, without running an agent.
  touchThread(thread.id, "Review the other repository and explain all the changes");
  await page.reload();
  await row.getByRole("button", { name: "Documentation review", exact: true }).waitFor();
  assert.equal(getThread(thread.id).messageCount, 1);
  for (const theme of ["light", "dark"]) {
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    await row.hover();
    await page.locator(".page").screenshot({ path: `output/rename-threads/${theme}.png` });
  }
  const rename = row.getByRole("button", { name: "Rename thread Documentation review", exact: true });
  await rename.focus();
  await page.keyboard.press("Enter");
  await input.fill("Cancel this name");
  await input.press("Escape");
  assert.equal(getThread(thread.id).title, "Documentation review");
  await rename.click();
  await input.fill("   ");
  assert.equal(await page.getByRole("button", { name: "Save thread name" }).isDisabled(), true);
  await input.fill("Pending name");
  await page.route("**/threads/*", route => route.request().method() === "PATCH"
    ? route.fulfill({ status: 500, json: { error: "Rename failed" } }) : route.continue());
  await input.press("Enter");
  await page.getByText("Rename failed", { exact: true }).waitFor();
  assert.equal(await input.inputValue(), "Pending name");
  assert.equal(getThread(thread.id).title, "Documentation review");
  await page.unroute("**/threads/*");
  await input.fill("  Release notes  ");
  const renamed = page.waitForResponse(response => response.request().method() === "PATCH");
  await page.getByRole("button", { name: "Save thread name" }).click();
  assert.equal((await renamed).status(), 200);
  await row.getByRole("button", { name: "Release notes", exact: true }).waitFor();
  for (const title of ["", "   ", null, 12]) {
    const response = await fetch(`${url}/threads/${thread.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title }),
    });
    assert.equal(response.status, 400);
    assert.equal(getThread(thread.id).title, "Release notes");
  }
  console.log("Thread rename: saved across reload and later turns; keyboard, cancel, validation and failed-save recovery verified.");
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  rmSync(data, { recursive: true, force: true });
}
