import type { CSSProperties } from "react";
import "./mascots.css";
import {
  MASCOTS,
  type MascotExpression,
  type MascotMotion,
  type MascotName,
} from "./mascot-data";

const EXPRESSIONS: MascotExpression[] = ["neutral", "happy", "sleepy"];

export interface MascotProps {
  name: MascotName;
  /** Ignored when motion="spin": spinning is always happy. */
  expression?: MascotExpression;
  motion?: MascotMotion;
  /** Body color. Defaults to the mascot's authored color. */
  color?: string;
  /** Eyes/nose ink. Defaults to #24211f (matches the main mascot). */
  ink?: string;
  /** Rendered width in px (height follows the viewBox). Defaults to native. */
  size?: number;
  /** Accessible label. Defaults to "<Name> mascot, <expression>". */
  label?: string;
  className?: string;
}

// All three expressions live in one SVG and crossfade via CSS, so switching
// the `expression` prop never pops. The neutral layer carries the blink;
// happy/sleepy never blink.
export default function Mascot({
  name,
  expression,
  motion = "idle",
  color,
  ink = "#24211f",
  size,
  label,
  className,
}: MascotProps) {
  const art = MASCOTS[name];
  const expr = motion === "spin" ? "happy" : (expression ?? "neutral");
  const style = {
    "--mascot-body": color ?? art.bodyDefault,
    "--mascot-ink": ink,
    "--mascot-travel": `${Math.round(art.w * 0.45)}px`,
  } as CSSProperties;
  const width = size ?? art.w;

  return (
    <svg
      className={className ? `mascot ${className}` : "mascot"}
      data-expression={expr}
      data-motion={motion}
      role="img"
      aria-label={
        label ?? `${art.label} mascot, ${expr}${motion === "spin" ? ", spinning" : ""}`
      }
      width={width}
      height={Math.round((width * art.h) / art.w)}
      viewBox={art.vb}
      fill="none"
      style={style}
    >
      <g className="mascot-idle">
        <g
          className="mascot-body"
          dangerouslySetInnerHTML={{ __html: art.body }}
        />
        <g className="mascot-travelface">
          {art.face !== "" && (
            <g
              className="mascot-face"
              dangerouslySetInnerHTML={{ __html: art.face }}
            />
          )}
          {EXPRESSIONS.map((e) => (
            <g
              key={e}
              className={e === expr ? "mascot-eyes is-active" : "mascot-eyes"}
              dangerouslySetInnerHTML={{
                __html:
                  e === "neutral"
                    ? `<g class="mascot-blink">${art.eyes.neutral}</g>`
                    : art.eyes[e],
              }}
            />
          ))}
        </g>
      </g>
    </svg>
  );
}
