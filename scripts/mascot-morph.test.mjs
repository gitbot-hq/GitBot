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
    for(const t of [0,.1,.25,.5,.75,.9,1]) {
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
