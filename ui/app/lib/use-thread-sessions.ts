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
  /** The bot that owns threadId. */
  botId?: string | null;
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
  /** By bot id: "awaiting_permissions" if any of its threads waits on an
   *  approval, else "running" if any runs. Bots with nothing live are absent. */
  liveBots: Record<string, BotLiveStatus>;
};

export type BotLiveStatus = "running" | "awaiting_permissions";

const live = (s: ThreadSessionStatus) => s === "running" || s === "awaiting_permissions";

/** A thread's status across its sessions: any live one wins, else the newest. */
function byThread(sessions: SessionSummary[]): Pick<ThreadSessions, "statuses" | "runningChildren"> {
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

/** Each bot's live status across its threads' sessions: waiting beats
 *  running. A Jarvis child's session belongs to the child's bot. */
export function liveByBot(sessions: SessionSummary[]): Record<string, BotLiveStatus> {
  const bots: Record<string, BotLiveStatus> = {};
  for (const s of sessions) {
    if (!s.botId || !s.threadId || !live(s.status)) continue;
    if (bots[s.botId] !== "awaiting_permissions") bots[s.botId] = s.status as BotLiveStatus;
  }
  return bots;
}

/**
 * A bot row's live label. A waiting thread wins over everything: it needs
 * the user. Then the selected bot's open chat (activeLabel, which says more),
 * then any other running thread. A bot still setting up keeps its setup
 * status: null, unless its own open chat is live.
 */
export function rowLabel(
  liveBots: Record<string, BotLiveStatus>,
  botId: string,
  selectedId: string | null | undefined,
  activeLabel: string | null,
  needsSetup: boolean,
): string | null {
  const open = botId === selectedId ? activeLabel : null;
  if (needsSetup) return open;
  const s = liveBots[botId];
  if (s === "awaiting_permissions") return "Waiting";
  return open ?? (s === "running" ? "Working" : null);
}

/**
 * The app's one subscription to the server's session statuses, by thread id.
 * It is how an open thread notices a turn gitbot started on its own — a
 * child's report waking Jarvis — and how a Jarvis thread knows it is waiting
 * on a child. Both come from the same snapshot, so a child's end and the
 * report turn it starts land in one render.
 */
export function useThreadSessions(): ThreadSessions {
  const [state, setState] = useState<ThreadSessions>({ statuses: {}, runningChildren: {}, pendingApprovals: null, liveBots: {} });
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
      const sessions = snapshot.sessions ?? [];
      const next = { ...byThread(sessions), pendingApprovals: pendingByJarvis(snapshot), liveBots: liveByBot(sessions) };
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
