import svgpath from 'svgpath';
const COUNT = 128;
const attrs = s => Object.fromEntries([...s.matchAll(/([\w-]+)="([^"]*)"/g)].map(m => [m[1], m[2]]));
const area = p => p.reduce((a, v, i) => { const n = p[(i + 1) % p.length]; return a + v[0] * n[1] - n[0] * v[1]; }, 0);
function resample(points) {
  const lengths = points.map((p, i) => Math.hypot(p[0] - points[(i + 1) % points.length][0], p[1] - points[(i + 1) % points.length][1]));
  const total = lengths.reduce((a, b) => a + b, 0);
  let segment = 0, start = 0;
  return Array.from({ length: COUNT }, (_, i) => {
    const d = total * i / COUNT;
    while (segment < lengths.length - 1 && start + lengths[segment] < d) start += lengths[segment++];
    const t = (d - start) / (lengths[segment] || 1), a = points[segment], b = points[(segment + 1) % points.length];
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  });
}
// Flatten authored Beziers deterministically; retain their actual silhouette.
function flatten(d) {
  const points = []; let x = 0, y = 0, start = [0, 0];
  for (const [command, ...v] of svgpath(d).abs().unshort().unarc().segments) {
    if (command === 'M') { [x,y] = v; start = [x,y]; points.push([x,y]); }
    else if (command === 'C' || command === 'Q') {
      const ox = x, oy = y;
      for (let i=1;i<=96;i++) {
        const t=i/96, u=1-t;
        points.push(command === 'C' ? [u*u*u*ox+3*u*u*t*v[0]+3*u*t*t*v[2]+t*t*t*v[4], u*u*u*oy+3*u*u*t*v[1]+3*u*t*t*v[3]+t*t*t*v[5]] : [u*u*ox+2*u*t*v[0]+t*t*v[2], u*u*oy+2*u*t*v[1]+t*t*v[3]]);
      }
      [x,y]=v.slice(-2);
    } else {
      if(command==='L') [x,y]=v;
      else if(command==='H') x=v[0];
      else if(command==='V') y=v[0];
      else if(command==='Z') [x,y]=start;
      else throw new Error(`Unsupported path command ${command}`);
      if(Math.hypot(x-points.at(-1)[0],y-points.at(-1)[1]) > .000001) points.push([x,y]);
    }
  }
  return points;
}
// Resolve overlap on the inside of tight stroked corners (round caps stay intact).
function outerContour(points) {
  let ring = points;
  for (let pass=0;pass<32;pass++) {
    let next = null;
    for(let i=0;i<ring.length && !next;i++) for(let j=i+2;j<ring.length;j++) {
      if(i===0 && j===ring.length-1) continue;
      const a=ring[i], b=ring[(i+1)%ring.length], c=ring[j], d=ring[(j+1)%ring.length];
      const rx=b[0]-a[0], ry=b[1]-a[1], sx=d[0]-c[0], sy=d[1]-c[1], det=rx*sy-ry*sx;
      if(Math.abs(det)<1e-9) continue;
      const t=((c[0]-a[0])*sy-(c[1]-a[1])*sx)/det, u=((c[0]-a[0])*ry-(c[1]-a[1])*rx)/det;
      if(t<=1e-6 || t>=1-1e-6 || u<=1e-6 || u>=1-1e-6) continue;
      const hit=[a[0]+t*rx,a[1]+t*ry];
      const one=[hit,...ring.slice(i+1,j+1)], two=[hit,...ring.slice(j+1),...ring.slice(0,i+1)];
      next=Math.abs(area(one))>Math.abs(area(two))?one:two; break;
    }
    if(!next) return ring;
    ring=next;
  }
  return ring;
}
function contour(element) {
  const a = attrs(element);
  let d = a.d;
  if (element.startsWith('<ellipse')) {
    const [cx, cy, rx, ry] = ['cx', 'cy', 'rx', 'ry'].map(k => Number(a[k]));
    d = `M${cx-rx} ${cy} A${rx} ${ry} 0 1 0 ${cx+rx} ${cy} A${rx} ${ry} 0 1 0 ${cx-rx} ${cy}Z`;
  }
  if (!d) throw new Error('Morph expressions require path or ellipse elements');
  if (a.transform) d = svgpath(d).transform(a.transform).toString();
  const centerline = flatten(d);
  const lengths = centerline.slice(1).map((p,i)=>Math.hypot(p[0]-centerline[i][0],p[1]-centerline[i][1]));
  const length = lengths.reduce((a,b)=>a+b,0);
  const at = distance => {
    const d = Math.max(0,Math.min(length,distance)); let start=0, i=0;
    while(i<lengths.length-1 && start+lengths[i]<d) start+=lengths[i++];
    const t=(d-start)/(lengths[i]||1), a=centerline[i], b=centerline[i+1];
    return [a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t];
  };
  let ring;
  if (a.stroke && a.stroke !== 'none') {
    const r = Number(a['stroke-width'] ?? 1) / 2;
    const samples = Array.from({ length: 129 }, (_, i) => {
      const t = length * i / 128, v = at(t), before = at(t - .01), after = at(t + .01);
      const angle = Math.atan2(after[1] - before[1], after[0] - before[0]);
      return { v, angle };
    });
    const side = (s, sign) => [s.v[0] - Math.sin(s.angle) * r * sign, s.v[1] + Math.cos(s.angle) * r * sign];
    const cap = (s, start) => Array.from({ length: 17 }, (_, i) => { const angle = s.angle + start - Math.PI * i / 16; return [s.v[0] + Math.cos(angle) * r, s.v[1] + Math.sin(angle) * r]; });
    ring = [...samples.map(s => side(s, 1)), ...cap(samples.at(-1), Math.PI / 2), ...samples.toReversed().map(s => side(s, -1)), ...cap(samples[0], -Math.PI / 2)];
  } else ring = Array.from({ length: 512 }, (_, i) => at(length * i / 512));
  ring = resample(outerContour(ring));
  if (area(ring) < 0) ring.reverse();
  const xs = ring.map(p => p[0]), ys = ring.map(p => p[1]);
  return { ring, fill: a.fill, cx: (Math.min(...xs) + Math.max(...xs)) / 2, cy: (Math.min(...ys) + Math.max(...ys)) / 2, height: Math.max(...ys) - Math.min(...ys) };
}
function align(ring, reference) {
  let best = 0, distance = Infinity;
  for (let offset = 0; offset < COUNT; offset++) {
    const score = ring.reduce((sum, _, i) => { const a = ring[(i + offset) % COUNT], b = reference[i]; return sum + (a[0]-b[0])**2 + (a[1]-b[1])**2; }, 0);
    if (score < distance) { distance = score; best = offset; }
  }
  return ring.map((_, i) => ring[(i + best) % COUNT].map(n => Math.round(n * 10000) / 10000));
}
export function makeMorphs(expressions) {
  const faces = {};
  for (const art of expressions) {
    const features = [...art.markup.matchAll(/<(?:path|ellipse)\b[^>]*\/?\s*>/g)].map(m => contour(m[0]));
    const tongue = features.find(f => f.fill && !['black', '#000', '#000000', 'none'].includes(f.fill));
    const ink = features.filter(f => f !== tongue);
    if (ink.length !== 3) throw new Error(`${art.id}: expected two eyes and one mouth`);
    // The mouth is the lowest feature, independent of export element order.
    const mouth = ink.toSorted((a,b) => b.cy-a.cy)[0];
    const eyes = ink.filter(f => f !== mouth).sort((a,b) => a.cx-b.cx);
    const scale = 53.707 / (eyes[1].cx - eyes[0].cx);
    const dx = 11.8535 - eyes[0].cx * scale;
    // Keep tall eyes stationary (including a single tall eye in Wink).
    const anchor = eyes.find(e => e.height > 45) ?? { cy: (eyes[0].cy + eyes[1].cy) / 2 };
    const dy = 35.3086 - anchor.cy * scale;
    const transform = f => f.ring.map(([x,y]) => [x * scale + dx, y * scale + dy]);
    const mouthRing = transform(mouth);
    const bottom = Math.max(...mouthRing.map(p=>p[1]));
    faces[art.id] = { left: transform(eyes[0]), right: transform(eyes[1]), mouth: mouthRing, tongue: tongue ? transform(tongue) : Array.from({length:COUNT},()=>[38.707,bottom]), tongueOpacity: tongue ? 1 : 0, tongueColor: tongue?.fill ?? '#FA6578' };
  }
  const reference = faces.neutral;
  for (const face of Object.values(faces)) for (const part of ['left','right','mouth','tongue']) face[part] = align(face[part], part === 'tongue' ? faces.happy.tongue : reference[part]);
  return faces;
}

// Derive gaze poses from the two authored short-eye faces, in the same fixed
// coordinates as all other expressions. Eyes lead; the mouth follows gently.
export const lookDirections = {
  'top-left': [-1, -1], top: [0, -1], 'top-right': [1, -1],
  left: [-1, 0], right: [1, 0],
  'bottom-left': [-1, 1], bottom: [0, 1], 'bottom-right': [1, 1],
};
export function makeLookAroundMorphs(smile, curious) {
  const result = { 'looking-around': smile, 'looking-around-curious': curious };
  for (const [direction, [x, y]] of Object.entries(lookDirections)) {
    for (const [suffix, face] of [['', smile], ['-curious', curious]]) {
      const shifted = { ...face };
      for (const part of ['left', 'right', 'mouth', 'tongue']) {
        const eye = part === 'left' || part === 'right';
        // Downward diagonals use the opposite eye-size emphasis.
        const smallerSide = y > 0 ? (x < 0 ? 'left' : 'right') : (x > 0 ? 'left' : 'right');
        const farEye = eye && part === smallerSide;
        const cx = part === 'left' ? 11.8535 : 65.5605;
        shifted[part] = face[part].map(([px, py]) => {
          // A small perspective squeeze makes a sideways glance read as a turn.
          const sx = eye && x && farEye ? cx + (px - cx) * .9 : px;
          const sy = eye && x && farEye ? 35.3086 + (py - 35.3086) * .94 : py;
          return [sx + x * (eye ? 11 : 6), sy + y * (eye ? 13 : 6)];
        });
      }
      result[`look-${direction}${suffix}`] = shifted;
    }
  }
  return result;
}
