// Tells the server where the user is, so a push is only sent when it would
// tell them something they can't already see (src/presence.ts decides). Each
// tab reports when its state changes, and renews it every RENEW_MS while it
// says the user is here; leaving (hidden, blur, closing) is sent at once, with
// keepalive so it survives the page going away. The service worker can't do
// this filtering itself: every push must show a notification.

import { useEffect, useRef } from "react";
import { ApiError, postPresence } from "./api";
import { IDLE_MS, presenceState, RENEW_MS } from "./presence-state";

const TAB_KEY = "gitbot-presence-tab";

/** This tab's id: random, kept in sessionStorage so a reload is the same tab. */
function tabId(): string {
  const fresh = () => {
    const bytes = new Uint8Array(12);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  };
  try {
    const kept = sessionStorage.getItem(TAB_KEY);
    if (kept && /^[a-f0-9]{24}$/.test(kept)) return kept;
    const id = fresh();
    sessionStorage.setItem(TAB_KEY, id);
    return id;
  } catch {
    return fresh();
  }
}

/** Reports this tab's presence on `threadId` (null: no thread on screen) for as long as it is mounted. */
export function usePresence(threadId: string | null): void {
  const threadRef = useRef(threadId);
  const reportRef = useRef<(leaving?: boolean) => void>(() => {});

  useEffect(() => {
    const tab = tabId();
    let lastInput = Date.now();
    let lastSent = "";
    let lastSentAt = 0;
    let wasIdle = false;
    // The server has push off (404) or won't take reports from this page (403): stop asking.
    let off = false;

    const report = (leaving = false) => {
      if (off) return;
      const idle = Date.now() - lastInput >= IDLE_MS;
      wasIdle = idle;
      const { state, thread } = presenceState({
        visible: document.visibilityState === "visible",
        focused: document.hasFocus(),
        idle,
        threadId: threadRef.current,
      });
      const key = `${state}:${thread ?? ""}`;
      const now = Date.now();
      // Unchanged: only a report that says "here" needs renewing; "away" stands until it changes.
      if (key === lastSent && (state === "away" || now - lastSentAt < RENEW_MS - 1_000)) return;
      lastSent = key;
      lastSentAt = now;
      postPresence({ tab, thread, state }, leaving).catch((err) => {
        if (err instanceof ApiError && (err.status === 404 || err.status === 403)) off = true;
        else if (lastSent === key) lastSent = ""; // try again on the next tick
      });
    };
    reportRef.current = report;

    const input = (e: Event) => {
      const now = Date.now();
      // pointermove fires constantly: once a second is plenty.
      if (e.type === "pointermove" && now - lastInput < 1_000) return;
      lastInput = now;
      if (wasIdle) report();
    };
    const inputs = ["pointermove", "pointerdown", "keydown", "wheel", "scroll", "touchstart"] as const;
    const opts = { capture: true, passive: true };
    for (const type of inputs) window.addEventListener(type, input, opts);

    const changed = () => {
      // Back: that counts as input. Leaving: say so now, before the page may be frozen.
      const here = document.visibilityState === "visible" && document.hasFocus();
      if (here) lastInput = Date.now();
      report(!here);
    };
    const leave = () => report(true);
    document.addEventListener("visibilitychange", changed);
    window.addEventListener("focus", changed);
    window.addEventListener("blur", changed);
    window.addEventListener("pagehide", leave);

    report();
    const timer = window.setInterval(() => report(), RENEW_MS);
    return () => {
      window.clearInterval(timer);
      for (const type of inputs) window.removeEventListener(type, input, opts);
      document.removeEventListener("visibilitychange", changed);
      window.removeEventListener("focus", changed);
      window.removeEventListener("blur", changed);
      window.removeEventListener("pagehide", leave);
      if (!off) postPresence({ tab, thread: null, state: "away" }, true).catch(() => {});
      reportRef.current = () => {};
    };
  }, []);

  useEffect(() => {
    threadRef.current = threadId;
    reportRef.current();
  }, [threadId]);
}

/**
 * Closes this device's notifications about a thread: it is on screen now, or
 * what they asked for was answered here. Other devices keep theirs until a
 * newer one replaces it (the server can't close them: iOS shows every push).
 */
export async function closeThreadNotifications(threadId: string): Promise<void> {
  try {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    const reg = await navigator.serviceWorker.getRegistration("/");
    const shown = await reg?.getNotifications({ tag: `thread-${threadId}` });
    for (const n of shown ?? []) n.close();
  } catch {
    // Older browsers without getNotifications: nothing to close.
  }
}
