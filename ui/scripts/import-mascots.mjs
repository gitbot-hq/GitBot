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
  const hands = folder === 'HelloHands';
  const invalidTag = hands ? /<(?!\/?(?:path|ellipse|circle|rect|g|defs|linearGradient|stop)\b)/i : /<(?!\/?(?:path|ellipse|circle|rect|g)\b)/i;
  const checkedMarkup = hands ? markup.replace(/url\(#[\w-]+\)/g, '') : markup;
  if (!viewBox || invalidTag.test(markup) || /\bon\w+\s*=|href\s*=|url\s*\(|style\s*=/i.test(checkedMarkup)) throw new Error(`Unsupported SVG: ${file}`);
  for (const [, id] of markup.matchAll(/url\(#([\w-]+)\)/g)) if (!markup.includes(`id="${id}"`)) throw new Error(`Missing local gradient: ${file}`);
  return { id: label.toLowerCase().replaceAll(' ', '-'), label, viewBox, markup: folder === 'Bodyv2' ? markup.replace(/fill="(?:black|#D9D9D9)"/g, 'fill="currentColor"') : markup };
}));
const data = { bodies: await read('Bodyv2'), expressions: await read('Expressions'), accessories: [] };
const handSources = await read('HelloHands');
const handFaces = handSources.map(art => {
  // ponytail: these three exports put the face first; add a layer map if future exports differ.
  // Reading repeats that trio, so remove every copy from the prop layer.
  const face = [...art.markup.matchAll(/<path\b[^>]*\/>/g)].slice(0, 3).map(m => m[0]);
  if (face.length !== 3) throw new Error(`Missing face: ${art.id}`);
  const offset = Number(face[0].match(/d="M([\d.]+)/)?.[1]);
  if (!Number.isFinite(offset)) throw new Error(`Missing face origin: ${art.id}`);
  let props = art.markup;
  for (const shape of face) props = props.split(shape).join('');
  props = props.replace(/<(?:circle|ellipse)\b[^>]*fill="#FF0000"[^>]*\/>/g, hand => {
    const side = Number(hand.match(/cx="([^"]+)"/)?.[1]) < offset + 38.707 ? 'left' : 'right';
    return `<g class="bm-hand bm-hand-${side}">${hand.replace('fill="#FF0000"', 'fill="currentColor"')}</g>`;
  });
  if (art.id === 'thinking') props = `<g class="bm-thinking-hand">${props}</g>`;
  // Each rendered SVG replaces this prefix with its own React ID.
  const scope = markup => markup.replace(/(id="|url\(#)([\w-]+)/g, '$1__mascot_id__$2');
  data.accessories.push({ id: art.id, markup: scope(`<g transform="translate(${-offset} 0)"><g class="bm-prop">${props}</g></g>`) });
  data.expressions.push({ ...art, markup: scope(art.markup.replaceAll('fill="#FF0000"', 'fill="currentColor"')) });
  return { ...art, markup: face.join('') };
});
const lookSources = await read('LookAround');
const morphs = makeMorphs([...data.expressions.filter(art => !handFaces.some(face => face.id === art.id)), ...handFaces, ...lookSources]);
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
