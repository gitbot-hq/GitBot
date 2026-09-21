"use client";

import { useState } from "react";
import Mascot from "../components/mascots/Mascot";
import {
  MASCOT_NAMES,
  type MascotExpression,
  type MascotMotion,
  type MascotName,
} from "../components/mascots/mascot-data";
import "./mascots-demo.css";

const EXPRESSIONS: MascotExpression[] = ["neutral", "happy", "sleepy"];
const MOTIONS: MascotMotion[] = ["idle", "spin", "still"];

type CardState = { expression: MascotExpression; motion: MascotMotion };

const INITIAL: Record<MascotName, CardState> = {
  spider: { expression: "neutral", motion: "idle" },
  ghost: { expression: "neutral", motion: "idle" },
  bunny: { expression: "neutral", motion: "idle" },
  horned: { expression: "neutral", motion: "idle" },
  spiky: { expression: "neutral", motion: "idle" },
};

function Segmented<T extends string>({
  label,
  options,
  value,
  onPick,
}: {
  label: string;
  options: T[];
  value: T;
  onPick: (v: T) => void;
}) {
  return (
    <div className="demo-seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o}
          type="button"
          role="radio"
          aria-checked={o === value}
          className={o === value ? "demo-seg-btn selected" : "demo-seg-btn"}
          onClick={() => onPick(o)}
        >
          {o}
        </button>
      ))}
    </div>
  );
}

// Live demo for the alternate-mascot set. The component stays mounted
// while props change, so expression switches crossfade instead of popping.
export default function MascotsDemo() {
  const [cards, setCards] = useState(INITIAL);
  const set = (name: MascotName, patch: Partial<CardState>) =>
    setCards((prev) => ({ ...prev, [name]: { ...prev[name], ...patch } }));

  return (
    <main className="demo-page">
      <header className="demo-head">
        <p className="demo-eyebrow">Alternate mascots</p>
        <h1>Five mascots, three moods, three motions</h1>
        <p className="demo-sub">
          Expression switches crossfade in place — the component never
          remounts. Spin is always happy with a parked body.
        </p>
      </header>
      <div className="demo-grid">
        {MASCOT_NAMES.map((name) => (
          <section key={name} className="demo-card" aria-label={`${name} demo`}>
            <div className="demo-stage">
              <Mascot
                name={name}
                expression={cards[name].expression}
                motion={cards[name].motion}
                size={150}
              />
            </div>
            <h2>{name}</h2>
            <Segmented
              label={`${name} expression`}
              options={EXPRESSIONS}
              value={cards[name].expression}
              onPick={(expression) => set(name, { expression })}
            />
            <Segmented
              label={`${name} motion`}
              options={MOTIONS}
              value={cards[name].motion}
              onPick={(motion) => set(name, { motion })}
            />
          </section>
        ))}
      </div>
    </main>
  );
}
