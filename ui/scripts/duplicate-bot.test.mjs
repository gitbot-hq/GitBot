// npm run build, then NODE_PATH=<Playwright modules> node ui/scripts/duplicate-bot.test.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';

const root = new URL('../../', import.meta.url).pathname;
const data = mkdtempSync(join(tmpdir(), 'gitbot-duplicate-'));
process.env.GITBOT_DATA_DIR = data;
const require = createRequire(import.meta.url);
const store = require('../../dist/bot-store.js');
const { handleRequest } = require('../../dist/server.js');
const { uiFileFor, serveUiFile } = require('../../dist/static-ui.js');
const { chromium } = require('playwright');
const source = store.createBot({
  name: 'PR Guardian', description: 'Review pull requests for correctness and test coverage.',
  emoji: '🛡️', agent: 'claude-code', model: 'claude-sonnet-4-6',
  instructions: 'Review the diff for bugs.\nCite files and lines.\nSuggest focused tests.',
  setupInstructions: 'Check that Git and Node.js are available. Do not install anything.',
  permissionMode: 'ask-permissions', allowedTools: ['Read', 'Grep', 'Glob'],
  disallowedTools: ['Bash', 'Write'], repoPath: data,
});
store.ensureSetupThread(source.id, data);
store.setSetupStatus(source.id, 'complete');
const original = store.getBot(source.id);
store.createThread(source.id, data, 'Review pull request 42');
let chatRequests = 0;
const server = http.createServer((req, res) => {
  if (req.url === '/chat') {
    chatRequests++;
    res.writeHead(500); res.end(JSON.stringify({ error: 'This check must not start an agent' }));
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
  assert.equal((await fetch(`${url}/bots/missing/duplicate`, { method: 'POST' })).status, 404);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1160 } });
  const pref = { mascot: 'cat', color: 'var(--brand-sun)' };
  await page.addInitScript(({ id, pref }) => {
    if (!localStorage.getItem('gitbot-avatars')) localStorage.setItem('gitbot-avatars', JSON.stringify({ [id]: pref }));
    localStorage.setItem('gitbot-theme', 'light');
  }, { id: source.id, pref });
  await page.goto(url);
  await page.getByRole('button', { name: 'Open PR Guardian profile', exact: true }).click();
  const profile = page.locator('.profile-pane');
  const output = join(root, 'output/duplicate-bots');
  mkdirSync(output, { recursive: true });
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    await profile.screenshot({ path: join(output, `profile-${theme}.png`) });
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  const response = page.waitForResponse(r => r.url().endsWith(`/bots/${source.id}/duplicate`) && r.request().method() === 'POST');
  await profile.getByRole('button', { name: 'Duplicate', exact: true }).click();
  const { bot: copy } = await (await response).json();
  assert.notEqual(copy.id, source.id);
  assert.equal(copy.name, 'Copy of PR Guardian');
  for (const key of ['description', 'emoji', 'instructions', 'agent', 'setupInstructions', 'model', 'repoPath', 'permissionMode', 'allowedTools', 'disallowedTools']) {
    assert.deepEqual(copy[key], original[key], key);
  }
  assert.equal(copy.setupStatus, 'pending');
  assert.equal(copy.setupThreadId, undefined);
  assert.deepEqual(store.listThreads(copy.id), []);
  const form = page.locator('[aria-label="Edit bot"]');
  const name = form.locator('.field').filter({ has: page.locator('label', { hasText: /^Name$/ }) }).locator('input');
  await name.waitFor();
  assert.equal(await name.inputValue(), copy.name);
  const fields = label => form.locator('.field').filter({ has: page.locator('label', { hasText: label }) });
  assert.equal(await fields(/^Instructions/).locator('textarea').inputValue(), original.instructions);
  assert.equal(await fields(/^Setup instructions/).locator('textarea').inputValue(), original.setupInstructions);
  assert.equal(await fields(/^Permissions/).locator('select').inputValue(), original.permissionMode);
  assert.equal(await fields(/^Allowed tools/).locator('input').inputValue(), original.allowedTools.join(', '));
  assert.deepEqual(await page.evaluate(id => JSON.parse(localStorage.getItem('gitbot-avatars'))[id], copy.id), pref);
  await page.locator('.toast').waitFor({ state: 'hidden' });
  await form.screenshot({ path: join(output, 'copy-editor.png'), animations: 'disabled' });
  await name.fill('Strict PR Guardian');
  await fields(/^Instructions/).locator('textarea').fill(`${original.instructions}\nRequire tests for every behavior change.`);
  const saved = page.waitForResponse(r => r.url().endsWith(`/bots/${copy.id}`) && r.request().method() === 'PATCH');
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  assert.equal((await saved).status(), 200);
  await page.locator('.form-overlay').filter({ has: form }).waitFor({ state: 'hidden' });
  assert.equal(store.getBot(copy.id).name, 'Strict PR Guardian');
  assert.match(store.getBot(copy.id).instructions, /Require tests/);
  assert.deepEqual(store.getBot(copy.id).disallowedTools, original.disallowedTools);
  assert.deepEqual(store.getBot(source.id), original);
  await profile.getByRole('heading', { name: 'Strict PR Guardian', exact: true }).waitFor();
  await profile.screenshot({ path: join(output, 'copy-profile.png'), animations: 'disabled' });
  // Mark the demo copy prepared before reload, which normally activates the first bot.
  store.setSetupStatus(copy.id, 'complete');
  await page.reload();
  await page.getByRole('button', { name: 'Open Strict PR Guardian profile', exact: true }).click();
  await profile.getByRole('heading', { name: 'Strict PR Guardian', exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(id => JSON.parse(localStorage.getItem('gitbot-avatars'))[id], copy.id), pref);
  assert.deepEqual(store.getBot(source.id), original);
  assert.equal(chatRequests, 0, 'Duplication/editing must not start setup or chat');
  for (const mode of ['auto-approve', 'plan']) {
    const bot = store.createBot({ name: `${mode} reviewer`, agent: 'codex', permissionMode: mode });
    const { bot: duplicate } = await fetch(`${url}/bots/${bot.id}/duplicate`, { method: 'POST' }).then(r => r.json());
    assert.equal(duplicate.permissionMode, mode);
    assert.equal(duplicate.agent, 'codex');
    assert.equal(duplicate.setupStatus, undefined);
  }
  console.log('Duplicate bot check passed: exact settings, fresh setup, no chats copied or started, independent edits, reload persistence, avatar and permission modes.');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
  rmSync(data, { recursive: true, force: true });
}
