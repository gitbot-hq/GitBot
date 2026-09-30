"use client";

import { useEffect, useState } from "react";
import { getUpdateStatus, type UpdateStatus } from "../lib/api";

export default function UpdateNotice() {
  const [update, setUpdate] = useState<UpdateStatus | null>(null);

  useEffect(() => {
    let mounted = true;
    const check = () => getUpdateStatus().then(
      (status) => { if (mounted) setUpdate(status); },
      () => { if (mounted) setUpdate(null); },
    );
    void check();
    const timer = window.setInterval(check, 60 * 60 * 1000);
    return () => { mounted = false; window.clearInterval(timer); };
  }, []);

  if (!update?.updateAvailable || !update.latestVersion) return null;
  return (
    <aside className="update-notice" role="status" aria-label="GitBot update">
      <span>GitBot <b>{update.latestVersion}</b> is available.</span>
      <span>Run <code>{update.installCommand}</code> in your terminal, then restart GitBot.</span>
    </aside>
  );
}
