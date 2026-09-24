"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { LaptopIcon, type LaptopIconHandle } from "@animateicons/react/lucide/laptop-icon";

const DISMISS_KEY = "gitbot-desktop-notice-dismissed";

/** Below 1100px the hub is cramped, so a notice says so — once per tab.
 *  It never locks the app: a tablet or phone on the same network is a
 *  supported way in (the README's "any device"), just not a polished one. */
export default function DesktopNotice({ children }: { children: ReactNode }) {
  const isReadmePreview = usePathname() === "/readme-preview";
  const contentRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const iconRef = useRef<LaptopIconHandle>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  // null until mounted: the notice must not flash for viewers who already
  // dismissed it (sessionStorage is only readable on the client).
  const [dismissed, setDismissed] = useState<boolean | null>(null);

  useEffect(() => {
    let saved = false;
    try {
      saved = sessionStorage.getItem(DISMISS_KEY) === "1";
    } catch {}
    setDismissed(saved);
  }, []);

  useEffect(() => {
    if (isReadmePreview) return;
    if (dismissed !== false) {
      if (contentRef.current) contentRef.current.inert = false;
      return;
    }
    const query = window.matchMedia("(max-width: 1100px)");
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
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
          previousFocus.current = document.activeElement as HTMLElement;
          contentRef.current!.inert = true;
          headingRef.current?.focus();
        }
      } else {
        contentRef.current!.inert = false;
        if (previousFocus.current?.isConnected) previousFocus.current.focus();
        previousFocus.current = null;
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
  }, [dismissed, isReadmePreview]);

  function dismiss() {
    try {
      sessionStorage.setItem(DISMISS_KEY, "1");
    } catch {}
    setDismissed(true);
    const back = previousFocus.current;
    previousFocus.current = null;
    requestAnimationFrame(() => {
      if (back?.isConnected) back.focus({ preventScroll: true });
    });
  }

  return (
    <>
      <div ref={contentRef}>{children}</div>
      {!isReadmePreview && dismissed === false && (
        <div className="desktop-notice" role="dialog" aria-modal="true" aria-labelledby="desktop-notice-title" aria-describedby="desktop-notice-copy">
          <div className="desktop-notice-inner">
            <LaptopIcon ref={iconRef} className="desktop-notice-icon" size={96} isAnimated={false} aria-hidden="true" />
            <h1 id="desktop-notice-title" ref={headingRef} tabIndex={-1}>Some things need a little more room.</h1>
            <p id="desktop-notice-copy">GitBot is designed for desktop. It works here too, but the panels are cramped — open it on a computer for the full experience.</p>
            <button type="button" className="btn-primary desktop-notice-continue" onClick={dismiss}>
              Continue anyway
            </button>
          </div>
        </div>
      )}
    </>
  );
}
