"use client";

import { useEffect, useId, useRef, useState } from "react";
import { interpolate } from "flubber";
import { EXPRESSION_ART, type Pupil } from "./mascot-art";

// GitBot logo, traced from Design/GitBot Logo.svg (full lockup) and
// Design/GitBot LogoMark.svg (mark only). Dropped: the red annotation path
// (design guide, not artwork).
//
// Two exports share one live face:
//   Logo     — full lockup (mascot + wordmark), e.g. the top bar.
//   LogoMark — mascot only, e.g. hero moments.
//
// Theme-aware via CSS vars (see globals.css):
//   --logo-ink   body, tufts, whisker strokes, wordmark
//   --logo-eye   eye whites
//   --logo-pupil pupils
// Filter IDs are uniquified per instance so multiple logos can coexist.
//
// The face is live: it cycles random positive mascot-page expressions,
// morphed with flubber (same technique as figma-expression-morph.tsx).
// The logo mascot is the Neutral expression at 333/217 scale, so
// expression paths map onto the face with a single scale transform.

// Rotation: neutral <-> excited only. Everything else either reads
// sad at logo size (shy) or isn't positive.
const POSITIVE = ["neutral", "excited"];

// Logo face (333x244) vs expression space (217x159).
const FACE_SCALE = 333 / 217;

type LivePupil = Pupil & { opacity: number };

function pupilsOf(name: string): [LivePupil, LivePupil] {
  const [a, b] = EXPRESSION_ART[name].pupils;
  const blank: LivePupil = { cx: 0, cy: 0, rx: 0, ry: 0, opacity: 0 };
  return [
    a ? { ...a, opacity: 1 } : blank,
    b ? { ...b, opacity: 1 } : { ...(a ? { ...a, opacity: 1 } : blank), opacity: 0 },
  ];
}

function mixPupil(a: LivePupil, b: LivePupil, t: number): LivePupil {
  return {
    cx: a.cx + (b.cx - a.cx) * t,
    cy: a.cy + (b.cy - a.cy) * t,
    rx: Math.max(0.1, a.rx + (b.rx - a.rx) * t),
    ry: Math.max(0.1, a.ry + (b.ry - a.ry) * t),
    opacity: a.opacity + (b.opacity - a.opacity) * t,
  };
}

type FaceFrame = {
  name: string;
  eyes: [string, string];
  pupils: [LivePupil, LivePupil];
};

// Random positive expression on load, then rotate every 6s with a
// flubber morph (same technique as figma-expression-morph.tsx).
function useLiveFace(): FaceFrame {
  const [frame, setFrame] = useState<FaceFrame>({
    name: "neutral",
    eyes: EXPRESSION_ART.neutral.eyes as [string, string],
    pupils: pupilsOf("neutral"),
  });
  const current = useRef(frame);
  const raf = useRef<number | null>(null);

  useEffect(() => {
    const pick = (exclude: string) => {
      const pool = POSITIVE.filter((p) => p !== exclude);
      return pool[Math.floor(Math.random() * pool.length)];
    };
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

    function morphTo(name: string) {
      if (raf.current) cancelAnimationFrame(raf.current);
      const target = EXPRESSION_ART[name];
      const targetPupils = pupilsOf(name);
      const startEyes = current.current.eyes;
      const startPupils = current.current.pupils;
      if (reduced) {
        current.current = { name, eyes: target.eyes, pupils: targetPupils };
        setFrame({ name, eyes: target.eyes, pupils: targetPupils });
        return;
      }
      const tweens = [
        interpolate(startEyes[0], target.eyes[0], { maxSegmentLength: 2 }),
        interpolate(startEyes[1], target.eyes[1], { maxSegmentLength: 2 }),
      ] as const;
      const started = performance.now();
      const duration = 420;
      current.current = { name, eyes: target.eyes, pupils: targetPupils };
      const animate = (now: number) => {
        const linear = Math.min((now - started) / duration, 1);
        const t = 1 - (1 - linear) ** 4;
        setFrame({
          name,
          eyes: [tweens[0](t), tweens[1](t)],
          pupils: [
            mixPupil(startPupils[0], targetPupils[0], t),
            mixPupil(startPupils[1], targetPupils[1], t),
          ],
        });
        if (linear < 1) raf.current = requestAnimationFrame(animate);
      };
      raf.current = requestAnimationFrame(animate);
    }

    morphTo(pick("neutral"));
    if (reduced) return;
    const timer = setInterval(() => morphTo(pick(current.current.name)), 6000);
    return () => {
      clearInterval(timer);
      if (raf.current) cancelAnimationFrame(raf.current);
    };
  }, []);

  return frame;
}

// Mascot body + live face. Shared by the lockup and the mark.
function MascotArt({ frame, f }: { frame: FaceFrame; f: (n: number) => string }) {
  return (
    <>
      <g className="logo-float">
      <g filter={`url(#${f(0)})`}>
        <path
          d="M73.7729 28.4329C94.06 -2.91989 121.161 49.6933 132.175 79.919C150.618 73.7716 177.257 75.3083 188.272 76.845C196.469 51.23 217.626 0 236.684 0C255.742 0 268.703 77.3573 272.801 116.036C277.412 116.036 328.898 234.377 166.755 243.599C36.4257 243.599 39.1925 162.143 56.867 121.415C54.0493 103.485 53.4858 59.7856 73.7729 28.4329Z"
          fill="var(--logo-ink)"
        />
      </g>
      <g filter={`url(#${f(1)})`}>
        <path
          d="M21.8376 147.695C16.8081 147.493 11.5629 147.519 8.23517 147.605C3.56843 147.725 -0.117171 151.606 0.00285006 156.273C0.12318 160.939 4.00373 164.625 8.67043 164.505C11.7179 164.427 16.5821 164.404 21.1607 164.588C23.4536 164.679 25.5755 164.819 27.3144 165.014C28.1817 165.111 28.8881 165.213 29.4321 165.315C32.5189 165.973 39.1533 165.91 40.9964 160.394C42.5778 156.002 40.2992 151.159 35.9069 149.577C33.8192 148.826 31.2923 148.446 29.1919 148.211C26.9065 147.956 24.3489 147.796 21.8376 147.695Z"
          fill="var(--logo-ink)"
        />
      </g>
      <path
        d="M8.26074 148.604C11.5719 148.519 16.795 148.494 21.7979 148.694C24.2964 148.795 26.8282 148.953 29.0811 149.205C31.1694 149.439 33.5977 149.809 35.5684 150.519C39.4408 151.913 41.45 156.183 40.0557 160.056L40.0479 160.077C39.2614 162.431 37.4696 163.643 35.416 164.205C33.3317 164.776 31.0689 164.642 29.6406 164.338L29.6289 164.335L29.6172 164.333L29.1553 164.252C28.665 164.172 28.0877 164.094 27.4258 164.02C25.6547 163.822 23.5067 163.68 21.2012 163.588C16.5959 163.403 11.7087 163.426 8.64453 163.505C4.53005 163.611 1.10913 160.361 1.00293 156.247C0.897108 152.132 4.14621 148.711 8.26074 148.604Z"
        stroke="var(--logo-ink)"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <g filter={`url(#${f(2)})`}>
        <path
          d="M9.31437 182.327C12.5323 180.883 17.6555 178.772 22.7213 177.076C25.2505 176.229 27.9035 175.437 30.3743 174.893C32.6259 174.397 35.5618 173.906 38.298 174.216C42.9369 174.74 46.2718 178.927 45.7471 183.566C45.2223 188.205 41.0369 191.539 36.3982 191.015C36.5666 191.034 35.9036 190.987 34.0127 191.404C32.3405 191.772 30.3055 192.364 28.09 193.106C23.6664 194.587 19.0702 196.48 16.2368 197.752C11.978 199.663 6.97523 197.759 5.06344 193.501C3.15183 189.242 5.0555 184.239 9.31437 182.327Z"
          fill="var(--logo-ink)"
        />
      </g>
      <path
        d="M30.5898 175.869C32.8184 175.378 35.6205 174.919 38.1855 175.209C42.2753 175.672 45.2162 179.363 44.7539 183.453C44.3056 187.415 40.8279 190.299 36.8926 190.055L36.5107 190.021L36.3975 191.021C36.311 191.028 36.0049 191.046 35.4316 191.135C35.4131 190.983 35.4265 190.815 35.4971 190.642C35.6197 190.34 35.8461 190.2 35.9053 190.164C36.049 190.077 36.1821 190.049 36.1895 190.047C36.2274 190.038 36.2574 190.033 36.2695 190.031C36.2841 190.029 36.2956 190.028 36.3018 190.027C36.3083 190.027 36.3141 190.026 36.3164 190.025H36.3125C36.3071 190.026 36.3008 190.027 36.292 190.027C36.2178 190.033 36.0762 190.043 35.8662 190.066C35.4483 190.113 34.7752 190.211 33.7979 190.427C32.0786 190.806 30.0066 191.409 27.7725 192.157C23.3108 193.651 18.6831 195.557 15.8271 196.839C12.0722 198.524 7.66125 196.846 5.97559 193.091C4.29047 189.336 5.96863 184.925 9.72363 183.239C12.9188 181.805 18.0112 179.708 23.0391 178.024C25.5499 177.184 28.1665 176.403 30.5898 175.869Z"
        stroke="var(--logo-ink)"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <g filter={`url(#${f(3)})`}>
        <path
          d="M324.194 147.605C320.866 147.519 315.621 147.493 310.591 147.695C308.08 147.796 305.523 147.956 303.237 148.211C301.137 148.446 298.61 148.826 296.522 149.577C292.13 151.159 289.851 156.002 291.433 160.394C293.014 164.786 297.857 167.065 302.25 165.484C302.205 165.499 302.414 165.425 302.997 165.315C303.541 165.213 304.247 165.111 305.115 165.014C306.854 164.819 308.976 164.679 311.268 164.588C315.847 164.404 320.711 164.427 323.759 164.505C328.425 164.625 332.306 160.939 332.426 156.273C332.546 151.606 328.861 147.725 324.194 147.605Z"
          fill="var(--logo-ink)"
        />
      </g>
      <path
        d="M310.632 148.694C315.635 148.494 320.857 148.519 324.168 148.604C328.283 148.71 331.533 152.132 331.427 156.247C331.321 160.362 327.899 163.611 323.784 163.505C320.72 163.426 315.834 163.403 311.229 163.588C308.923 163.68 306.775 163.822 305.004 164.02C304.121 164.118 303.389 164.225 302.812 164.333C302.502 164.391 302.283 164.442 302.142 164.478C302.071 164.495 302.021 164.51 301.989 164.519C301.962 164.526 301.974 164.523 301.977 164.522C301.979 164.522 301.988 164.519 301.998 164.517C302.003 164.515 302.014 164.513 302.027 164.51C302.034 164.508 302.071 164.499 302.119 164.493C302.134 164.491 302.21 164.481 302.307 164.487C302.366 164.493 302.53 164.528 302.63 164.563C302.793 164.653 303.085 164.988 303.204 165.279C303.133 165.292 303.064 165.303 302.997 165.315L302.628 165.391C302.325 165.457 302.217 165.495 302.25 165.483L301.911 164.543C298.039 165.937 293.769 163.928 292.374 160.056C290.98 156.183 292.989 151.913 296.861 150.519C298.832 149.809 301.26 149.439 303.349 149.205C305.601 148.953 308.133 148.795 310.632 148.694Z"
        stroke="var(--logo-ink)"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <g filter={`url(#${f(4)})`}>
        <path
          d="M323.115 182.327C319.897 180.883 314.774 178.772 309.708 177.076C307.179 176.229 304.526 175.437 302.055 174.893C299.803 174.397 296.868 173.906 294.131 174.216C289.492 174.74 286.158 178.927 286.682 183.566C287.207 188.205 291.393 191.539 296.031 191.015C295.863 191.034 296.526 190.987 298.417 191.404C300.089 191.772 302.124 192.364 304.339 193.106C308.763 194.587 313.359 196.48 316.193 197.752C320.451 199.663 325.454 197.759 327.366 193.501C329.278 189.242 327.374 184.239 323.115 182.327Z"
          fill="var(--logo-ink)"
        />
      </g>
      <path
        d="M294.244 175.209C296.809 174.919 299.611 175.378 301.84 175.869C304.263 176.403 306.88 177.184 309.391 178.024C314.418 179.708 319.51 181.805 322.705 183.239C326.46 184.925 328.139 189.336 326.454 193.091C324.768 196.846 320.356 198.524 316.602 196.839H316.603C313.747 195.557 309.119 193.651 304.657 192.157C302.702 191.503 300.872 190.959 299.293 190.579L298.632 190.427C297.655 190.211 296.981 190.113 296.563 190.066C296.354 190.043 296.212 190.033 296.138 190.027C296.129 190.027 296.123 190.026 296.117 190.025H296.113C296.116 190.026 296.121 190.027 296.127 190.027C296.133 190.028 296.145 190.029 296.16 190.031C296.173 190.033 296.202 190.038 296.24 190.047C296.248 190.049 296.381 190.077 296.524 190.164C296.584 190.2 296.81 190.341 296.933 190.642C297.003 190.815 297.016 190.983 296.997 191.135C296.423 191.046 296.117 191.028 296.031 191.021L295.919 190.021C291.829 190.483 288.139 187.543 287.676 183.453C287.213 179.363 290.154 175.672 294.244 175.209Z"
        stroke="var(--logo-ink)"
        strokeWidth="2"
        strokeLinecap="round"
      />
      {/* Excited eyes are already closed — blinking them looks broken */}
      <g
        className="logo-eyes"
        style={frame.name === "excited" ? { animation: "none" } : undefined}
      >
      <g transform={`scale(${FACE_SCALE})`}>
      <path d={frame.eyes[0]} fill="var(--logo-eye)" />
      <path d={frame.eyes[1]} fill="var(--logo-eye)" />
      <g className="logo-pupils">
      {frame.pupils.map((p, i) => (
        <ellipse key={i} fill="var(--logo-pupil)" opacity={p.opacity} cx={p.cx} cy={p.cy} rx={p.rx} ry={p.ry} />
      ))}
      </g>
      </g>
      </g>
      </g>
    </>
  );
}

function MascotDefs({ f }: { f: (n: number) => string }) {
  return (
      <defs>
        <filter id={f(0)} x="48.1211" y="0" width="236.043" height="255.6" filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
          <feFlood floodOpacity="0" result="BackgroundImageFix" />
          <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
          <feColorMatrix in="SourceAlpha" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" result="hardAlpha" />
          <feOffset dy="12" />
          <feGaussianBlur stdDeviation="12" />
          <feComposite in2="hardAlpha" operator="arithmetic" k2="-1" k3="1" />
          <feColorMatrix type="matrix" values="0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 0.55 0" />
          <feBlend mode="normal" in2="shape" result="effect1_innerShadow" />
        </filter>
        <filter id={f(1)} x="0" y="147.541" width="41.498" height="22.0586" filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
          <feFlood floodOpacity="0" result="BackgroundImageFix" />
          <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
          <feColorMatrix in="SourceAlpha" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" result="hardAlpha" />
          <feOffset dy="4" />
          <feGaussianBlur stdDeviation="2" />
          <feComposite in2="hardAlpha" operator="arithmetic" k2="-1" k3="1" />
          <feColorMatrix type="matrix" values="0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 0.55 0" />
          <feBlend mode="normal" in2="shape" result="effect1_innerShadow" />
        </filter>
        <filter id={f(2)} x="4.32031" y="174.119" width="41.4814" height="28.375" filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
          <feFlood floodOpacity="0" result="BackgroundImageFix" />
          <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
          <feColorMatrix in="SourceAlpha" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" result="hardAlpha" />
          <feOffset dy="4" />
          <feGaussianBlur stdDeviation="2" />
          <feComposite in2="hardAlpha" operator="arithmetic" k2="-1" k3="1" />
          <feColorMatrix type="matrix" values="0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 0.55 0" />
          <feBlend mode="normal" in2="shape" result="effect1_innerShadow" />
        </filter>
        <filter id={f(3)} x="290.931" y="147.541" width="41.498" height="22.4453" filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
          <feFlood floodOpacity="0" result="BackgroundImageFix" />
          <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
          <feColorMatrix in="SourceAlpha" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" result="hardAlpha" />
          <feOffset dy="4" />
          <feGaussianBlur stdDeviation="2" />
          <feComposite in2="hardAlpha" operator="arithmetic" k2="-1" k3="1" />
          <feColorMatrix type="matrix" values="0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 0.55 0" />
          <feBlend mode="normal" in2="shape" result="effect1_innerShadow" />
        </filter>
        <filter id={f(4)} x="286.628" y="174.119" width="41.4814" height="28.375" filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
          <feFlood floodOpacity="0" result="BackgroundImageFix" />
          <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
          <feColorMatrix in="SourceAlpha" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" result="hardAlpha" />
          <feOffset dy="4" />
          <feGaussianBlur stdDeviation="2" />
          <feComposite in2="hardAlpha" operator="arithmetic" k2="-1" k3="1" />
          <feColorMatrix type="matrix" values="0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 0.55 0" />
          <feBlend mode="normal" in2="shape" result="effect1_innerShadow" />
        </filter>
      </defs>
  );
}

// Mascot only (Design/GitBot LogoMark.svg space, 333x244). Same live face
// as the lockup.
export function LogoMark({ height = 40 }: { height?: number }) {
  const uid = useId().replace(/:/g, "");
  const f = (n: number) => `logo-m${n}-${uid}`;
  const frame = useLiveFace();

  return (
    <svg
      height={height}
      viewBox="0 0 333 244"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="GitBot mascot"
      className="logo-mark"
    >
      {/* Depth shading (same filter as the mascots): top light, bottom
          shade. Eyes are white/dark, so only the body visibly models. */}
      <g style={{ filter: "url(#mascot-depth)" }}>
        <MascotArt frame={frame} f={f} />
      </g>
      <MascotDefs f={f} />
    </svg>
  );
}

export default function Logo({ height = 30 }: { height?: number }) {
  const uid = useId().replace(/:/g, "");
  const f = (n: number) => `logo-f${n}-${uid}`;
  const frame = useLiveFace();

  return (
    <svg
      height={height}
      viewBox="0 0 1038 244"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="GitBot"
    >
      <MascotArt frame={frame} f={f} />
      <g fill="var(--logo-ink)">
        <path d="M462.718 224.499C447.05 224.499 433.324 221.084 421.539 214.254C409.755 207.425 400.582 197.783 394.02 185.329C387.459 172.875 384.178 158.345 384.178 141.74C384.178 125.001 387.526 110.405 394.221 97.9507C401.051 85.4967 410.425 75.855 422.343 69.0254C434.261 62.1959 447.853 58.7811 463.119 58.7811C479.859 58.7811 494.053 62.5307 505.704 70.0298C517.488 77.5289 526.059 88.0411 531.415 101.566C531.549 101.834 531.616 102.236 531.616 102.772C531.616 104.111 530.946 104.981 529.607 105.383L505.503 112.012C504.164 112.012 503.293 111.409 502.892 110.204C499.142 102.838 493.92 97.2141 487.224 93.3307C480.528 89.4472 472.627 87.5054 463.521 87.5054C453.344 87.5054 444.573 89.782 437.207 94.335C429.842 98.8881 424.218 105.249 420.334 113.418C416.451 121.452 414.509 130.96 414.509 141.941C414.509 152.788 416.451 162.229 420.334 170.264C424.352 178.299 429.976 184.592 437.207 189.145C444.573 193.565 453.344 195.774 463.521 195.774C475.306 195.774 485.215 192.828 493.25 186.936C501.285 180.91 505.905 172.072 507.11 160.421H467.137C465.262 160.421 464.325 159.484 464.325 157.609V135.915C464.325 134.04 465.262 133.103 467.137 133.103H533.826C535.7 133.103 536.638 134.04 536.638 135.915V153.993C536.638 167.251 533.826 179.236 528.201 189.949C522.577 200.528 514.274 208.898 503.293 215.058C492.313 221.352 478.787 224.499 462.718 224.499Z" />
        <path d="M569.557 88.7107C564.87 88.7107 560.919 87.3046 557.706 84.4924C554.626 81.5463 553.086 77.7298 553.086 73.0428C553.086 68.3559 554.626 64.6063 557.706 61.7941C560.919 58.848 564.87 57.375 569.557 57.375C574.244 57.375 578.127 58.848 581.207 61.7941C584.421 64.6063 586.028 68.3559 586.028 73.0428C586.028 77.7298 584.421 81.5463 581.207 84.4924C578.127 87.3046 574.244 88.7107 569.557 88.7107ZM555.496 111.61C555.496 109.735 556.433 108.798 558.308 108.798H581.408C583.283 108.798 584.22 109.735 584.22 111.61V218.472C584.22 220.481 583.283 221.485 581.408 221.485H558.308C556.433 221.485 555.496 220.481 555.496 218.472V111.61Z" />
        <path d="M649.118 223.695C636.932 223.695 627.558 219.879 620.997 212.245C614.569 204.612 611.355 193.163 611.355 177.897V134.107H594.884C593.009 134.107 592.072 133.17 592.072 131.295V111.61C592.072 109.735 593.009 108.798 594.884 108.798H611.355V78.4663C611.355 76.5915 612.292 75.6541 614.167 75.6541H636.865C638.74 75.6541 639.678 76.5915 639.678 78.4663V108.798H666.393C668.268 108.798 669.205 109.735 669.205 111.61V131.295C669.205 133.17 668.268 134.107 666.393 134.107H639.678V179.705C639.678 191.891 643.896 197.984 652.332 197.984C655.814 197.984 658.626 196.176 660.769 192.56C661.706 190.819 662.978 190.351 664.585 191.154L681.659 198.787C682.731 199.457 683.266 200.26 683.266 201.198C683.266 202.001 682.998 202.738 682.463 203.407C678.445 210.772 673.491 215.995 667.598 219.075C661.706 222.155 655.546 223.695 649.118 223.695Z" />
        <path d="M695.894 221.485C694.02 221.485 693.082 220.548 693.082 218.673V64.6063C693.082 62.7315 694.02 61.7941 695.894 61.7941H750.732C763.454 61.7941 773.899 63.602 782.067 67.2176C790.236 70.6994 796.262 75.5872 800.146 81.8811C804.163 88.0411 806.172 95.0715 806.172 102.972C806.172 110.739 804.297 117.77 800.547 124.064C796.798 130.224 791.307 134.777 784.076 137.723C794.12 140.401 801.619 145.155 806.574 151.985C811.662 158.814 814.207 166.782 814.207 175.888C814.207 189.815 809.319 200.93 799.543 209.232C789.901 217.401 774.301 221.485 752.741 221.485H695.894ZM749.527 126.273C757.963 126.273 764.458 124.733 769.011 121.653C773.698 118.439 776.041 113.819 776.041 107.793C776.041 101.767 773.698 97.2141 769.011 94.1341C764.458 90.9202 757.963 89.3133 749.527 89.3133H722.409V126.273H749.527ZM753.745 194.167C763.52 194.167 770.953 192.359 776.041 188.744C781.13 185.128 783.674 179.972 783.674 173.277C783.674 166.581 781.13 161.492 776.041 158.011C770.953 154.529 763.52 152.788 753.745 152.788H722.409V194.167H753.745Z" />
        <path d="M884.745 223.695C872.693 223.695 862.18 221.151 853.208 216.062C844.37 211.107 837.474 204.278 832.519 195.573C827.564 186.735 825.087 176.625 825.087 165.242C825.087 153.725 827.564 143.615 832.519 134.911C837.474 126.072 844.37 119.176 853.208 114.221C862.18 109.132 872.693 106.588 884.745 106.588C896.797 106.588 907.309 109.132 916.281 114.221C925.254 119.176 932.15 126.072 936.971 134.911C941.926 143.615 944.403 153.725 944.403 165.242C944.403 176.625 941.926 186.735 936.971 195.573C932.15 204.278 925.254 211.107 916.281 216.062C907.309 221.151 896.797 223.695 884.745 223.695ZM854.213 165.242C854.213 174.884 857.025 182.785 862.649 188.945C868.407 194.971 875.773 197.984 884.745 197.984C893.851 197.984 901.216 194.971 906.841 188.945C912.465 182.785 915.277 174.884 915.277 165.242C915.277 155.466 912.465 147.565 906.841 141.539C901.216 135.379 893.851 132.299 884.745 132.299C875.773 132.299 868.407 135.379 862.649 141.539C857.025 147.565 854.213 155.466 854.213 165.242Z" />
        <path d="M1003.21 223.695C991.028 223.695 981.654 219.879 975.092 212.245C968.664 204.612 965.45 193.163 965.45 177.897V134.107H948.979C947.104 134.107 946.167 133.17 946.167 131.295V111.61C946.167 109.735 947.104 108.798 948.979 108.798H965.45V78.4663C965.45 76.5915 966.388 75.6541 968.263 75.6541H990.961C992.836 75.6541 993.773 76.5915 993.773 78.4663V108.798H1020.49C1022.36 108.798 1023.3 109.735 1023.3 111.61V131.295C1023.3 133.17 1022.36 134.107 1020.49 134.107H993.773V179.705C993.773 191.891 997.991 197.984 1006.43 197.984C1009.91 197.984 1012.72 196.176 1014.86 192.56C1015.8 190.819 1017.07 190.351 1018.68 191.154L1035.75 198.787C1036.83 199.457 1037.36 200.26 1037.36 201.198C1037.36 202.001 1037.09 202.738 1036.56 203.407C1032.54 210.772 1027.59 215.995 1021.69 219.075C1015.8 222.155 1009.64 223.695 1003.21 223.695Z" />
      </g>
      <MascotDefs f={f} />
    </svg>
  );
}
