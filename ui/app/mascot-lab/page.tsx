"use client";

import { useEffect, useState } from "react";
import KawaiiFace from "../components/kawaii/KawaiiFace";
import KawaiiMascot, {
  type KawaiiMorph,
  type KawaiiMotion,
} from "../components/kawaii/KawaiiMascot";
import { KAWAII_FACES } from "../components/kawaii/kawaii-faces";
import {
  MASCOT_NAMES,
  type MascotName,
} from "../components/mascots/mascot-data";
import "./mascot-lab.css";

const BODY_PRESETS = [
  "#ffffff",
  "#FECE00",
  "#FEA1CD",
  "#FF7300",
  "#31CC66",
  "#00A3FE",
  "#FEA501",
  "#B79CFF",
];

const INK_PRESETS = ["#24211f", "#152f47", "#ffffff"];

const MORPHS: KawaiiMorph[] = ["fade", "pop", "slide"];
const MOTIONS: KawaiiMotion[] = ["idle", "still"];

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
    <div className="lab-seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o}
          type="button"
          role="radio"
          aria-checked={o === value}
          className={o === value ? "lab-seg-btn selected" : "lab-seg-btn"}
          onClick={() => onPick(o)}
        >
          {o}
        </button>
      ))}
    </div>
  );
}

function Swatches({
  label,
  presets,
  value,
  onPick,
}: {
  label: string;
  presets: string[];
  value: string;
  onPick: (v: string) => void;
}) {
  return (
    <div className="lab-swatches" role="radiogroup" aria-label={label}>
      {presets.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={c.toLowerCase() === value.toLowerCase()}
          aria-label={c}
          title={c}
          className={
            c.toLowerCase() === value.toLowerCase()
              ? "lab-swatch selected"
              : "lab-swatch"
          }
          style={{ background: c }}
          onClick={() => onPick(c)}
        />
      ))}
      <label className="lab-custom" title="Custom color">
        <input
          type="color"
          aria-label={`${label} custom color`}
          value={value}
          onChange={(e) => onPick(e.target.value)}
        />
        <span aria-hidden="true">+</span>
      </label>
    </div>
  );
}

// Mascot builder lab: pick a body + colors once, and every mascot wears the
// same shared expression. This page is where the expression morph and the
// per-expression idle loops get tuned.
export default function MascotLab() {
  const [body, setBody] = useState<MascotName>("ghost");
  const [color, setColor] = useState("#FECE00");
  const [ink, setInk] = useState("#24211f");
  const [expression, setExpression] = useState("normal");
  const [morph, setMorph] = useState<KawaiiMorph>("pop");
  const [motion, setMotion] = useState<KawaiiMotion>("idle");
  const [slow, setSlow] = useState(false);
  const [playing, setPlaying] = useState(false);

  // Play-all: cycle the shared expression so the morph can be reviewed
  // hands-free. Slow-mo stretches the interval to match the transition.
  useEffect(() => {
    if (!playing) return;
    const step = slow ? 1600 : 900;
    const timer = setInterval(() => {
      setExpression((prev) => {
        const i = KAWAII_FACES.findIndex((f) => f.id === prev);
        return KAWAII_FACES[(i + 1) % KAWAII_FACES.length].id;
      });
    }, step);
    return () => clearInterval(timer);
  }, [playing, slow]);

  const activeLabel =
    KAWAII_FACES.find((f) => f.id === expression)?.label ?? expression;

  return (
    <main className="lab-page">
      <header className="lab-head">
        <p className="lab-eyebrow">Mascot lab</p>
        <h1>One expression, every mascot</h1>
        <p className="lab-sub">
          Pick a body and colors, then flip through the 15 shared kawaii
          faces. Every mascot morphs in place — the component never remounts.
        </p>
      </header>

      <section className="lab-hero" aria-label="Featured mascot">
        <div className="lab-stage">
          <KawaiiMascot
            body={body}
            expression={expression}
            color={color}
            ink={ink}
            motion={motion}
            morph={morph}
            slow={slow}
            size={260}
          />
          <span className="lab-caption">
            {body} · {activeLabel}
          </span>
        </div>
        <div className="lab-controls">
          <div className="lab-group">
            <p className="lab-label">Body / shape</p>
            <div className="lab-bodies" role="radiogroup" aria-label="Body shape">
              {MASCOT_NAMES.map((n) => (
                <button
                  key={n}
                  type="button"
                  role="radio"
                  aria-checked={n === body}
                  className={n === body ? "lab-body selected" : "lab-body"}
                  onClick={() => setBody(n)}
                >
                  <KawaiiMascot
                    body={n}
                    expression={expression}
                    color={color}
                    ink={ink}
                    motion="still"
                    morph="fade"
                    size={56}
                  />
                  <span>{n}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="lab-group">
            <p className="lab-label">Body color</p>
            <Swatches
              label="Body color"
              presets={BODY_PRESETS}
              value={color}
              onPick={setColor}
            />
          </div>
          <div className="lab-group">
            <p className="lab-label">Face ink</p>
            <Swatches
              label="Face ink"
              presets={INK_PRESETS}
              value={ink}
              onPick={setInk}
            />
          </div>
          <div className="lab-row">
            <div className="lab-group">
              <p className="lab-label">Morph</p>
              <Segmented
                label="Morph transition"
                options={MORPHS}
                value={morph}
                onPick={setMorph}
              />
            </div>
            <div className="lab-group">
              <p className="lab-label">Motion</p>
              <Segmented
                label="Idle motion"
                options={MOTIONS}
                value={motion}
                onPick={setMotion}
              />
            </div>
          </div>
          <div className="lab-row">
            <button
              type="button"
              aria-pressed={slow}
              className={slow ? "lab-toggle selected" : "lab-toggle"}
              onClick={() => setSlow((s) => !s)}
            >
              Slow-mo morph
            </button>
            <button
              type="button"
              aria-pressed={playing}
              className={playing ? "lab-toggle selected" : "lab-toggle"}
              onClick={() => setPlaying((p) => !p)}
            >
              {playing ? "Pause cycle" : "Play all faces"}
            </button>
          </div>
          <pre className="lab-snippet" aria-label="Usage snippet">
            {`<KawaiiMascot body="${body}" expression="${expression}" color="${color}" ink="${ink}" />`}
          </pre>
        </div>
      </section>

      <section aria-label="All bodies, shared expression">
        <h2 className="lab-h2">The pack — same face everywhere</h2>
        <div className="lab-grid">
          {MASCOT_NAMES.map((n) => (
            <button
              key={n}
              type="button"
              className={n === body ? "lab-card selected" : "lab-card"}
              onClick={() => setBody(n)}
              aria-pressed={n === body}
              aria-label={`Select ${n} body`}
            >
              <KawaiiMascot
                body={n}
                expression={expression}
                color={color}
                ink={ink}
                motion={motion}
                morph={morph}
                slow={slow}
                size={130}
              />
              <span>{n}</span>
            </button>
          ))}
        </div>
      </section>

      <section aria-label="Expression picker">
        <h2 className="lab-h2">Expressions — pick the shared face</h2>
        <div className="lab-faces">
          {KAWAII_FACES.map((f) => (
            <button
              key={f.id}
              type="button"
              className={f.id === expression ? "lab-face selected" : "lab-face"}
              onClick={() => {
                setExpression(f.id);
                setPlaying(false);
              }}
              aria-pressed={f.id === expression}
              aria-label={`Select ${f.label} expression`}
            >
              <span className="lab-face-art">
                <KawaiiFace id={f.id} ink={ink} size={104} />
              </span>
              <span>{f.label}</span>
            </button>
          ))}
        </div>
      </section>
    </main>
  );
}
