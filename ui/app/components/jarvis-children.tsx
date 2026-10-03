"use client";

import AnimatedActionIcon from "./animated-action-icon";
import { ChevronDownIcon } from "@animateicons/react/lucide/chevron-down-icon";
import { useEffect, useState } from "react";
import { getThreads } from "../lib/api";
import type { Bot, ThreadFull } from "../lib/gitbot";

/** How often the list is re-read while open: Jarvis starts children mid-turn. */
const POLL_MS = 4000;

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
  onOpen,
}: {
  jarvisThreadId: string;
  bots: Bot[];
  /** Switches the hub to the child, under its own bot. */
  onOpen: (botId: string, threadId: string) => void;
}) {
  const [children, setChildren] = useState<ThreadFull[]>([]);
  const [open, setOpen] = useState(true);

  useEffect(() => {
    let live = true;
    setChildren([]);
    const load = () => {
      if (document.visibilityState === "hidden") return;
      getThreads().then(
        ({ threads }) => {
          if (!live) return;
          setChildren(
            threads
              .filter((t) => t.reportTo === jarvisThreadId)
              .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
          );
        },
        () => {},
      );
    };
    load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [jarvisThreadId]);

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
                  <span className="jarvis-child-title">{t.title}</span>
                  <small>
                    {bot?.name ?? "Bot"} · {folderName(t.repoPath)}
                  </small>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
