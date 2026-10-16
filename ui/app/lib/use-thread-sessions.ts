"use client";

import { useEffect, useState } from "react";
import { sessionsStreamUrl } from "./api";
import { pendingByJarvis } from "./approvals";
import { JARVIS_BOT_ID } from "./gitbot";

export type ThreadSessionStatus = "running" | "awaiting_permissions" | "done" | "error";

type SessionSummary = {
  gitbotId: string;
  status: ThreadSessionStatus;
  threadId: string | null;
  /** The Jarvis thread this session's turn reports to; null when Jarvis did not start it. */
  reportTo?: string | null;
  /** The bot that owns threadId. */
  botId?: string | null;
  /** The user stopped this session's turn. */
  stopped?: boolean;
  /** Its last turn ended quietly (a scheduled run its schedule's notify does not tell): not news. */
  quietEnd?: boolean;
};

/**
 * How a thread stands, for its row's indicator: the server's thread_status
 * states (thread-tools.ts), less "idle". A thread with no session since
 * gitbot started is absent: there is nothing known to show.
 */
export type ThreadRowState = "running" | "waiting" | "done" | "failed" | "stopped";

/** A Jarvis thread's running child: what locks its composer, and what Stop aborts. */
export type RunningChild = { threadId: string; sessionId: string; status: ThreadSessionStatus };

export type ThreadSessions = {
  /** Each thread's status across its sessions. */
  statuses: Record<string, ThreadSessionStatus>;
  /** Each thread's row state, from the same sessions as statuses. */
  states: Record<string, ThreadRowState>;
  /** By Jarvis thread id: its child whose reportable turn is live. A Jarvis
   *  thread is locked exactly while it has one. */
  runningChildren: Record<string, RunningChild>;
  /** By Jarvis thread id: the approvals its children wait on (toolUseIDs).
   *  Null until the stream is first heard from. */
  pendingApprovals: Record<string, string[]> | null;
  /** By bot id: "awaiting_permissions" if any of its threads waits on an
   *  approval, else "running" if any runs. Bots with nothing live are absent. */
  liveBots: Record<string, BotLiveStatus>;
  /** The stream's schedules hint: `version` changes whenever any schedule
   *  may have (a write anywhere, or a reconnect), so consumers re-read
   *  GET /schedules. Null until the stream is first heard from. */
  schedules: SchedulesHint | null;
};

/** `version` is local (it survives a server restart's reset), `attentionCount` the server's. */
export type SchedulesHint = { version: number; attentionCount: number };

/**
 * Folds one schedules event (or a reconnect: `event` null) into the hint.
 * `seen` is the last server version heard on this connection, null after a
 * (re)connect: the first event on a connection only records it, and a
 * reconnect itself bumps, since writes may have been missed meanwhile.
 */
export function nextSchedulesHint(
  prev: SchedulesHint | null,
  seen: number | null,
  event: { version: number; attentionCount: number } | null,
): { hint: SchedulesHint; seen: number | null } {
  const base = prev ?? { version: 0, attentionCount: 0 };
  if (!event) return { hint: { ...base, version: base.version + 1 }, seen: null };
  const changed = seen !== null && event.version !== seen;
  return { hint: { version: base.version + (changed ? 1 : 0), attentionCount: event.attentionCount }, seen: event.version };
}

export type BotLiveStatus = "running" | "awaiting_permissions";

const live = (s: ThreadSessionStatus) => s === "running" || s === "awaiting_permissions";

/** A session's state as its thread's row shows it. */
function rowState(s: SessionSummary): ThreadRowState {
  if (s.status === "awaiting_permissions") return "waiting";
  if (s.status === "running") return "running";
  if (s.stopped) return "stopped";
  return s.status === "error" ? "failed" : "done";
}

/**
 * A thread's status across its sessions: any live one wins, else the newest.
 * A newest one that ended quietly gives the thread no row state, so its row
 * shows the stored lastOutcome (threadIndicator): a quiet scheduled success
 * never recolours an earlier unseen dot.
 */
export function byThread(sessions: SessionSummary[]): Pick<ThreadSessions, "statuses" | "states" | "runningChildren"> {
  const statuses: Record<string, ThreadSessionStatus> = {};
  const states: Record<string, ThreadRowState> = {};
  const runningChildren: Record<string, RunningChild> = {};
  for (const s of sessions) {
    if (!s.threadId) continue;
    if (s.reportTo && live(s.status)) {
      runningChildren[s.reportTo] = { threadId: s.threadId, sessionId: s.gitbotId, status: s.status };
    }
    const prev = statuses[s.threadId];
    if (prev && live(prev)) continue;
    statuses[s.threadId] = s.status;
    if (s.quietEnd && !live(s.status)) delete states[s.threadId];
    else states[s.threadId] = rowState(s);
  }
  return { statuses, states, runningChildren };
}

/**
 * The indicator a thread's row shows. Waiting on the user wins (its own
 * approval or question, or, for a Jarvis thread, a child's), then a turn
 * running (a Jarvis thread runs while a child it started does). Both show
 * whether or not the thread has been looked at.
 *
 * How a turn ended (done, failed, stopped) is an unread marker: it shows
 * only while the thread has news (lib/attention.ts, hasNews), and goes once
 * the thread is seen. The live stream's ending is the freshest; the stored
 * lastOutcome covers a reload or a restart; news with neither (a Jarvis
 * thread whose child a restart interrupted) reads as done. Null: nothing to show.
 */
export function threadIndicator(
  state: ThreadRowState | undefined,
  opts: { needsYou?: boolean; childRunning?: boolean; unseen?: boolean; lastOutcome?: ThreadRowState } = {},
): ThreadRowState | null {
  if (opts.needsYou || state === "waiting") return "waiting";
  if (state === "running" || opts.childRunning) return "running";
  if (!opts.unseen) return null;
  return state ?? opts.lastOutcome ?? "done";
}

/** Each bot's live status across its threads' sessions: waiting beats
 *  running. A Jarvis child's session belongs to the child's bot, and counts
 *  for Jarvis too (reportTo names a Jarvis thread, and only Jarvis starts
 *  children): Jarvis is engaged while a thread it started is. */
export function liveByBot(sessions: SessionSummary[]): Record<string, BotLiveStatus> {
  const bots: Record<string, BotLiveStatus> = {};
  const mark = (botId: string, status: BotLiveStatus) => {
    if (bots[botId] !== "awaiting_permissions") bots[botId] = status;
  };
  for (const s of sessions) {
    if (!s.threadId || !live(s.status)) continue;
    const status = s.status as BotLiveStatus;
    if (s.botId) mark(s.botId, status);
    if (s.reportTo) mark(JARVIS_BOT_ID, status);
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
  const [state, setState] = useState<ThreadSessions>({ statuses: {}, states: {}, runningChildren: {}, pendingApprovals: null, liveBots: {}, schedules: null });
  useEffect(() => {
    const es = new EventSource(sessionsStreamUrl());
    let last = "";
    let hint: SchedulesHint | null = null;
    let seen: number | null = null;
    let broken = false;
    const setHint = (event: SchedulesHint | null) => {
      const next = nextSchedulesHint(hint, seen, event);
      seen = next.seen;
      if (hint && next.hint.version === hint.version && next.hint.attentionCount === hint.attentionCount) return;
      hint = next.hint;
      const h = hint;
      setState((prev) => ({ ...prev, schedules: h }));
    };
    es.addEventListener("schedules", (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data ?? "{}");
        if (typeof data.version === "number") setHint({ version: data.version, attentionCount: Number(data.attentionCount) || 0 });
      } catch {
        // a bad event is skipped
      }
    });
    // EventSource reconnects by itself; once back, schedules may have changed unseen.
    es.addEventListener("error", () => {
      broken = true;
    });
    es.addEventListener("open", () => {
      if (!broken) return;
      broken = false;
      setHint(null);
    });
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
      setState((prev) => ({ ...prev, ...next }));
    });
    return () => es.close();
  }, []);
  return state;
}
