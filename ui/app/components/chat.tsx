"use client";

import { useEffect, useRef, useState } from "react";
import { IconArrowUp, IconCheck, IconCopy, IconPlayerStop, IconRefresh } from "@tabler/icons-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import LoadingState from "./loading-state";
import {
  ApiError,
  getMessages,
  getPendingPermissions,
  getSessionConfig,
  getSessionStatus,
  patchPermissionMode,
  postAbort,
  postChat,
  postPermission,
  streamUrl,
} from "../lib/api";
import { EDIT_TOOLS, PERMISSION_MODES, botPermissionToSession } from "../lib/gitbot";
import type { HistoryMsg, PermRequest, SessionPermissionMode, ThreadFull } from "../lib/gitbot";

type ToolChip = { name: string; input: unknown };
type Msg = {
  id: string;
  role: "user" | "assistant";
  text: string;
  tools: ToolChip[];
};

let seq = 0;
const nid = () => `m${Date.now()}-${seq++}`;

// History blocks → plain text. Non-text blocks are skipped, and so is
// the harness-injected context dump (e.g. <recommended_plugins>) that
// the agent prepends when a session starts — it isn't user chat.
function flatten(role: string, content: { type: string; text?: string }[]) {
  const text = (content ?? [])
    .filter(
      (b) =>
        b.type === "text" &&
        b.text &&
        !b.text.trimStart().startsWith("<recommended_plugins>"),
    )
    .map((b) => b.text as string)
    .join("\n");
  return { role: role === "user" ? "user" : "assistant", text } as const;
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
  botPermission,
  autoSend,
  onAutoSent,
  onTurnDone,
  onWorkingChange,
  onLiveSession,
  booting,
}: {
  thread: ThreadFull | null;
  botName: string;
  /** The bot's saved permission setting — the default until the user
   *  switches modes for this thread. */
  botPermission?: string;
  autoSend: string | null;
  onAutoSent: () => void;
  onTurnDone: () => void;
  onWorkingChange?: (working: boolean) => void;
  /** Reports the session a thread's turn runs in, and null once that turn
   *  ends here. Switching threads mid-turn reports nothing: the turn keeps
   *  running server-side and the caller checks on it. */
  onLiveSession?: (threadId: string, sessionId: string | null) => void;
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
  // Permission mode the user picked for this thread; null = bot default.
  const [modeOverride, setModeOverride] = useState<SessionPermissionMode | null>(null);
  const permMode = modeOverride ?? botPermissionToSession(botPermission);

  const esRef = useRef<EventSource | null>(null);
  const sessionRef = useRef<string | null>(null);
  const liveIdRef = useRef<string | null>(null);
  // Progressive reveal: the server emits whole messages, so the live
  // bubble types out at reading pace instead of popping in at once.
  const [live, setLive] = useState<{
    key: number;
    text: string;
    shown: number;
    tools: ToolChip[];
  } | null>(null);
  const liveKey = useRef(0);
  const threadRef = useRef<string | null>(null);
  const lastPrompt = useRef("");
  const scrollRef = useRef<HTMLElement | null>(null);
  const stick = useRef(true);
  const boxRef = useRef<HTMLTextAreaElement | null>(null);
  const reloadTimer = useRef<number | null>(null);
  // Rejoin mode: a turn is already running server-side. Text/tool events
  // are replays of painted history, so only approvals (filtered to the
  // still-pending set), status, and terminal events are honored.
  const catchupRef = useRef(false);
  const pendingFilter = useRef<string[] | null>(null);

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
        setMsgs(flattenMsgs(messages));
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
    return messages
      .map((m, idx) => ({ ...flatten(m.role, m.content), idx }))
      .filter((m) => m.text.trim().length > 0)
      .map((m) => ({ id: `h${m.idx}`, role: m.role, text: m.text, tools: [] as ToolChip[] }));
  }

  // Load history on thread switch; drop any live turn.
  useEffect(() => {
    closeStream();
    if (reloadTimer.current) clearTimeout(reloadTimer.current);
    sessionRef.current = null;
    liveIdRef.current = null;
    setLive(null);
    threadRef.current = thread?.id ?? null;
    setMsgs([]);
    setPerms([]);
    setModeOverride(null);
    setTurnError(null);
    setActivity(null);
    setStreaming(false);
    stick.current = true;
    catchupRef.current = false;
    pendingFilter.current = null;
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
              onLiveSession?.(tid, sid);
              setStreaming(true);
              setActivity("Thinking…");
              openStream(sid);
              // The running turn may be in a mode the user switched to earlier.
              getSessionConfig(sid)
                .then(({ permissionMode }) => {
                  if (threadRef.current === tid) setModeOverride(permissionMode);
                })
                .catch(() => {});
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

  // Typewriter: reveal the live bubble a few chars at a time.
  useEffect(() => {
    if (!streaming || !live || live.shown >= live.text.length) return;
    const timer = window.setInterval(() => {
      setLive((prev) =>
        !prev || prev.shown >= prev.text.length
          ? prev
          : { ...prev, shown: Math.min(prev.text.length, prev.shown + 6) },
      );
    }, 24);
    return () => clearInterval(timer);
  }, [streaming, live]);

  function ensureLive(): string {
    if (!liveIdRef.current) {
      liveIdRef.current = nid();
      liveKey.current += 1;
      const key = liveKey.current;
      setLive({ key, text: "", shown: 0, tools: [] });
    }
    return liveIdRef.current;
  }

  function finish(refetch: boolean) {
    closeStream();
    const tid = threadRef.current;
    if (tid) onLiveSession?.(tid, null);
    setStreaming(false);
    setActivity(null);
    liveIdRef.current = null;
    sessionRef.current = null;
    if (refetch && tid) {
      // Complete the reveal instantly, settle the view, then swap in
      // history (identical content — invisible) a beat later.
      setLive((prev) => (prev ? { ...prev, shown: prev.text.length } : prev));
      requestAnimationFrame(scrollDown);
      reloadTimer.current = window.setTimeout(() => {
        if (threadRef.current !== tid) return;
        getMessages(tid)
          .then(({ messages }) => {
            if (threadRef.current !== tid) return;
            setLive(null);
            setMsgs(flattenMsgs(messages));
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
      if (chunk) setLive((prev) => (prev ? { ...prev, text: prev.text + chunk } : prev));
    });
    es.addEventListener("tool_use", (ev) => {
      if (catchupRef.current) return;
      ensureLive();
      const d = data(ev);
      const chip = { name: String(d.tool_name ?? "tool"), input: d.tool_input };
      setLive((prev) => (prev ? { ...prev, tools: [...prev.tools, chip] } : prev));
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
    });
    // The agent itself failed (provider refused, bad model, crashed CLI). The
    // turn still ends with its own `done`/`error`; this only keeps the reason,
    // which would otherwise show as an empty reply.
    es.addEventListener("agent_error", (ev) => {
      setTurnError(String(data(ev).message ?? "The agent reported an error"));
    });
    es.addEventListener("aborted", () => {
      setMsgs((prev) => [...prev, { id: nid(), role: "assistant", text: "_Stopped._", tools: [] }]);
      catchupRef.current = false;
      pendingFilter.current = null;
      finish(true);
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
    setTurnError(null);
    setPerms([]);
    setMsgs((prev) => [...prev, { id: nid(), role: "user", text: prompt, tools: [] }]);
    setStreaming(true);
    setActivity("Thinking…");
    stick.current = true;
    requestAnimationFrame(scrollDown);
    try {
      const { sessionId } = await postChat(thread.id, prompt, modeOverride ?? undefined);
      if (threadRef.current !== thread.id) return;
      sessionRef.current = sessionId;
      onLiveSession?.(thread.id, sessionId);
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

  // Switch permission mode. Between turns it just rides along on the next
  // /chat; mid-turn the server applies it at once and resolves any waiting
  // approvals the new mode covers — re-read the pending set to mirror that.
  function changeMode(mode: SessionPermissionMode) {
    const before = modeOverride;
    setModeOverride(mode);
    const sid = sessionRef.current;
    if (!sid) return;
    patchPermissionMode(sid, mode)
      .then(() => getPendingPermissions(sid))
      .then(({ pending }) =>
        setPerms((prev) =>
          prev.map((x) =>
            x.verdict === undefined && pending.indexOf(x.toolUseID) === -1 ? { ...x, verdict: true } : x,
          ),
        ),
      )
      .catch((e) => {
        setModeOverride(before);
        setTurnError(errText(e));
      });
  }

  // Shown while any approval card is unanswered; otherwise the last status.
  const awaitingApproval = perms.some((p) => p.verdict === undefined);
  const activityLabel = awaitingApproval ? "Waiting for your approval…" : activity;

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
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 96;
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
              <RichText text={m.text} />
              {m.tools.map((t, ti) => (
                <span
                  key={ti}
                  className="tool-chip"
                  style={{ animationDelay: `${Math.min(ti, 5) * 45}ms` }}
                >
                  ⌘ {t.name}
                </span>
              ))}
              {m.role === "assistant" && m.id.startsWith("h") && (
                <span className="msg-acts">
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={() => copyText(m.id, m.text)}
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
        {live && (live.shown > 0 || streaming) && (
          <article key={live.key} className="bubble assistant msg-in">
            <RichText text={live.text.slice(0, live.shown)} />
            {live.tools.map((t, ti) => (
              <span
                key={ti}
                className="tool-chip"
                style={{ animationDelay: `${Math.min(ti, 5) * 45}ms` }}
              >
                ⌘ {t.name}
              </span>
            ))}
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
              {EDIT_TOOLS.indexOf(p.toolName) !== -1 && permMode === "ask-permissions" ? (
                <button
                  type="button"
                  className="btn-secondary perm-all"
                  title="Stop asking about file edits in this thread"
                  onClick={() => changeMode("allow-all-edits")}
                >
                  Allow all edits
                </button>
              ) : (
                <button
                  type="button"
                  className="btn-secondary perm-all"
                  title="Stop asking in this thread — auto-approve every tool"
                  onClick={() => changeMode("yolo")}
                >
                  Allow all
                </button>
              )}
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
        {activityLabel && (
          <div className="thinking-row">
            <LoadingState label={activityLabel} variant="Drive" />
          </div>
        )}
      </section>
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
              e.target.style.height = "auto";
              e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`;
            }}
            onKeyDown={(e) => {
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
        <label className="perm-mode">
          <span>Permissions</span>
          <select
            value={permMode}
            onChange={(e) => changeMode(e.target.value as SessionPermissionMode)}
            aria-label="Permission mode for this thread"
          >
            {PERMISSION_MODES.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
      </form>
    </main>
  );
}
