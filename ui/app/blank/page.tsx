"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  IconArrowBarToLeft,
  IconArrowBarToRight,
  IconDownload,
  IconPencil,
  IconPlus,
} from "@tabler/icons-react";
import Chat from "../components/chat";
import NewBotButton from "../components/new-bot-button";
import BotForm from "../components/bot-form";
import ThreadPanel from "../components/thread-panel";
import { ImportModal, ShareModal } from "../components/share-modals";
import { useToast } from "../components/toast";
import BotFace from "../components/bot-face";
import { botTile } from "../components/bot-avatar";
import TopBar from "../components/top-bar";
import {
  botSetupAction,
  createBot,
  getBots,
  getThreads,
} from "../lib/api";
import { getAvatarPref, setAvatarPref, resolveAvatar, defaultMascotFor, type AvatarPref } from "../lib/avatar-prefs";
import type { Bot, ThreadFull } from "../lib/gitbot";

const DEFAULT_WIDTH = 260;
const COLLAPSED_WIDTH = 84;
const MIN_WIDTH = 180;
const MAX_WIDTH = 420;
const THREADS_WIDTH = 248;
const THREADS_MIN = 200;
const THREADS_MAX = 480;

function avatarFor(id: string): AvatarPref {
  return resolveAvatar(getAvatarPref(id), {
    mascot: defaultMascotFor(id),
    color: botTile(id),
  });
}

function needsSetup(bot: Bot) {
  return !!bot.setupInstructions && bot.setupStatus !== "complete";
}

type Modal = { kind: "share"; bot: Bot } | { kind: "import" } | null;

export default function Blank() {
  const [bots, setBots] = useState<Bot[]>([]);
  const [botsError, setBotsError] = useState<string | null>(null);
  const [threads, setThreads] = useState<ThreadFull[]>([]);
  const [threadsError, setThreadsError] = useState<string | null>(null);
  const [threadsLoading, setThreadsLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [threadByBot, setThreadByBot] = useState<Record<string, string>>({});
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [modal, setModal] = useState<Modal>(null);
  // Inline bot studio: replaces threads + chat while open.
  const [editing, setEditing] = useState<Bot | "new" | null>(null);
  // New-thread folder picker: slides over the chat column only.
  const [threadPanel, setThreadPanel] = useState(false);
  const [autoSend, setAutoSend] = useState<string | null>(null);
  const { toast, view: toastView } = useToast();

  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [threadsWidth, setThreadsWidth] = useState(THREADS_WIDTH);
  const [threadsDragging, setThreadsDragging] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [settled, setSettled] = useState(false);
  // Header icons fade in place and swap sets only while invisible, so
  // rows never shift: nothing mounts/unmounts mid-travel.
  const [iconSet, setIconSet] = useState<"full" | "solo">("full");
  const [iconsDim, setIconsDim] = useState(false);
  const [dragging, setDragging] = useState(false);
  const startX = useRef(0);
  const startWidth = useRef(DEFAULT_WIDTH);
  const tStartX = useRef(0);
  const tStartWidth = useRef(THREADS_WIDTH);
  const settleTimer = useRef<number | null>(null);

  const loadBots = useCallback(() => {
    setBotsError(null);
    getBots()
      .then(({ bots }) => {
        setBots(bots);
        setSelectedId((prev) => prev ?? bots[0]?.id ?? null);
      })
      .catch((e) => setBotsError(e instanceof Error ? e.message : "Failed to load bots"));
  }, []);

  useEffect(loadBots, [loadBots]);

  const bot = bots.find((b) => b.id === selectedId) ?? null;

  const refreshThreads = useCallback((botId: string) => {
    setThreadsLoading(true);
    setThreadsError(null);
    getThreads(botId)
      .then(({ threads }) => {
        setThreads(threads);
        setThreadByBot((prev) => {
          if (prev[botId] && threads.some((t) => t.id === prev[botId])) return prev;
          return { ...prev, [botId]: threads[0]?.id };
        });
      })
      .catch((e) =>
        setThreadsError(e instanceof Error ? e.message : "Failed to load threads"),
      )
      .finally(() => setThreadsLoading(false));
  }, []);

  useEffect(() => {
    if (bot) refreshThreads(bot.id);
    else setThreads([]);
  }, [bot?.id, refreshThreads]);

  const activeThread =
    threads.find((t) => t.id === (bot ? threadByBot[bot.id] : undefined)) ??
    threads[0] ??
    null;

  function toggleCollapse() {
    if (settleTimer.current) {
      clearTimeout(settleTimer.current);
      settleTimer.current = null;
    }
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!collapsed) {
      setCollapsed(true);
      setIconsDim(true);
      // Must match the sidebar travel duration (--duration-slow, 450ms).
      // Settle only swaps already-invisible structure — positions land
      // during the single width+padding motion, so nothing moves after.
      if (reduced) {
        setSettled(true);
        setIconSet("solo");
        setIconsDim(false);
      } else {
        settleTimer.current = window.setTimeout(() => {
          setSettled(true);
          setIconSet("solo");
          setIconsDim(false);
        }, 450);
      }
    } else {
      setSettled(false);
      setCollapsed(false);
      setIconsDim(true);
      if (reduced) {
        setIconSet("full");
        setIconsDim(false);
      } else {
        settleTimer.current = window.setTimeout(() => {
          setIconSet("full");
          setIconsDim(false);
        }, 450);
      }
    }
  }

  useEffect(
    () => () => {
      if (settleTimer.current) clearTimeout(settleTimer.current);
    },
    [],
  );

  const onHandleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      if (collapsed) return;
      setDragging(true);
      startX.current = e.clientX;
      startWidth.current = width;
      document.body.style.cursor = "ew-resize";
      document.body.style.userSelect = "none";

      function onMove(ev: MouseEvent) {
        const next = startWidth.current + ev.clientX - startX.current;
        setWidth(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, next)));
      }
      function onUp() {
        setDragging(false);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      }
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [width, collapsed],
  );

  const onThreadsHandleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setThreadsDragging(true);
      tStartX.current = e.clientX;
      tStartWidth.current = threadsWidth;
      document.body.style.cursor = "ew-resize";
      document.body.style.userSelect = "none";

      function onMove(ev: MouseEvent) {
        const next = tStartWidth.current + ev.clientX - tStartX.current;
        setThreadsWidth(Math.min(THREADS_MAX, Math.max(THREADS_MIN, next)));
      }
      function onUp() {
        setThreadsDragging(false);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      }
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [threadsWidth],
  );

  function newThread() {
    if (!bot || threadPanel) return;
    if (needsSetup(bot)) {
      toast(`Set up ${bot.name} on this machine first`);
      openSetup(bot.id);
      return;
    }
    setThreadPanel(true);
  }

  function threadCreated(thread: ThreadFull) {
    if (!bot) return;
    setThreads((prev) => [thread, ...prev]);
    setThreadByBot((prev) => ({ ...prev, [bot.id]: thread.id }));
    setThreadPanel(false);
  }

  function threadSetupNeeded(message: string) {
    if (!bot) return;
    setThreadPanel(false);
    toast(message);
    refreshThreads(bot.id);
    openSetup(bot.id);
  }

  function threadFailed(message: string) {
    setThreadPanel(false);
    toast(message);
  }

  /** Opens the setup thread (making one first if missing) and auto-sends
   *  the opening prompt into it when it is still empty. */
  function openSetup(botId: string) {
    getThreads(botId)
      .then(({ threads: list }) => {
        setThreads(list);
        const found = list.find((t) => t.kind === "setup");
        if (found) {
          setThreadByBot((prev) => ({ ...prev, [botId]: found.id }));
          if (!found.messageCount) setAutoSend("Start setup.");
          return;
        }
        return botSetupAction(botId, "reset").then(() => getThreads(botId)).then(({ threads: fresh }) => {
          setThreads(fresh);
          const t = fresh.find((x) => x.kind === "setup");
          if (t) {
            setThreadByBot((prev) => ({ ...prev, [botId]: t.id }));
            setAutoSend("Start setup.");
          }
        });
      })
      .catch((e) => toast(e instanceof Error ? e.message : String(e)));
  }

  function markSetupDone() {
    if (!bot) return;
    botSetupAction(bot.id, "complete")
      .then(({ bot: updated }) => {
        setBots((prev) => prev.map((b) => (b.id === updated.id ? updated : b)));
      })
      .catch((e) => toast(e instanceof Error ? e.message : String(e)));
  }

  /** Called right after a bot lands here, whether created or imported. */
  function afterBotAdded(added: Bot, pref: AvatarPref) {
    setAvatarPref(added.id, pref);
    loadBots();
    setSelectedId(added.id);
    getThreads(added.id)
      .then(({ threads: list }) => {
        setThreads(list);
        setThreadByBot((prev) => ({ ...prev, [added.id]: list[0]?.id }));
        // A new bot may owe this machine a setup run.
        if (needsSetup(added)) openSetup(added.id);
      })
      .catch(() => {});
  }

  return (
    <div className="page">
      <TopBar />
      <div className="page-body">
        <aside
          className={`side${collapsed ? " closing" : ""}${settled ? " settled" : ""}`}
          style={{
            width: collapsed ? COLLAPSED_WIDTH : width,
            transition: dragging ? "none" : undefined,
          }}
          aria-label="Bots"
        >
          <div className="side-head">
            {!(collapsed && settled) && (
              <h2 className="side-title">Your bots</h2>
            )}
            <span className={iconsDim ? "head-icons dim" : "head-icons"}>
            {iconSet === "solo" ? (
              <button
                type="button"
                className="collapse-btn fade-in-slow"
                onClick={toggleCollapse}
                aria-expanded={!collapsed}
                aria-label="Expand sidebar"
              >
                <IconArrowBarToRight size={18} stroke={2} aria-hidden="true" />
              </button>
            ) : (
              <>
              <button
                type="button"
                className="collapse-btn"
                onClick={toggleCollapse}
                aria-expanded={!collapsed}
                aria-label="Collapse sidebar"
              >
                <IconArrowBarToLeft size={18} stroke={2} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="collapse-btn"
                onClick={() => setModal({ kind: "import" })}
                aria-label="Import a bot"
              >
                <IconDownload size={18} stroke={2} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="collapse-btn"
                aria-label="Add new bot"
                onClick={() => setEditing("new")}
              >
                <IconPlus size={18} stroke={2} aria-hidden="true" />
              </button>
              </>
            )}
            </span>
          </div>
          {botsError ? (
            <p className="threads-empty">
              {botsError}{" "}
              <button type="button" className="link" onClick={loadBots}>
                Retry
              </button>
            </p>
          ) : (
            <div className="bot-list">
              {bots.map((b) => (
                <button
                  key={b.id}
                  type="button"
                  className={b.id === bot?.id ? "bot-row selected" : "bot-row"}
                  onClick={() => setSelectedId(b.id)}
                  onMouseEnter={() => setHoverId(b.id)}
                  onMouseLeave={() => setHoverId((prev) => (prev === b.id ? null : prev))}
                  aria-current={b.id === bot?.id ? "true" : undefined}
                >
                  <span className="mascot-wrap">
                    <BotFace mascot={avatarFor(b.id).mascot} size={44} color={avatarFor(b.id).color} cheer={hoverId === b.id} />
                  </span>
                  <span className="bot-row-text">
                    <b>{b.name}</b>
                    <small>
                      <i aria-hidden="true" />
                      Idle
                    </small>
                  </span>
                  <span
                    className="edit-badge"
                    aria-hidden="true"
                    onClick={(e) => {
                      e.stopPropagation();
                      setEditing(b);
                    }}
                  >
                    <IconPencil size={16} stroke={2} />
                  </span>
                </button>
              ))}
              {bots.length === 0 && <p className="threads-empty">Loading bots…</p>}
            </div>
          )}
          {collapsed && settled && (
            <NewBotButton onClick={() => setEditing("new")} />
          )}
          <span
            className="side-handle"
            onMouseDown={onHandleMouseDown}
            onDoubleClick={() => setWidth(DEFAULT_WIDTH)}
            aria-hidden="true"
          />
        </aside>
        {editing ? (
          <div className="form-pane">
            <BotForm
              bot={editing === "new" ? null : editing}
              onClose={() => setEditing(null)}
              onSaved={(saved, pref) => {
                if (editing === "new") {
                  setEditing(null);
                  afterBotAdded(saved, pref);
                } else {
                  setEditing(null);
                  setAvatarPref(saved.id, pref);
                  setBots((prev) => prev.map((b) => (b.id === saved.id ? saved : b)));
                }
              }}
              onDeleted={(id) => {
                setEditing(null);
                setBots((prev) => prev.filter((b) => b.id !== id));
                setSelectedId((prev) => (prev === id ? null : prev));
              }}
              onShare={(b) => setModal({ kind: "share", bot: b })}
            />
          </div>
        ) : (
          <>
        <aside
          className="threads"
          style={{
            width: threadsWidth,
            transition: threadsDragging ? "none" : undefined,
          }}
          aria-label="Threads"
        >
          {bot && bot.setupInstructions && bot.setupStatus !== "complete" && (
            <SetupBanner
              bot={bot}
              setupThread={threads.find((t) => t.kind === "setup") ?? null}
              onOpen={() => openSetup(bot.id)}
              onDone={markSetupDone}
            />
          )}
          <div className={collapsed ? "threads-bot-wrap open" : "threads-bot-wrap"}>
            <div className="threads-bot">
              <b>{bot?.name ?? ""}</b>
              <small>
                <i aria-hidden="true" />
                Idle
              </small>
            </div>
          </div>
          <div className="side-head threads-head-row">
            <h2 className="side-title">Threads</h2>
            <button
              type="button"
              className="collapse-btn"
              onClick={newThread}
              aria-label="New thread"
            >
              <IconPlus size={18} stroke={2} aria-hidden="true" />
            </button>
          </div>
          <div className="threads-list">
            {threadsLoading && <p className="threads-empty">Loading threads…</p>}
            {threadsError && <p className="threads-empty">{threadsError}</p>}
            {!threadsLoading &&
              threads.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className={t.id === activeThread?.id ? "thread-row active" : "thread-row"}
                  onClick={() =>
                    bot && setThreadByBot((prev) => ({ ...prev, [bot.id]: t.id }))
                  }
                >
                  {t.title}
                </button>
              ))}
            {!threadsLoading && !threadsError && threads.length === 0 && (
              <p className="threads-empty">No threads yet — start one with +.</p>
            )}
          </div>
          <span
            className="side-handle"
            onMouseDown={onThreadsHandleMouseDown}
            onDoubleClick={() => setThreadsWidth(THREADS_WIDTH)}
            aria-hidden="true"
          />
        </aside>
        <div className={threadPanel ? "chat-col panel-open" : "chat-col"}>
        <Chat
          thread={activeThread}
          botName={bot?.name ?? "bot"}
          autoSend={autoSend}
          onAutoSent={() => setAutoSend(null)}
          onTurnDone={() => {
            if (bot) {
              refreshThreads(bot.id);
              // A setup run reports its verdict on the bot — refresh it too.
              getBots().then(
                ({ bots }) => setBots(bots),
                () => {},
              );
            }
          }}
        />
          <div className="thread-overlay" aria-hidden={!threadPanel}>
            {threadPanel && bot && (
              <ThreadPanel
                key={bot.id}
                bot={bot}
                onClose={() => setThreadPanel(false)}
                onCreated={threadCreated}
                onSetupNeeded={threadSetupNeeded}
                onError={threadFailed}
              />
            )}
          </div>
        </div>
          </>
        )}
      </div>
      {toastView}
      {modal?.kind === "share" && (
        <ShareModal bot={modal.bot} onClose={() => setModal(null)} />
      )}
      {modal?.kind === "import" && (
        <ImportModal
          onClose={() => setModal(null)}
          onAdd={(parsed) => {
            setModal(null);
            createBot({
              name: String(parsed.name),
              emoji: typeof parsed.emoji === "string" ? parsed.emoji : undefined,
              description: typeof parsed.description === "string" ? parsed.description : undefined,
              instructions: typeof parsed.instructions === "string" ? parsed.instructions : undefined,
              setupInstructions:
                typeof parsed.setupInstructions === "string" ? parsed.setupInstructions : undefined,
              model: typeof parsed.model === "string" ? parsed.model : undefined,
              permissionMode: typeof parsed.permissionMode === "string" ? parsed.permissionMode : undefined,
              allowedTools: Array.isArray(parsed.allowedTools)
                ? (parsed.allowedTools as string[])
                : undefined,
            }).then(
              ({ bot: added }) => afterBotAdded(added, { mascot: "ghost", color: "var(--brand-sun)" }),
              (e) => toast(e instanceof Error ? e.message : String(e)),
            );
          }}
        />
      )}
    </div>
  );
}

// Setup banner. Copy verbatim from the original: pending and failed
// earn a banner, a ready machine gets out of the way.
function SetupBanner({
  bot,
  setupThread,
  onOpen,
  onDone,
}: {
  bot: Bot;
  setupThread: ThreadFull | null;
  onOpen: () => void;
  onDone: () => void;
}) {
  const failed = bot.setupStatus === "failed";
  return (
    <div className={failed ? "setup failed" : "setup"}>
      <div className="txt">
        {failed ? (
          <>
            <div className="hd">Setup did not finish</div>
            <p>
              Open the setup thread to see what stopped it — it is an ordinary
              conversation, so you can answer it and carry on.
            </p>
          </>
        ) : (
          <>
            <div className="hd">Setup needed on this machine</div>
            <p>
              {bot.name} needs this machine prepared before it can take work. New
              threads open once setup is done.
            </p>
          </>
        )}
      </div>
      <div className="acts">
        <button type="button" className="btn-primary" onClick={onOpen}>
          {setupThread && setupThread.messageCount ? "Open setup" : "Run setup"}
        </button>
        <button
          type="button"
          className="btn-secondary"
          title="Use this if you sorted it out yourself"
          onClick={onDone}
        >
          Mark as done
        </button>
      </div>
    </div>
  );
}
