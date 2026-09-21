import { useCallback, useEffect, useRef, useState } from "react";
import BotMascot from "./bot-maker/BotMascot";
import { bodies } from "./bot-maker/registry";
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

function useMood(ambient: boolean, cheer: boolean) {
  const [sleeping, setSleeping] = useState(false);
  const [hovering, setHovering] = useState(false);
  const sleepTimer = useRef(0);

  const poke = useCallback(() => {
    setSleeping(false);
    if (!ambient) return;
    clearTimeout(sleepTimer.current);
    sleepTimer.current = window.setTimeout(() => setSleeping(true), SLEEP_AFTER);
  }, [ambient]);

  useEffect(() => {
    poke();
    return () => clearTimeout(sleepTimer.current);
  }, [poke]);

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
}) {
  const mood = useMood(ambient, cheer);
  const motion = mood.reduced ? false : !still;
  const expression = mood.happy ? "happy" : still ? "neutral" : undefined;
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
      />
    </span>
  );
}
