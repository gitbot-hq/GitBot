import { useEffect, useRef, useState } from "react";

// Tab alerts for bot status: swaps <link rel="icon"> hrefs to pre-made
// notification SVGs (mascot + colored dot) and sets a standout title
// while the tab is hidden.
//
// Statuses, highest priority first:
//   attention — a permission request awaits the user (brand-ember dot)
//   error     — the turn failed (danger dot)
//   working   — a turn is streaming (brand-sky dot)
//   done      — the turn just finished cleanly (brand-leaf dot, ~6s)
//   idle      — plain favicons, original title

export type FaviconSignal = "idle" | "working" | "attention" | "error";

type Status = FaviconSignal | "done";

type ThemeVariant = "light" | "dark";

const NOTIF: Record<Status, Record<ThemeVariant, string>> = {
  idle: { light: "", dark: "" },
  working: { light: "/notif/light.svg", dark: "/notif/dark.svg" },
  attention: { light: "/notif/light-attention.svg", dark: "/notif/dark-attention.svg" },
  error: { light: "/notif/light-error.svg", dark: "/notif/dark-error.svg" },
  done: { light: "/notif/light-done.svg", dark: "/notif/dark-done.svg" },
};

const LABELS: Record<Exclude<Status, "idle">, string> = {
  working: "Working",
  attention: "Needs your approval",
  done: "Done",
  error: "Something went wrong",
};

const DONE_MS = 6000;

const originals = new Map<HTMLLinkElement, string>();
let originalTitle: string | null = null;

function iconLinks(): HTMLLinkElement[] {
  return Array.from(
    document.querySelectorAll<HTMLLinkElement>('link[rel="icon"]'),
  );
}

function themeVariant(href: string): ThemeVariant {
  return href.includes("dark") ? "dark" : "light";
}

function restore() {
  for (const [link, href] of originals) {
    if (link.isConnected) link.href = href;
  }
  originals.clear();
  if (originalTitle !== null) {
    document.title = originalTitle;
    originalTitle = null;
  }
}

function settleTitle(status: Status) {
  if (originalTitle === null) return;
  if (status === "idle" || !document.hidden) {
    document.title = originalTitle;
    if (status === "idle") originalTitle = null;
  } else {
    document.title = `● ${LABELS[status]} · ${originalTitle}`;
  }
}

/** Drive tab alerts from the chat's live signal. Restores everything on
 *  unmount or return to idle. */
export function useStatusFavicon(signal: FaviconSignal) {
  const [doneUntil, setDoneUntil] = useState(0);
  const prev = useRef<FaviconSignal>(signal);
  const doneTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const last = prev.current;
    prev.current = signal;
    if (signal === "idle" && (last === "working" || last === "attention")) {
      setDoneUntil(Date.now() + DONE_MS);
      if (doneTimer.current) clearTimeout(doneTimer.current);
      doneTimer.current = setTimeout(() => setDoneUntil(0), DONE_MS + 50);
    }
    return () => {
      if (doneTimer.current) {
        clearTimeout(doneTimer.current);
        doneTimer.current = null;
      }
    };
  }, [signal]);

  const effective: Status =
    signal === "idle" && Date.now() < doneUntil ? "done" : signal;

  useEffect(() => {
    if (effective === "idle") {
      restore();
      return;
    }
    // Record originals on first use.
    for (const link of iconLinks()) {
      if (!originals.has(link)) originals.set(link, link.href);
    }
    // Swap each icon to the state-appropriate notif SVG.
    for (const link of iconLinks()) {
      const orig = originals.get(link) ?? link.href;
      const variant = themeVariant(orig);
      link.href = NOTIF[effective][variant];
    }
    if (originalTitle === null) originalTitle = document.title;
    settleTitle(effective);
    const onVis = () => settleTitle(effective);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [effective]);

  useEffect(() => () => restore(), []);
}
