"use client";

import { useEffect, useRef, type ComponentPropsWithRef, type ComponentType, type HTMLAttributes } from "react";
import type { DownloadIcon } from "@animateicons/react/lucide/download-icon";

type AnimatedIconProps = ComponentPropsWithRef<typeof DownloadIcon>;
type IconHandle = { startAnimation: () => void; stopAnimation: () => void };

// Each caller imports its icon directly so unused icons stay out of its bundle.
export default function AnimatedActionIcon({ icon: Icon, size = 16, className = "", ...props }: HTMLAttributes<HTMLSpanElement> & {
  icon: ComponentType<AnimatedIconProps>;
  size?: number;
}) {
  const elementRef = useRef<HTMLSpanElement>(null);
  const animationRef = useRef<IconHandle>(null);

  useEffect(() => {
    const control = elementRef.current?.closest<HTMLElement>("button, a, summary, [role='button']");
    if (!control) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let playing = false;
    function sync() {
      const active = !reducedMotion.matches && !control!.matches(":disabled, [aria-disabled='true']") &&
        !elementRef.current?.closest("[hidden], [inert]") &&
        control!.matches(":hover, :focus-visible");
      if (active === playing) return;
      playing = active;
      if (active) animationRef.current?.startAnimation();
      else animationRef.current?.stopAnimation();
    }
    const events = ["pointerenter", "pointerleave", "focusin", "focusout"] as const;
    events.forEach((event) => control.addEventListener(event, sync));
    reducedMotion.addEventListener("change", sync);
    sync();
    return () => {
      events.forEach((event) => control.removeEventListener(event, sync));
      reducedMotion.removeEventListener("change", sync);
      animationRef.current?.stopAnimation();
    };
  }, [Icon]);

  return (
    <span {...props} ref={elementRef} className={`action-icon ${className}`} aria-hidden="true">
      <Icon ref={animationRef} size={size} duration={0.5} isAnimated={false} />
    </span>
  );
}
