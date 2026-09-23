import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const exports = {};
new Function('exports', ts.transpileModule(readFileSync(new URL('../app/lib/chat-mascot-activity.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText)(exports);

test('live status selects task poses and clears them when the turn ends', () => {
  const { chatMascotActivity: activity } = exports;
  for (const label of ['Thinking…', 'Reconnecting…']) assert.equal(activity(label), 'thinking');
  for (const tool of ['Read', 'read', 'read_file', 'Grep', 'Glob', 'WebFetch', 'WebSearch']) assert.equal(activity(`Running ${tool}…`), 'reading');
  for (const label of ['Running Bash…', 'Running Edit…', 'Running Write…', 'Running unknown…', 'Writing…', 'Updated two files']) assert.equal(activity(label), 'working');
  assert.equal(activity('Waiting for your approval…'), 'listening');
  assert.equal(activity(null), undefined);
});
