"use client";

import { useEffect, useState } from "react";
import { sessionsStreamUrl } from "./api";

export type ThreadSessionStatus = "running" | "awaiting_permissions" | "done" | "error";

type SessionSummary = { status: ThreadSessionStatus; threadId: string | null };

/** A thread's status across its sessions: any live one wins, else the newest. */
function byThread(sessions: SessionSummary[]): Record<string, ThreadSessionStatus> {
  const out: Record<string, ThreadSessionStatus> = {};
  for (const s of sessions) {
    if (!s.threadId) continue;
    const prev = out[s.threadId];
    if (prev === "running" || prev === "awaiting_permissions") continue;
    out[s.threadId] = s.status;
  }
  return out;
}

/**
 * The app's one subscription to the server's session statuses, by thread id.
 * It is how an open thread notices a turn gitbot started on its own — a
 * child's report waking Jarvis.
 */
export function useThreadSessions(): Record<string, ThreadSessionStatus> {
  const [statuses, setStatuses] = useState<Record<string, ThreadSessionStatus>>({});
  useEffect(() => {
    const es = new EventSource(sessionsStreamUrl());
    let last = "";
    es.addEventListener("permissions", (ev) => {
      let sessions: SessionSummary[] = [];
      try {
        sessions = JSON.parse((ev as MessageEvent).data ?? "{}").sessions ?? [];
      } catch {
        return;
      }
      const next = byThread(sessions);
      const key = JSON.stringify(next);
      // Approvals change far more often than statuses: re-render only on these.
      if (key === last) return;
      last = key;
      setStatuses(next);
    });
    return () => es.close();
  }, []);
  return statuses;
}
