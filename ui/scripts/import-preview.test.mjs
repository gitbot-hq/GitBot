// Serve ui/out, then run with Playwright installed (or provided through NODE_PATH):
// GITBOT_PREVIEW_URL=http://127.0.0.1:3338 node --experimental-strip-types ui/scripts/import-preview.test.mjs
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { parseShare, shareCode } from "../app/lib/share.ts";

const { chromium } = createRequire(import.meta.url)("playwright");
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 1200 } });
  let imported;
  let resolveImport;
  const submitted = new Promise(resolve => { resolveImport = resolve; });
  await page.route("**/agents", route => route.fulfill({ json: { agents: ["claude-code", "codex"] } }));
  await page.route("**/bots", route => {
    if (route.request().method() === "POST") {
      imported = route.request().postDataJSON();
      resolveImport();
      return route.abort(); // No bot or setup run is created during this check.
    }
    return route.fulfill({ json: { bots: [] } });
  });
  await page.goto(`${process.env.GITBOT_PREVIEW_URL ?? "http://127.0.0.1:3338"}/onboarding.html`);
  await page.getByRole("button", { name: "Import bot", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Import bot" });
  const input = dialog.getByLabel("Bot code");
  const button = dialog.getByRole("button", { name: "Import bot", exact: true });
  await input.fill("invalid code");
  assert.equal(await button.isDisabled(), true);
  const bot = {
    name: "Import review demo", emoji: "🤖", description: "Check every setting before importing.",
    agent: "claude-code", permissionMode: "auto-approve", model: "test-model",
    setupInstructions: "Check that git is installed.\nExplain the result.",
    instructions: "Review documentation.\nPreserve this full line.\n<img src=x onerror=alert(1)>\n" + "Long instruction ".repeat(100),
    allowedTools: ["Read", "Bash"], disallowedTools: ["Write"],
  };
  const code = shareCode(bot);
  await input.fill(code);
  await dialog.getByRole("alert").waitFor();
  for (const text of ["Claude Code", "Auto-approve tools", "test-model", "Read, Bash", "Write"]) {
    assert.ok((await dialog.innerText()).includes(text));
  }
  for (const [title, content] of [["Setup steps", bot.setupInstructions], ["Full instructions", bot.instructions]]) {
    const summary = dialog.locator("summary").filter({ hasText: title });
    await summary.focus();
    await page.keyboard.press("Enter");
    assert.equal(await summary.locator("..").locator("pre").textContent(), content);
    assert.equal(await summary.locator("..").getAttribute("open"), "");
  }
  assert.equal(await dialog.locator(".import-preview img").count(), 0);
  assert.equal(imported, undefined);
  await input.fill(shareCode({ ...bot, name: "Docs Keeper", model: "", instructions: "Read README.md and compare it with the current code.\nList documentation gaps.\nExplain any proposed edits before making them." }));
  await page.locator("#bot-import-code").blur();
  await mkdir("output/import-preview", { recursive: true });
  for (const theme of ["light", "dark"]) {
    await page.evaluate(value => document.documentElement.dataset.theme = value, theme);
    await dialog.screenshot({ path: `output/import-preview/${theme}.png` });
  }
  await input.fill(code);
  await button.click();
  await submitted;
  assert.deepEqual(imported, parseShare(code));
  await page.getByRole("button", { name: "Import bot", exact: true }).click();
  await page.getByLabel("Bot code").fill(shareCode({ name: "Legacy bot" }));
  assert.ok((await dialog.innerText()).includes("Ask before each tool"));
  assert.equal(await dialog.getByRole("alert").count(), 0);
  await page.getByLabel("Bot code").fill(shareCode({ name: "Codex bot", agent: "codex", permissionMode: "auto-approve", allowedTools: ["Read"] }));
  assert.ok((await dialog.innerText()).includes("Full access"));
  assert.ok((await dialog.innerText()).includes("Codex does not enforce tool lists."));
  console.log("Import preview: full text, warning, defaults, escaped content and unchanged payload verified.");
} finally {
  await browser.close();
}
