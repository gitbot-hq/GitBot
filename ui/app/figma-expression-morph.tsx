"use client";

import { interpolate } from "flubber";
import { useEffect, useRef, useState } from "react";

type Point = { cx: number; cy: number; rx: number; ry: number; opacity: number };
type Expression = { label: string; file: string };
type ParsedExpression = { eyes: [string, string]; pupils: [Point, Point] };

const EXPRESSIONS: Expression[] = [
  { label: "Neutral", file: "Neutral.svg" }, { label: "Attentive", file: "Attentive.svg" },
  { label: "Angry", file: "Angry.svg" }, { label: "Confused", file: "Confused.svg" },
  { label: "Excited", file: "Excited.svg" }, { label: "Sad", file: "Sad.svg" },
  { label: "Shy", file: "Shy.svg" }, { label: "Sleepy", file: "Sleepy.svg" },
  { label: "Surprised", file: "Suprised.svg" }, { label: "Suspicious", file: "Sus.svg" },
  { label: "Unimpressed", file: "Unimpressed.svg" },
];

// Shared silhouette and tuft layers, taken directly from the Neutral Figma export.
const bodyPaths = [
  "M48.0002 18.5001C61.2002 -1.89986 78.8335 32.3335 86.0002 52.0001C98.0003 48.0003 115.333 49.0001 122.5 50C127.833 33.3333 141.6 0 154 0C166.4 0 174.833 50.3333 177.5 75.5C180.5 75.5 214 152.5 108.5 158.5C23.6998 158.5 25.5001 105.5 37.0002 79C35.1668 67.3334 34.8002 38.9001 48.0002 18.5001Z",
  "M5.3583 96.0417C7.52353 95.986 10.9363 95.9691 14.2089 96.1003C15.8429 96.1658 17.507 96.27 18.994 96.4362C20.3607 96.589 22.0048 96.8358 23.3632 97.3249C26.2211 98.3539 27.7037 101.505 26.6747 104.363C25.6457 107.221 22.4946 108.703 19.6366 107.674C19.6654 107.685 19.5299 107.636 19.1503 107.565C18.7964 107.499 18.3367 107.432 17.7724 107.369C16.641 107.242 15.2603 107.151 13.7685 107.091C10.7893 106.972 7.62437 106.987 5.6415 107.038C2.60507 107.116 0.0801481 104.718 0.00185442 101.681C-0.0762383 98.6448 2.32184 96.1199 5.3583 96.0417Z",
  "M6.06019 118.635C8.15398 117.695 11.4875 116.322 14.7836 115.219C16.4292 114.668 18.1554 114.152 19.7631 113.798C21.2281 113.475 23.1384 113.156 24.9187 113.357C27.937 113.699 30.1069 116.423 29.7655 119.441C29.424 122.459 26.7008 124.629 23.6826 124.288C23.7922 124.3 23.3608 124.27 22.1304 124.541C21.0424 124.781 19.7183 125.166 18.2767 125.649C15.3985 126.612 12.4079 127.844 10.5643 128.671C7.79328 129.915 4.5382 128.676 3.29428 125.905C2.05047 123.134 3.28911 119.879 6.06019 118.635Z",
  "M210.94 96.0417C208.774 95.986 205.362 95.9691 202.089 96.1003C200.455 96.1658 198.791 96.27 197.304 96.4362C195.937 96.589 194.293 96.8358 192.935 97.3249C190.077 98.3539 188.594 101.505 189.623 104.363C190.652 107.221 193.803 108.703 196.661 107.674C196.632 107.685 196.768 107.636 197.148 107.565C197.501 107.499 197.961 107.432 198.525 107.369C199.657 107.242 201.038 107.151 202.529 107.091C205.509 106.972 208.673 106.987 210.656 107.038C213.693 107.116 216.218 104.718 216.296 101.681C216.374 98.6448 213.976 96.1199 210.94 96.0417Z",
  "M210.238 118.635C208.144 117.695 204.81 116.322 201.514 115.219C199.869 114.668 198.142 114.152 196.535 113.798C195.07 113.475 193.159 113.156 191.379 113.357C188.361 113.699 186.191 116.423 186.532 119.441C186.874 122.459 189.597 124.629 192.615 124.288C192.506 124.3 192.937 124.27 194.167 124.541C195.255 124.781 196.58 125.166 198.021 125.649C200.899 126.612 203.89 127.844 205.734 128.671C208.505 129.915 211.76 128.676 213.004 125.905C214.247 123.134 213.009 119.879 210.238 118.635Z",
];

const fallbackPupils: [Point, Point] = [
  { cx: 77.5, cy: 106, rx: 7.5, ry: 13.5, opacity: 1 },
  { cx: 154.5, cy: 103, rx: 7.5, ry: 13.5, opacity: 1 },
];

const firstX = (path: string) => Number(path.match(/[-+]?\d*\.?\d+/)?.[0] ?? 0);

function pointFromEllipse(ellipse: Element): Point {
  const point: Point = {
    cx: Number(ellipse.getAttribute("cx")), cy: Number(ellipse.getAttribute("cy")),
    rx: Number(ellipse.getAttribute("rx")), ry: Number(ellipse.getAttribute("ry")), opacity: 1,
  };
  // Figma sometimes writes the right pupil as an ellipse plus matrix transform.
  // Bake its simple translation/reflection into the point so both pupils use one schema.
  const values = ellipse.getAttribute("transform")?.match(/matrix\(([^)]+)\)/)?.[1].trim().split(/[ ,]+/).map(Number);
  if (values?.length === 6) {
    const [a, b, c, d, e, f] = values;
    const { cx, cy } = point;
    point.cx = a * cx + c * cy + e;
    point.cy = b * cx + d * cy + f;
  }
  return point;
}

function readExpression(markup: string): ParsedExpression {
  const svg = new DOMParser().parseFromString(markup, "image/svg+xml");
  const eyes = [...svg.querySelectorAll('path[fill="white"]')].map((path) => path.getAttribute("d") ?? "").sort((a, b) => firstX(a) - firstX(b));
  const pupils = [...svg.querySelectorAll("ellipse")].map(pointFromEllipse).sort((a, b) => a.cx - b.cx);
  const hiddenPupils = eyes.map((eye) => ({ ...(firstX(eye) < 110 ? fallbackPupils[0] : fallbackPupils[1]), opacity: 0 })) as [Point, Point];
  return { eyes: [eyes[0], eyes[1]], pupils: pupils.length === 2 ? [pupils[0], pupils[1]] : hiddenPupils };
}

function mixPoint(a: Point, b: Point, t: number): Point {
  return { cx: a.cx + (b.cx - a.cx) * t, cy: a.cy + (b.cy - a.cy) * t, rx: a.rx + (b.rx - a.rx) * t, ry: a.ry + (b.ry - a.ry) * t, opacity: a.opacity + (b.opacity - a.opacity) * t };
}

function BlinkingEye({ d, pupil, side, blinking = true }: { d: string; pupil: Point; side: "left" | "right"; blinking?: boolean }) {
  const clipId = `eye-${side}-clip`;
  const blinkTimes = "0;.89;.906;.914;.94;1";
  return <g className="eye-stack">
    <defs><clipPath id={clipId}><path d={d} /></clipPath></defs>
    <path d={d} fill="white" />
    <g className={`pupil-layer pupil-${side}`}><ellipse fill="#24211f" {...pupil} /></g>
    {blinking && <g clipPath={`url(#${clipId})`} fill="#24211f">
      <rect x="-20" y="-160" width="260" height="160">
        <animateTransform attributeName="transform" type="translate" dur="5.2s" repeatCount="indefinite" values="0 0;0 0;0 135;0 135;0 0;0 0" keyTimes={blinkTimes} calcMode="spline" keySplines="0 0 1 1;.25 0 .7 .15;0 0 1 1;.2 .85 .55 1;0 0 1 1" />
      </rect>
      <rect x="-20" y="150" width="260" height="120">
        <animateTransform attributeName="transform" type="translate" dur="5.2s" repeatCount="indefinite" values="0 0;0 0;0 -48;0 -48;0 0;0 0" keyTimes={blinkTimes} calcMode="spline" keySplines="0 0 1 1;.25 0 .7 .15;0 0 1 1;.2 .85 .55 1;0 0 1 1" />
      </rect>
    </g>}
  </g>;
}

export default function FigmaExpressionMorph() {
  const [active, setActive] = useState("Neutral");
  const [ready, setReady] = useState(false);
  const shapes = useRef<Record<string, ParsedExpression>>({});
  const paths = useRef<[string, string]>(["", ""]);
  const pupils = useRef<[Point, Point]>(fallbackPupils);
  const current = useRef("Neutral");
  const raf = useRef<number | null>(null);
  const [frame, setFrame] = useState({ eyes: ["", ""] as [string, string], pupils: fallbackPupils });

  useEffect(() => {
    Promise.all(EXPRESSIONS.map(async ({ label, file }) => [label, readExpression(await fetch(`/figma-expressions/${file}`).then((r) => r.text()))] as const)).then((entries) => {
      shapes.current = Object.fromEntries(entries); paths.current = shapes.current.Neutral.eyes; pupils.current = shapes.current.Neutral.pupils;
      setFrame({ eyes: paths.current, pupils: pupils.current }); setReady(true);
    });
    return () => { if (raf.current) cancelAnimationFrame(raf.current); };
  }, []);

  function select(label: string) {
    if (!ready || label === current.current) return;
    if (raf.current) cancelAnimationFrame(raf.current);
    const target = shapes.current[label];
    const eyeTween = [interpolate(paths.current[0], target.eyes[0], { maxSegmentLength: 2 }), interpolate(paths.current[1], target.eyes[1], { maxSegmentLength: 2 })] as const;
    const startPupils = pupils.current, started = performance.now(), duration = 420;
    current.current = label; setActive(label);
    const animate = (now: number) => {
      const linear = Math.min((now - started) / duration, 1), t = 1 - (1 - linear) ** 4;
      const eyes = [eyeTween[0](t), eyeTween[1](t)] as [string, string];
      const nextPupils = [mixPoint(startPupils[0], target.pupils[0], t), mixPoint(startPupils[1], target.pupils[1], t)] as [Point, Point];
      paths.current = eyes; pupils.current = nextPupils; setFrame({ eyes, pupils: nextPupils });
      if (linear < 1) raf.current = requestAnimationFrame(animate);
    };
    raf.current = requestAnimationFrame(animate);
  }

  return <main className="expression-canvas"><section className="expression-card" aria-labelledby="expression-title">
    <div className="intro"><p className="eyebrow">Figma expression set</p><h1 id="expression-title">Smooth, layer-safe transitions.</h1><p>Every state uses the same silhouette, tuft, eye, and pupil stack. Pupil-free states fade those layers out rather than removing them.</p></div>
    <div className="mascot-stage" aria-live="polite"><svg className={`figma-mascot motion-${active.toLowerCase()}`} viewBox="0 0 217 159" role="img" aria-label={`${active} mascot expression`}><g className="character-motion"><g fill="#24211f"><path d={bodyPaths[0]} /><path className="whisker whisker-left" d={bodyPaths[1]} /><path className="whisker whisker-left" d={bodyPaths[2]} /><path className="whisker whisker-right" d={bodyPaths[3]} /><path className="whisker whisker-right" d={bodyPaths[4]} /></g>{frame.eyes[0] && <BlinkingEye d={frame.eyes[0]} pupil={frame.pupils[0]} side="left" blinking={active !== "Excited"} />}{frame.eyes[1] && <BlinkingEye d={frame.eyes[1]} pupil={frame.pupils[1]} side="right" blinking={active !== "Excited"} />}</g></svg><span className="expression-name">{active}</span></div>
    <div className="expression-picker" aria-label="Expression picker">{EXPRESSIONS.map(({ label }) => <button className={label === active ? "selected" : ""} disabled={!ready} key={label} onClick={() => select(label)}>{label}</button>)}</div>
  </section></main>;
}
