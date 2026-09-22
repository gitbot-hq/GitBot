"use client";

import { useEffect, useRef, type ReactNode } from "react";

export default function DesktopNotice({ children }: { children: ReactNode }) {
  const contentRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 1100px)");
    let previousFocus: HTMLElement | null = null;

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
    query.addEventListener("change", update);
    return () => {
      query.removeEventListener("change", update);
      if (contentRef.current) contentRef.current.inert = false;
    };
  }, []);

  return (
    <>
      <div ref={contentRef}>{children}</div>
      <div className="desktop-notice" role="dialog" aria-modal="true" aria-labelledby="desktop-notice-title" aria-describedby="desktop-notice-copy">
        <div className="desktop-notice-inner">
          <svg className="desktop-notice-icon" viewBox="0 0 120 96" fill="none" aria-hidden="true">
            <rect x="15" y="12" width="90" height="65" rx="7" stroke="currentColor" strokeWidth="3" />
            <path d="M5 80h110l-7 7H12l-7-7Z" fill="currentColor" />
            <path d="M49 43c5 8 17 8 22 0" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
            <circle cx="49" cy="37" r="2.5" fill="currentColor" />
            <circle cx="71" cy="37" r="2.5" fill="currentColor" />
          </svg>
          <h1 id="desktop-notice-title" ref={headingRef} tabIndex={-1}>Some things need a little more room.</h1>
          <p id="desktop-notice-copy">GitBot is designed for desktop. Open it on a computer for the full experience. We’re making room for smaller screens.</p>
        </div>
      </div>
    </>
  );
}
