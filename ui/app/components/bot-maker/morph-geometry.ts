import data from './morphs.json';
export type Point = number[];
export type FaceGeometry = { left: Point[]; right: Point[]; mouth: Point[]; tongue: Point[]; tongueOpacity: number; tongueColor: string };
export const morphs: Record<string, FaceGeometry> = data;
export const parts = ['left', 'right', 'mouth', 'tongue'] as const;
export function outline(points: Point[]) {
  return points.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(4)},${y.toFixed(4)}`).join('') + 'Z';
}
export function blendFace(from: FaceGeometry, to: FaceGeometry, t: number): FaceGeometry {
  const mix = (a: number, b: number) => a + (b - a) * t;
  const points = (part: typeof parts[number]) => from[part].map((p, i) => [mix(p[0], to[part][i][0]), mix(p[1], to[part][i][1])]);
  return { left: points('left'), right: points('right'), mouth: points('mouth'), tongue: points('tongue'), tongueOpacity: mix(from.tongueOpacity, to.tongueOpacity), tongueColor: to.tongueColor };
}

const cross = (a: Point, b: Point) => a[0] * b[1] - a[1] * b[0];
const subtract = (a: Point, b: Point) => [a[0] - b[0], a[1] - b[1]];

// Each edge orientation is quadratic in time. Between its roots the sign is
// constant, so checking those intervals catches crossings even between frames.
function orientation(a: Point, da: Point, b: Point, db: Point, c: Point, dc: Point) {
  const u = subtract(b, a), v = subtract(c, a), du = subtract(db, da), dv = subtract(dc, da);
  return [cross(u, v), cross(du, v) + cross(u, dv), cross(du, dv)];
}
function roots([c, b, a]: number[]) {
  if (Math.abs(a) < 1e-10) return Math.abs(b) < 1e-10 ? [] : [-c / b];
  const d = b * b - 4 * a * c;
  return d < 0 ? [] : [(-b - Math.sqrt(d)) / (2 * a), (-b + Math.sqrt(d)) / (2 * a)];
}
function crossesDuringMorph(a: Point[], b: Point[], offset: number) {
  const target = b.map((_, i) => b[(i + offset) % b.length]);
  const delta = a.map((p, i) => subtract(target[i], p));
  const bounds = a.map((p, i) => {
    const j = (i + 1) % a.length;
    return [Math.min(p[0], a[j][0], target[i][0], target[j][0]), Math.max(p[0], a[j][0], target[i][0], target[j][0]), Math.min(p[1], a[j][1], target[i][1], target[j][1]), Math.max(p[1], a[j][1], target[i][1], target[j][1])];
  });
  for (let i = 0; i < a.length; i++) for (let j = i + 2; j < a.length; j++) {
    if (i === 0 && j === a.length - 1) continue;
    const box = bounds[i], other = bounds[j];
    if (box[1] < other[0] || other[1] < box[0] || box[3] < other[2] || other[3] < box[2]) continue;
    const k = (i + 1) % a.length, l = (j + 1) % a.length;
    const polynomials = [
      orientation(a[i], delta[i], a[k], delta[k], a[j], delta[j]),
      orientation(a[i], delta[i], a[k], delta[k], a[l], delta[l]),
      orientation(a[j], delta[j], a[l], delta[l], a[i], delta[i]),
      orientation(a[j], delta[j], a[l], delta[l], a[k], delta[k]),
    ];
    const times = [0, ...polynomials.flatMap(roots).filter(t => t > 0 && t < 1), 1].sort((x, y) => x - y);
    for (let n = 1; n < times.length; n++) {
      const t = (times[n - 1] + times[n]) / 2;
      const values = polynomials.map(([c, b, a]) => c + b * t + a * t * t);
      if (values[0] * values[1] < -1e-8 && values[2] * values[3] < -1e-8) return true;
    }
  }
  return false;
}

const correspondenceCache = new WeakMap<Point[], WeakMap<Point[], Point[]>>();

/** Match perimeter starting points without changing the target silhouette. */
export function alignFace(from: FaceGeometry, to: FaceGeometry): FaceGeometry {
  const aligned = { ...to };
  for (const part of parts) {
    const a = from[part], b = to[part];
    const cached = correspondenceCache.get(a)?.get(b);
    if (cached) { aligned[part] = cached; continue; }
    const candidates = b.map((_, offset) => {
      let distance = 0;
      for (let i = 0; i < a.length; i++) {
        const target = b[(i + offset) % b.length];
        distance += (a[i][0] - target[0]) ** 2 + (a[i][1] - target[1]) ** 2;
      }
      return { offset, distance };
    }).sort((x, y) => x.distance - y.distance);
    const best = part === 'tongue' ? candidates[0] : candidates.find(({ offset }) => !crossesDuringMorph(a, b, offset)) ?? candidates[0];
    aligned[part] = b.map((_, i) => b[(i + best.offset) % b.length]);
    let targets = correspondenceCache.get(a);
    if (!targets) { targets = new WeakMap(); correspondenceCache.set(a, targets); }
    targets.set(b, aligned[part]);
  }
  return aligned;
}
