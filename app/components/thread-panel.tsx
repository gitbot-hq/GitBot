"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { IconX } from "@tabler/icons-react";
import {
  ApiError,
  browse,
  createThread,
  type BrowseResult,
} from "../lib/api";
import type { Bot, ThreadFull } from "../lib/gitbot";

const AGENT_OPTIONS = [
  { id: "claude-code", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "opencode", label: "OpenCode" },
] as const;

// New-thread folder picker as a slide-over panel. This mirrors
// openFolderPicker from the original client verbatim — same order, same
// strings, same fallback; only the shell is ours (a panel sliding over
// the chat column instead of a centered modal, so Back closes it the way
// Back closes the bot studio).
//
// Original behavior, kept as-is:
// - A thread is pinned to a folder for its whole life, so the folder is
//   chosen up front rather than argued about later.
// - Browsing is confined to the directory the CLI was started in and
//   roams from there; "Use default" skips the choice, which leaves the
//   server to fall back to the bot's directory or its own.
// - A remembered folder can be gone or unreadable; the workspace is
//   always browsable, so fall back to it.
// - The server has the last word on whether setup is done.
export default function ThreadPanel({
  bot,
  onClose,
  onCreated,
  onSetupNeeded,
  onError,
}: {
  bot: Bot;
  onClose: () => void;
  onCreated: (thread: ThreadFull) => void;
  onSetupNeeded: (message: string) => void;
  onError: (message: string) => void;
}) {
  const [current, setCurrent] = useState<BrowseResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [agent, setAgent] = useState(bot.agent || "claude-code");
  const paneRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback((path: string | null) => {
    browse(path)
      .then((d) => {
        setCurrent(d);
        setError(null);
      })
      .catch((e) => {
        if (path) return load(null);
        setError(e instanceof Error ? e.message : String(e));
      });
  }, []);

  useEffect(() => {
    load(bot.repoPath || null);
  }, [bot.repoPath, load]);

  // The overlay is scrollable; always start a new thread at step one.
  useEffect(() => {
    paneRef.current?.parentElement?.scrollTo({ top: 0 });
  }, []);

  useEffect(() => {
    function esc(ev: KeyboardEvent) {
      if (ev.key === "Escape") onClose();
    }
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [onClose]);

  function pick(repoPath: string | null) {
    // "Run here" with nowhere loaded is a no-op in the original.
    if (repoPath && !current) return;
    createThread(bot.id, repoPath ?? undefined, agent).then(
      ({ thread }) => onCreated(thread),
      (e) => {
        if (e instanceof ApiError && e.extra?.setupRequired) {
          onSetupNeeded(e.message);
          return;
        }
        onError(e instanceof Error ? e.message : String(e));
      },
    );
  }

  return (
    <div ref={paneRef} className="thread-pane" aria-label="Create thread">
      <div className="thread-pane-inner">
        <header className="thread-pane-head">
          <div>
            <h2>Create thread</h2>
            <p>Choose a workspace and agent.</p>
          </div>
          <button
            type="button"
            className="thread-close"
            onClick={onClose}
            aria-label="Close create thread"
          >
            <IconX size={22} stroke={1.8} aria-hidden="true" />
          </button>
        </header>

        <section className="thread-step" aria-labelledby="thread-workspace-title">
          <div className="thread-step-head">
            <span className="thread-step-number" aria-hidden="true">1</span>
            <h3 id="thread-workspace-title">Choose workspace</h3>
          </div>
          {current && (
            <div className="jump-row" aria-label="Jump to">
              <JumpChip label="Workspace" path={current.workspace} active={current.path === current.workspace} onJump={load} />
              <JumpChip label="Home" path={current.home} active={current.path === current.home} onJump={load} />
              <JumpChip label="/" path="/" active={current.path === "/"} onJump={load} />
            </div>
          )}
          <p className="pathbar" title={current?.path ?? ""}>
            {current ? current.path : "…"}
          </p>
          <div className="pick-list">
            {error && <p className="chat-error">{error}</p>}
            {!error &&
              current &&
              current.parent && (
                <button
                  type="button"
                  className="thread-row pick-row"
                  onClick={() => load(current.parent)}
                >
                  ..
                </button>
              )}
            {!error &&
              current?.dirs.map((d) => (
                <button
                  key={d.path}
                  type="button"
                  className="thread-row pick-row"
                  onClick={() => load(d.path)}
                >
                  {d.name}
                </button>
              ))}
            {!error && current && !current.dirs.length && !current.parent && (
              <p className="threads-empty">No subfolders here.</p>
            )}
          </div>
        </section>

        <section className="thread-agent thread-step" aria-labelledby="thread-agent-title">
          <div className="thread-step-head">
            <span className="thread-step-number" aria-hidden="true">2</span>
            <h3 id="thread-agent-title">Choose AI</h3>
          </div>
          <div className="seg-row thread-agent-options" role="radiogroup" aria-labelledby="thread-agent-title">
            {AGENT_OPTIONS.map((option) => (
              <button
                key={option.id}
                type="button"
                role="radio"
                aria-checked={option.id === agent}
                className={option.id === agent ? "seg-btn selected" : "seg-btn"}
                onClick={() => setAgent(option.id)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </section>

        <footer className="pick-acts">
          <button
            type="button"
            className="btn-ghost"
            title="Run where the CLI was started (or the bot's directory)"
            onClick={() => pick(null)}
          >
            Use default
          </button>
          <div className="spacer" />
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-primary"
            onClick={() => current && pick(current.path)}
          >
            Create thread
          </button>
        </footer>
      </div>
    </div>
  );
}

function JumpChip({
  label,
  path,
  active,
  onJump,
}: {
  label: string;
  path: string;
  active: boolean;
  onJump: (path: string) => void;
}) {
  return (
    <button
      type="button"
      className={active ? "jump-chip selected" : "jump-chip"}
      title={path}
      aria-pressed={active}
      onClick={() => onJump(path)}
    >
      {label}
    </button>
  );
}
