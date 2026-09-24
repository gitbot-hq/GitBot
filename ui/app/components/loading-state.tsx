"use client";

import { useEffect, useState } from "react";

/* ─────────────────────────────────────────────────────────
 * Thinking loader — pixel-grid wavefront + shimmering label
 * + live elapsed timer. Adapted to our tokens (no Tailwind
 * ink scale in this repo).
 *
 * Variants: Drive (chevron sweep), Dots (same, round cells),
 * Orbit (comet lapping the perimeter).
 * Reduced motion freezes the grid dim; the timer ticks on.
 * ───────────────────────────────────────────────────────── */

const chevron = Array.from({ length: 9 }, (_, i) => {
  const r = Math.floor(i / 3),
    c = i % 3;
  return (c + Math.abs(r - 1)) * 90;
});

const ORBIT_ORDER = [0, 1, 2, 5, 8, 7, 6, 3];
const orbit = Array.from({ length: 9 }, (_, i) => {
  const k = ORBIT_ORDER.indexOf(i);
  return k === -1 ? null : k * 110;
});

const PATTERNS: Record<
  string,
  { delays: (number | null)[]; dur: number; round: boolean }
> = {
  Drive: { delays: chevron, dur: 650, round: false },
  Dots: { delays: chevron, dur: 650, round: true },
  Orbit: { delays: orbit, dur: 950, round: false },
};

function LoaderGrid({
  delays,
  dur,
  round,
}: {
  delays: (number | null)[];
  dur: number;
  round: boolean;
}) {
  return (
    <span aria-hidden="true" className="px-grid">
      {delays.map((delay, index) => (
        <span
          key={index}
          className={round ? "px-cell round" : "px-cell"}
          style={{
            opacity: delay === null ? 0.07 : 0.15,
            animation:
              delay === null ? "none" : `pixel-on ${dur}ms ease-in-out ${delay}ms infinite`,
          }}
        />
      ))}
    </span>
  );
}

function useElapsed() {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setSeconds((value) => value + 1), 1000);
    return () => clearInterval(t);
  }, []);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export default function LoadingState({
  label,
  variant = "Drive",
}: {
  label?: string;
  variant?: string;
}) {
  const elapsed = useElapsed();
  const { delays, dur, round } = PATTERNS[variant] ?? PATTERNS.Drive;
  return (
    <div role="status" className="thinking">
      <LoaderGrid delays={delays} dur={dur} round={round} />
      <span className="thinking-label">{label ?? "Churning"}</span>
      <span className="thinking-elapsed">{elapsed}</span>
    </div>
  );
}
