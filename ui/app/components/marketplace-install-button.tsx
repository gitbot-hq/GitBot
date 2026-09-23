"use client";

import AnimatedActionIcon from "./animated-action-icon";
import { CheckIcon } from "@animateicons/react/lucide/check-icon";
import { DownloadIcon } from "@animateicons/react/lucide/download-icon";

import { useEffect, useState } from "react";

type InstallState = "idle" | "installing" | "completing" | "installed";

export default function MarketplaceInstallButton({ state, timing, onInstall }: {
  state: InstallState;
  timing?: { startedAt: number; duration: number };
  onInstall: () => void;
}) {
  const [progress, setProgress] = useState(0);
  const startedAt = timing?.startedAt;
  const duration = timing?.duration;

  useEffect(() => {
    if (state !== "installing" || startedAt === undefined || duration === undefined) return;
    // Presentation progress stops short of full until the service confirms success.
    const update = () => setProgress(Math.min(0.92, Math.max(0, (performance.now() - startedAt) / (duration - 180)) * 0.92));
    update();
    const timer = window.setInterval(update, 50);
    return () => window.clearInterval(timer);
  }, [state, startedAt, duration]);

  const busy = state === "installing" || state === "completing";
  const complete = state === "completing" || state === "installed";
  return (
    <button type="button" className="bot-details-install" data-state={state}
      onClick={onInstall} disabled={state !== "idle"} aria-busy={busy}
      aria-label={busy ? "Installing bot" : state === "installed" ? "Installed" : "Install bot"}>
      <span className="install-button-label install-button-idle" aria-hidden="true"><AnimatedActionIcon icon={DownloadIcon} size={16} />Install bot</span>
      <span className="install-button-progress" aria-hidden="true">
        <svg viewBox="0 0 40 40" fill="none">
          <circle className="install-ring-track" cx="20" cy="20" r="17" strokeWidth="2" />
          <circle className="install-ring-fill" cx="20" cy="20" r="17" pathLength="100" strokeWidth="2.5" strokeLinecap="round" strokeDasharray="100" strokeDashoffset={complete ? 0 : 100 - progress * 100} />
        </svg>
        <span className="install-progress-center" />
      </span>
      <span className="install-button-label install-button-done" aria-hidden="true"><AnimatedActionIcon icon={CheckIcon} size={16} />Installed</span>
    </button>
  );
}
