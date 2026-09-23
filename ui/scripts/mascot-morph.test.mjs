import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
const file = new URL('../app/components/bot-maker/morph-geometry.ts', import.meta.url);
const source = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
const exports = {};
new Function('require', 'exports', source)(createRequire(file), exports);
const { morphs, blendFace, alignFace, parts } = exports;
const cross = (a,b,c) => (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
function selfIntersects(p) {
  for(let i=0;i<p.length;i++) for(let j=i+2;j<p.length;j++) {
    if(i===0 && j===p.length-1) continue;
    const a=p[i],b=p[(i+1)%p.length],c=p[j],d=p[(j+1)%p.length];
    if(cross(a,b,c)*cross(a,b,d)<-1e-8 && cross(c,d,a)*cross(c,d,b)<-1e-8) return true;
  }
  return false;
}
test('identical eyes stay fixed despite differently cropped expression exports', () => {
  for(const expression of ['happy','sad','confused','surprised']) for(const part of ['left','right']) assert.deepEqual(morphs.neutral[part], morphs[expression][part]);
});
test('every expression pair has finite, untwisted intermediate eyes and mouth', () => {
  for(const [an,a] of Object.entries(morphs)) for(const [bn,b] of Object.entries(morphs)) {
    const target = alignFace(a,b);
    for(const t of Array.from({ length: 41 }, (_, i) => i / 40)) {
      const frame = blendFace(a,target,t);
      for(const part of parts) assert.ok(frame[part].flat().every(Number.isFinite));
      for(const part of ['left','right','mouth']) assert.ok(!selfIntersects(frame[part]), `${an}→${bn}, ${part} at ${t}`);
    }
  }
});
test('interruption starts exactly at the visible frame and ends at the next target', () => {
  const visible = blendFace(morphs.neutral, alignFace(morphs.neutral,morphs.excited), .43);
  const next = alignFace(visible,morphs.wink);
  for(const part of parts) {
    assert.deepEqual(blendFace(visible,next,0)[part], visible[part]);
    blendFace(visible,next,1)[part].forEach((p,i) => p.forEach((n,j) => assert.ok(Math.abs(n-next[part][i][j])<1e-9)));
  }
});

test('new curved lids stay untwisted when interrupted by another positive expression', () => {
  for (const [start, end, next] of [['calm', 'playful-2', 'starry'], ['excited-wink', 'wink', 'sassy']]) {
    const visible = blendFace(morphs[start], alignFace(morphs[start], morphs[end]), .475);
    const target = alignFace(visible, morphs[next]);
    for (const part of parts) assert.deepEqual(blendFace(visible, target, 0)[part], visible[part]);
    for (let step = 0; step <= 40; step++) {
      const frame = blendFace(visible, target, step / 40);
      for (const part of ['left', 'right', 'mouth']) assert.ok(!selfIntersects(frame[part]), `${start}→${end} interrupted by ${next}: ${part}`);
    }
  }
});

test('all eight gaze directions move the eyes farther than the mouth in the requested direction', () => {
  const center = points => [0, 1].map(axis => points.reduce((sum, p) => sum + p[axis], 0) / points.length);
  const directions = { 'top-left': [-1,-1], top: [0,-1], 'top-right': [1,-1], left: [-1,0], right: [1,0], 'bottom-left': [-1,1], bottom: [0,1], 'bottom-right': [1,1] };
  for (const suffix of ['', '-curious']) {
    const base = morphs[`looking-around${suffix}`];
    for (const [name, vector] of Object.entries(directions)) {
      const face = morphs[`look-${name}${suffix}`];
      assert.ok(face, name);
      const eye = center([...face.left, ...face.right]), restEye = center([...base.left, ...base.right]);
      const mouth = center(face.mouth), restMouth = center(base.mouth);
      for (let axis = 0; axis < 2; axis++) {
        const movement = eye[axis] - restEye[axis], follow = mouth[axis] - restMouth[axis];
        if (vector[axis]) {
          assert.equal(Math.sign(movement), vector[axis], `${name} eye direction`);
          assert.equal(Math.sign(follow), vector[axis], `${name} mouth direction`);
          assert.ok(Math.abs(movement) > Math.abs(follow), `${name} eyes lead`);
        } else assert.ok(Math.abs(movement) < .1, `${name} stationary axis`);
      }
    }
  }
});

test('hand expressions keep duplicate faces out of props and recolor placeholder hands', () => {
  const artwork = JSON.parse(readFileSync(new URL('../app/components/bot-maker/artwork.json', import.meta.url), 'utf8'));
  for (const name of ['Reading', 'Thinking', 'Working']) {
    const id = name.toLowerCase();
    const prop = artwork.accessories.find(p => p.id === id);
    assert.ok(prop && morphs[id] && artwork.expressions.some(e => e.id === id));
    const source = readFileSync(new URL(`../Design/Mascots2/HelloHands/${name}.svg`, import.meta.url), 'utf8');
    for (const [facePath] of [...source.matchAll(/<path\b[^>]*\/>/g)].slice(0, 3)) assert.ok(!prop.markup.includes(facePath), `${name}: face duplicated over morph layer`);
    assert.ok(!prop.markup.includes('#FF0000'), `${name}: placeholder hand color`);
  }
});
