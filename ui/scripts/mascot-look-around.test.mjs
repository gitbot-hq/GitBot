import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

test('each look-around bout visits two distinct directions before resting; cleanup stops it', () => {
  const source = ts.transpileModule(readFileSync(new URL('../app/components/bot-maker/LookAroundFace.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const poses = [], timers = new Map();
  let cleanup, nextId = 0;
  const exports = {};
  const require = name => {
    if (name === 'react') return {
      useState: initial => [initial, value => poses.push(value)],
      useEffect: effect => { cleanup = effect(); },
    };
    if (name === 'react/jsx-runtime') return { jsx: (_, props) => props };
    if (name === './MorphFace') return { default: () => null };
    throw new Error(`Unexpected import: ${name}`);
  };
  new Function('require', 'exports', 'matchMedia', 'setTimeout', 'clearTimeout', source)(
    require, exports,
    () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    (fn, delay) => { const id = ++nextId; timers.set(id, { fn, delay }); return id; },
    id => timers.delete(id),
  );
  exports.default({ expression: 'looking-around', duration: 420, motion: true });
  const advance = (min, max) => {
    assert.equal(timers.size, 1);
    const [id, { fn, delay }] = timers.entries().next().value;
    assert.ok(delay >= min && delay <= max);
    timers.delete(id); fn();
  };
  assert.equal(poses.at(-1), 'neutral');
  for (let bout = 0; bout < 5; bout++) {
    advance(5000, 10000);
    const first = poses.at(-1);
    assert.match(first, /^look-/);
    advance(1200, 2200);
    const second = poses.at(-1);
    assert.match(second, /^look-/);
    assert.notEqual(first.replace('-curious', ''), second.replace('-curious', ''));
    assert.equal(first.endsWith('-curious'), second.endsWith('-curious'));
    advance(1200, 2200);
    assert.equal(poses.at(-1), 'neutral');
  }
  cleanup();
  assert.equal(timers.size, 0);
});
