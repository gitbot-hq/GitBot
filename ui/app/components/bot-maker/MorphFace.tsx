'use client';
import { useEffect, useId, useRef, useState } from 'react';
import { alignFace, blendFace, morphs, outline, parts, type FaceGeometry } from './morph-geometry';

// These poses already have closed or winking eyes.
const closedEyeExpressions = new Set(['sleepy', 'wink', 'excited-wink', 'calm', 'excited', 'playful', 'playful-2']);

export default function MorphFace({ expression, duration, motion }: { expression: string; duration: number; motion: boolean }) {
  const target = morphs[expression] ?? morphs.neutral;
  const [initial] = useState(target);
  const current = useRef(initial);
  const svg = useRef<SVGSVGElement>(null);
  const mouthClip = useId();

  useEffect(() => {
    const root = svg.current;
    if (!root) return;
    const paths = parts.map(part => root.querySelector<SVGPathElement>(`[data-part="${part}"]`)!);
    const clip = root.querySelector<SVGPathElement>('[data-mouth-clip]')!;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    let frame = 0;
    const paint = (geometry: FaceGeometry) => {
      current.current = geometry;
      parts.forEach((part, i) => paths[i].setAttribute('d', outline(geometry[part])));
      clip.setAttribute('d', outline(geometry.mouth));
      paths[3].setAttribute('opacity', String(geometry.tongueOpacity));
      paths[3].setAttribute('fill', geometry.tongueColor);
    };
    const spinStars = () => {
      if (expression !== 'starry' || !motion || reduced.matches) return;
      const centers = [target.left, target.right].map(eye => {
        const xs = eye.map(p => p[0]), ys = eye.map(p => p[1]);
        return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
      });
      const start = performance.now();
      const tick = (now: number) => {
        const elapsed = now - start;
        // Ease gently into a 24-second revolution, with opposite directions.
        const angle = (elapsed - 600 * (1 - Math.exp(-elapsed / 600))) / 24000 * Math.PI * 2;
        const eyes = [target.left, target.right].map((eye, i) => {
          const [cx, cy] = centers[i], a = i === 0 ? angle : -angle;
          const cos = Math.cos(a), sin = Math.sin(a);
          return eye.map(([x, y]) => [cx + (x - cx) * cos - (y - cy) * sin, cy + (x - cx) * sin + (y - cy) * cos]);
        });
        // Keep the visible pose so the next expression morphs from the rotated eyes.
        current.current = { ...target, left: eyes[0], right: eyes[1] };
        paths[0].setAttribute('d', outline(eyes[0]));
        paths[1].setAttribute('d', outline(eyes[1]));
        frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
    };
    const finish = () => { cancelAnimationFrame(frame); paint(target); root.dataset.morphing = 'false'; spinStars(); };
    if (!motion || reduced.matches || current.current === target) finish();
    else {
      // Start at the visible geometry, even if an earlier morph was interrupted.
      const from = current.current;
      const destination = alignFace(from, target);
      const start = performance.now();
      const ms = Math.max(120, Math.min(duration, 2000));
      root.dataset.morphing = 'true';
      const tick = (now: number) => {
        const t = Math.min(1, (now - start) / ms);
        const eased = t * t * (3 - 2 * t);
        paint(blendFace(from, destination, eased));
        if (t < 1) frame = requestAnimationFrame(tick);
        else finish();
      };
      frame = requestAnimationFrame(tick);
    }
    const preferenceChanged = () => { if (reduced.matches) finish(); else spinStars(); };
    reduced.addEventListener('change', preferenceChanged);
    return () => { cancelAnimationFrame(frame); reduced.removeEventListener('change', preferenceChanged); };
  }, [target, expression, duration, motion]);

  return <svg ref={svg} className="bm-morph-face" data-expression={expression} data-blink={!closedEyeExpressions.has(expression)} viewBox="0 0 78 104" fill="black" aria-hidden="true">
    <defs><clipPath id={mouthClip}><path data-mouth-clip d={outline(initial.mouth)} /></clipPath></defs>
    <g className="bm-eyes"><path data-part="left" d={outline(initial.left)} /><path data-part="right" d={outline(initial.right)} /></g>
    <path data-part="mouth" d={outline(initial.mouth)} />
    <path data-part="tongue" d={outline(initial.tongue)} fill={initial.tongueColor} opacity={initial.tongueOpacity} clipPath={`url(#${mouthClip})`} />
  </svg>;
}
