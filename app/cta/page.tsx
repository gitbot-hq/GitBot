"use client";

import { useState } from "react";
import "./cta.css";

function StateCard({
  name,
  hint,
  children,
}: {
  name: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <section className="cta-card">
      <div className="cta-stage">{children}</div>
      <b>{name}</b>
      <small>{hint}</small>
    </section>
  );
}

// CTA state matrix. The primary button is theme-flipped: near-black on
// light mode, white on dark mode (--text on --bg).
export default function CtaDemo() {
  const [loading, setLoading] = useState(false);

  function fakeLoad() {
    if (loading) return;
    setLoading(true);
    window.setTimeout(() => setLoading(false), 2200);
  }

  return (
    <main className="cta-page">
      <header className="cta-head">
        <p className="cta-eyebrow">Buttons</p>
        <h1>One CTA, every state</h1>
        <p className="cta-sub">
          Primary flips with the color mode. Everything here is live — hover,
          hold, tab, and trigger.
        </p>
      </header>

      <h2 className="cta-group">Primary</h2>
      <div className="cta-grid">
        <StateCard name="Default" hint="Resting.">
          <button type="button" className="cta-primary">
            Create bot
          </button>
        </StateCard>
        <StateCard name="Hover" hint="Hover me.">
          <button type="button" className="cta-primary force-hover">
            Create bot
          </button>
        </StateCard>
        <StateCard name="Active" hint="Click and hold.">
          <button type="button" className="cta-primary">
            Create bot
          </button>
        </StateCard>
        <StateCard name="Focus" hint="Tab to me.">
          <button type="button" className="cta-primary force-focus">
            Create bot
          </button>
        </StateCard>
        <StateCard name="Disabled" hint="No action available.">
          <button type="button" className="cta-primary" disabled>
            Create bot
          </button>
        </StateCard>
        <StateCard name="Loading" hint="Click to run 2.2s.">
          <button
            type="button"
            className="cta-primary cta-loading-demo"
            disabled={loading}
            onClick={fakeLoad}
          >
            {loading ? (
              <span key="loading" className="cta-label">
                <span className="cta-spinner" aria-hidden="true" />
                Creating…
              </span>
            ) : (
              <span key="idle" className="cta-label">
                Create bot
              </span>
            )}
          </button>
        </StateCard>
      </div>

      <h2 className="cta-group">Variants</h2>
      <div className="cta-grid">
        <StateCard name="Secondary" hint="Lower emphasis.">
          <button type="button" className="cta-secondary">
            Cancel
          </button>
        </StateCard>
        <StateCard name="Ghost" hint="Chromeless.">
          <button type="button" className="cta-ghost">
            Learn more
          </button>
        </StateCard>
        <StateCard name="Danger" hint="Destructive confirm.">
          <button type="button" className="cta-danger">
            Delete
          </button>
        </StateCard>
      </div>
    </main>
  );
}
