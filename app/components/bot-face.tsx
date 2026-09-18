import { useCallback, useEffect, useRef, useState } from "react";
import BotMascot from "./bot-maker/BotMascot";
import { activityExpressions, bodies } from "./bot-maker/registry";
import type { AvatarMascot } from "../lib/avatar-prefs";

// Ambient behavior (our own director; the bot-maker motion system is
// untouched — only activity/expression props change, so every switch
// morphs instead of popping):
// - baseline idle cycles (neutral/looking/happy/wink come free)
// - idle 60s+ with no interaction → sleeping; any activity wakes
// - hover (or external cheer) holds happy while active
// - reduced motion parks the body; morphs stay permitted
const SLEEP_AFTER = 60000;

function dimsFor(id: string): { w: number; h: number } {
  const found =
    bodies.find((b) => b.id === id) ?? bodies.find((b) => b.id === "ghost")!;
  const [w, h] = found.viewBox.split(" ").slice(2).map(Number);
  return { w: w || 1, h: h || 1 };
}

function useMood(ambient: boolean, cheer: boolean, phase: number) {
  const [sleeping, setSleeping] = useState(false);
  const [hovering, setHovering] = useState(false);
  // Staggered release: instances mounted together hold different starting
  // expressions, then join the activity cycle offset — same period, so the
  // offset (and the sleep-timer stagger below) persists instead of
  // reconverging.
  const [released, setReleased] = useState(() => !phase);
  const sleepTimer = useRef(0);

  const poke = useCallback(() => {
    setSleeping(false);
    if (!ambient) return;
    clearTimeout(sleepTimer.current);
    sleepTimer.current = window.setTimeout(() => setSleeping(true), SLEEP_AFTER);
  }, [ambient]);

  useEffect(() => {
    // Arm the sleep watch late per instance so rails don't doze as one.
    const arm = window.setTimeout(poke, phase * 1700);
    return () => {
      clearTimeout(arm);
      clearTimeout(sleepTimer.current);
    };
  }, [poke, phase]);

  useEffect(() => {
    if (released || !phase) return;
    const t = window.setTimeout(() => setReleased(true), phase * 1700);
    return () => clearTimeout(t);
  }, [phase, released]);

  // External cheer (e.g. hovering the bot's row) holds a smile and wakes.
  useEffect(() => {
    if (ambient && cheer) poke();
  }, [cheer, ambient, poke]);

  // Reduced motion parks the body; morphs stay permitted.
  const [reduced] = useState(
    () =>
      typeof matchMedia !== "undefined" &&
      matchMedia("(prefers-reduced-motion: reduce)").matches,
  );

  return {
    activity: (sleeping ? "sleeping" : "idle") as "idle" | "sleeping",
    happy: cheer || hovering,
    reduced,
    released,
    onEnter() {
      setHovering(true);
      poke();
    },
    onLeave() {
      setHovering(false);
      poke();
    },
  };
}

// One avatar renderer for the app. No tiles, boxes, or backgrounds —
// the mascot floats free.
export default function BotFace({
  mascot,
  color,
  size = 40,
  ambient = true,
  cheer = false,
  follow = false,
  still = false,
  duration = 420,
  phase = 0,
}: {
  mascot: AvatarMascot;
  color: string;
  size?: number;
  ambient?: boolean;
  /** External delight signal (e.g. row hovered). Holds a smile. */
  cheer?: boolean;
  /** Face tracks the cursor (studio only). Gated on no-preference. */
  follow?: boolean;
  /** Pose neutral and still (picker tiles). Preview + rail stay live. */
  still?: boolean;
  /** Geometry morph time in ms (bot-maker clamps 120–2000). */
  duration?: number;
  /** Stagger index: holds a different starting expression and arms sleep
   *  late, so instances mounted together never move as one. Default 0
   *  preserves existing behavior exactly. */
  phase?: number;
}) {
  const mood = useMood(ambient, cheer, phase);
  const motion = mood.reduced ? false : !still;
  const seq = activityExpressions[mood.activity] ?? activityExpressions.idle;
  const holdExpr = seq[phase % seq.length];
  const expression = mood.happy
    ? "happy"
    : !mood.released
      ? holdExpr
      : still
        ? "neutral"
        : undefined;
  // Fit tall bodies inside the square box by width.
  const { w, h } = dimsFor(mascot);
  const fitWidth = Math.round(size * Math.min(1, w / h));
  return (
    <span
      className={follow ? "bot-avatar follow" : "bot-avatar"}
      style={{ width: size, height: size }}
      aria-hidden="true"
      onMouseEnter={mood.onEnter}
      onMouseLeave={mood.onLeave}
    >
      <BotMascot
        body={mascot}
        color={color}
        size={fitWidth}
        expression={expression}
        activity={mood.activity}
        motion={motion}
        duration={duration}
      />
    </span>
  );
}
