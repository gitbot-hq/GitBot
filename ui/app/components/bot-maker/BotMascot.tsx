'use client';

import { useEffect, useId, useState, type CSSProperties } from 'react';
import { activityExpressions, bodies, expressions, facePlacement, type BotActivity } from './registry';
import './mascot.css';
import LookAroundFace from './LookAroundFace';
import BodyReaction from './BodyReaction';
import ExpressionProps from './ExpressionProps';

export type BotMascotProps = {
  body?: string;
  color?: string;
  /** Explicit expression overrides the activity director. */
  expression?: string;
  activity?: BotActivity;
  motion?: boolean;
  duration?: number;
  size?: number;
  label?: string;
};

export function Artwork({ art, className }: { art: typeof bodies[number]; className?: string }) {
  const id = useId();
  return <svg className={className} viewBox={art.viewBox} fill="none" aria-hidden="true" dangerouslySetInnerHTML={{ __html: art.markup.replaceAll('__mascot_id__', id) }} />;
}

export default function BotMascot({ body = 'ghost', color = '#FECE00', expression, activity = 'idle', motion = true, duration = 420, size = 280, label }: BotMascotProps) {
  const [cycle, setCycle] = useState({ activity, step: 0 });
  const sequence = activityExpressions[activity];
  const requested = expression ?? sequence[(cycle.activity === activity ? cycle.step : 0) % sequence.length];
  const active = expressions.find(e => e.id === requested)?.id ?? 'neutral';
  const shape = bodies.find(b => b.id === body) ?? bodies.find(b => b.id === 'ghost')!;
  const placement = facePlacement[shape.id] ?? [50, 53, 36];

  useEffect(() => {
    if (expression || !motion || sequence.length < 2) return;
    const timer = window.setTimeout(() => setCycle(s => ({ activity, step: s.activity === activity ? s.step + 1 : 1 })), active === 'looking-around' ? 6800 : activity === 'working' ? 2900 : 4300);
    return () => clearTimeout(timer);
  }, [activity, expression, motion, sequence, cycle, active]);

  return <div className="bot-mascot" data-motion={motion} data-mood={active} role="img" aria-label={label ?? `${shape.label} bot, ${active}`} style={{ width: size, color, '--face-x': `${placement[0]}%`, '--face-y': `${placement[1]}%`, '--face-width': `${placement[2]}%` } as CSSProperties}>
    <BodyReaction expression={active} motion={motion}>
      <Artwork art={shape} className="bm-body" />
      <div className="bm-face-anchor"><div className="bm-gaze">
        <LookAroundFace expression={active} duration={duration} motion={motion} />
      </div><ExpressionProps expression={active} /></div>
    </BodyReaction>
  </div>;
}
