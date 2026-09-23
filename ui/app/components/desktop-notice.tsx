"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { LaptopIcon, type LaptopIconHandle } from "@animateicons/react/lucide/laptop-icon";

export default function DesktopNotice({ children }: { children: ReactNode }) {
  const contentRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const iconRef = useRef<LaptopIconHandle>(null);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 1100px)");
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let previousFocus: HTMLElement | null = null;
    let animationTimer: number | undefined;

    const animateIcon = () => {
      window.clearInterval(animationTimer);
      if (query.matches && !reducedMotion.matches) {
        iconRef.current?.startAnimation();
        animationTimer = window.setInterval(() => iconRef.current?.startAnimation(), 4500);
      } else {
        iconRef.current?.stopAnimation();
      }
    };

    const update = () => {
      if (query.matches) {
        if (!contentRef.current?.inert) {
          previousFocus = document.activeElement as HTMLElement;
          contentRef.current!.inert = true;
          headingRef.current?.focus();
        }
      } else {
        contentRef.current!.inert = false;
        if (previousFocus?.isConnected) previousFocus.focus();
        previousFocus = null;
      }
    };

    update();
    animateIcon();
    query.addEventListener("change", update);
    query.addEventListener("change", animateIcon);
    reducedMotion.addEventListener("change", animateIcon);
    return () => {
      query.removeEventListener("change", update);
      query.removeEventListener("change", animateIcon);
      reducedMotion.removeEventListener("change", animateIcon);
      window.clearInterval(animationTimer);
      if (contentRef.current) contentRef.current.inert = false;
    };
  }, []);

  return (
    <>
      <div ref={contentRef}>{children}</div>
      <div className="desktop-notice" role="dialog" aria-modal="true" aria-labelledby="desktop-notice-title" aria-describedby="desktop-notice-copy">
        <div className="desktop-notice-inner">
          <LaptopIcon ref={iconRef} className="desktop-notice-icon" size={96} isAnimated={false} aria-hidden="true" />
          <h1 id="desktop-notice-title" ref={headingRef} tabIndex={-1}>Some things need a little more room.</h1>
          <p id="desktop-notice-copy">GitBot is designed for desktop. Open it on a computer for the full experience. We’re making room for smaller screens.</p>
        </div>
      </div>
    </>
  );
}
