"use client";

import { useEffect, useState } from "react";
import { sessionsStreamUrl } from "./api";
import { pendingByJarvis } from "./approvals";

export type ThreadSessionStatus = "running" | "awaiting_permissions" | "done" | "error";

type SessionSummary = {
  gitbotId: string;
  status: ThreadSessionStatus;
  threadId: string | null;
  /** The Jarvis thread this session's turn reports to; null when Jarvis did not start it. */
  reportTo?: string | null;
};

/** A Jarvis thread's running child: what locks its composer, and what Stop aborts. */
export type RunningChild = { threadId: string; sessionId: string; status: ThreadSessionStatus };

export type ThreadSessions = {
  /** Each thread's status across its sessions. */
  statuses: Record<string, ThreadSessionStatus>;
  /** By Jarvis thread id: its child whose reportable turn is live. A Jarvis
   *  thread is locked exactly while it has one. */
  runningChildren: Record<string, RunningChild>;
  /** By Jarvis thread id: the approvals its children wait on (toolUseIDs).
   *  Null until the stream is first heard from. */
  pendingApprovals: Record<string, string[]> | null;
};

const live = (s: ThreadSessionStatus) => s === "running" || s === "awaiting_permissions";

/** A thread's status across its sessions: any live one wins, else the newest. */
function byThread(sessions: SessionSummary[]): Omit<ThreadSessions, "pendingApprovals"> {
  const statuses: Record<string, ThreadSessionStatus> = {};
  const runningChildren: Record<string, RunningChild> = {};
  for (const s of sessions) {
    if (!s.threadId) continue;
    if (s.reportTo && live(s.status)) {
      runningChildren[s.reportTo] = { threadId: s.threadId, sessionId: s.gitbotId, status: s.status };
    }
    const prev = statuses[s.threadId];
    if (prev && live(prev)) continue;
    statuses[s.threadId] = s.status;
  }
  return { statuses, runningChildren };
}

/**
 * The app's one subscription to the server's session statuses, by thread id.
 * It is how an open thread notices a turn gitbot started on its own — a
 * child's report waking Jarvis — and how a Jarvis thread knows it is waiting
 * on a child. Both come from the same snapshot, so a child's end and the
 * report turn it starts land in one render.
 */
export function useThreadSessions(): ThreadSessions {
  const [state, setState] = useState<ThreadSessions>({ statuses: {}, runningChildren: {}, pendingApprovals: null });
  useEffect(() => {
    const es = new EventSource(sessionsStreamUrl());
    let last = "";
    es.addEventListener("permissions", (ev) => {
      let snapshot: { sessions?: SessionSummary[]; permissions?: { sessionId: string; toolUseID: string }[] } = {};
      try {
        snapshot = JSON.parse((ev as MessageEvent).data ?? "{}");
      } catch {
        return;
      }
      const next = { ...byThread(snapshot.sessions ?? []), pendingApprovals: pendingByJarvis(snapshot) };
      const key = JSON.stringify(next);
      // Approvals change far more often than these: re-render only when they
      // do (only a Jarvis-owned child's approvals are kept).
      if (key === last) return;
      last = key;
      setState(next);
    });
    return () => es.close();
  }, []);
  return state;
}
