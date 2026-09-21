import data from './morphs.json';
export type Point = number[];
export type FaceGeometry = { left: Point[]; right: Point[]; mouth: Point[]; tongue: Point[]; tongueOpacity: number; tongueColor: string };
export const morphs: Record<string, FaceGeometry> = { ...data, 'looking-around': data.neutral };
export const parts = ['left', 'right', 'mouth', 'tongue'] as const;
export function outline(points: Point[]) {
  return points.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(4)},${y.toFixed(4)}`).join('') + 'Z';
}
export function blendFace(from: FaceGeometry, to: FaceGeometry, t: number): FaceGeometry {
  const mix = (a: number, b: number) => a + (b - a) * t;
  const points = (part: typeof parts[number]) => from[part].map((p, i) => [mix(p[0], to[part][i][0]), mix(p[1], to[part][i][1])]);
  return { left: points('left'), right: points('right'), mouth: points('mouth'), tongue: points('tongue'), tongueOpacity: mix(from.tongueOpacity, to.tongueOpacity), tongueColor: to.tongueColor };
}

/** Match perimeter starting points without changing the target silhouette. */
export function alignFace(from: FaceGeometry, to: FaceGeometry): FaceGeometry {
  const aligned = { ...to };
  for (const part of parts) {
    const a = from[part], b = to[part];
    let best = 0, score = Infinity;
    for (let offset = 0; offset < b.length; offset++) {
      let distance = 0;
      for (let i = 0; i < a.length; i++) {
        const target = b[(i + offset) % b.length];
        distance += (a[i][0] - target[0]) ** 2 + (a[i][1] - target[1]) ** 2;
      }
      if (distance < score) { score = distance; best = offset; }
    }
    aligned[part] = b.map((_, i) => b[(i + best) % b.length]);
  }
  return aligned;
}
