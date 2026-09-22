import { readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { makeMorphs, makeLookAroundMorphs, lookDirections } from './mascot-morph.mjs';
const root = resolve(import.meta.dirname, '..');
const read = async (folder) => Promise.all((await readdir(`${root}/Design/Mascots2/${folder}`)).filter(f => f.endsWith('.svg') && !f.startsWith('Vector ')).sort().map(async file => {
  const svg = await readFile(`${root}/Design/Mascots2/${folder}/${file}`, 'utf8');
  const label = file.replace('.svg', '').replace('Surpised', 'Surprised').replace('Traingle', 'Triangle');
  const viewBox = svg.match(/viewBox="([^"]+)"/)?.[1];
  const markup = svg.replace(/^[\s\S]*?<svg\b[^>]*>/, '').replace(/<\/svg>\s*$/, '').trim();
  // Only trusted, inert shape exports. Reject active content rather than injecting it.
  if (!viewBox || /<(?!\/?(?:path|ellipse|circle|rect|g)\b)/i.test(markup) || /\bon\w+\s*=|href\s*=|url\s*\(|style\s*=/i.test(markup)) throw new Error(`Unsupported SVG: ${file}`);
  return { id: label.toLowerCase().replaceAll(' ', '-'), label, viewBox, markup: folder === 'Bodyv2' ? markup.replace(/fill="(?:black|#D9D9D9)"/g, 'fill="currentColor"') : markup };
}));
const data = { bodies: await read('Bodyv2'), expressions: await read('Expressions') };
const lookSources = await read('LookAround');
const morphs = makeMorphs([...data.expressions, ...lookSources]);
const looks = makeLookAroundMorphs(morphs['look-around-expression-1'], morphs['look-around-expression-2']);
for (const source of lookSources) delete morphs[source.id];
Object.assign(morphs, looks);
const outline = points => points.map(([x,y], i) => `${i ? 'L' : 'M'}${x.toFixed(4)},${y.toFixed(4)}`).join('') + 'Z';
for (const id of ['looking-around', ...Object.keys(lookDirections).map(direction => `look-${direction}`)]) {
  const face = looks[id];
  data.expressions.push({ id, label: id === 'looking-around' ? 'Looking around' : id.replace('look-', 'Look ').replaceAll('-', ' '), viewBox: '0 0 78 104', markup: ['left', 'right', 'mouth'].map(part => `<path d="${outline(face[part])}" fill="black"/>`).join('') });
}
await writeFile(`${root}/app/components/bot-maker/artwork.json`, JSON.stringify(data, null, 2) + '\n');
await writeFile(`${root}/app/components/bot-maker/morphs.json`, JSON.stringify(morphs) + '\n');
console.log(`Imported ${data.bodies.length} bodies and ${data.expressions.length} expressions.`);
