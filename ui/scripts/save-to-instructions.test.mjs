// npm run build, then NODE_PATH=<Playwright modules> node ui/scripts/save-to-instructions.test.mjs
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const data = mkdtempSync(join(tmpdir(), 'gitbot-instructions-'));
process.env.GITBOT_DATA_DIR = data;
process.env.CLAUDE_CONFIG_DIR = join(data, 'claude');
const store = require('../../dist/bot-store.js');
const { presetSystemPrompt } = require('../../dist/bot-prompt.js');
const common = require('../../dist/server-common.js');
let agentStarts = 0;
let nextPrompt;
// Exercise the real /chat preset without starting a paid model or touching a repo.
require('../../dist/start-claude-code.js').runAgent = async session => {
  agentStarts++;
  nextPrompt = presetSystemPrompt(session.botPreset);
  session.status = 'done';
  common.emitEvent(session, 'done', {});
};
const { handleRequest } = require('../../dist/server.js');
const { uiFileFor, serveUiFile } = require('../../dist/static-ui.js');
const { chromium } = require('playwright');
const bot = store.createBot({
  name: 'PR Guardian', description: 'Review pull requests for bugs and missing tests.',
  instructions: 'Review the diff for correctness. Cite files and line numbers.',
  agent: 'claude-code', permissionMode: 'ask-permissions',
  setupInstructions: 'Check that Git is available.',
  allowedTools: ['Read', 'Grep'], disallowedTools: ['Write'], repoPath: data,
});
store.ensureSetupThread(bot.id, data);
store.setSetupStatus(bot.id, 'complete');
const original = store.getBot(bot.id);
const thread = store.createThread(bot.id, data, 'Keep our review conventions');
store.updateThread(thread.id, { sdkSessionId: 'demo-review', messageCount: 2 });
const prose = 'Keep the existing TypeScript naming conventions.\nSkip generated files in dist/ during reviews.\nUse strict equality in new code.';
const transcriptDir = join(process.env.CLAUDE_CONFIG_DIR, 'projects', data.replace(/[^a-zA-Z0-9]/g, '-'));
mkdirSync(transcriptDir, { recursive: true });
writeFileSync(join(transcriptDir, 'demo-review.jsonl'), [
  { type: 'user', userType: 'external', message: { content: 'Which conventions should we keep for future reviews?' } },
  { type: 'assistant', message: { content: [
    { type: 'text', text: prose },
    { type: 'tool_use', name: 'Read', input: { file_path: 'CONTRIBUTING.md' } },
  ] } },
].map(entry => JSON.stringify(entry)).join('\n'));
let failSave = false;
const server = http.createServer((req, res) => {
  if (failSave && req.method === 'POST' && req.url.endsWith('/instructions')) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Could not save. Please try again.' }));
    return;
  }
  const file = uiFileFor(req.method, req.url);
  if (file) serveUiFile(req, res, file);
  else void handleRequest(req, res, ['claude-code'], data);
});
let browser;
try {
  await new Promise((resolve, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  const append = (id, body) => fetch(`${url}/bots/${id}/instructions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  for (const body of [null, {}, { text: 42 }, { text: ' \n ' }]) {
    assert.equal((await append(bot.id, body)).status, 400);
  }
  assert.equal((await append('missing', { text: 'A rule' })).status, 404);
  assert.deepEqual(store.getBot(bot.id), original);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1080 } });
  await page.addInitScript(id => {
    localStorage.setItem('gitbot-theme', 'light');
    localStorage.setItem('gitbot-avatars', JSON.stringify({ [id]: { mascot: 'cat', color: 'var(--brand-sun)' } }));
  }, bot.id);
  await page.goto(url);
  const action = page.getByRole('button', { name: 'Save to instructions', exact: true });
  await action.waitFor();
  const output = new URL('../../output/save-to-instructions/', import.meta.url).pathname;
  mkdirSync(output, { recursive: true });
  await action.hover();
  await page.screenshot({ path: join(output, 'message-action.png'), animations: 'disabled' });
  await action.click();
  const dialog = page.getByRole('dialog', { name: 'Save to instructions' });
  const input = dialog.getByRole('textbox', { name: 'Instruction to keep' });
  assert.equal(await input.inputValue(), prose, 'Only message text, no tool payload');
  assert.equal(await input.evaluate(el => document.activeElement === el), true);
  await input.fill('   ');
  assert.equal(await dialog.getByRole('button', { name: 'Save to instructions', exact: true }).isDisabled(), true);
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  assert.deepEqual(store.getBot(bot.id), original, 'Cancel must not modify instructions');
  assert.equal(await action.evaluate(el => document.activeElement === el), true);
  await action.click();
  // Another edit after the dialog opened must survive the append.
  const base = `${original.instructions}\nKeep review comments concise.`;
  store.updateBot(bot.id, { instructions: base });
  const decision = 'Skip generated files in dist/ during reviews.\nUse strict equality in new code.';
  await input.fill(decision);
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    await page.screenshot({ path: join(output, `review-${theme}.png`), animations: 'disabled' });
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  failSave = true;
  await dialog.getByRole('button', { name: 'Save to instructions', exact: true }).click();
  await dialog.getByRole('alert').waitFor();
  assert.equal(await input.inputValue(), decision, 'Failed save keeps the draft');
  assert.equal(store.getBot(bot.id).instructions, base);
  failSave = false;
  await dialog.getByRole('button', { name: 'Save to instructions', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(agentStarts, 0, 'Saving instructions must not start any agent or setup');
  const saved = store.getBot(bot.id);
  assert.equal(saved.instructions, `${base}\n\n${decision}`);
  for (const key of Object.keys(original).filter(key => !['instructions', 'updatedAt'].includes(key))) {
    assert.deepEqual(saved[key], original[key], `Preserve ${key}`);
  }
  await page.reload();
  await page.getByRole('button', { name: 'Open PR Guardian profile', exact: true }).click();
  await page.locator('.profile-pane').getByRole('button', { name: 'Edit', exact: true }).click();
  const form = page.locator('[aria-label="Edit bot"]');
  const instructions = form.locator('.field').filter({ has: page.locator('label', { hasText: /^Instructions/ }) }).locator('textarea');
  assert.equal(await instructions.inputValue(), saved.instructions, 'Reload and bot editor show the saved decision');
  // Expand the resizable field so the appended lines are visible in the screenshot.
  await instructions.evaluate(el => { el.style.height = '180px'; });
  await form.screenshot({ path: join(output, 'saved-instructions.png'), animations: 'disabled' });
  const response = await fetch(`${url}/threads`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ botId: bot.id }),
  });
  assert.equal(response.status, 200);
  const { thread: next } = await response.json();
  const chat = await fetch(`${url}/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ threadId: next.id, prompt: 'Review this branch' }),
  });
  assert.equal(chat.status, 200);
  assert.equal(agentStarts, 1);
  assert.ok(nextPrompt.includes(saved.instructions), 'The new conversation receives both original instructions and the saved decision');
  console.log('Save to instructions passed: review/edit/cancel, validation, failed-save recovery, latest instructions preserved, settings unchanged, reload persistence, and new-thread system prompt. Screenshots use a seeded demo transcript; no paid agent runs.');
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  rmSync(data, { recursive: true, force: true });
}
