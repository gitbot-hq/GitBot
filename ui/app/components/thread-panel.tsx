"use client";

import { useCallback, useEffect, useState } from "react";
import { IconArrowLeft } from "@tabler/icons-react";
import {
  ApiError,
  browse,
  createThread,
  type BrowseResult,
} from "../lib/api";
import type { Bot, ThreadFull } from "../lib/gitbot";

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
    createThread(bot.id, repoPath ?? undefined).then(
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
    <div className="thread-pane" aria-label="Where should this thread run?">
      <button type="button" className="back-btn" onClick={onClose}>
        <IconArrowLeft size={16} stroke={2} aria-hidden="true" />
        Back
      </button>
      <div className="thread-pane-inner">
      <h2>Where should this thread run?</h2>
      {current && (
        <div className="jump-row" aria-label="Jump to">
          <JumpChip label="Workspace" path={current.workspace} onJump={load} />
          <JumpChip label="Home" path={current.home} onJump={load} />
          <JumpChip label="/" path="/" onJump={load} />
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
              <span aria-hidden="true">{"\u2191"}</span>
              <span>..</span>
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
              <span aria-hidden="true">{"\u{1F4C1}"}</span>
              <span>{d.name}</span>
            </button>
          ))}
        {!error && current && !current.dirs.length && !current.parent && (
          <p className="threads-empty">No subfolders here.</p>
        )}
      </div>
      <div className="pick-acts">
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
          Run here
        </button>
      </div>
      </div>
    </div>
  );
}

function JumpChip({
  label,
  path,
  onJump,
}: {
  label: string;
  path: string;
  onJump: (path: string) => void;
}) {
  return (
    <button
      type="button"
      className="jump-chip"
      title={path}
      onClick={() => onJump(path)}
    >
      {label}
    </button>
  );
}
