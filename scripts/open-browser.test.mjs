// npm run build && node scripts/open-browser.test.mjs
// NODE_PATH=<Playwright modules> adds screenshots; GITBOT_TEST_NATIVE_BROWSER=1 opens one real browser tab.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';

const root = new URL('../', import.meta.url).pathname;
const require = createRequire(import.meta.url);
if (process.argv[2] === '--cli-case') {
  // Agent detection is unrelated to opening a browser. Avoid starting agent servers in the check.
  require('../dist/start-claude-code.js').initAgent = async () => false;
  require('../dist/start-opencode.js').initAgent = async () => false;
  require('../dist/start-codex.js').initAgent = async () => false;
  const childProcess = require('node:child_process');
  const nativeExecFile = childProcess.execFile;
  childProcess.execFile = (command, args, options, callback) => {
    const url = args.at(-1);
    const capture = async error => {
      const health = await fetch(`${url}/health`).then(r => r.json());
      const ui = await fetch(url);
      appendFileSync(process.env.GITBOT_BROWSER_CAPTURE, JSON.stringify({ command, args, healthReady: health.status === 'ok', uiReady: ui.status === 200, failed: !!error }) + '\n');
      callback(error, '', '');
    };
    if (process.env.GITBOT_BROWSER_FAIL) void capture(new Error('No desktop browser'));
    else if (process.env.GITBOT_BROWSER_NATIVE) return nativeExecFile(command, args, options, error => void capture(error));
    else void capture(null);
    return {};
  };
  process.argv = [process.execPath, join(root, 'dist/index.js'), ...process.argv.slice(3)];
  require('../dist/index.js');
} else {
  const demo = mkdtempSync(join(tmpdir(), 'gitbot-browser-'));
  const outputs = join(root, 'output/open-workspace-browser');
  const children = new Set();
  let screenshotBrowser;
  let playwright;
  try { playwright = require('playwright'); } catch { /* CLI checks do not require a browser dependency. */ }
  if (playwright) { mkdirSync(outputs, { recursive: true }); screenshotBrowser = await playwright.chromium.launch({ headless: true }); }
  async function freePort(requested = 0) {
    const server = http.createServer();
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(requested, '127.0.0.1', resolve); });
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    return port;
  }
  async function until(check, child) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (check()) return;
      if (child.exitCode !== null) throw new Error(`CLI exited ${child.exitCode} before the check finished`);
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    throw new Error('CLI check timed out');
  }
  async function runCase(name, noOpen = false, fail = false) {
    const port = fail ? await freePort() : await freePort(3000).catch(() => freePort());
    const cwd = join(demo, name);
    mkdirSync(cwd);
    const capture = join(cwd, 'browser.jsonl');
    const flags = ['start', ...(port === 3000 ? [] : ['-p', String(port)]), ...(noOpen ? ['--no-open'] : [])];
    const child = spawn(process.execPath, [new URL(import.meta.url).pathname, '--cli-case', ...flags], {
      cwd, env: { ...process.env, GITBOT_DATA_DIR: join(cwd, 'state'), GITBOT_BROWSER_CAPTURE: capture,
        GITBOT_BROWSER_FAIL: fail ? '1' : '', GITBOT_BROWSER_NATIVE: process.env.GITBOT_TEST_NATIVE_BROWSER && !noOpen && !fail ? '1' : '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.add(child);
    let log = '';
    child.stdout.on('data', data => { log += data; });
    child.stderr.on('data', data => { log += data; });
    try {
      await until(() => noOpen ? log.includes('skipped (--no-open)') : existsSync(capture), child);
      const calls = existsSync(capture) ? readFileSync(capture, 'utf8').trim().split('\n').map(JSON.parse) : [];
      assert.equal(calls.length, noOpen ? 0 : 1);
      if (!noOpen) {
        assert.equal(calls[0].args.at(-1), `http://localhost:${port}`);
        assert.equal(calls[0].healthReady, true, 'API is ready before browser dispatch');
        assert.equal(calls[0].uiReady, true, 'Workspace is ready before browser dispatch');
        assert.equal(calls[0].failed, fail);
      }
      if (fail) await until(() => log.includes('could not open automatically'), child);
      assert.equal((await fetch(`http://localhost:${port}/health`).then(r => r.json())).status, 'ok');
      if (screenshotBrowser && !fail) {
        const page = await screenshotBrowser.newPage({ viewport: { width: 1440, height: 950 } });
        await page.goto(`http://localhost:${port}`);
        await page.getByRole('heading', { name: 'Welcome to GitBot', exact: true }).waitFor();
        if (!noOpen) await page.screenshot({ path: join(outputs, 'workspace.png'), animations: 'disabled' });
        const terminal = await screenshotBrowser.newPage({ viewport: { width: 1100, height: 1050 } });
        const text = `$ node dist/index.js ${flags.join(' ')}\n\n${log}`;
        await terminal.setContent('<style>body{background:#171717;color:#eee;margin:28px}pre{white-space:pre-wrap;font:18px/1.4 monospace}</style><pre></pre>');
        await terminal.locator('pre').evaluate((el, text) => { el.textContent = text; }, text);
        await terminal.screenshot({ path: join(outputs, `${name}.png`), fullPage: true });
        writeFileSync(join(outputs, `${name}.txt`), text);
        await page.close(); await terminal.close();
      }
      console.log(`${name}: ${noOpen ? 'no opener called' : fail ? 'opener failed; workspace remains available' : 'opener called once after API and workspace are ready'}.`);
    } finally {
      child.kill('SIGTERM');
      await new Promise(resolve => { if (child.exitCode !== null) resolve(); else child.once('exit', resolve); });
      children.delete(child);
    }
  }
  try {
    const childProcess = require('node:child_process');
    const nativeExecFile = childProcess.execFile;
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    const common = require('../dist/server-common.js');
    const calls = [];
    try {
      childProcess.execFile = (command, args, options, callback) => { calls.push({ command, args, options }); callback(null); };
      for (const value of ['darwin', 'win32', 'linux']) {
        Object.defineProperty(process, 'platform', { value });
        common.openWorkspaceBrowser('http://localhost:4000');
      }
      assert.deepEqual(calls.map(c => [c.command, c.args]), [
        ['open', ['http://localhost:4000']],
        ['cmd.exe', ['/d', '/s', '/c', 'start', '""', 'http://localhost:4000']],
        ['xdg-open', ['http://localhost:4000']],
      ]);
      assert.ok(calls.every(c => c.options.timeout === 5000 && c.options.windowsHide));
    } finally { childProcess.execFile = nativeExecFile; Object.defineProperty(process, 'platform', platform); }
    await runCase('automatic-open');
    await runCase('no-open', true);
    await runCase('opener-unavailable', false, true);
    console.log('Browser startup check passed: CLI default, --no-open, actual chosen port, ready workspace, nonfatal opener failure and platform dispatch.');
  } finally {
    for (const child of children) child.kill('SIGTERM');
    await screenshotBrowser?.close();
    rmSync(demo, { recursive: true, force: true });
  }
}
