'use client';

import { useEffect, useState } from 'react';
import MorphFace from './MorphFace';

const directions = ['top-left', 'top', 'top-right', 'left', 'right', 'bottom-left', 'bottom', 'bottom-right'];
const between = (min: number, max: number) => min + Math.random() * (max - min);

// Direct only the gaze. Keep MorphFace mounted so interruptions still morph
// from the visible pose, including when the owner gets the bot's attention.
export default function LookAroundFace({ expression, duration, motion }: { expression: string; duration: number; motion: boolean }) {
  const [gaze, setGaze] = useState('neutral');

  useEffect(() => {
    if (expression !== 'looking-around' || !motion) { setGaze('neutral'); return; }
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    let timer: ReturnType<typeof setTimeout> | undefined;
    let bag: string[] = [];
    let current = '';
    const nextDirection = () => {
      if (!bag.length) {
        bag = [...directions];
        for (let i = bag.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [bag[i], bag[j]] = [bag[j], bag[i]];
        }
        if (bag[bag.length - 1] === current) [bag[0], bag[bag.length - 1]] = [bag[bag.length - 1], bag[0]];
      }
      return bag.pop()!;
    };
    const glance = (remaining = 2, curious = Math.random() < .18) => {
      current = nextDirection();
      setGaze(`look-${current}${curious ? '-curious' : ''}`);
      // Visit two distinct directions before settling back into neutral.
      timer = setTimeout(() => {
        if (remaining > 1) { glance(remaining - 1, curious); return; }
        setGaze('neutral');
        timer = setTimeout(glance, between(5000, 10000));
      }, between(1200, 2200));
    };
    const restart = () => {
      clearTimeout(timer);
      current = '';
      setGaze('neutral');
      if (!reduced.matches) timer = setTimeout(glance, between(5000, 10000));
    };
    restart();
    reduced.addEventListener('change', restart);
    return () => { clearTimeout(timer); reduced.removeEventListener('change', restart); };
  }, [expression, motion]);

  return <MorphFace expression={expression === 'looking-around' ? (motion ? gaze : 'neutral') : expression} duration={duration} motion={motion} />;
}
