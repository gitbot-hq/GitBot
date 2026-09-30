// npm run build, then NODE_PATH=<Playwright modules> node ui/scripts/update-notice.test.mjs
// GITBOT_TEST_LIVE_UPDATES=1 also checks the real npm registry for the first notice.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';

const root = new URL('../../', import.meta.url).pathname;
const demo = mkdtempSync(join(tmpdir(), 'gitbot-updates-'));
process.env.GITBOT_DATA_DIR = demo;
const require = createRequire(import.meta.url);
const { checkForUpdate, isNewerStableRelease } = require('../../dist/updates.js');
const { handleRequest } = require('../../dist/server.js');
const { uiFileFor, serveUiFile } = require('../../dist/static-ui.js');
const store = require('../../dist/bot-store.js');
const { chromium } = require('playwright');
const current = require('../../package.json').version;
for (const [before, after, expected] of [
  ['0.0.9', '0.0.10', true], ['0.9.99', '0.10.0', true], ['0.99.99', '1.0.0', true],
  ['1.0.0', '0.99.99', false], ['0.0.10', '0.0.10', false], ['0.0.11', '0.0.10', false],
  ['1.0.0-beta.1', '1.0.0', true], ['1.0.0+build.1', '1.0.0+build.2', false],
  ['1.0.0', '1.1.0-beta.1', false], ['1.0.0', '01.1.0', false], ['bad', '1.0.0', false],
  ['1.0.0', null, false], ['1.0.0', '<script>bad</script>', false],
  ['1.0.0', '1.0.' + '9'.repeat(200), false],
]) assert.equal(isNewerStableRelease(before, after), expected, `${before} -> ${after}`);

const nativeFetch = globalThis.fetch;
const nativeNow = Date.now;
let now = nativeNow();
Date.now = () => now;
let registryCalls = 0;
const parts = current.split('.').map(Number);
const newer = `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
let registryPayload = process.env.GITBOT_TEST_LIVE_UPDATES ? undefined : { version: newer };
let registryFailure = null;
globalThis.fetch = async (input, options) => {
  if (String(input) !== 'https://registry.npmjs.org/@gitbot-hq%2Fgitbot/latest') return nativeFetch(input, options);
  registryCalls++;
  assert.ok(options.signal instanceof AbortSignal);
  if (registryFailure === 'offline') throw new Error('offline');
  if (registryFailure === 'http') return new Response(null, { status: 503 });
  if (registryFailure === 'json') return new Response('not json');
  if (registryPayload === undefined) return nativeFetch(input, options);
  return Response.json(registryPayload);
};
const bot = store.createBot({ name: 'PR Guardian', agent: 'claude-code', permissionMode: 'plan' });
store.createThread(bot.id, demo, 'Review auth.js');
const server = http.createServer((req, res) => {
  const file = uiFileFor(req.method, req.url);
  if (file) serveUiFile(req, res, file);
  else void handleRequest(req, res, ['claude-code'], demo);
});
let browser;
try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const statuses = await Promise.all([checkForUpdate(), checkForUpdate(), nativeFetch(`${url}/updates`).then(r => r.json())]);
  assert.equal(registryCalls, 1, 'Concurrent callers share one registry request');
  assert.deepEqual(statuses[0], statuses[1]);
  assert.deepEqual(statuses[0], statuses[2]);
  const status = statuses[0];
  assert.equal(status.currentVersion, current);
  assert.equal(status.updateAvailable, true);
  assert.equal(status.installCommand, 'npm i -g @gitbot-hq/gitbot');
  if (process.env.GITBOT_TEST_LIVE_UPDATES) console.log(`Real npm check: installed ${current}, npm latest ${status.latestVersion}.`);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript(id => {
    localStorage.setItem('gitbot-theme', 'light');
    localStorage.setItem('gitbot-avatars', JSON.stringify({ [id]: { mascot: 'cat', color: 'var(--brand-leaf)' } }));
  }, bot.id);
  await page.goto(url);
  const notice = page.getByRole('status', { name: 'GitBot update' });
  await notice.waitFor();
  assert.ok((await notice.innerText()).includes(`GitBot ${status.latestVersion} is available.`));
  assert.equal(await notice.locator('code').innerText(), status.installCommand);
  const output = join(root, 'output/version-update-notice');
  mkdirSync(output, { recursive: true });
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    await page.screenshot({ path: join(output, `available-${theme}.png`), animations: 'disabled' });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  const continueButton = page.getByRole('button', { name: 'Continue anyway', exact: true });
  if (await continueButton.isVisible()) await continueButton.click();
  const box = await notice.boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 390, 'Notice fits a phone viewport');
  assert.equal(await notice.evaluate(el => el.scrollWidth <= el.clientWidth), true);
  await page.screenshot({ path: join(output, 'available-mobile.png'), animations: 'disabled' });
  await page.setViewportSize({ width: 1440, height: 900 });
  assert.equal(registryCalls, 1, 'Browser uses the cached server result');

  registryPayload = { version: current }; // simulate an installed version matching npm latest
  now += 60 * 60 * 1000 + 1;
  const latest = await nativeFetch(`${url}/updates`).then(r => r.json());
  assert.equal(latest.updateAvailable, false);
  const checked = page.waitForResponse(response => response.url().endsWith('/updates'));
  await page.reload();
  await checked;
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.getByRole('button', { name: 'Open PR Guardian profile', exact: true }).waitFor();
  assert.equal(await notice.count(), 0);
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await page.screenshot({ path: join(output, 'up-to-date.png'), animations: 'disabled' });
  for (const payload of [{ version: '0.0.1' }, { version: '2.0.0-beta.1' }, { version: '<script>bad</script>' }, null]) {
    registryPayload = payload;
    now += 60 * 60 * 1000 + 1;
    assert.equal((await checkForUpdate()).updateAvailable, false);
  }
  for (const failure of ['offline', 'http', 'json']) {
    registryFailure = failure;
    now += 60 * 60 * 1000 + 1;
    const failed = await nativeFetch(`${url}/updates`).then(r => r.json());
    assert.equal(failed.updateAvailable, false);
    assert.equal(failed.latestVersion, null);
    const callsBefore = registryCalls;
    await checkForUpdate();
    assert.equal(registryCalls, callsBefore, 'Failures are cached too');
  }
  const failedCheck = page.waitForResponse(response => response.url().endsWith('/updates'));
  await page.reload();
  await failedCheck;
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.getByRole('button', { name: 'Open PR Guardian profile', exact: true }).waitFor();
  assert.equal(await notice.count(), 0);
  console.log('Update notice passed: numeric version comparison, stable releases, shared/hourly cache, offline/HTTP/JSON errors, real API/UI, current-version hidden state and mobile layout.');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
  globalThis.fetch = nativeFetch;
  Date.now = nativeNow;
  rmSync(demo, { recursive: true, force: true });
}
