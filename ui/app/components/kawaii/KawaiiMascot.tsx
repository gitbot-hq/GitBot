import type { CSSProperties } from "react";
import "./kawaii.css";
import { MASCOTS, type MascotName } from "../mascots/mascot-data";
import { KAWAII_FACES } from "./kawaii-faces";

export type KawaiiMorph = "fade" | "pop" | "slide";
export type KawaiiMotion = "idle" | "still";

/** Idle loop per face — shared by KawaiiMascot and KawaiiFace. */
export function loopForFace(id: string): string {
  switch (id) {
    case "happy":
    case "very-happy":
    case "wink-happy":
      return "kloop-bounce";
    case "sleep":
      return "kloop-breathe";
    case "heart-eyes":
      return "kloop-pulse";
    case "star-eyes":
      return "kloop-twinkle";
    case "dead":
      return "kloop-wobble";
    case "confused":
      return "kloop-tilt";
    case "wink":
      return "kloop-sway";
    // Solid round eyes read a squash as a blink.
    case "cute":
    case "emotional":
    case "normal":
    case "normal-2":
    case "tongue-out":
    case "sad":
      return "kloop-blink";
    default:
      return "kloop-none";
  }
}

/**
 * Where the shared face slot sits on each body: center + slot width in
 * body viewBox units. The slot is fixed-ratio (108:42, the bounding box of
 * the whole face set), so swapping expressions never shifts the layout.
 * Tuned from each body's authored eye positions in mascot-data.ts.
 */
export const FACE_ANCHOR: Record<MascotName, { cx: number; cy: number; w: number }> = {
  spider: { cx: 80, cy: 62, w: 104 },
  ghost: { cx: 81, cy: 64, w: 76 },
  bunny: { cx: 70, cy: 149, w: 96 },
  horned: { cx: 74, cy: 97, w: 98 },
  spiky: { cx: 98, cy: 106, w: 116 },
};

const SLOT_RATIO = 42 / 108;

export interface KawaiiMascotProps {
  body: MascotName;
  /** Face id from KAWAII_FACES. Unknown ids fall back to "normal". */
  expression?: string;
  /** Body color. Defaults to the body's authored color. */
  color?: string;
  /** Face ink. Defaults to #24211f. */
  ink?: string;
  motion?: KawaiiMotion;
  morph?: KawaiiMorph;
  /** Slow-mo morph for studying the transition frame by frame. */
  slow?: boolean;
  /** Rendered width in px (height follows the viewBox). Defaults to native. */
  size?: number;
  label?: string;
  className?: string;
}

// All fifteen faces live in one SVG and crossfade in a shared slot, so
// switching `expression` morphs instead of popping. Bodies deliberately
// drop their skull nose (art.face) — the kawaii face brings its own mouth.
export default function KawaiiMascot({
  body,
  expression = "normal",
  color,
  ink = "#24211f",
  motion = "idle",
  morph = "pop",
  slow = false,
  size,
  label,
  className,
}: KawaiiMascotProps) {
  const art = MASCOTS[body];
  const active = KAWAII_FACES.some((f) => f.id === expression) ? expression : "normal";
  const anchor = FACE_ANCHOR[body];
  const slotW = anchor.w;
  const slotH = slotW * SLOT_RATIO;
  const slotX = anchor.cx - slotW / 2;
  const slotY = anchor.cy - slotH / 2;
  const style = {
    "--k-body": color ?? art.bodyDefault,
    "--k-ink": ink,
  } as CSSProperties;
  const width = size ?? art.w;
  const activeLabel = KAWAII_FACES.find((f) => f.id === active)?.label ?? active;

  return (
    <svg
      className={className ? `kawaii ${className}` : "kawaii"}
      data-morph={morph}
      data-motion={motion}
      data-slow={slow ? "true" : "false"}
      role="img"
      aria-label={label ?? `${art.label} mascot, ${activeLabel}`}
      width={width}
      height={Math.round((width * art.h) / art.w)}
      viewBox={art.vb}
      fill="none"
      style={style}
    >
      <g className="k-idle">
        <g className="kawaii-body" dangerouslySetInnerHTML={{ __html: art.body }} />
        {KAWAII_FACES.map((f) => (
          <svg
            key={f.id}
            className={f.id === active ? "kface is-active" : "kface"}
            x={slotX}
            y={slotY}
            width={slotW}
            height={slotH}
            viewBox={f.viewBox}
            aria-hidden="true"
          >
            <g className={loopForFace(f.id)} dangerouslySetInnerHTML={{ __html: f.art }} />
          </svg>
        ))}
      </g>
    </svg>
  );
}
