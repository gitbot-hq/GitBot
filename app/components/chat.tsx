"use client";

import AnimatedActionIcon from "./animated-action-icon";
import { ArrowDownIcon } from "@animateicons/react/lucide/arrow-down-icon";
import { ArrowUpIcon } from "@animateicons/react/lucide/arrow-up-icon";
import { CheckIcon } from "@animateicons/react/lucide/check-icon";
import { CodeIcon } from "@animateicons/react/lucide/code-icon";
import { CopyIcon } from "@animateicons/react/lucide/copy-icon";
import { CircleStopIcon } from "@animateicons/react/lucide/circle-stop-icon";
import { EllipsisIcon } from "@animateicons/react/lucide/ellipsis-icon";
import { MessageSquarePlusIcon } from "@animateicons/react/lucide/message-square-plus-icon";
import { RefreshCwIcon } from "@animateicons/react/lucide/refresh-cw-icon";
import { ShareIcon } from "@animateicons/react/lucide/share-icon";
import { StoreIcon } from "@animateicons/react/lucide/store-icon";
import { UserIcon } from "@animateicons/react/lucide/user-icon";

import { Fragment, useEffect, useRef, useState } from "react";

import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import LoadingState from "./loading-state";
import BotFace from "./bot-face";
import BotName from "./bot-name";
import {
  ApiError,
  getMessages,
  getPendingPermissions,
  getSessionStatus,
  postAbort,
  postChat,
  postPermission,
  streamUrl,
} from "../lib/api";
import type { HistoryMsg, PermRequest, ThreadFull } from "../lib/gitbot";
import type { AvatarPref } from "../lib/avatar-prefs";
import { useMascotPointerFollow } from "../lib/use-mascot-pointer-follow";
import { useScrollEdge } from "../lib/use-scroll-edge";
import { useStatusFavicon } from "../lib/status-favicon";
import { groupTools, type ToolChip } from "../lib/tool-ui";
import {
  presentSetupText,
  readSetupNeedsInput,
  readSetupOutcome,
  type SetupOutcome,
} from "../lib/setup";
import RunSummary, { ActionRow } from "./run-summary";
import QueueTray from "./queue-tray";

// Ordered segments: text and tool calls interleave exactly as they
// arrived, so a turn reads text → tool → text → tool instead of all
// text on top and all tools below.
type Seg =
  | { kind: "text"; text: string }
  | { kind: "tools"; tools: ToolChip[] };
type Msg = {
  id: string;
  role: "user" | "assistant";
  segs: Seg[];
  /** End-of-turn receipt (client-side overlay, see below). */
  summary?: { secs: number; stopped: boolean };
};

let seq = 0;
const nid = () => `m${Date.now()}-${seq++}`;

// History blocks → ordered segments. Non-text, non-tool blocks are
// skipped, and so is the harness-injected context dump (e.g.
// <recommended_plugins>) that the agent prepends when a session starts —
// it isn't user chat.
function flatten(
  role: string,
  content: { type: string; text?: string; tool_name?: string; tool_input?: unknown }[],
): { role: "user" | "assistant"; segs: Seg[] } {
  const segs: Seg[] = [];
  const pushText = (text: string) => {
    const last = segs[segs.length - 1];
    if (last && last.kind === "text") last.text += text;
    else segs.push({ kind: "text", text });
  };
  const pushTool = (name: string, input: unknown) => {
    const last = segs[segs.length - 1];
    if (last && last.kind === "tools") last.tools.push({ name, input });
    else segs.push({ kind: "tools", tools: [{ name, input }] });
  };
  for (const b of content ?? []) {
    if (
      b.type === "text" &&
      b.text &&
      !b.text.trimStart().startsWith("<recommended_plugins>")
    ) {
      pushText(b.text as string);
    } else if (b.type === "tool_use" && b.tool_name) {
      pushTool(String(b.tool_name), b.tool_input);
    }
  }
  return { role: role === "user" ? "user" : "assistant", segs };
}

function errText(e: unknown) {
  if (e instanceof ApiError) return e.message;
  return e instanceof Error ? e.message : "Something went wrong";
}

// Assistant markdown (GFM). Raw HTML is off by default — no XSS surface.
function RichText({ text }: { text: string }) {
  return (
    <div className="md">
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node, ...props }) => <a target="_blank" rel="noreferrer" {...props} />,
        }}
      >
        {text}
      </Markdown>
    </div>
  );
}

// One grouped activity row lives in run-summary.tsx (shared with the
// end-of-turn card).

/** Revealed + total chars across a segment list (tools don't count). */
function liveTextLen(segs: Seg[]): number {
  return segs.reduce((n, s) => (s.kind === "text" ? n + s.text.length : n), 0);
}

/** Full prose of a message (copy + retry operate on this). */
function msgText(m: Msg): string {
  return m.segs
    .filter((s) => s.kind === "text")
    .map((s) => s.text)
    .join("\n");
}

/** Slice text segments down to a reveal budget, tools passing through. */
function revealSegs(segs: Seg[], shown: number): Seg[] {
  const out: Seg[] = [];
  let rest = shown;
  for (const s of segs) {
    if (s.kind === "tools") {
      out.push(s);
      continue;
    }
    if (rest <= 0) break;
    const take = s.text.slice(0, rest);
    rest -= take.length;
    if (take) out.push({ kind: "text", text: take });
  }
  return out;
}

// Live chat: history in, SSE turn streaming, approvals inline.
// Talks to the server only through app/lib/api.ts.

// Loading state shaped like the conversation replacing it: user bubbles
// right, assistant lines left. Bars reuse .skel i (shimmer +
// reduced-motion handling) — only the exchange layout lives here.
function ChatSkeleton({ label }: { label: string }) {
  return (
    <div className="skel chat-skel" aria-label={label} aria-hidden="true">
      <i className="chat-skel-user" style={{ width: "38%" }} />
      <i style={{ width: "96%" }} />
      <i style={{ width: "82%" }} />
      <i style={{ width: "64%" }} />
      <i className="chat-skel-user" style={{ width: "27%" }} />
      <i style={{ width: "91%" }} />
      <i style={{ width: "57%" }} />
    </div>
  );
}

type SetupMode = {
  status: string;
  instructions: string;
  retrying: boolean;
  paused: boolean;
  onRetry: () => void;
  onPause: () => void;
  onOutcome: (outcome: SetupOutcome) => Promise<void>;
};

function SetupIntro({
  botName,
  botColor,
  setup,
  running,
  threadReady,
  awaitingInput,
}: {
  botName: string;
  botColor?: string;
  setup: SetupMode;
  running: boolean;
  threadReady: boolean;
  awaitingInput: boolean;
}) {
  const failed = setup.status === "failed";
  const paused = setup.paused && !running;
  return (
    <header className={failed || paused ? "setup-gate failed" : "setup-gate"}>
      <div className="setup-gate-status" role="status" aria-live="polite">
        <span aria-hidden="true" />
        {failed || paused
          ? "Setup paused"
          : running
            ? "Setting up"
            : awaitingInput
              ? "Action needed"
              : "One-time setup"}
      </div>
      <h1>
        {paused
          ? "Setup is paused"
          : failed
            ? "Setup needs attention"
            : awaitingInput
              ? "Setup needs your input"
              : <>Preparing <BotName color={botColor}>{botName}</BotName></>}
      </h1>
      <p>
        {paused
          ? "Resume setup to finish preparing this bot. Normal conversations stay locked until verification succeeds."
          : failed
            ? "Review what stopped below, then try setup again when the blocker is resolved."
            : awaitingInput
              ? "Answer the setup question below so GitBot can continue verification."
              : running
                ? "GitBot is checking and preparing this machine. Normal conversations will unlock automatically when verification finishes."
                : "GitBot will prepare this machine once. Normal conversations unlock automatically after it verifies the requirements."}
      </p>
      <details className="setup-requirements">
        <summary>Setup requirements</summary>
        <p>{setup.instructions}</p>
      </details>
      {!threadReady && !paused && (
        <button
          type="button"
          className="btn-secondary btn-compact setup-retry"
          onClick={setup.onRetry}
          disabled={setup.retrying}
        >
          <AnimatedActionIcon icon={RefreshCwIcon} size={14} aria-hidden="true" />
          {setup.retrying ? "Starting setup" : "Try setup again"}
        </button>
      )}
    </header>
  );
}

export default function Chat({
  thread,
  botId,
  botName,
  botAvatar,
  autoSend,
  onAutoSent,
  onTurnDone,
  onWorkingChange,
  onActivityChange,
  onShare,
  onOpenBot,
  onNewThread,
  booting,
  setup,
}: {
  thread: ThreadFull | null;
  botId?: string;
  botName: string;
  botAvatar?: AvatarPref;
  autoSend: string | null;
  onAutoSent: () => void;
  onTurnDone: () => void;
  onWorkingChange?: (working: boolean) => void;
  /** Live activity sentence ("Thinking…", "Running Bash…", null when idle).
   *  Lets the shell show what the bot is doing outside the chat. */
  onActivityChange?: (activity: string | null) => void;
  onShare?: (view?: "options" | "code") => void;
  onOpenBot?: () => void;
  onNewThread?: () => void;
  /** True while the app is still loading bots/threads on boot. Shows a
   *  skeleton instead of the empty-thread copy, so the first paint never
   *  flashes placeholder text. Defaults to false (old behavior). */
  booting?: boolean;
  /** Present while this bot is preparing the current machine. Setup uses
   *  the chat transport, but is rendered as activation rather than a thread. */
  setup?: SetupMode;
}) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [loading, setLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [activity, setActivity] = useState<string | null>(null);
  const [perms, setPerms] = useState<(PermRequest & { verdict?: boolean })[]>([]);
  const [turnError, setTurnError] = useState<string | null>(null);
  // Single "up next" slot: the server runs one turn per thread (a second
  // POST /chat mid-turn is a 409), so follow-ups sent while streaming wait
  // here and flush when the turn ends. One slot — a newer send replaces it.
  const [queue, setQueue] = useState<string | null>(null);
  const queueRef = useRef<string | null>(null);
  // Steer: abort the running turn and send this text the moment it ends.
  const pendingSteer = useRef<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [escapeStopArmed, setEscapeStopArmed] = useState(false);
  const [activeMenu, setActiveMenu] = useState<"share" | "more" | null>(null);
  const shareButtonRef = useRef<HTMLButtonElement | null>(null);
  const moreButtonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const esRef = useRef<EventSource | null>(null);
  const sessionRef = useRef<string | null>(null);
  const liveIdRef = useRef<string | null>(null);
  const liveTextRef = useRef("");
  const reportedSetupOutcome = useRef<string | null>(null);
  // Progressive reveal: the server emits whole messages, so the live
  // bubble types out at reading pace instead of popping in at once.
  const [live, setLive] = useState<{
    key: number;
    segs: Seg[];
    shown: number;
  } | null>(null);
  // Flat tool log of the running turn. On finish, history replaces the
  // live bubble — and histories that carry no tool records (Codex) would
  // wipe the evidence. These get reattached to the closing reply.
  const pendingTools = useRef<ToolChip[]>([]);
  const liveKey = useRef(0);
  const threadRef = useRef<string | null>(null);
  const lastPrompt = useRef("");
  const scrollRef = useRef<HTMLElement | null>(null);
  const stick = useRef(true);
  // Render mirror of stick: drives the jump-to-latest button.
  const [stuck, setStuck] = useState(true);
  const boxRef = useRef<HTMLTextAreaElement | null>(null);
  const reloadTimer = useRef<number | null>(null);
  const escapeStopTimer = useRef<number | null>(null);
  const escapeStopArmedRef = useRef(false);
  // Rejoin mode: a turn is already running server-side. Text/tool events
  // are replays of painted history, so only approvals (filtered to the
  // still-pending set), status, and terminal events are honored.
  const catchupRef = useRef(false);
  const pendingFilter = useRef<string[] | null>(null);
  // Drafts are per thread: switching stashes, returning restores.
  const drafts = useRef<Record<string, string>>({});
  const draftRef = useRef("");
  // Turn bookkeeping for the end-of-turn card.
  const turnStart = useRef(0);
  const pendingRun = useRef<{ secs: number; stopped: boolean } | null>(null);
  // Client-side overlays: tool records + receipts reattached to history
  // messages, keyed by thread then message index. Server history is
  // append-only, so indices stay valid across refetches; guards skip
  // anything the server already carries (no dupes, idempotent).
  const overlays = useRef<
    Record<string, { index: number; tools: ToolChip[]; summary: { secs: number; stopped: boolean } }[]>
  >({});
  // Expanded activity groups (live turn), keyed by segment + group.
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const scrollEdge = useScrollEdge(scrollRef, thread?.id ?? "no-thread");

  useEffect(() => {
    setActiveMenu(null);
  }, [thread?.id]);

  useEffect(() => {
    if (!streaming || activeMenu || setup) {
      escapeStopArmedRef.current = false;
      setEscapeStopArmed(false);
      if (escapeStopTimer.current) window.clearTimeout(escapeStopTimer.current);
      return;
    }
    function confirmStop(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.repeat) return;
      event.preventDefault();
      if (escapeStopArmedRef.current) {
        stop();
        return;
      }
      escapeStopArmedRef.current = true;
      setEscapeStopArmed(true);
      if (escapeStopTimer.current) window.clearTimeout(escapeStopTimer.current);
      escapeStopTimer.current = window.setTimeout(() => {
        escapeStopArmedRef.current = false;
        setEscapeStopArmed(false);
      }, 3000);
    }
    document.addEventListener("keydown", confirmStop);
    return () => {
      document.removeEventListener("keydown", confirmStop);
      if (escapeStopTimer.current) window.clearTimeout(escapeStopTimer.current);
    };
  }, [streaming, activeMenu, setup]);

  useEffect(() => {
    if (!activeMenu) return;
    const frame = window.requestAnimationFrame(() => {
      menuRef.current?.querySelector<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)')?.focus();
    });
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setActiveMenu(null);
      (activeMenu === "share" ? shareButtonRef : moreButtonRef).current?.focus();
    }
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [activeMenu]);

  function moveMenuFocus(event: React.KeyboardEvent<HTMLDivElement>) {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)'),
    );
    if (!items.length) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home"
      ? 0
      : event.key === "End"
        ? items.length - 1
        : event.key === "ArrowUp"
          ? (current <= 0 ? items.length - 1 : current - 1)
          : (current + 1) % items.length;
    items[next]?.focus();
  }

  function resetBox() {
    if (boxRef.current) boxRef.current.style.height = "auto";
  }

  function fitBox() {
    const box = boxRef.current;
    if (box) {
      box.style.height = "auto";
      box.style.height = `${Math.min(box.scrollHeight, 160)}px`;
    }
  }

  function closeStream() {
    esRef.current?.close();
    esRef.current = null;
  }

  function scrollDown() {
    const el = scrollRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }

  function loadHistory(tid: string, scroll = false) {
    setLoading(true);
    setHistoryError(null);
    getMessages(tid)
      .then(({ messages }) => {
        if (threadRef.current !== tid) return;
        const flat = flattenMsgs(messages);
        applyOverlays(tid, flat);
        setMsgs(flat);
      })
      .catch((e) => {
        if (threadRef.current !== tid) return;
        setHistoryError(errText(e));
      })
      .finally(() => {
        if (threadRef.current !== tid) return;
        setLoading(false);
        if (scroll) requestAnimationFrame(scrollDown);
      });
  }

  function flattenMsgs(messages: HistoryMsg[]): Msg[] {
    const pushSeg = (list: Seg[], s: Seg) => {
      const tail = list[list.length - 1];
      if (s.kind === "text" && tail?.kind === "text") tail.text += s.text;
      else if (s.kind === "tools" && tail?.kind === "tools")
        tail.tools.push(...s.tools);
      else
        list.push(
          s.kind === "text"
            ? { kind: "text", text: s.text }
            : { kind: "tools", tools: [...s.tools] },
        );
    };
    const out: Msg[] = [];
    messages.forEach((m) => {
      const { role, segs } = flatten(m.role, m.content);
      if (segs.length === 0) return;
      const prev = out[out.length - 1];
      const target =
        prev && prev.role === role
          ? prev.segs
          : (() => {
              const fresh: Seg[] = [];
              out.push({ id: `h${out.length}`, role, segs: fresh });
              return fresh;
            })();
      for (const s of segs) pushSeg(target, s);
    });
    // Drop whitespace-only text; drop messages left with nothing.
    for (const m of out) {
      m.segs = m.segs.filter(
        (s) => s.kind === "tools" || s.text.trim().length > 0,
      );
    }
    return out.filter((m) => m.segs.length > 0);
  }

  // Load history on thread switch; drop any live turn.
  useEffect(() => {
    closeStream();
    if (reloadTimer.current) clearTimeout(reloadTimer.current);
    // Stash this thread's draft, restore the next one's. A queued
    // follow-up rides back into the draft — never silently dropped.
    const prevId = threadRef.current;
    if (prevId) drafts.current[prevId] = queueRef.current ?? draftRef.current;
    sessionRef.current = null;
    liveIdRef.current = null;
    liveTextRef.current = "";
    reportedSetupOutcome.current = null;
    setLive(null);
    threadRef.current = thread?.id ?? null;
    setMsgs([]);
    setPerms([]);
    setTurnError(null);
    setActivity(null);
    setStreaming(false);
    setOpenGroups({});
    setStuck(true);
    stick.current = true;
    catchupRef.current = false;
    pendingFilter.current = null;
    pendingTools.current = [];
    pendingRun.current = null;
    queueRef.current = null;
    setQueue(null);
    pendingSteer.current = null;
    const nextDraft = thread?.id ? (drafts.current[thread.id] ?? "") : "";
    draftRef.current = nextDraft;
    setDraft(nextDraft);
    resetBox();
    // Restored drafts need their height back (resetBox collapses to 1 row).
    requestAnimationFrame(() => {
      const box = boxRef.current;
      if (box) {
        box.style.height = "auto";
        box.style.height = `${Math.min(box.scrollHeight, 160)}px`;
      }
    });
    if (!thread) return;
    loadHistory(thread.id, true);
    // Rejoin a turn still running server-side (e.g. after a reload).
    if (thread.sdkSessionId) {
      const sid = thread.sdkSessionId;
      const tid = thread.id;
      getSessionStatus(sid)
        .then(({ streaming }) => {
          if (!streaming || threadRef.current !== tid) return;
          return getPendingPermissions(sid)
            .catch(() => ({ pending: [] as string[] }))
            .then(({ pending }) => {
              if (threadRef.current !== tid) return;
              pendingFilter.current = pending;
              catchupRef.current = true;
              sessionRef.current = sid;
              setStreaming(true);
              setActivity("Thinking…");
              openStream(sid);
            });
        })
        .catch(() => {});
    }
    return () => {
      closeStream();
      if (reloadTimer.current) clearTimeout(reloadTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread?.id]);

  // Setup runs auto-send their opening or continuation prompt once history
  // has settled. Continuations intentionally run in non-empty setup threads.
  useEffect(() => {
    if (!thread || !autoSend || loading || streaming) return;
    onAutoSent();
    sendPrompt(autoSend);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread?.id, autoSend, loading, streaming, msgs.length]);

  // Report turn activity upward so avatars can react to work.
  useEffect(() => {
    onWorkingChange?.(streaming);
  }, [streaming, onWorkingChange]);

  // Live activity sentence for the shell rail (null = idle).
  useEffect(() => {
    onActivityChange?.(streaming ? activity : null);
  }, [streaming, activity, onActivityChange]);

  // Tab alerts: badged favicon + standout title while hidden.
  // Unverdict permission requests outrank everything — the bot is
  // waiting on the user.
  const awaitingApproval = perms.some((p) => p.verdict === undefined);
  useStatusFavicon(
    awaitingApproval
      ? "attention"
      : turnError
        ? "error"
        : streaming
          ? "working"
          : "idle",
  );

  // Typewriter: reveal the live bubble a few chars at a time.
  // Reduced motion completes instantly instead of animating.
  useEffect(() => {
    if (!streaming || !live) return;
    if (liveTextLen(live.segs) <= live.shown) return;
    if (
      typeof matchMedia !== "undefined" &&
      matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      setLive((prev) =>
        prev ? { ...prev, shown: liveTextLen(prev.segs) } : prev,
      );
      return;
    }
    const timer = window.setInterval(() => {
      setLive((prev) =>
        !prev || liveTextLen(prev.segs) <= prev.shown
          ? prev
          : {
              ...prev,
              shown: Math.min(liveTextLen(prev.segs), prev.shown + 6),
            },
      );
    }, 24);
    return () => clearInterval(timer);
  }, [streaming, live]);

  function ensureLive(): string {
    if (!liveIdRef.current) {
      liveIdRef.current = nid();
      liveKey.current += 1;
      const key = liveKey.current;
      setLive({ key, segs: [], shown: 0 });
    }
    return liveIdRef.current;
  }

  function appendLiveText(chunk: string) {
    liveTextRef.current += chunk;
    setLive((prev) => {
      if (!prev) return prev;
      const segs = [...prev.segs];
      const tail = segs[segs.length - 1];
      if (tail && tail.kind === "text") {
        segs[segs.length - 1] = { kind: "text", text: tail.text + chunk };
      } else {
        segs.push({ kind: "text", text: chunk });
      }
      return { ...prev, segs };
    });
  }

  function appendLiveTool(chip: ToolChip) {
    pendingTools.current.push(chip);
    setLive((prev) => {
      if (!prev) return prev;
      const segs = [...prev.segs];
      const tail = segs[segs.length - 1];
      if (tail && tail.kind === "tools") {
        segs[segs.length - 1] = { kind: "tools", tools: [...tail.tools, chip] };
      } else {
        segs.push({ kind: "tools", tools: [chip] });
      }
      return { ...prev, segs };
    });
  }

  // Reapply this thread's client-side overlays (tool records + receipts
  // for turns whose history carries none). Idempotent: skips messages
  // the server already covers.
  function applyOverlays(tid: string, flat: Msg[]) {
    for (const entry of overlays.current[tid] ?? []) {
      const m = flat[entry.index];
      if (!m || m.role !== "assistant") continue;
      const hasTools = m.segs.some(
        (s) => s.kind === "tools" && s.tools.length > 0,
      );
      if (!hasTools && entry.tools.length > 0) {
        m.segs.push({
          kind: "tools",
          tools: entry.tools.map((t) => ({ ...t })),
        });
      }
      if (!m.summary) m.summary = { ...entry.summary };
    }
  }

  /** A turn just ended: start whatever is waiting (steer wins over the
   *  queue) as the next turn on the same thread. */
  function maybeFlush(tid: string | null) {
    if (!tid || threadRef.current !== tid) return;
    const next = pendingSteer.current ?? queueRef.current;
    pendingSteer.current = null;
    if (queueRef.current) {
      queueRef.current = null;
      setQueue(null);
    }
    if (next) startTurn(next);
  }

  function finish(refetch: boolean, stopped = false, notifyTurnDone = true) {
    closeStream();
    const tid = threadRef.current;
    setStreaming(false);
    setActivity(null);
    liveIdRef.current = null;
    sessionRef.current = null;
    if (turnStart.current) {
      pendingRun.current = {
        secs: Math.max(1, Math.round((Date.now() - turnStart.current) / 1000)),
        stopped,
      };
      turnStart.current = 0;
    }
    if (refetch && tid) {
      // Complete the reveal instantly, settle the view, then swap in
      // history (identical content — invisible) a beat later.
      setLive((prev) =>
        prev ? { ...prev, shown: liveTextLen(prev.segs) } : prev,
      );
      requestAnimationFrame(scrollDown);
      reloadTimer.current = window.setTimeout(() => {
        if (threadRef.current !== tid) return;
        getMessages(tid)
          .then(({ messages }) => {
            if (threadRef.current !== tid) return;
            const flat = flattenMsgs(messages);
            // Record this turn's evidence for replay: reattached now, and
            // re-applied on every future load of this thread.
            const pending = pendingTools.current;
            const run = pendingRun.current;
            pendingTools.current = [];
            pendingRun.current = null;
            if (pending.length > 0 && run) {
              const idx = flat
                .map((m, i) => ({ m, i }))
                .reverse()
                .find(({ m }) => m.role === "assistant")?.i;
              if (idx != null) {
                const list = overlays.current[tid] ?? [];
                if (!list.some((e) => e.index === idx)) {
                  list.push({
                    index: idx,
                    tools: pending.map((t) => ({ ...t })),
                    summary: { ...run },
                  });
                }
                overlays.current[tid] = list;
              }
            }
            applyOverlays(tid, flat);
            setLive(null);
            setMsgs(flat);
            maybeFlush(tid);
          })
          .catch(() => {});
      }, 300);
      if (notifyTurnDone) onTurnDone();
    } else {
      setLive(null);
      requestAnimationFrame(scrollDown);
      maybeFlush(tid);
      if (notifyTurnDone) onTurnDone();
    }
  }

  function openStream(sid: string) {
    closeStream();
    const es = new EventSource(streamUrl(sid));
    esRef.current = es;
    const data = (ev: Event) => {
      try {
        return JSON.parse((ev as MessageEvent).data ?? "{}");
      } catch {
        return {};
      }
    };
    es.addEventListener("assistant", (ev) => {
      if (catchupRef.current) return;
      ensureLive();
      const chunk = String(data(ev).content ?? "");
      if (chunk) appendLiveText(chunk);
    });
    es.addEventListener("tool_use", (ev) => {
      if (catchupRef.current) return;
      ensureLive();
      const d = data(ev);
      appendLiveTool({ name: String(d.tool_name ?? "tool"), input: d.tool_input });
    });
    es.addEventListener("status", (ev) => {
      const d = data(ev);
      if (d.status === "thinking") setActivity("Thinking…");
      else if (d.status === "tool") setActivity(`Running ${d.tool_name || "tool"}…`);
      else if (d.status === "tool_summary" && d.summary) setActivity(String(d.summary));
    });
    es.addEventListener("permission_request", (ev) => {
      const d = data(ev);
      if (!d.toolUseID) return;
      // On rejoin, only still-pending approvals are offered again.
      if (catchupRef.current && pendingFilter.current && pendingFilter.current.indexOf(d.toolUseID) === -1) return;
      setPerms((prev) =>
        prev.some((p) => p.toolUseID === d.toolUseID)
          ? prev
          : [...prev, { toolUseID: d.toolUseID, toolName: String(d.toolName ?? "tool"), input: d.input }],
      );
      setActivity("Waiting for your approval…");
    });
    es.addEventListener("aborted", () => {
      setMsgs((prev) => [
        ...prev,
        { id: nid(), role: "assistant", segs: [{ kind: "text", text: setup ? "_Setup paused._" : "_Stopped._" }] },
      ]);
      catchupRef.current = false;
      pendingFilter.current = null;
      finish(true, true);
    });
    es.addEventListener("done", () => {
      catchupRef.current = false;
      pendingFilter.current = null;
      const tid = threadRef.current;
      const setupOutcomeReported = !!tid && reportSetupOutcome(tid, liveTextRef.current);
      // The setup outcome request updates the bot directly. Avoid racing it
      // with the generic post-turn bot refresh.
      finish(true, false, !setupOutcomeReported);
    });
    es.addEventListener("error", (ev) => {
      const me = ev as MessageEvent;
      if (me.data) {
        setTurnError(String(data(ev).message ?? "Stream error"));
        catchupRef.current = false;
        pendingFilter.current = null;
        finish(true);
      } else if (es.readyState === EventSource.CLOSED) {
        setTurnError("Connection lost");
        catchupRef.current = false;
        pendingFilter.current = null;
        finish(false);
      } else {
        setActivity("Reconnecting…");
      }
    });
  }

  // The composer never locks: sending mid-turn parks the message in the
  // queue (flushed by finish()), sending while idle starts a turn.
  async function sendPrompt(prompt: string) {
    if (!thread || !prompt.trim()) return;
    if (streaming) {
      enqueue(prompt.trim());
      return;
    }
    startTurn(prompt);
  }

  function enqueue(text: string) {
    queueRef.current = text;
    setQueue(text);
    setDraft("");
    draftRef.current = "";
    if (threadRef.current) drafts.current[threadRef.current] = "";
    resetBox();
    stick.current = true;
    requestAnimationFrame(scrollDown);
  }

  async function startTurn(prompt: string) {
    // No streaming check: callers own that (sendPrompt enqueues mid-turn,
    // maybeFlush only runs once the previous turn fully ended).
    if (!thread || !prompt.trim()) return;
    lastPrompt.current = prompt;
    catchupRef.current = false;
    pendingFilter.current = null;
    setDraft("");
    draftRef.current = "";
    if (threadRef.current) drafts.current[threadRef.current] = "";
    setTurnError(null);
    setPerms([]);
    setOpenGroups({});
    pendingTools.current = [];
    pendingRun.current = null;
    liveTextRef.current = "";
    turnStart.current = Date.now();
    setMsgs((prev) => [
      ...prev,
      { id: nid(), role: "user", segs: [{ kind: "text", text: prompt }] },
    ]);
    setStreaming(true);
    setActivity("Thinking…");
    stick.current = true;
    requestAnimationFrame(scrollDown);
    try {
      const { sessionId } = await postChat(thread.id, prompt);
      if (threadRef.current !== thread.id) return;
      sessionRef.current = sessionId;
      openStream(sessionId);
    } catch (e) {
      if (threadRef.current !== thread.id) return;
      setStreaming(false);
      setActivity(null);
      setTurnError(errText(e));
    }
  }

  function abortCurrent() {
    const sid = sessionRef.current;
    if (sid) postAbort(sid).catch(() => {});
    // The `aborted` event finishes the turn; safety net below.
    setTimeout(() => {
      if (esRef.current) {
        setTurnError("Stop timed out — stream closed");
        finish(true);
      }
    }, 8000);
  }

  function stop() {
    escapeStopArmedRef.current = false;
    setEscapeStopArmed(false);
    if (escapeStopTimer.current) window.clearTimeout(escapeStopTimer.current);
    // Halting means halting: a queued follow-up rides back into the draft
    // instead of firing the moment the turn dies.
    const q = queueRef.current;
    if (q) {
      queueRef.current = null;
      setQueue(null);
      pendingSteer.current = null;
      setDraft(q);
      draftRef.current = q;
      if (threadRef.current) drafts.current[threadRef.current] = q;
      fitBox();
    }
    setup?.onPause();
    abortCurrent();
  }

  /** Steer: abort this turn and send the queued message the moment it ends.
   *  Falls back to staying queued if the turn hasn't reached the server. */
  function steerNow() {
    const q = queueRef.current;
    if (!q || !thread) return;
    if (!sessionRef.current && !esRef.current) return;
    queueRef.current = null;
    setQueue(null);
    pendingSteer.current = q;
    abortCurrent();
  }

  /** Drop the queued message back into the composer for editing. */
  function editQueue() {
    const q = queueRef.current;
    queueRef.current = null;
    setQueue(null);
    if (!q) return;
    setDraft(q);
    draftRef.current = q;
    if (threadRef.current) drafts.current[threadRef.current] = q;
    fitBox();
    boxRef.current?.focus({ preventScroll: true });
  }

  /** Discard the queued message entirely. */
  function discardQueue() {
    queueRef.current = null;
    setQueue(null);
  }

  function copyText(id: string, text: string) {
    navigator.clipboard.writeText(text).catch(() => {});
    setCopiedId(id);
    window.setTimeout(() => {
      setCopiedId((prev) => (prev === id ? null : prev));
    }, 1500);
  }

  function reportSetupOutcome(tid: string, text: string): boolean {
    const outcome = readSetupOutcome(text);
    if (!setup || !outcome) return false;
    const key = `${tid}:${outcome}`;
    if (reportedSetupOutcome.current === key) return true;
    reportedSetupOutcome.current = key;
    setup.onOutcome(outcome).catch((error) => {
      if (reportedSetupOutcome.current === key) reportedSetupOutcome.current = null;
      setTurnError(`Setup finished, but GitBot could not save the result: ${errText(error)}`);
    });
    return true;
  }

  function answerPerm(p: PermRequest, approved: boolean) {
    const sid = sessionRef.current;
    if (!sid) return;
    postPermission(sid, p.toolUseID, approved)
      .then(() =>
        setPerms((prev) =>
          prev.map((x) => (x.toolUseID === p.toolUseID ? { ...x, verdict: approved } : x)),
        ),
      )
      .catch((e) => setTurnError(errText(e)));
  }

  const visibleMsgs = setup
    ? msgs.filter((message) => {
        if (message.role !== "user") return true;
        const text = msgText(message).trim();
        return !text.startsWith("[GitBot setup run]");
      })
    : msgs;

  const latestAssistant = [...msgs].reverse().find((message) => message.role === "assistant");
  const setupAwaitingInput = !!setup && (
    readSetupNeedsInput(liveTextRef.current) ||
    (!!latestAssistant && readSetupNeedsInput(msgText(latestAssistant)))
  );
  const showThreadEmpty = !loading && visibleMsgs.length === 0 && !historyError && !setup;
  useMascotPointerFollow({
    group: botId,
    enabled: !!botId && !setup && (!thread || showThreadEmpty),
  });

  const toolbar = (onShare || onOpenBot || onNewThread) && (
    <div className="chat-toolbar" aria-label="Chat actions">
      {onShare && (
        <div className="chat-toolbar-action">
          <button
            ref={shareButtonRef}
            type="button"
            className={`icon-btn${activeMenu === "share" ? " is-active" : ""}`}
            onClick={() => setActiveMenu((menu) => menu === "share" ? null : "share")}
            aria-label="Share bot"
            aria-expanded={activeMenu === "share"}
            aria-haspopup="menu"
            aria-controls="chat-share-menu"
            data-tip="Share bot"
          >
            <AnimatedActionIcon icon={ShareIcon} size={17} aria-hidden="true" />
          </button>
          {activeMenu === "share" && (
            <div ref={menuRef} id="chat-share-menu" className="chat-options-menu chat-share-menu" role="menu" aria-label="Share bot" onKeyDown={moveMenuFocus}>
              <button type="button" role="menuitem" onClick={() => { setActiveMenu(null); onShare("code"); }}>
                <AnimatedActionIcon icon={CodeIcon} size={15} aria-hidden="true" />
                <span className="chat-menu-label">Share with code</span>
              </button>
              <button type="button" role="menuitem" disabled>
                <AnimatedActionIcon icon={StoreIcon} size={15} aria-hidden="true" />
                <span className="chat-menu-label">Publish to Marketplace</span>
                <span className="chat-menu-status">Soon</span>
              </button>
            </div>
          )}
        </div>
      )}
      {(onOpenBot || onNewThread) && (
        <div className="chat-toolbar-action">
          <button
            ref={moreButtonRef}
            type="button"
            className={`icon-btn${activeMenu === "more" ? " is-active" : ""}`}
            onClick={() => setActiveMenu((menu) => menu === "more" ? null : "more")}
            aria-label="More chat options"
            aria-expanded={activeMenu === "more"}
            aria-haspopup="menu"
            aria-controls="chat-more-menu"
            data-tip="More options"
          >
            <AnimatedActionIcon icon={EllipsisIcon} size={18} aria-hidden="true" />
          </button>
          {activeMenu === "more" && (
            <div ref={menuRef} id="chat-more-menu" className="chat-options-menu" role="menu" aria-label="Chat options" onKeyDown={moveMenuFocus}>
              {onOpenBot && (
                <button type="button" role="menuitem" onClick={() => { setActiveMenu(null); onOpenBot(); }}>
                  <AnimatedActionIcon icon={UserIcon} size={15} aria-hidden="true" />
                  <span className="chat-menu-label">View bot profile</span>
                </button>
              )}
              {onNewThread && (
                <button type="button" role="menuitem" onClick={() => { setActiveMenu(null); onNewThread(); }}>
                  <AnimatedActionIcon icon={MessageSquarePlusIcon} size={15} aria-hidden="true" />
                  <span className="chat-menu-label">New conversation</span>
                </button>
              )}
            </div>
          )}
        </div>
      )}
      {activeMenu && (
        <button type="button" className="menu-scrim" onClick={() => setActiveMenu(null)} aria-label="Close menu" tabIndex={-1} />
      )}
    </div>
  );

  if (!thread) {
    return (
      <main className="chat" aria-label={setup ? "Bot setup" : "Chat"}>
        {toolbar}
        <section className={setup ? "chat-body setup-chat-body" : "chat-body"}>
          {setup && (
            <SetupIntro
              botName={botName}
              botColor={botAvatar?.color}
              setup={setup}
              running={false}
              threadReady={false}
              awaitingInput={false}
            />
          )}
          {booting || setup ? (
            <ChatSkeleton label={setup ? "Preparing setup" : "Loading chat"} />
          ) : (
            <div className="conversation-empty">
              {botAvatar && (
                <div
                  className="conversation-empty-mascot"
                  data-bot-follow={botId}
                >
                  <BotFace
                    mascot={botAvatar.mascot}
                    color={botAvatar.color}
                    size={144}
                    follow
                  />
                </div>
              )}
              <div className="conversation-empty-copy">
                <h1>Start a conversation</h1>
                <p>Choose a folder, then tell <BotName color={botAvatar?.color}>{botName}</BotName> what you’d like help with.</p>
              </div>
              {onNewThread && (
                <button type="button" className="btn-primary" onClick={onNewThread}>
                  <AnimatedActionIcon icon={MessageSquarePlusIcon} size={16} aria-hidden="true" />
                  New conversation
                </button>
              )}
            </div>
          )}
        </section>
      </main>
    );
  }

  return (
    <main className="chat" aria-label={setup ? "Bot setup" : "Chat"}>
      {toolbar}
      <div className={`chat-scroll-edge chat-scroll-edge-top${scrollEdge === "top" ? " is-visible" : ""}`} aria-hidden="true" />
      <section
        className={setup ? "chat-body setup-chat-body" : "chat-body"}
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          const pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 96;
          stick.current = pinned;
          setStuck(pinned);
        }}
      >
        {setup && (
          <SetupIntro
            botName={botName}
            botColor={botAvatar?.color}
            setup={setup}
            running={streaming}
            threadReady
            awaitingInput={setupAwaitingInput}
          />
        )}
        {historyError && (
          <p className="chat-error">
            {historyError}{" "}
            <button type="button" onClick={() => thread && loadHistory(thread.id)}>
              Retry
            </button>
          </p>
        )}
        {!loading &&
          visibleMsgs.map((m) => (
            <article
              key={m.id}
              className={`${m.role === "user" ? "bubble user" : "bubble assistant"}${m.id.startsWith("m") ? " msg-in" : ""}`}
            >
              {m.segs.map((s, si) =>
                s.kind === "text" ? (
                  <RichText key={si} text={setup && m.role === "assistant" ? presentSetupText(s.text) : s.text} />
                ) : null,
              )}
              {m.role === "assistant" &&
                m.segs.some(
                  (s) => s.kind === "tools" && s.tools.length > 0,
                ) && (
                  <RunSummary
                    tools={m.segs.flatMap((s) =>
                      s.kind === "tools" ? s.tools : [],
                    )}
                    secs={m.summary?.secs}
                    stopped={m.summary?.stopped}
                  />
                )}
              {m.role === "assistant" && m.id.startsWith("h") && (
                <span className="msg-acts">
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={() => copyText(m.id, setup ? presentSetupText(msgText(m)) : msgText(m))}
                    aria-label="Copy reply"
                    data-tip="Copy reply"
                  >
                    {copiedId === m.id ? (
                      <AnimatedActionIcon icon={CheckIcon} size={15} aria-hidden="true" />
                    ) : (
                      <AnimatedActionIcon icon={CopyIcon} size={15} aria-hidden="true" />
                    )}
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={() => lastPrompt.current && sendPrompt(lastPrompt.current)}
                    aria-label="Try again"
                    data-tip="Try again"
                  >
                    <AnimatedActionIcon icon={RefreshCwIcon} size={15} aria-hidden="true" />
                  </button>
                </span>
              )}
            </article>
          ))}
        {live && (liveTextLen(live.segs) > 0 || streaming) && (
          <article key={live.key} className="bubble assistant msg-in">
            {revealSegs(live.segs, live.shown).map((s, si) =>
              s.kind === "text" ? (
                <RichText key={`t${si}`} text={setup ? presentSetupText(s.text) : s.text} />
              ) : (
                <Fragment key={`g${si}`}>
                  {groupTools(s.tools).map((g, gi) => {
                    const key = `l${si}-${gi}`;
                    return (
                      <ActionRow
                        key={key}
                        group={g}
                        open={!!openGroups[key]}
                        onToggle={() =>
                          setOpenGroups((prev) => ({ ...prev, [key]: !prev[key] }))
                        }
                      />
                    );
                  })}
                </Fragment>
              ),
            )}
          </article>
        )}
        {loading && <ChatSkeleton label="Loading history" />}
        {showThreadEmpty && (
          <div className="conversation-empty" data-bot-follow={botId}>
            {botAvatar && (
              <div className="conversation-empty-mascot">
                <BotFace
                  mascot={botAvatar.mascot}
                  color={botAvatar.color}
                  size={144}
                  follow
                />
              </div>
            )}
            <div className="conversation-empty-copy">
              <h1>Start a conversation</h1>
              <p>Tell <BotName color={botAvatar?.color}>{botName}</BotName> what you’d like help with.</p>
            </div>
          </div>
        )}
        {perms.map((p) =>
          p.verdict === undefined ? (
            <div key={p.toolUseID} className="perm-card">
              <b>Allow {p.toolName}?</b>
              <pre>{JSON.stringify(p.input, null, 2)}</pre>
            <div className="perm-acts">
              <button type="button" className="btn-primary" onClick={() => answerPerm(p, true)}>
                Allow
              </button>
              <button type="button" className="btn-secondary" onClick={() => answerPerm(p, false)}>
                Deny
              </button>
            </div>
            </div>
          ) : (
            <p key={p.toolUseID} className="perm-note">
              {(p.verdict ? "Allowed " : "Denied ") + p.toolName}
            </p>
          ),
        )}
        {turnError && (
          <p className="chat-error">
            {turnError}{" "}
            {lastPrompt.current && !streaming && (
              <button type="button" onClick={() => sendPrompt(lastPrompt.current)}>
                Retry
              </button>
            )}
          </p>
        )}
        {activity && (
          <div className="thinking-row">
            <LoadingState label={activity} variant="Drive" />
          </div>
        )}
      </section>
      <div className={`chat-scroll-edge chat-scroll-edge-bottom${scrollEdge === "bottom" ? " is-visible" : ""}`} aria-hidden="true" />
      {!stuck && (
        <button
          type="button"
          className="jump-latest"
          onClick={() => {
            stick.current = true;
            setStuck(true);
            requestAnimationFrame(scrollDown);
          }}
          aria-label="Jump to latest"
          data-tip="Jump to latest"
          data-tip-pos="above"
        >
          <AnimatedActionIcon icon={ArrowDownIcon} size={15} aria-hidden="true" />
          Latest
        </button>
      )}
      {setup && streaming ? (
        <div className="composer setup-resume-composer">
          <div className="setup-resume-card" role="status">
            <span>
              <b>Setup in progress</b>
              <small>GitBot is preparing and verifying this machine.</small>
            </span>
            <button
              type="button"
              className="btn-secondary btn-compact"
              onClick={stop}
            >
              <AnimatedActionIcon icon={CircleStopIcon} size={14} aria-hidden="true" />
              Stop setup
            </button>
          </div>
        </div>
      ) : setup && !setupAwaitingInput ? (
        <div className="composer setup-resume-composer">
          <div className="setup-resume-card" role="status">
            <span>
              <b>{setup.paused ? "Setup pending" : autoSend ? "Starting setup" : "Setup incomplete"}</b>
              <small>
                {setup.paused
                  ? "Resume setup to unlock conversations."
                  : autoSend
                    ? "GitBot is preparing the setup run."
                    : "Continue setup to finish verification and unlock conversations."}
              </small>
            </span>
            <button
              type="button"
              className="btn-primary btn-compact"
              onClick={setup.onRetry}
              disabled={setup.retrying}
            >
              <AnimatedActionIcon icon={RefreshCwIcon} size={14} aria-hidden="true" />
              {setup.retrying ? "Resuming" : "Resume setup"}
            </button>
          </div>
        </div>
      ) : (
        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            sendPrompt(draft);
            resetBox();
          }}
        >
          <QueueTray
            text={queue}
            onSteer={steerNow}
            onEdit={editQueue}
            onDiscard={discardQueue}
          />
          <div className="composer-pill">
            <textarea
              ref={boxRef}
              value={draft}
              rows={1}
              onChange={(e) => {
                setDraft(e.target.value);
                draftRef.current = e.target.value;
                e.target.style.height = "auto";
                e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`;
              }}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  sendPrompt(draft);
                  resetBox();
                  return;
                }
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  sendPrompt(draft);
                  resetBox();
                }
              }}
              placeholder={
                setup
                  ? streaming
                    ? "Add setup information…"
                    : "Reply if setup needs you…"
                  : streaming
                    ? "Add a follow-up…"
                    : `Ask ${botName}…`
              }
              aria-label={setup ? "Setup response" : "Message"}
            />
            {streaming ? (
              <div className="composer-action">
                {escapeStopArmed && (
                  <span className="stop-confirm" role="status">Press Escape again to stop</span>
                )}
                <button
                  type="button"
                  className="send-btn"
                  onClick={stop}
                  aria-label="Stop"
                  data-tip="Stop"
                  data-tip-pos="above"
                >
                  <AnimatedActionIcon icon={CircleStopIcon} size={16} aria-hidden="true" />
                </button>
              </div>
            ) : (
              <button type="submit" className="send-btn" disabled={!draft.trim()} aria-label="Send" data-tip="Send" data-tip-pos="above">
                <AnimatedActionIcon icon={ArrowUpIcon} size={16} aria-hidden="true" />
              </button>
            )}
          </div>
        </form>
      )}
    </main>
  );
}
