"use client";

import { useEffect, useState } from "react";
import { disablePush, enablePush, pushState, testPush, type PushState } from "../lib/push";

const HINTS: Record<PushState, string> = {
  insecure: "Notifications need a secure address. Open gitbot over HTTPS, or on http://localhost on this computer.",
  "needs-install":
    "On iPhone and iPad, notifications only work from the Home Screen app. Tap Share, then Add to Home Screen, open GitBot from there, and enable them here.",
  "ios-too-old": "Notifications need iOS 16.4 or later. Update iOS, then open GitBot from the Home Screen again.",
  unsupported: "This browser can't get notifications from gitbot. Try Chrome, Edge, Firefox or Safari.",
  "server-off": "Turned off on this gitbot (GITBOT_PUSH=0).",
  denied:
    "Blocked for this site. Allow notifications in the browser's site settings (on iPhone: Settings → Notifications → GitBot), then reload.",
  off: "Get a notification when a thread finishes, fails, or waits on your approval or a question.",
  on: "On for this browser: you'll hear when a thread finishes, fails, or needs you.",
};

/** Browser notifications for this device: on, off, and a test. */
export default function NotificationsSetting() {
  // null while the first check runs.
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tested, setTested] = useState(false);

  useEffect(() => {
    let live = true;
    pushState().then(
      (s) => { if (live) setState(s); },
      () => { if (live) setState("off"); },
    );
    return () => { live = false; };
  }, []);

  async function run(action: () => Promise<PushState | void>) {
    setBusy(true);
    setError(null);
    setTested(false);
    try {
      const next = await action();
      if (next) setState(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="profile-notify" aria-label="Notifications">
      <div className="profile-notify-text">
        <h3>Notifications</h3>
        <p>{state ? HINTS[state] : "Checking this browser…"}</p>
        {error && <p className="chat-error" role="alert">{error}</p>}
        {tested && <p role="status">Test sent. It should appear in a moment.</p>}
      </div>
      <div className="profile-acts">
        {state === "off" && (
          <button type="button" className="btn-primary" disabled={busy} onClick={() => run(enablePush)}>
            Enable notifications
          </button>
        )}
        {state === "on" && (
          <>
            <button
              type="button"
              className="btn-secondary"
              disabled={busy}
              onClick={() => run(async () => { await testPush(); setTested(true); })}
            >
              Send a test
            </button>
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => run(disablePush)}>
              Turn off
            </button>
          </>
        )}
      </div>
    </section>
  );
}
