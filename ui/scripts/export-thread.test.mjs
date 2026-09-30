// npm run build, then NODE_PATH=<Playwright modules> node --experimental-strip-types ui/scripts/export-thread.test.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { threadMarkdown, threadMarkdownFilename } from '../app/lib/thread-markdown.ts';

const code = '```js\nif (!authorization) return res.sendStatus(401);\n```';
assert.equal(threadMarkdownFilename('../CON: review?'), 'gitbot-..-CON- review-.md');
assert.equal(threadMarkdownFilename('  '), 'gitbot-thread.md');
assert.ok(threadMarkdownFilename('x'.repeat(200)).length <= 110);
assert.equal(threadMarkdown('A\n# review', [{ role: 'user', text: '  ' }]), '# A \\# review\n\n_Exported from GitBot. Tool calls are omitted._\n\n\n');
assert.ok(threadMarkdown('Review', [{ role: 'assistant', text: code }]).includes(code));

const root = new URL('../../', import.meta.url).pathname;
const demo = mkdtempSync(join(tmpdir(), 'gitbot-export-'));
const repo = join(demo, 'review-demo');
mkdirSync(repo);
process.env.GITBOT_DATA_DIR = join(demo, 'state');
process.env.CLAUDE_CONFIG_DIR = join(demo, 'claude');
const require = createRequire(import.meta.url);
const store = require('../../dist/bot-store.js');
const { handleRequest } = require('../../dist/server.js');
const { uiFileFor, serveUiFile } = require('../../dist/static-ui.js');
const { chromium } = require('playwright');
const bot = store.createBot({ name: 'PR Guardian', agent: 'claude-code', permissionMode: 'plan', description: 'Review pull requests for bugs.' });
const empty = store.createThread(bot.id, repo, 'Empty thread');
const thread = store.createThread(bot.id, repo, 'Review auth.js');
store.bindSession(thread.id, 'demo-review');
const first = 'Review auth.js and tell me what is wrong.';
const finding = '**Verdict: 3 bugs found.**\n\n1. `auth.js:12`: Missing Authorization header can crash the handler.\n2. `auth.js:13`: Loose equality can match an unintended token.\n3. `auth.js:13`: `db` is used without being imported.\n\nAdd a header guard and use strict equality.';
const followup = 'Show me an example header guard.';
const answer = `Return 401 when the header is missing:\n\n${code}`;
const entries = [
  { type: 'user', userType: 'external', message: { content: first } },
  { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'auth.js', private_tool_marker: 'omit-this-tool-data' } }] } },
  { type: 'assistant', message: { content: [{ type: 'text', text: finding }] } },
  { type: 'user', userType: 'external', message: { content: followup } },
  { type: 'assistant', message: { content: [{ type: 'text', text: answer }] } },
];
const transcripts = join(process.env.CLAUDE_CONFIG_DIR, 'projects', repo.replace(/[^a-zA-Z0-9]/g, '-'));
mkdirSync(transcripts, { recursive: true });
writeFileSync(join(transcripts, 'demo-review.jsonl'), entries.map(entry => JSON.stringify(entry)).join('\n'));
let historyUnavailable = false;
let chatRequests = 0;
const server = http.createServer((req, res) => {
  if (req.url === '/chat') {
    chatRequests++; res.writeHead(500); res.end(JSON.stringify({ error: 'No agent runs in this check' })); return;
  }
  if (historyUnavailable && req.url === `/threads/${thread.id}/messages`) {
    res.writeHead(500); res.end(JSON.stringify({ error: 'Transcript unavailable' })); return;
  }
  const file = uiFileFor(req.method, req.url);
  if (file) serveUiFile(req, res, file);
  else void handleRequest(req, res, ['claude-code'], repo);
});
let browser;
try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const url = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, acceptDownloads: true });
  await page.addInitScript(id => {
    localStorage.setItem('gitbot-theme', 'light');
    localStorage.setItem('gitbot-avatars', JSON.stringify({ [id]: { mascot: 'cat', color: 'var(--brand-leaf)' } }));
  }, bot.id);
  await page.goto(url);
  await page.getByRole('button', { name: 'Review auth.js', exact: true }).click();
  await page.getByText('Verdict: 3 bugs found.', { exact: true }).waitFor();
  assert.ok((await page.locator('.chat').innerText()).includes('1 tool call'));
  const output = join(root, 'output/export-thread-markdown');
  mkdirSync(output, { recursive: true });
  await page.getByRole('button', { name: 'More chat options' }).click();
  const menu = page.getByRole('menu', { name: 'Chat options' });
  await menu.getByRole('menuitem', { name: 'Download as Markdown' }).waitFor();
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    await page.screenshot({ path: join(output, `menu-${theme}.png`), animations: 'disabled' });
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await menu.press('End');
  assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Download as Markdown');
  const downloadEvent = page.waitForEvent('download');
  await page.keyboard.press('Enter');
  const download = await downloadEvent;
  assert.equal(download.suggestedFilename(), 'gitbot-Review auth.js.md');
  const markdown = readFileSync(await download.path(), 'utf8');
  assert.equal(markdown, threadMarkdown(thread.title, [
    { role: 'user', text: first }, { role: 'assistant', text: finding },
    { role: 'user', text: followup }, { role: 'assistant', text: answer },
  ]));
  assert.equal(markdown.includes('omit-this-tool-data'), false);
  assert.equal(markdown.includes('tool_use'), false);
  writeFileSync(join(output, download.suggestedFilename()), markdown);
  // Render the actual downloaded Markdown through the same GFM renderer used by chat.
  const renderPage = await browser.newPage();
  const React = require(join(root, 'ui/node_modules/react'));
  const { renderToStaticMarkup } = require(join(root, 'ui/node_modules/react-dom/server'));
  const { default: Markdown } = await import('../node_modules/react-markdown/index.js');
  const { default: remarkGfm } = await import('../node_modules/remark-gfm/index.js');
  const html = renderToStaticMarkup(React.createElement(Markdown, { remarkPlugins: [remarkGfm] }, markdown));
  assert.ok(html.includes('<pre><code class="language-js">'));
  await renderPage.setViewportSize({ width: 1000, height: 1120 });
  await renderPage.setContent(`<style>body{font:16px/1.6 system-ui;color:#202020;margin:40px auto;max-width:860px}h1,h2{line-height:1.3}h2{margin-top:28px}hr{border:0;border-top:1px solid #ddd;margin:24px 0}pre{background:#f6f8fa;padding:16px;border-radius:6px}code{font-family:monospace}</style>${html}`);
  await renderPage.screenshot({ path: join(output, 'download-preview.png'), fullPage: true });
  await page.getByRole('button', { name: 'Empty thread', exact: true }).click();
  await page.getByRole('button', { name: 'More chat options' }).click();
  assert.equal(await menu.getByRole('menuitem', { name: 'Download as Markdown' }).isDisabled(), true);
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('button', { name: 'More chat options' }).evaluate(el => el === document.activeElement), true);
  historyUnavailable = true;
  await page.getByRole('button', { name: 'Review auth.js', exact: true }).click();
  await page.locator('.chat-error').filter({ hasText: 'Transcript unavailable' }).waitFor();
  await page.getByRole('button', { name: 'More chat options' }).click();
  assert.equal(await menu.getByRole('menuitem', { name: 'Download as Markdown' }).isDisabled(), true);
  assert.equal(chatRequests, 0);
  console.log('Markdown export passed: actual saved transcript/download, ordered turns, omitted tool data, intact code fences, GFM rendering, safe filename, keyboard action, empty/error states.');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
  rmSync(demo, { recursive: true, force: true });
}
