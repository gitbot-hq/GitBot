"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import { IconArrowDown, IconArrowUp, IconCheck, IconCopy, IconPlayerStop, IconRefresh } from "@tabler/icons-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import LoadingState from "./loading-state";
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
import { groupTools, type ToolChip } from "../lib/tool-ui";
import RunSummary, { ActionRow } from "./run-summary";

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
export default function Chat({
  thread,
  botName,
  autoSend,
  onAutoSent,
  onTurnDone,
  onWorkingChange,
  onActivityChange,
  booting,
}: {
  thread: ThreadFull | null;
  botName: string;
  autoSend: string | null;
  onAutoSent: () => void;
  onTurnDone: () => void;
  onWorkingChange?: (working: boolean) => void;
  /** Live activity sentence ("Thinking…", "Running Bash…", null when idle).
   *  Lets the shell show what the bot is doing outside the chat. */
  onActivityChange?: (activity: string | null) => void;
  /** True while the app is still loading bots/threads on boot. Shows a
   *  skeleton instead of the empty-thread copy, so the first paint never
   *  flashes placeholder text. Defaults to false (old behavior). */
  booting?: boolean;
}) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [loading, setLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [activity, setActivity] = useState<string | null>(null);
  const [perms, setPerms] = useState<(PermRequest & { verdict?: boolean })[]>([]);
  const [turnError, setTurnError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const esRef = useRef<EventSource | null>(null);
  const sessionRef = useRef<string | null>(null);
  const liveIdRef = useRef<string | null>(null);
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

  function resetBox() {
    if (boxRef.current) boxRef.current.style.height = "auto";
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
    // Stash this thread's draft, restore the next one's.
    const prevId = threadRef.current;
    if (prevId) drafts.current[prevId] = draftRef.current;
    sessionRef.current = null;
    liveIdRef.current = null;
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

  // Setup runs auto-send their opening prompt into empty threads.
  useEffect(() => {
    if (!thread || !autoSend || loading || streaming || msgs.length > 0) return;
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

  function finish(refetch: boolean, stopped = false) {
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
          })
          .catch(() => {});
      }, 300);
      onTurnDone();
    } else {
      setLive(null);
      requestAnimationFrame(scrollDown);
      onTurnDone();
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
        { id: nid(), role: "assistant", segs: [{ kind: "text", text: "_Stopped._" }] },
      ]);
      catchupRef.current = false;
      pendingFilter.current = null;
      finish(true, true);
    });
    es.addEventListener("done", () => {
      catchupRef.current = false;
      pendingFilter.current = null;
      finish(true);
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

  async function sendPrompt(prompt: string) {
    if (!thread || streaming || !prompt.trim()) return;
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

  function stop() {
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

  function copyText(id: string, text: string) {
    navigator.clipboard.writeText(text).catch(() => {});
    setCopiedId(id);
    window.setTimeout(() => {
      setCopiedId((prev) => (prev === id ? null : prev));
    }, 1500);
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

  if (!thread) {
    return (
      <main className="chat" aria-label="Chat">
        <section className="chat-body">
          {booting ? (
            <ChatSkeleton label="Loading chat" />
          ) : (
            <p className="chat-empty">Select a thread — or start one with +.</p>
          )}
        </section>
      </main>
    );
  }

  return (
    <main className="chat" aria-label="Chat">
      <section
        className="chat-body"
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          const pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 96;
          stick.current = pinned;
          setStuck(pinned);
        }}
      >
        {historyError && (
          <p className="chat-error">
            {historyError}{" "}
            <button type="button" onClick={() => thread && loadHistory(thread.id)}>
              Retry
            </button>
          </p>
        )}
        {!loading &&
          msgs.map((m) => (
            <article
              key={m.id}
              className={`${m.role === "user" ? "bubble user" : "bubble assistant"}${m.id.startsWith("m") ? " msg-in" : ""}`}
            >
              {m.segs.map((s, si) =>
                s.kind === "text" ? (
                  <RichText key={si} text={s.text} />
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
                    onClick={() => copyText(m.id, msgText(m))}
                    aria-label="Copy reply"
                  >
                    {copiedId === m.id ? (
                      <IconCheck size={15} aria-hidden="true" />
                    ) : (
                      <IconCopy size={15} aria-hidden="true" />
                    )}
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={() => lastPrompt.current && sendPrompt(lastPrompt.current)}
                    aria-label="Try again"
                  >
                    <IconRefresh size={15} aria-hidden="true" />
                  </button>
                </span>
              )}
            </article>
          ))}
        {live && (liveTextLen(live.segs) > 0 || streaming) && (
          <article key={live.key} className="bubble assistant msg-in">
            {revealSegs(live.segs, live.shown).map((s, si) =>
              s.kind === "text" ? (
                <RichText key={`t${si}`} text={s.text} />
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
        {!loading && msgs.length === 0 && !historyError && (
          <p className="chat-empty">New thread. Say hello below.</p>
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
        >
          <IconArrowDown size={15} aria-hidden="true" />
          Latest
        </button>
      )}
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          sendPrompt(draft);
          resetBox();
        }}
      >
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
              if (e.key === "Escape" && streaming) {
                e.preventDefault();
                stop();
                return;
              }
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
            placeholder={streaming ? "Working…" : `Ask ${botName}…`}
            aria-label="Message"
            disabled={streaming}
          />
          {streaming ? (
            <button type="button" className="send-btn" onClick={stop} aria-label="Stop">
              <IconPlayerStop size={16} aria-hidden="true" />
            </button>
          ) : (
            <button type="submit" className="send-btn" disabled={!draft.trim()} aria-label="Send">
              <IconArrowUp size={16} aria-hidden="true" />
            </button>
          )}
        </div>
      </form>
    </main>
  );
}
