"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  IconArrowBarToLeft,
  IconArrowBarToRight,
  IconArrowLeft,
  IconShoppingBag,
  IconDownload,
  IconPencil,
  IconPlus,
  IconSearch,
} from "@tabler/icons-react";
import Chat from "./chat";
import NewBotButton from "./new-bot-button";
import BotForm from "./bot-form";
import BotProfile from "./bot-profile";
import UserProfile from "./user-profile";
import ThreadPanel from "./thread-panel";
import OnboardingFlow from "./onboarding-flow";
import ThemeButton from "./theme-button";
import { ImportModal, ShareModal } from "./share-modals";
import { useToast } from "./toast";
import BotFace from "./bot-face";
import { botTile } from "./bot-avatar";
import TopBar from "./top-bar";
import {
  DEFAULT_USER_NAME,
  getUserPref,
  setUserPref,
  type UserPref,
} from "../lib/user-prefs";
import {
  botSetupAction,
  createBot,
  getBots,
  getThreads,
} from "../lib/api";
import { getAvatarPref, setAvatarPref, resolveAvatar, defaultMascotFor, type AvatarPref } from "../lib/avatar-prefs";
import type { Bot, ThreadFull } from "../lib/gitbot";
import "../v2-theme.css";
import "../onboarding/onboarding.css";

const DEFAULT_WIDTH = 260;
const COLLAPSED_WIDTH = 96;
// Four 32px header buttons + "Your bots" + side padding: anything less
// truncates the title.
const MIN_WIDTH = 240;
const MAX_WIDTH = 420;
const THREADS_WIDTH = 248;
const THREADS_MIN = 200;
const THREADS_MAX = 480;
const SIDE_WIDTH_KEY = "gitbot-v2-side-width";
const THREADS_WIDTH_KEY = "gitbot-v2-threads-width";

function storeWidth(key: string, value: number) {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // private mode — widths just won't persist
  }
}

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

export default function V2() {
  const [bots, setBots] = useState<Bot[]>([]);
  const [botsLoading, setBotsLoading] = useState(true);
  const [botsError, setBotsError] = useState<string | null>(null);
  const [threads, setThreads] = useState<ThreadFull[]>([]);
  const [threadsError, setThreadsError] = useState<string | null>(null);
  const [threadsLoading, setThreadsLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [threadByBot, setThreadByBot] = useState<Record<string, string>>({});
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [botActivity, setBotActivity] = useState<string | null>(null);
  const [modal, setModal] = useState<Modal>(null);
  // Inline bot studio: slides over threads + chat.
  const [editing, setEditing] = useState<Bot | "new" | null>(null);
  // Pending sidebar switch target while the studio guards unsaved changes.
  const [switchTo, setSwitchTo] = useState<Bot | null>(null);
  // Bot profile: fills the tray where threads + chat live. Edit dives
  // into the studio on top of it; saving lands back here.
  const [profileId, setProfileId] = useState<string | null>(null);
  // New-thread folder picker: slides over the chat column only.
  const [threadPanel, setThreadPanel] = useState(false);
  const [autoSend, setAutoSend] = useState<string | null>(null);
  // User profile: generic default until set; stored on this device only.
  const [user, setUser] = useState<UserPref>({
    name: DEFAULT_USER_NAME,
    email: "",
    bio: "",
    location: "",
    emailVerified: false,
    photo: null,
  });
  const [userOpen, setUserOpen] = useState(false);
  const { toast, view: toastView } = useToast();

  const [width, setWidth] = useState<number | null>(null);
  const [threadsWidth, setThreadsWidth] = useState<number | null>(null);
  const sideRef = useRef<HTMLElement | null>(null);
  const threadsAsideRef = useRef<HTMLElement | null>(null);
  const [threadsDragging, setThreadsDragging] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [settled, setSettled] = useState(false);
  const [iconSet, setIconSet] = useState<"full" | "solo">("full");
  const [iconsDim, setIconsDim] = useState(false);
  const [dragging, setDragging] = useState(false);
  // Header search: the row morphs — title/collapse/import collapse away,
  // the box opens between search and +, and + rotates 45° into its close.
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement | null>(null);
  const searchBtnRef = useRef<HTMLButtonElement | null>(null);

  function closeSearch() {
    setSearchOpen(false);
    setQuery("");
    searchBtnRef.current?.focus({ preventScroll: true });
  }

  // Threads header search: same morph as the bots header — title collapses
  // away, the box opens between search and +, + rotates into its close.
  const [threadSearchOpen, setThreadSearchOpen] = useState(false);
  const [threadQuery, setThreadQuery] = useState("");
  const threadSearchRef = useRef<HTMLInputElement | null>(null);
  const threadSearchBtnRef = useRef<HTMLButtonElement | null>(null);

  function closeThreadSearch() {
    setThreadSearchOpen(false);
    setThreadQuery("");
    threadSearchBtnRef.current?.focus({ preventScroll: true });
  }
  const startX = useRef(0);
  const startWidth = useRef(DEFAULT_WIDTH);
  const tStartX = useRef(0);
  const tStartWidth = useRef(THREADS_WIDTH);
  const settleTimer = useRef<number | null>(null);
  const undimTimer = useRef<number | null>(null);

  const loadBots = useCallback(() => {
    setBotsError(null);
    setBotsLoading(true);
    getBots()
      .then(({ bots }) => {
        setBots(bots);
        setSelectedId((prev) => prev ?? bots[0]?.id ?? null);
      })
      .catch((e) => setBotsError(e instanceof Error ? e.message : "Failed to load bots"))
      .finally(() => setBotsLoading(false));
  }, []);

  useEffect(loadBots, [loadBots]);

  // Stored profile loads after mount (default first — no hydration flash).
  useEffect(() => {
    setUser(getUserPref());
  }, []);

  function savedUser(next: UserPref) {
    setUser(next);
    setUserPref(next);
  }

  // Widths: null means "CSS owns it" — layout.tsx sets --v2-side-w /
  // --v2-threads-w before paint, so the first paint is already final.
  // React writes an inline width only after a drag or reset (persisted).
  useEffect(() => {
    if (width != null) storeWidth(SIDE_WIDTH_KEY, width);
  }, [width]);

  useEffect(() => {
    if (threadsWidth != null) storeWidth(THREADS_WIDTH_KEY, threadsWidth);
  }, [threadsWidth]);

  // Focus the field without scrolling anything: it mounts in normal flow,
  // but preventScroll keeps this true even if that ever changes.
  useEffect(() => {
    if (searchOpen) searchRef.current?.focus({ preventScroll: true });
  }, [searchOpen]);

  useEffect(() => {
    if (threadSearchOpen) threadSearchRef.current?.focus({ preventScroll: true });
  }, [threadSearchOpen]);

  const bot = bots.find((b) => b.id === selectedId) ?? null;
  const profileBot = bots.find((b) => b.id === profileId) ?? null;
  // The profile stays mounted under the studio: opening edit slides the
  // studio over it, closing slides back to it.
  const showProfile = profileBot != null;

  // Live rail status: the chat's activity sentence shortened to one word.
  // Anything unrecognized is honestly just "Working".
  function shortActivity(a: string | null): string | null {
    if (!a) return null;
    if (a === "Thinking…") return "Thinking";
    if (a === "Waiting for your approval…") return "Waiting";
    const m = a.match(/^Running (.+?)…$/);
    if (m) {
      return (
        (
          {
            Read: "Reading",
            Edit: "Editing",
            Write: "Writing",
            Bash: "Running",
            Grep: "Searching",
            Glob: "Finding",
          } as Record<string, string>
        )[m[1]] ?? "Working"
      );
    }
    return "Working";
  }
  const activeLabel = bot ? shortActivity(botActivity) : null;

  const searchText = query.trim().toLowerCase();
  const visibleBots = searchText
    ? bots.filter((b) => b.name.toLowerCase().includes(searchText))
    : bots;

  const threadSearchText = threadQuery.trim().toLowerCase();
  const visibleThreads = threadSearchText
    ? threads.filter((t) => t.title.toLowerCase().includes(threadSearchText))
    : threads;

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
    else {
      setThreads([]);
      // No bot yet because bots are still loading is not the same as no
      // bot at all — only settle when bots are in.
      if (!botsLoading) setThreadsLoading(false);
    }
  }, [bot?.id, botsLoading, refreshThreads]);

  const activeThread =
    threads.find((t) => t.id === (bot ? threadByBot[bot.id] : undefined)) ??
    threads[0] ??
    null;

  function toggleCollapse() {
    if (settleTimer.current) {
      clearTimeout(settleTimer.current);
      settleTimer.current = null;
    }
    if (undimTimer.current) {
      clearTimeout(undimTimer.current);
      undimTimer.current = null;
    }
    // The collapsed rail fits one button — search can't survive the trip,
    // so it closes first and the normal icon flow takes over.
    setSearchOpen(false);
    setQuery("");
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!collapsed) {
      setCollapsed(true);
      setIconsDim(true);
      // Must match the sidebar travel duration (--duration-slow, 450ms).
      // Landing is two beats: swap sets while still invisible, then fade
      // in — so neither the centering flip nor the set swap ever pops.
      if (reduced) {
        setSettled(true);
        setIconSet("solo");
        setIconsDim(false);
      } else {
        settleTimer.current = window.setTimeout(() => {
          setSettled(true);
          setIconSet("solo");
          undimTimer.current = window.setTimeout(() => {
            setIconsDim(false);
          }, 80);
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
          undimTimer.current = window.setTimeout(() => {
            setIconsDim(false);
          }, 80);
        }, 450);
      }
    }
  }

  useEffect(
    () => () => {
      if (settleTimer.current) clearTimeout(settleTimer.current);
      if (undimTimer.current) clearTimeout(undimTimer.current);
    },
    [],
  );

  const onHandleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      if (collapsed) return;
      setDragging(true);
      startX.current = e.clientX;
      startWidth.current =
        sideRef.current?.getBoundingClientRect().width ?? width ?? DEFAULT_WIDTH;
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
      tStartWidth.current =
        threadsAsideRef.current?.getBoundingClientRect().width ??
        threadsWidth ??
        THREADS_WIDTH;
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

  function savedBot(saved: Bot, pref: AvatarPref) {
    setAvatarPref(saved.id, pref);
    setSwitchTo(null);
    if (editing === "new") {
      setEditing(null);
      afterBotAdded(saved, pref);
    } else {
      setEditing(null);
      setBots((prev) => prev.map((b) => (b.id === saved.id ? saved : b)));
    }
  }

  function deletedBot(id: string) {
    setEditing(null);
    setSwitchTo(null);
    setProfileId((prev) => (prev === id ? null : prev));
    setBots((prev) => prev.filter((b) => b.id !== id));
    setSelectedId((prev) => (prev === id ? null : prev));
  }

  /** A guarded studio save completed — refresh the list, then apply the
   *  pending sidebar switch. */
  function switchedBot(saved: Bot, pref: AvatarPref) {
    setAvatarPref(saved.id, pref);
    setBots((prev) => {
      const i = prev.findIndex((b) => b.id === saved.id);
      return i === -1 ? [...prev, saved] : prev.map((b) => (b.id === saved.id ? saved : b));
    });
    const target = switchTo;
    setSwitchTo(null);
    if (target) setEditing(target);
  }

  function applySwitch(target: Bot) {
    setSwitchTo(null);
    setEditing(target);
  }

  /** Sidebar bot rows while panels are open. The studio guards unsaved
   *  work (switch with a Save check); every other panel yields — profile
   *  re-targets, picker re-targets, user panel closes — and the tapped bot
   *  gets selected. */
  function botRowClick(b: Bot) {
    if (editing) {
      if (editing !== "new" && editing.id === b.id) return; // already editing it
      setSwitchTo(b);
      return;
    }
    setSelectedId(b.id);
    // The user panel is global, not bot-scoped — any bot pick dismisses it.
    setUserOpen(false);
    if (showProfile) {
      setProfileId(b.id);
    } else if (threadPanel) {
      if (needsSetup(b)) {
        setThreadPanel(false);
        toast(`Set up ${b.name} on this machine first`);
        openSetup(b.id);
      }
      // else: the picker stays open and re-targets via key={bot.id}
    } else if (b.id === bot?.id) {
      setProfileId(b.id);
    }
  }

  function refreshAfterTurn() {
    if (!bot) return;
    refreshThreads(bot.id);
    // A setup run reports its verdict on the bot — refresh it too.
    getBots().then(
      ({ bots }) => setBots(bots),
      () => {},
    );
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

  // No bots yet (and done loading, no error): first run. The onboarding
  // flow takes the whole page; creating or importing reloads bots and
  // lands in the app with the new bot selected.
  if (!botsLoading && !botsError && bots.length === 0) {
    return (
      <div className="page v2">
        <TopBar
          actions={
            <>
              <Link href="/marketplace" className="topbar-marketplace-btn">
                <IconShoppingBag size={16} stroke={2} aria-hidden="true" />
                <span>Marketplace</span>
              </Link>
              <span className="topbar-action-separator" aria-hidden="true" />
              <ThemeButton />
            </>
          }
          userName={user.name}
          userPhoto={user.photo}
          onProfile={() => setUserOpen((v) => !v)}
        />
        <div className="page-body">
          <OnboardingFlow onDone={loadBots} />
          <div
            className={userOpen ? "user-overlay open" : "user-overlay"}
            aria-hidden={!userOpen}
          >
            {userOpen && (
              <UserProfile
                user={user}
                onBack={() => setUserOpen(false)}
                onSaved={savedUser}
              />
            )}
          </div>
        </div>
        {toastView}
      </div>
    );
  }

  return (
    <div className="page v2">
      <TopBar
        actions={
          <>
            <Link href="/marketplace" className="topbar-marketplace-btn">
              <IconShoppingBag size={16} stroke={2} aria-hidden="true" />
              <span>Marketplace</span>
            </Link>
            <span className="topbar-action-separator" aria-hidden="true" />
            <ThemeButton />
          </>
        }
        userName={user.name}
        userPhoto={user.photo}
        onProfile={() => setUserOpen((v) => !v)}
      />
      <div className="page-body">
        <aside
          ref={sideRef}
          className={`side${collapsed ? " closing" : ""}${settled ? " settled" : ""}`}
          style={{
            width: collapsed ? COLLAPSED_WIDTH : (width ?? undefined),
            transition: dragging ? "none" : undefined,
          }}
          aria-label="Bots"
        >
          <div className={`side-head${searchOpen ? " searching" : ""}${iconSet === "solo" ? " solo" : ""}`}>
            {iconSet === "full" && (
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
                data-tip="Expand sidebar"
              >
                <IconArrowBarToRight size={18} stroke={2} aria-hidden="true" />
              </button>
            ) : (
              <>
              <button
                type="button"
                className="collapse-btn fades"
                onClick={toggleCollapse}
                aria-expanded={!collapsed}
                aria-label="Collapse sidebar"
                data-tip="Collapse sidebar"
              >
                <IconArrowBarToLeft size={18} stroke={2} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="collapse-btn search-lead"
                ref={searchBtnRef}
                onClick={() => {
                  if (searchOpen) searchRef.current?.focus({ preventScroll: true });
                  else setSearchOpen(true);
                }}
                aria-label="Search bots"
                data-tip="Search bots"
                aria-hidden={searchOpen || undefined}
                tabIndex={searchOpen ? -1 : 0}
              >
                <IconSearch size={16} stroke={2} aria-hidden="true" />
              </button>
              <div className="search-box">
                <input
                  ref={searchRef}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") closeSearch();
                  }}
                  placeholder="Search bots"
                  aria-label="Search bots"
                  tabIndex={searchOpen ? 0 : -1}
                />
              </div>
              <button
                type="button"
                className="collapse-btn fades"
                onClick={() => setModal({ kind: "import" })}
                aria-label="Import a bot"
                data-tip="Import a bot"
              >
                <IconDownload size={18} stroke={2} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="collapse-btn plus-btn"
                aria-label={searchOpen ? "Close search" : "Add new bot"}
                data-tip={searchOpen ? "Close search" : "Add new bot"}
                onClick={() => (searchOpen ? closeSearch() : setEditing("new"))}
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
          ) : botsLoading && bots.length === 0 ? (
            <div className="bot-skel" aria-label="Loading bots">
              {[0, 1, 2].map((i) => (
                <div key={i} className="skel bot-skel-row" aria-hidden="true">
                  <i className="bot-skel-avatar" />
                  <span className="bot-skel-lines">
                    <i style={{ width: "58%" }} />
                    <i style={{ width: "38%" }} />
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="bot-list">
              {visibleBots.map((b, i) => (
                <button
                  key={b.id}
                  type="button"
                  className={`${b.id === bot?.id ? "bot-row selected" : "bot-row"}${b.id === bot?.id && activeLabel ? " live" : ""}${searchText ? "" : " msg-in"}`}
                  onClick={() => botRowClick(b)}
                  onMouseEnter={() => setHoverId(b.id)}
                  onMouseLeave={() => setHoverId((prev) => (prev === b.id ? null : prev))}
                  aria-current={b.id === bot?.id ? "true" : undefined}
                >
                  <span className="mascot-wrap">
                    <BotFace mascot={avatarFor(b.id).mascot} size={44} color={avatarFor(b.id).color} cheer={hoverId === b.id || (b.id === bot?.id && activeLabel != null)} duration={240} phase={i} />
                    <span className="presence" aria-hidden="true" />
                  </span>
                  <span className="bot-row-text">
                    <b>{b.name}</b>
                    <small>
                      <i aria-hidden="true" />
                      {b.id === bot?.id && activeLabel ? activeLabel : "Idle"}
                    </small>
                  </span>
                  <span
                    className="edit-badge"
                    aria-hidden="true"
                    data-tip="Open profile"
                    onClick={(e) => {
                      e.stopPropagation();
                      setUserOpen(false);
                      setProfileId(b.id);
                    }}
                  >
                    <IconPencil size={16} stroke={2} />
                  </span>
                </button>
              ))}
              {bots.length === 0 && <p className="threads-empty">No bots yet — add one with +.</p>}
              {bots.length > 0 && visibleBots.length === 0 && (
                <p className="threads-empty">No bots match your search.</p>
              )}
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
        <div className={`tray${editing ? " open" : ""}${showProfile ? " profile-open" : ""}`}>
          <div className="tray-main">
            <aside
              ref={threadsAsideRef}
              className="threads"
              style={{
                width: threadsWidth ?? undefined,
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
              <div className={activeLabel ? "threads-bot live" : "threads-bot"}>
                <b>{bot?.name ?? ""}</b>
                <small>
                  <i aria-hidden="true" />
                  {activeLabel ?? "Idle"}
                </small>
              </div>
              </div>
              <div className={threadSearchOpen ? "side-head threads-head-row searching" : "side-head threads-head-row"}>
                <h2 className="side-title">Threads</h2>
                <button
                  type="button"
                  className="collapse-btn search-lead"
                  ref={threadSearchBtnRef}
                  onClick={() => {
                    if (threadSearchOpen) threadSearchRef.current?.focus({ preventScroll: true });
                    else setThreadSearchOpen(true);
                  }}
                  aria-label="Search threads"
                  data-tip="Search threads"
                  aria-hidden={threadSearchOpen || undefined}
                  tabIndex={threadSearchOpen ? -1 : 0}
                >
                  <IconSearch size={16} stroke={2} aria-hidden="true" />
                </button>
                <div className="search-box">
                  <input
                    ref={threadSearchRef}
                    value={threadQuery}
                    onChange={(e) => setThreadQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") closeThreadSearch();
                    }}
                    placeholder="Search threads"
                    aria-label="Search threads"
                    tabIndex={threadSearchOpen ? 0 : -1}
                  />
                </div>
                <button
                  type="button"
                  className="collapse-btn plus-btn"
                  aria-label={threadSearchOpen ? "Close search" : "New thread"}
                  data-tip={threadSearchOpen ? "Close search" : "New thread"}
                  onClick={() => (threadSearchOpen ? closeThreadSearch() : newThread())}
                >
                  <IconPlus size={18} stroke={2} aria-hidden="true" />
                </button>
              </div>
              <div className="threads-list">
                {threadsLoading && threads.length === 0 ? (
                  <div className="skel" aria-label="Loading threads">
                    <i style={{ width: "92%", height: 34 }} />
                    <i style={{ width: "97%", height: 34 }} />
                    <i style={{ width: "88%", height: 34 }} />
                  </div>
                ) : (
                  <>
                {threadsError && <p className="threads-empty">{threadsError}</p>}
                {visibleThreads.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      className={`${t.id === activeThread?.id ? "thread-row active" : "thread-row"}${threadSearchText ? "" : " msg-in"}`}
                      onClick={() =>
                        bot && setThreadByBot((prev) => ({ ...prev, [bot.id]: t.id }))
                      }
                    >
                      {t.title}
                    </button>
                  ))}
                {!threadsError && threads.length === 0 && (
                  <p className="threads-empty">No threads yet — start one with +.</p>
                )}
                {!threadsError && threads.length > 0 && visibleThreads.length === 0 && (
                  <p className="threads-empty">No threads match your search.</p>
                )}
                  </>
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
                onActivityChange={setBotActivity}
              onTurnDone={refreshAfterTurn}
                booting={botsLoading || threadsLoading}
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
          </div>
          <div className="profile-overlay" aria-hidden={!showProfile || !!editing}>
            {showProfile && (
              <BotProfile
                key={profileBot.id}
                bot={profileBot}
                pref={avatarFor(profileBot.id)}
                onBack={() => setProfileId(null)}
                onEdit={() => setEditing(profileBot)}
                onShare={() => setModal({ kind: "share", bot: profileBot })}
              />
            )}
          </div>
          <div className="form-overlay" aria-hidden={!editing}>
            {editing && (
              <div className="form-pane">
                <button
                  type="button"
                  className="back-btn"
                  onClick={() => {
                    setEditing(null);
                    setSwitchTo(null);
                  }}
                >
                  <IconArrowLeft size={16} stroke={2} aria-hidden="true" />
                  Back
                </button>
                <BotForm
                  key={editing === "new" ? "new" : editing.id}
                  bot={editing === "new" ? null : editing}
                  onClose={() => {
                    setEditing(null);
                    setSwitchTo(null);
                  }}
                  onSaved={savedBot}
                  onDeleted={deletedBot}
                  onShare={(b) => setModal({ kind: "share", bot: b })}
                  switchTo={switchTo}
                  onSwitched={switchedBot}
                  onSwitchDiscard={() => switchTo && applySwitch(switchTo)}
                  onSwitchCancel={() => setSwitchTo(null)}
                />
              </div>
            )}
          </div>
          <div
            className={userOpen ? "user-overlay open" : "user-overlay"}
            aria-hidden={!userOpen}
          >
            {userOpen && (
              <UserProfile
                user={user}
                onBack={() => setUserOpen(false)}
                onSaved={savedUser}
              />
            )}
          </div>
        </div>
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
