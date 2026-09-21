'use client';
import { useEffect, useRef, type ReactNode } from 'react';

// Scale changes stay within 3.5%; every reaction resolves back to the original body.
const reactions: Record<string, { pose: string; settle: string; period: number }> = {
  neutral: { pose: 'scale(1.012, .988)', settle: 'scale(.996, 1.004)', period: 5800 },
  happy: { pose: 'scale(1.028, .974) rotate(-.7deg)', settle: 'scale(.987, 1.013) rotate(.4deg)', period: 3600 },
  excited: { pose: 'scale(1.035, .967) rotate(-1deg)', settle: 'scale(.976, 1.024) rotate(1deg)', period: 2600 },
  surprised: { pose: 'scale(.973, 1.03)', settle: 'scale(1.014, .986)', period: 4300 },
  confused: { pose: 'scale(1.012, .988) rotate(-1.8deg)', settle: 'scale(.994, 1.006) rotate(1.3deg)', period: 4600 },
  sus: { pose: 'scale(1.015, .985) rotate(1.3deg)', settle: 'scale(1) rotate(-.5deg)', period: 5200 },
  wink: { pose: 'scale(1.025, .975) rotate(1.5deg)', settle: 'scale(.99, 1.01) rotate(-.5deg)', period: 4400 },
  sad: { pose: 'scale(1.023, .977) rotate(-.7deg)', settle: 'scale(1.008, .992)', period: 6200 },
  'very-sad': { pose: 'scale(1.03, .97) rotate(-1deg)', settle: 'scale(1.01, .99)', period: 6500 },
  angry: { pose: 'scale(1.03, .97) rotate(-.8deg)', settle: 'scale(1.018, .982) rotate(.8deg)', period: 3200 },
  unimpressed: { pose: 'scale(1.017, .983) rotate(.7deg)', settle: 'scale(1)', period: 6200 },
  sleepy: { pose: 'scale(1.025, .975)', settle: 'scale(.993, 1.007)', period: 7000 },
  'looking-around': { pose: 'scale(1.012, .988) rotate(-1.4deg)', settle: 'scale(1.012, .988) rotate(1.4deg)', period: 6400 },
};

export default function BodyReaction({ expression, motion, children }: { expression: string; motion: boolean; children: ReactNode }) {
  const shell = useRef<HTMLDivElement>(null);
  const visible = useRef('none');
  useEffect(() => {
    const element = shell.current;
    if (!element) return;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    const profile = reactions[expression] ?? reactions.neutral;
    let animation: Animation | undefined;
    const stop = () => { animation?.cancel(); visible.current = 'none'; };
    const start = () => {
      if (!motion || reduced.matches) { stop(); return; }
      animation = element.animate([
        { transform: visible.current === 'none' ? 'scale(1)' : visible.current },
        { transform: profile.pose, offset: .38 },
        { transform: profile.settle, offset: .72 },
        { transform: 'scale(1)' },
      ], { duration: expression === 'sleepy' ? 1100 : 760, easing: 'ease-in-out' });
      animation.onfinish = () => {
        animation = element.animate([
          { transform: 'scale(1)', offset: 0 },
          { transform: profile.pose, offset: .22 },
          { transform: profile.settle, offset: .48 },
          { transform: 'scale(1)', offset: .72 },
          { transform: 'scale(1)', offset: 1 },
        ], { duration: profile.period, iterations: Infinity, easing: 'ease-in-out' });
      };
    };
    const preferenceChanged = () => { stop(); start(); };
    start();
    reduced.addEventListener('change', preferenceChanged);
    return () => {
      visible.current = getComputedStyle(element).transform;
      if (animation) { animation.onfinish = null; animation.cancel(); }
      reduced.removeEventListener('change', preferenceChanged);
    };
  }, [expression, motion]);
  return <div ref={shell} className="bm-shell" data-reaction={expression}>{children}</div>;
}
