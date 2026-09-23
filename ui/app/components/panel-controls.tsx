"use client";

import AnimatedActionIcon from "./animated-action-icon";
import { ArrowLeftIcon } from "@animateicons/react/lucide/arrow-left-icon";
import { XIcon } from "@animateicons/react/lucide/x-icon";
import { useEffect, useRef, useState, type ButtonHTMLAttributes } from "react";

type ControlProps = ButtonHTMLAttributes<HTMLButtonElement>;

export function CloseButton({ className = "", "aria-label": label = "Close", ...props }: ControlProps) {
  return (
    <button {...props} type="button" className={`close-btn ${className}`} aria-label={label} data-tip="Close">
      <AnimatedActionIcon icon={XIcon} size={18} aria-hidden="true" />
    </button>
  );
}

export function BackButton({ children = "Back", ...props }: ControlProps) {
  return (
    <button {...props} type="button" className="back-btn">
      <AnimatedActionIcon icon={ArrowLeftIcon} size={16} aria-hidden="true" />
      {children}
    </button>
  );
}

// Navigation belongs to the panel edge, outside its centered content column.
export function PanelBack(props: Omit<ControlProps, "children">) {
  const navRef = useRef<HTMLDivElement>(null);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    let scroller = navRef.current?.parentElement ?? null;
    while (scroller) {
      const overflow = getComputedStyle(scroller).overflowY;
      if (overflow === "auto" || overflow === "scroll" || overflow === "overlay") break;
      scroller = scroller.parentElement;
    }
    if (!scroller) return;

    const update = () => setScrolled(scroller.scrollTop > 1);
    update();
    scroller.addEventListener("scroll", update, { passive: true });
    return () => scroller.removeEventListener("scroll", update);
  }, []);

  return (
    <div ref={navRef} className={`panel-nav${scrolled ? " is-scrolled" : ""}`}>
      <BackButton {...props} />
    </div>
  );
}
