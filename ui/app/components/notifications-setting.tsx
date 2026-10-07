"use client";

import { useCallback, useEffect, useState } from "react";
import type { PushSubscriptionSummary } from "../lib/api";
import {
  deleteSubscription,
  disablePush,
  enablePush,
  listPushSubscriptions,
  pushState,
  testPush,
  type PushState,
} from "../lib/push";

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

const SERVICES: Record<NonNullable<PushSubscriptionSummary["service"]>, string> = {
  Google: "Google push",
  Mozilla: "Mozilla push",
  Apple: "Apple push",
  Microsoft: "Microsoft push",
};

/** "Google push · Added 7 Oct 2026 · #3f9a1c2b": nothing in it is secret. */
function details(sub: PushSubscriptionSummary): string {
  const service = sub.service ? SERVICES[sub.service] : "Not a known push service, never sent to";
  const added = sub.addedAt
    ? `Added ${new Date(sub.addedAt).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}`
    : "Date not recorded";
  return `${service} · ${added} · #${sub.id.slice(0, 8)}`;
}

/** Browser notifications for this device: on, off, and a test; and every subscribed browser, to delete. */
export default function NotificationsSetting() {
  // null while the first check runs.
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tested, setTested] = useState(false);
  const [subs, setSubs] = useState<PushSubscriptionSummary[] | null>(null);

  const reloadList = useCallback(async () => {
    try {
      setSubs(await listPushSubscriptions());
    } catch {
      setSubs(null);
    }
  }, []);

  useEffect(() => {
    let live = true;
    // The list after the state: pushState re-sends this browser's subscription first.
    pushState()
      .then(
        (s) => { if (live) setState(s); },
        () => { if (live) setState("off"); },
      )
      .then(() => { if (live) return reloadList(); });
    return () => { live = false; };
  }, [reloadList]);

  async function run(action: () => Promise<PushState | null | void>) {
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
      await reloadList();
    }
  }

  const showList = state !== null && state !== "server-off" && subs !== null && subs.length > 0;

  return (
    <section className="profile-notify" aria-label="Notifications">
      <div className="profile-notify-row">
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
      </div>
      {showList && (
        <div className="push-subs">
          <h4>Subscribed browsers ({subs.length})</h4>
          <ul>
            {subs.map((sub) => (
              <li key={sub.id}>
                <div className="push-sub-text">
                  <span className="push-sub-name">
                    {sub.device ?? "Unknown browser"}
                    {sub.current && <span className="push-sub-this">This device</span>}
                  </span>
                  <span className="push-sub-meta">{details(sub)}</span>
                </div>
                <button
                  type="button"
                  className="btn-ghost"
                  disabled={busy}
                  aria-label={`Delete ${sub.device ?? "unknown browser"} (#${sub.id.slice(0, 8)})`}
                  onClick={() => run(() => deleteSubscription(sub))}
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
