"use client";

import { useEffect, type RefObject } from "react";

export function useMascotPointerFollow({
  root,
  group,
  enabled = true,
}: {
  root?: RefObject<HTMLElement | null>;
  group?: string;
  enabled?: boolean;
} = {}) {
  useEffect(() => {
    if (!enabled || matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    let frame = 0;
    let pointerX = window.innerWidth / 2;
    let pointerY = window.innerHeight / 2;
    const apply = () => {
      frame = 0;
      const mascots = group
        ? document.querySelectorAll<HTMLElement>("[data-bot-follow] .bot-mascot")
        : root?.current?.querySelectorAll<HTMLElement>(".bot-avatar.follow .bot-mascot") ?? [];

      mascots.forEach((mascot) => {
        if (group && mascot.closest<HTMLElement>("[data-bot-follow]")?.dataset.botFollow !== group) return;
        const bounds = mascot.getBoundingClientRect();
        const dx = (pointerX - (bounds.left + bounds.width / 2)) / bounds.width;
        const dy = (pointerY - (bounds.top + bounds.height / 2)) / bounds.height;
        const length = Math.hypot(dx, dy) || 1;
        const distance = Math.min(1, length * 1.5) * 3;
        mascot.style.setProperty("--px", `${((dx / length) * distance).toFixed(2)}px`);
        mascot.style.setProperty("--py", `${((dy / length) * distance).toFixed(2)}px`);
      });
    };
    const followPointer = (event: PointerEvent) => {
      pointerX = event.clientX;
      pointerY = event.clientY;
      if (!frame) frame = requestAnimationFrame(apply);
    };

    window.addEventListener("pointermove", followPointer, { passive: true });
    return () => {
      window.removeEventListener("pointermove", followPointer);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [enabled, group, root]);
}
