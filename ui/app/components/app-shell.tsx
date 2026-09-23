"use client";

import AnimatedActionIcon from "./animated-action-icon";
import { ChevronsLeftIcon } from "@animateicons/react/lucide/chevrons-left-icon";
import { ChevronsRightIcon } from "@animateicons/react/lucide/chevrons-right-icon";
import { CheckIcon } from "@animateicons/react/lucide/check-icon";
import { ShoppingBagIcon } from "@animateicons/react/lucide/shopping-bag-icon";
import { DownloadIcon } from "@animateicons/react/lucide/download-icon";
import { UserIcon } from "@animateicons/react/lucide/user-icon";
import { PlusIcon } from "@animateicons/react/lucide/plus-icon";
import { SearchIcon } from "@animateicons/react/lucide/search-icon";
import { TrashIcon } from "@animateicons/react/lucide/trash-icon";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "./page-link";
import { useUserProfile } from "./app-providers";

import Chat from "./chat";
import NewBotButton from "./new-bot-button";
import BotForm from "./bot-form";
import BotProfile from "./bot-profile";
import UserProfile from "./user-profile";
import ProfilePanelOverlay from "./profile-panel-overlay";
import LearnMorePanel, { type LearnMoreKind } from "./learn-more-panel";
import ThreadPanel from "./thread-panel";
import OnboardingFlow from "./onboarding-flow";
import ThemeButton from "./theme-button";
import { ImportModal, ShareModal } from "./share-modals";
import { useToast } from "./toast";
import BotFace from "./bot-face";
import { chatMascotActivity } from "../lib/chat-mascot-activity";
import BotName from "./bot-name";
import { botTile } from "./bot-avatar";
import TopBar from "./top-bar";

import {
  botSetupAction,
  createBot,
  deleteThread,
  getBots,
  getSessionStatus,
  getThreads,
} from "../lib/api";
import { getAvatarPref, setAvatarPref, resolveAvatar, defaultMascotFor, type AvatarPref } from "../lib/avatar-prefs";
import type { Bot, ThreadFull } from "../lib/gitbot";
import { setupPrompt, type SetupOutcome, type SetupRunKind } from "../lib/setup";
import { useScrollEdge } from "../lib/use-scroll-edge";
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

type Modal = { kind: "share"; bot: Bot; view?: "options" | "code" } | { kind: "import" } | null;

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
  const [learnMore, setLearnMore] = useState<LearnMoreKind | null>(null);
  const learnMoreTriggerRef = useRef<HTMLElement | null>(null);
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
  const [setupRetrying, setSetupRetrying] = useState(false);
  const [pausedSetupIds, setPausedSetupIds] = useState<Record<string, boolean>>({});
  const setupLaunchRef = useRef<string | null>(null);
  // User profile: generic default until set; stored on this device only.
  const { user, saveUser: savedUser } = useUserProfile();
  const [userOpen, setUserOpen] = useState(false);
  const { toast, view: toastView } = useToast();

  const [width, setWidth] = useState<number | null>(null);
  const [threadsWidth, setThreadsWidth] = useState<number | null>(null);
  const sideRef = useRef<HTMLElement | null>(null);
  const threadsAsideRef = useRef<HTMLElement | null>(null);
  const botsHeaderRef = useRef<HTMLDivElement | null>(null);
  const threadsHeaderRef = useRef<HTMLDivElement | null>(null);
  const botsScrollRef = useRef<HTMLDivElement | null>(null);
  const threadsScrollRef = useRef<HTMLDivElement | null>(null);
  const [botsHeaderHeight, setBotsHeaderHeight] = useState(44);
  const [threadsHeaderHeight, setThreadsHeaderHeight] = useState(60);
  const [botsScrolled, setBotsScrolled] = useState(false);
  const [threadsScrolled, setThreadsScrolled] = useState(false);
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
        let installedId: string | null = null;
        try {
          installedId = sessionStorage.getItem("gitbot-marketplace-installed-bot");
          sessionStorage.removeItem("gitbot-marketplace-installed-bot");
        } catch {}
        setSelectedId((prev) => installedId && bots.some((bot) => bot.id === installedId)
          ? installedId
          : prev ?? bots[0]?.id ?? null);
      })
      .catch((e) => setBotsError(e instanceof Error ? e.message : "Failed to load bots"))
      .finally(() => setBotsLoading(false));
  }, []);

  useEffect(loadBots, [loadBots]);

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

  useEffect(() => {
    const entries = [
      [botsHeaderRef.current, setBotsHeaderHeight],
      [threadsHeaderRef.current, setThreadsHeaderHeight],
    ] as const;
    const observers: ResizeObserver[] = [];
    for (const [node, setHeight] of entries) {
      if (!node) continue;
      const measure = () => {
        const style = getComputedStyle(node);
        const margins = parseFloat(style.marginTop) + parseFloat(style.marginBottom);
        setHeight(Math.ceil(node.getBoundingClientRect().height + margins));
      };
      measure();
      const observer = new ResizeObserver(measure);
      observer.observe(node);
      observers.push(observer);
    }
    return () => observers.forEach((observer) => observer.disconnect());
  }, [botsLoading]);

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
  const setupRequired = !!bot && needsSetup(bot);
  const setupThread = threads.find((t) => t.kind === "setup") ?? null;
  const workThreads = threads.filter((t) => t.kind !== "setup");

  const searchText = query.trim().toLowerCase();
  const visibleBots = searchText
    ? bots.filter((b) => b.name.toLowerCase().includes(searchText))
    : bots;

  const threadSearchText = threadQuery.trim().toLowerCase();
  const visibleThreads = threadSearchText
    ? workThreads.filter((t) => t.title.toLowerCase().includes(threadSearchText))
    : workThreads;
  const botsScrollEdge = useScrollEdge(
    botsScrollRef,
    `${collapsed}:${botsLoading}:${visibleBots.length}`,
  );
  const threadsScrollEdge = useScrollEdge(
    threadsScrollRef,
    `${bot?.id ?? "no-bot"}:${threadsLoading}:${visibleThreads.length}`,
  );

  useEffect(() => {
    const entries = [
      [botsScrollRef.current, setBotsScrolled],
      [threadsScrollRef.current, setThreadsScrolled],
    ] as const;
    const cleanups: (() => void)[] = [];
    for (const [node, setScrolled] of entries) {
      if (!node) continue;
      const update = () => setScrolled(node.scrollTop > 1);
      update();
      node.addEventListener("scroll", update, { passive: true });
      cleanups.push(() => node.removeEventListener("scroll", update));
    }
    return () => cleanups.forEach((cleanup) => cleanup());
  }, [botsLoading, visibleBots.length, bot?.id, threadsLoading, visibleThreads.length]);

  const refreshThreads = useCallback((botId: string) => {
    setThreadsLoading(true);
    setThreadsError(null);
    getThreads(botId)
      .then(({ threads }) => {
        setThreads(threads);
        setThreadByBot((prev) => {
          if (
            prev[botId] &&
            threads.some((t) => t.id === prev[botId] && t.kind !== "setup")
          ) {
            return prev;
          }
          const firstWorkThread = threads.find((t) => t.kind !== "setup");
          if (firstWorkThread) return { ...prev, [botId]: firstWorkThread.id };
          const { [botId]: _removed, ...rest } = prev;
          return rest;
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

  const activeThread = setupRequired
    ? setupThread
    : workThreads.find((t) => t.id === (bot ? threadByBot[bot.id] : undefined)) ??
      workThreads[0] ??
      null;
  // When the selected bot also appears in the empty chat panel, both
  // renderings act as one character: same pose and same pointer gaze.
  const mirroredEmptyBotId =
    bot && !setupRequired && !threadsLoading && workThreads.length === 0
      ? bot.id
      : null;

  // Activating a bot that owes this machine setup immediately enters its
  // setup run. The setup thread is implementation detail, so it never needs
  // a click in the thread rail to begin or resume.
  useEffect(() => {
    if (!bot || !setupRequired || threadsLoading) return;
    if (setupThread) {
      if (!setupThread.messageCount && setupLaunchRef.current !== setupThread.id) {
        setupLaunchRef.current = setupThread.id;
        setAutoSend(
          setupPrompt({
            setupInstructions: bot.setupInstructions ?? "",
            botInstructions: bot.instructions,
          }),
        );
      }
      return;
    }
    const launchKey = `create:${bot.id}`;
    if (setupLaunchRef.current === launchKey) return;
    setupLaunchRef.current = launchKey;
    openSetup(bot.id);
    // openSetup intentionally owns the network flow; its inputs are all
    // represented above, and including it would re-run on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bot?.id, setupRequired, setupThread?.id, setupThread?.messageCount, threadsLoading]);

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

  function dismissLearnMore() {
    setLearnMore(null);
  }

  function toggleUserProfile() {
    dismissLearnMore();
    if (!userOpen) {
      setThreadPanel(false);
      setProfileId(null);
    }
    setUserOpen((open) => !open);
  }

  function openLearnMore(kind: "share" | "import" | "permissions") {
    learnMoreTriggerRef.current = document.activeElement as HTMLElement | null;
    setLearnMore(kind);
  }

  function backFromLearnMore() {
    setLearnMore(null);
    requestAnimationFrame(() => learnMoreTriggerRef.current?.focus({ preventScroll: true }));
  }

  function openBotProfile(id: string) {
    dismissLearnMore();
    setThreadPanel(false);
    setUserOpen(false);
    setProfileId(id);
  }

  function openBotEditor(target: Bot | "new") {
    dismissLearnMore();
    setThreadPanel(false);
    setUserOpen(false);
    setEditing(target);
  }

  function newThread() {
    dismissLearnMore();
    if (!bot || threadPanel) return;
    if (needsSetup(bot)) {
      return;
    }
    setUserOpen(false);
    setProfileId(null);
    setThreadPanel(true);
  }

  /** Opens the setup thread (making one first if missing) and auto-sends
   *  the opening prompt into it when it is still empty. */
  function openSetup(botId: string, kind: SetupRunKind = "start", sourceBot?: Bot) {
    const setupBot = sourceBot ?? bots.find((candidate) => candidate.id === botId);
    if (!setupBot?.setupInstructions) return Promise.resolve();
    const prompt = setupPrompt({
      setupInstructions: setupBot.setupInstructions,
      botInstructions: setupBot.instructions,
      kind,
    });
    return getThreads(botId)
      .then(({ threads: list }) => {
        setThreads(list);
        const found = list.find((t) => t.kind === "setup");
        if (found) {
          if (kind !== "start" || !found.messageCount) setAutoSend(prompt);
          return;
        }
        return botSetupAction(botId, "reset").then(() => getThreads(botId)).then(({ threads: fresh }) => {
          setThreads(fresh);
          const t = fresh.find((x) => x.kind === "setup");
          if (t) {
            setAutoSend(prompt);
          }
        });
      })
      .catch((e) => toast(e instanceof Error ? e.message : String(e)));
  }

  function retrySetup() {
    if (!bot) return;
    setSetupRetrying(true);
    botSetupAction(bot.id, "reset")
      .then(({ bot: updated }) => {
        setBots((prev) => prev.map((b) => (b.id === updated.id ? updated : b)));
        return openSetup(updated.id, "continue").then(() => {
          setPausedSetupIds((prev) => ({ ...prev, [updated.id]: false }));
        });
      })
      .catch((e) => toast(e instanceof Error ? e.message : String(e)))
      .finally(() => setSetupRetrying(false));
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
      })
      .catch(() => {});
  }

  function savedBot(saved: Bot, pref: AvatarPref) {
    const setupChanged =
      editing !== "new" &&
      editing != null &&
      editing.setupInstructions !== saved.setupInstructions &&
      needsSetup(saved);
    setAvatarPref(saved.id, pref);
    setSwitchTo(null);
    if (editing === "new") {
      setEditing(null);
      afterBotAdded(saved, pref);
    } else {
      setEditing(null);
      setBots((prev) => prev.map((b) => (b.id === saved.id ? saved : b)));
      if (setupChanged) {
        setupLaunchRef.current = null;
        openSetup(saved.id, "changed", saved);
      }
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
    dismissLearnMore();
    if (editing) {
      if (editing !== "new" && editing.id === b.id) return; // already editing it
      setSwitchTo(b);
      return;
    }
    setSelectedId(b.id);
    // The user panel is global, not bot-scoped — any bot pick dismisses it.
    setUserOpen(false);
    if (showProfile) {
      openBotProfile(b.id);
    } else if (threadPanel) {
      if (needsSetup(b)) {
        setThreadPanel(false);
      }
      // else: the picker stays open and re-targets via key={bot.id}
    } else if (b.id === bot?.id) {
      openBotProfile(b.id);
    }
  }

  function refreshAfterTurn() {
    if (!bot) return;
    refreshThreads(bot.id);
    // A normal turn may still change bot metadata server-side.
    getBots().then(
      ({ bots: nextBots }) => {
        setBots(nextBots);
      },
      () => {},
    );
  }

  async function recordSetupOutcome(outcome: SetupOutcome) {
    if (!bot) return;
    const { bot: updated } = await botSetupAction(
      bot.id,
      outcome === "complete" ? "complete" : "fail",
    );
    setBots((prev) => prev.map((candidate) =>
      candidate.id === updated.id ? updated : candidate,
    ));
    setPausedSetupIds((prev) => ({ ...prev, [updated.id]: false }));
    if (outcome === "complete") toast(`${updated.name} is ready`);
  }

  function threadCreated(thread: ThreadFull) {
    if (!bot) return;
    setThreads((prev) => [thread, ...prev]);
    setThreadByBot((prev) => ({ ...prev, [bot.id]: thread.id }));
    setThreadPanel(false);
  }

  async function removeThread(thread: ThreadFull) {
    if (!bot) return;
    if (thread.sdkSessionId) {
      const running = await getSessionStatus(thread.sdkSessionId)
        .then((status) => status.streaming)
        .catch(() => false);
      if (running) {
        toast("Stop the running turn before deleting this thread");
        return;
      }
    }
    if (!confirm(`Delete "${thread.title}"? The agent's transcript stays on disk.`)) return;
    deleteThread(thread.id).then(
      () => {
        setThreads((current) => current.filter((candidate) => candidate.id !== thread.id));
        setThreadByBot((current) => {
          if (current[bot.id] !== thread.id) return current;
          const { [bot.id]: _deleted, ...rest } = current;
          return rest;
        });
      },
      (error) => toast(error instanceof Error ? error.message : String(error)),
    );
  }

  function threadSetupNeeded(message: string) {
    if (!bot) return;
    setThreadPanel(false);
    toast(message);
    refreshThreads(bot.id);
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
              <Link href="/marketplace" className="text-action topbar-marketplace-btn" aria-label="Open marketplace">
                <AnimatedActionIcon icon={ShoppingBagIcon} size={16} aria-hidden="true" />
                <span>Marketplace</span>
              </Link>
              <span className="topbar-action-separator" aria-hidden="true" />
              <ThemeButton />
            </>
          }
          userName={user.name}
          userPhoto={user.photo}
          onProfile={toggleUserProfile}
        />
        <div className="page-body">
          <OnboardingFlow onDone={loadBots} active={!userOpen} />
          <ProfilePanelOverlay open={userOpen}>
            {userOpen && (
              <UserProfile
                user={user}
                onBack={() => setUserOpen(false)}
                onSaved={savedUser}
              />
            )}
          </ProfilePanelOverlay>
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
            <Link href="/marketplace" className="text-action topbar-marketplace-btn" aria-label="Open marketplace">
              <AnimatedActionIcon icon={ShoppingBagIcon} size={16} aria-hidden="true" />
              <span>Marketplace</span>
            </Link>
            <span className="topbar-action-separator" aria-hidden="true" />
            <ThemeButton />
          </>
        }
        userName={user.name}
        userPhoto={user.photo}
        onProfile={toggleUserProfile}
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
          <div ref={botsHeaderRef} className={`side-head bots-panel-header${searchOpen ? " searching" : ""}${iconSet === "solo" ? " solo" : ""}${botsScrolled ? " is-scrolled" : ""}`}>
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
                <AnimatedActionIcon icon={ChevronsRightIcon} size={18} aria-hidden="true" />
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
                <AnimatedActionIcon icon={ChevronsLeftIcon} size={18} aria-hidden="true" />
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
                <AnimatedActionIcon icon={SearchIcon} size={16} aria-hidden="true" />
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
                onClick={() => { dismissLearnMore(); setModal({ kind: "import" }); }}
                aria-label="Import bot"
                data-tip="Import bot"
              >
                <AnimatedActionIcon icon={DownloadIcon} size={18} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="collapse-btn plus-btn"
                aria-label={searchOpen ? "Close search" : "Create bot"}
                data-tip={searchOpen ? "Close search" : "Create bot"}
                onClick={() => (searchOpen ? closeSearch() : openBotEditor("new"))}
              >
                <AnimatedActionIcon icon={PlusIcon} size={18} aria-hidden="true" />
              </button>
              </>
            )}
            </span>
          </div>
          <div
            className="side-scroll-region panel-scroll-under-header"
            style={{ "--scroll-header-height": `${botsHeaderHeight}px` } as React.CSSProperties}
          >
            <div ref={botsScrollRef} className="side-scroll-content bot-scroll-content">
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
                  {visibleBots.map((b, i) => {
                    const setupPending = needsSetup(b);
                    const mirrored = !setupPending && b.id === mirroredEmptyBotId;
                    return (
                      <div className="bot-row-wrap" key={b.id}>
                        <button
                          type="button"
                          className={`${b.id === bot?.id ? "bot-row selected" : "bot-row"}${b.id === bot?.id && activeLabel ? " live" : ""}${setupPending ? " needs-setup" : ""}${searchText ? "" : " msg-in"}`}
                          onClick={() => botRowClick(b)}
                          onMouseEnter={() => setHoverId(b.id)}
                          onMouseLeave={() => setHoverId((prev) => (prev === b.id ? null : prev))}
                          aria-current={b.id === bot?.id ? "true" : undefined}
                        >
                          <span
                            className={`mascot-wrap${setupPending ? " unpowered" : ""}`}
                            data-bot-follow={mirrored ? b.id : undefined}
                          >
                            <BotFace
                              mascot={avatarFor(b.id).mascot}
                              size={44}
                              activity={!setupPending && b.id === bot?.id ? chatMascotActivity(botActivity) : undefined}
                              color={avatarFor(b.id).color}
                              cheer={!setupPending && !mirrored && (hoverId === b.id)}
                              follow={mirrored}
                              still={setupPending || mirrored}
                              unpowered={setupPending}
                              duration={240}
                              phase={i}
                            />
                            <span className="presence" aria-hidden="true" />
                          </span>
                          <span className="bot-row-text">
                            <b>{b.name}</b>
                            <small>
                              <i aria-hidden="true" />
                              {b.id === bot?.id && activeLabel
                                ? activeLabel
                                : setupPending
                                  ? pausedSetupIds[b.id]
                                    ? "Setup pending"
                                    : b.setupStatus === "failed"
                                    ? "Setup paused"
                                    : "Setup pending"
                                  : "Idle"}
                            </small>
                          </span>
                        </button>
                        <button
                          type="button"
                          className="bot-profile-btn"
                          aria-label={`Open ${b.name} profile`}
                          data-tip="Open profile"
                          onClick={() => {
                            openBotProfile(b.id);
                          }}
                        >
                          <AnimatedActionIcon icon={UserIcon} size={16} aria-hidden="true" />
                        </button>
                      </div>
                    );
                  })}
                  {bots.length === 0 && <p className="threads-empty">No bots yet — add one with +.</p>}
                  {bots.length > 0 && visibleBots.length === 0 && (
                    <p className="threads-empty">No bots match your search.</p>
                  )}
                </div>
              )}
            </div>
            <div className={`side-scroll-edge side-scroll-edge-bottom${botsScrollEdge === "bottom" ? " is-visible" : ""}`} aria-hidden="true" />
          </div>
          {collapsed && settled && (
            <NewBotButton onClick={() => openBotEditor("new")} />
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
              <div ref={threadsHeaderRef} className={`threads-scroll-header${threadsScrolled ? " is-scrolled" : ""}`}>
              <div className={collapsed ? "threads-bot-wrap open" : "threads-bot-wrap"}>
              <div className={`${activeLabel ? "threads-bot live" : "threads-bot"}${setupRequired ? " needs-setup" : ""}`}>
                <b>{bot?.name ?? ""}</b>
                <small>
                  <i aria-hidden="true" />
                  {activeLabel ??
                    (setupRequired
                      ? bot && pausedSetupIds[bot.id]
                        ? "Setup pending"
                        : bot?.setupStatus === "failed"
                        ? "Setup paused"
                        : "Setup pending"
                      : "Idle")}
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
                  <AnimatedActionIcon icon={SearchIcon} size={16} aria-hidden="true" />
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
                  data-tip={
                    threadSearchOpen
                      ? "Close search"
                      : setupRequired
                        ? "Available after setup"
                        : "New thread"
                  }
                  disabled={setupRequired && !threadSearchOpen}
                  onClick={() => (threadSearchOpen ? closeThreadSearch() : newThread())}
                >
                  <AnimatedActionIcon icon={PlusIcon} size={18} aria-hidden="true" />
                </button>
              </div>
              </div>
              <div
                className="side-scroll-region panel-scroll-under-header"
                style={{ "--scroll-header-height": `${threadsHeaderHeight}px` } as React.CSSProperties}
              >
                <div ref={threadsScrollRef} className="threads-list">
                  {threadsLoading && workThreads.length === 0 ? (
                    <div className="skel" aria-label="Loading threads">
                      <i style={{ width: "92%", height: 34 }} />
                      <i style={{ width: "97%", height: 34 }} />
                      <i style={{ width: "88%", height: 34 }} />
                    </div>
                  ) : (
                    <>
                      {threadsError && <p className="threads-empty">{threadsError}</p>}
                      {visibleThreads.map((t) => (
                        <div
                          key={t.id}
                          className={`${t.id === activeThread?.id ? "thread-row active" : "thread-row"}${threadSearchText ? "" : " msg-in"}`}
                          aria-current={t.id === activeThread?.id ? "true" : undefined}
                        >
                          <button
                            type="button"
                            className="thread-open"
                            disabled={setupRequired}
                            title={setupRequired ? "Available after setup" : undefined}
                            onClick={() =>
                              bot && setThreadByBot((prev) => ({ ...prev, [bot.id]: t.id }))
                            }
                          >
                            <span className="thread-row-title">{t.title}</span>
                            {t.id === activeThread?.id && <AnimatedActionIcon icon={CheckIcon} className="thread-selected-mark" size={16} aria-hidden="true" />}
                          </button>
                          <button
                            type="button"
                            className="thread-kill"
                            aria-label={`Delete thread ${t.title}`}
                            title="Delete thread"
                            onClick={() => removeThread(t)}
                          >
                            <AnimatedActionIcon icon={TrashIcon} size={14} aria-hidden="true" />
                          </button>
                        </div>
                      ))}
                      {!threadsError && workThreads.length === 0 && (
                        setupRequired ? (
                          <p className="threads-empty">Threads unlock when setup is complete.</p>
                        ) : (
                          <p className="threads-empty">
                            No threads yet. New threads with{" "}
                            <BotName color={bot ? avatarFor(bot.id).color : undefined}>
                              {bot?.name ?? "this bot"}
                            </BotName>{" "}
                            will appear here.
                          </p>
                        )
                      )}
                      {!threadsError && workThreads.length > 0 && visibleThreads.length === 0 && (
                        <p className="threads-empty">No threads match your search.</p>
                      )}
                    </>
                  )}
                </div>
                <div className={`side-scroll-edge side-scroll-edge-bottom${threadsScrollEdge === "bottom" ? " is-visible" : ""}`} aria-hidden="true" />
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
                botId={bot?.id}
                botName={bot?.name ?? "bot"}
                botPermissionMode={bot?.permissionMode}
                botAvatar={bot ? avatarFor(bot.id) : undefined}
                autoSend={autoSend}
                onAutoSent={() => setAutoSend(null)}
                onActivityChange={setBotActivity}
                onTurnDone={refreshAfterTurn}
                onShare={bot ? (view) => setModal({ kind: "share", bot, view }) : undefined}
                onLearnMorePermissions={() => openLearnMore("permissions")}
                onOpenBot={bot ? () => openBotProfile(bot.id) : undefined}
                onNewThread={bot && !setupRequired ? newThread : undefined}
                booting={botsLoading || threadsLoading}
                setup={
                  setupRequired && bot?.setupInstructions
                    ? {
                        status: bot.setupStatus ?? "pending",
                        instructions: bot.setupInstructions,
                        retrying: setupRetrying,
                        paused: !!pausedSetupIds[bot.id],
                        onRetry: retrySetup,
                        onPause: () => setPausedSetupIds((prev) => ({ ...prev, [bot.id]: true })),
                        onOutcome: recordSetupOutcome,
                      }
                    : undefined
                }
              />
              <div className="thread-overlay" aria-hidden={!threadPanel}>
                {threadPanel && bot && (
                  <ThreadPanel
                    key={bot.id}
                    active={!userOpen && !modal && !editing && !showProfile && !learnMore}
                    bot={bot}
                    botAvatar={avatarFor(bot.id)}
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
                active={!editing && !modal && !userOpen && !learnMore}
                onBack={() => setProfileId(null)}
                onEdit={() => openBotEditor(profileBot)}
                onShare={(view) => setModal({ kind: "share", bot: profileBot, view })}
              />
            )}
          </div>
          <div className="form-overlay" aria-hidden={!editing}>
            {editing && (
              <div className="form-pane">
                <BotForm
                  active={!modal && !userOpen && !learnMore}
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
          <ProfilePanelOverlay open={userOpen}>
            {userOpen && (
              <UserProfile
                user={user}
                onBack={() => setUserOpen(false)}
                onSaved={savedUser}
              />
            )}
          </ProfilePanelOverlay>
        </div>
      </div>
      {toastView}
      {modal?.kind === "share" && (
        <ShareModal
          bot={modal.bot}
          initialView={modal.view}
          inactive={!!learnMore}
          onClose={() => setModal(null)}
          onLearnMore={() => openLearnMore("share")}
        />
      )}
      {modal?.kind === "import" && (
        <ImportModal
          inactive={!!learnMore}
          onClose={() => setModal(null)}
          onLearnMore={() => openLearnMore("import")}
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
              disallowedTools: Array.isArray(parsed.disallowedTools)
                ? (parsed.disallowedTools as string[])
                : undefined,
              agent: typeof parsed.agent === "string" ? parsed.agent : undefined,
            }).then(
              ({ bot: added }) => afterBotAdded(added, { mascot: "ghost", color: "var(--brand-sun)" }),
              (e) => toast(e instanceof Error ? e.message : String(e)),
            );
          }}
        />
      )}
      <ProfilePanelOverlay open={!!learnMore} className="learn-more-overlay">
        {learnMore && <LearnMorePanel kind={learnMore} onBack={backFromLearnMore} />}
      </ProfilePanelOverlay>
    </div>
  );
}
