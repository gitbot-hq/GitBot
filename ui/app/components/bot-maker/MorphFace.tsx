'use client';
import { useEffect, useId, useRef, useState } from 'react';
import { alignFace, blendFace, morphs, outline, parts, type FaceGeometry } from './morph-geometry';

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
    const finish = () => { cancelAnimationFrame(frame); paint(target); root.dataset.morphing = 'false'; };
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
    const preferenceChanged = () => { if (reduced.matches) finish(); };
    reduced.addEventListener('change', preferenceChanged);
    return () => { cancelAnimationFrame(frame); reduced.removeEventListener('change', preferenceChanged); };
  }, [target, duration, motion]);

  return <svg ref={svg} className="bm-morph-face" viewBox="0 0 78 104" fill="black" aria-hidden="true">
    <defs><clipPath id={mouthClip}><path data-mouth-clip d={outline(initial.mouth)} /></clipPath></defs>
    <g className="bm-eyes"><path data-part="left" d={outline(initial.left)} /><path data-part="right" d={outline(initial.right)} /></g>
    <path data-part="mouth" d={outline(initial.mouth)} />
    <path data-part="tongue" d={outline(initial.tongue)} fill={initial.tongueColor} opacity={initial.tongueOpacity} clipPath={`url(#${mouthClip})`} />
  </svg>;
}
