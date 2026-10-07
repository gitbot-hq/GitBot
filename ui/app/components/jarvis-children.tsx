"use client";

import AnimatedActionIcon from "./animated-action-icon";
import { ChevronDownIcon } from "@animateicons/react/lucide/chevron-down-icon";
import { useCallback, useEffect, useRef, useState } from "react";
import { getThreads } from "../lib/api";
import type { Bot, ThreadFull } from "../lib/gitbot";
import { hasNews } from "../lib/attention";
import { useTabVisible } from "../lib/use-tab-visible";
import { threadIndicator, type ThreadRowState } from "../lib/use-thread-sessions";
import ThreadStatus from "./thread-status";

/** How often the list is re-read while a Jarvis turn runs. */
const POLL_MS = 3000;

function folderName(path: string) {
  return path.split("/").filter(Boolean).pop() ?? path;
}

/**
 * The threads a Jarvis thread started (its children, by reportTo), each one a
 * way into the child. Renders nothing until there is at least one.
 */
export default function JarvisChildren({
  jarvisThreadId,
  bots,
  working,
  states,
  onOpen,
}: {
  jarvisThreadId: string;
  bots: Bot[];
  /** True while the Jarvis thread's turn is running. */
  working: boolean;
  /** Each thread's row state, live from the session stream. */
  states: Record<string, ThreadRowState>;
  /** Switches the hub to the child, under its own bot. */
  onOpen: (botId: string, threadId: string) => void;
}) {
  const [children, setChildren] = useState<ThreadFull[]>([]);
  const [open, setOpen] = useState(true);
  const live = useRef(true);

  const load = useCallback(() => {
    if (document.visibilityState === "hidden") return;
    getThreads().then(
      ({ threads }) => {
        if (!live.current) return;
        setChildren(
          threads
            .filter((t) => t.reportTo === jarvisThreadId)
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
        );
      },
      () => {},
    );
  }, [jarvisThreadId]);

  // Once on mount, and whenever someone comes back to the tab (shown again,
  // or its window refocused): a child may have been seen on another device,
  // or have reported, meanwhile. Seen here, the child is opened in its own
  // bot, and coming back to this Jarvis thread mounts this afresh.
  useEffect(() => {
    live.current = true;
    load();
    return () => {
      live.current = false;
    };
  }, [load]);
  useTabVisible(load);

  // Children start mid-turn, so poll only while Jarvis is working, and read
  // once more when its turn ends.
  useEffect(() => {
    if (!working) return;
    const timer = setInterval(load, POLL_MS);
    return () => {
      clearInterval(timer);
      load();
    };
  }, [working, load]);

  // A child's turn ended (or started): re-read, so its news, and so its
  // dot, is current.
  // (Not when the list itself changed: that was a read.)
  const ids = children.map((t) => t.id).join("|");
  const childKey = children.map((t) => states[t.id] ?? "").join("|");
  const lastChildKey = useRef({ ids, childKey });
  useEffect(() => {
    const last = lastChildKey.current;
    lastChildKey.current = { ids, childKey };
    if (last.ids === ids && last.childKey !== childKey) load();
  }, [ids, childKey, load]);

  if (children.length === 0) return null;

  const label = `Started ${children.length} thread${children.length === 1 ? "" : "s"}`;
  return (
    <section className={open ? "jarvis-children open" : "jarvis-children"} aria-label="Threads Jarvis started">
      <button
        type="button"
        className="jarvis-children-toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {label}
        <AnimatedActionIcon icon={ChevronDownIcon} size={14} aria-hidden="true" />
      </button>
      {open && (
        <ul className="jarvis-children-list">
          {children.map((t) => {
            const bot = bots.find((b) => b.id === t.botId);
            return (
              <li key={t.id}>
                <button
                  type="button"
                  className="jarvis-child"
                  onClick={() => onOpen(t.botId, t.id)}
                  title={`Open ${t.title}`}
                >
                  <ThreadStatus state={threadIndicator(states[t.id], { unseen: hasNews(t), lastOutcome: t.lastOutcome })} />
                  <span className="jarvis-child-copy">
                    <span className="jarvis-child-title">{t.title}</span>
                    <small>
                      {bot?.name ?? "Bot"} · {folderName(t.repoPath)}
                    </small>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
