"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  IconArrowUp,
  IconBriefcase,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconChevronUp,
  IconDeviceDesktop,
  IconFolder,
  IconFolderOpen,
  IconHome,
} from "@tabler/icons-react";
import { PanelBack } from "./panel-controls";
import BotFace from "./bot-face";
import BotName from "./bot-name";
import { botTile } from "./bot-avatar";
import {
  ApiError,
  browse,
  createThread,
  type BrowseResult,
} from "../lib/api";
import type { Bot, ThreadFull } from "../lib/gitbot";
import { defaultMascotFor, type AvatarPref } from "../lib/avatar-prefs";

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
  botAvatar,
  onClose,
  onCreated,
  onSetupNeeded,
  onError,
  active = true,
}: {
  bot: Bot;
  botAvatar?: AvatarPref;
  active?: boolean;
  onClose: () => void;
  onCreated: (thread: ThreadFull) => void;
  onSetupNeeded: (message: string) => void;
  onError: (message: string) => void;
}) {
  const avatar = botAvatar ?? {
    mascot: defaultMascotFor(bot.id),
    color: botTile(bot.id),
  };
  const [current, setCurrent] = useState<BrowseResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [agent, setAgent] = useState(bot.agent || "claude-code");
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [folderBrowserOpen, setFolderBrowserOpen] = useState(false);
  const paneRef = useRef<HTMLDivElement | null>(null);
  const loadRequest = useRef(0);

  const load = useCallback((path: string | null) => {
    const request = ++loadRequest.current;
    setLoading(true);
    setError(null);
    browse(path)
      .then((d) => {
        if (request !== loadRequest.current) return;
        setCurrent(d);
        setError(null);
      })
      .catch((e) => {
        if (request !== loadRequest.current) return;
        if (path) return load(null);
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (request === loadRequest.current) setLoading(false);
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
      if (active && ev.key === "Escape") onClose();
    }
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [active, onClose]);

  function pick(repoPath: string | null) {
    // "Run here" with nowhere loaded is a no-op in the original.
    if (creating || (repoPath && !current)) return;
    setCreating(true);
    createThread(bot.id, repoPath ?? undefined, agent).then(
      ({ thread }) => onCreated(thread),
      (e) => {
        setCreating(false);
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
      <PanelBack onClick={onClose} />
      <div className="thread-pane-inner">
        <header className="thread-pane-head">
          <BotFace mascot={avatar.mascot} color={avatar.color} size={64} ambient={false} still />
          <div className="thread-pane-head-copy">
            <p className="thread-pane-kicker">Create thread</p>
            <h2>
              What should <BotName color={avatar.color}>{bot.name}</BotName> work on?
            </h2>
            <p>Choose a workspace and AI to get started.</p>
          </div>
        </header>

        <section className="thread-step" aria-labelledby="thread-workspace-title">
          <div className="thread-step-head">
            <span className="thread-step-number" aria-hidden="true">1</span>
            <div>
              <h3 id="thread-workspace-title">Choose workspace</h3>
              <p>Select a folder on this computer for the thread to work in.</p>
            </div>
          </div>
          <p className="thread-local-note">
            <IconDeviceDesktop size={17} stroke={1.7} aria-hidden="true" />
            <span>These are files and folders on your computer. GitBot uses the selected folder as this thread&apos;s working context.</span>
          </p>
          <div className="thread-folder-picker">
            <button
              type="button"
              className="pathbar"
              title={current?.path ?? ""}
              aria-expanded={folderBrowserOpen}
              disabled={!current || loading}
              onClick={() => setFolderBrowserOpen((open) => !open)}
            >
              <span className="pathbar-icon" aria-hidden="true"><IconFolderOpen size={18} stroke={1.7} /></span>
              <span className="pathbar-copy">
                <span className="pathbar-label">Selected folder</span>
                <span className="pathbar-value">{current ? current.path : "…"}</span>
              </span>
              {current && !loading && <IconCheck className="pathbar-check" size={17} stroke={2} aria-hidden="true" />}
              <span className="pathbar-action">{folderBrowserOpen ? "Hide folders" : "Change folder"}</span>
              {folderBrowserOpen
                ? <IconChevronUp className="pathbar-chevron" size={17} stroke={1.7} aria-hidden="true" />
                : <IconChevronDown className="pathbar-chevron" size={17} stroke={1.7} aria-hidden="true" />}
            </button>
            {folderBrowserOpen && (
              <div className="folder-browser-body">
                {current && (
                  <div className="jump-row" aria-label="Jump to">
                    <JumpChip icon={<IconBriefcase size={18} stroke={1.7} />} label="Workspace" hint="Current project" path={current.workspace} active={current.path === current.workspace} disabled={loading} onJump={load} />
                    <JumpChip icon={<IconHome size={18} stroke={1.7} />} label="Home" hint="Your personal files" path={current.home} active={current.path === current.home} disabled={loading} onJump={load} />
                    <JumpChip icon={<IconDeviceDesktop size={18} stroke={1.7} />} label="Computer" hint="Top level (/)" path="/" active={current.path === "/"} disabled={loading} onJump={load} />
                  </div>
                )}
                <div className={loading ? "pick-list is-loading" : "pick-list"} aria-busy={loading}>
                  <div className="pick-list-head">
                    <span>Folders</span>
                    {loading && <span className="pick-loading" role="status">Opening…</span>}
                  </div>
                  {error && <p className="chat-error">{error}</p>}
                  {!error && current && current.parent && (
                    <button
                      type="button"
                      className="thread-row pick-row"
                      disabled={loading}
                      onClick={() => load(current.parent)}
                    >
                      <span className="pick-row-icon" aria-hidden="true"><IconArrowUp size={18} stroke={1.7} /></span>
                      <span className="pick-row-name">..</span>
                    </button>
                  )}
                  {!error && current?.dirs.map((d) => (
                    <button
                      key={d.path}
                      type="button"
                      className="thread-row pick-row"
                      disabled={loading}
                      onClick={() => load(d.path)}
                    >
                      <span className="pick-row-icon" aria-hidden="true"><IconFolder size={18} stroke={1.7} /></span>
                      <span className="pick-row-name">{d.name}</span>
                      <IconChevronRight className="pick-row-arrow" size={17} stroke={1.7} aria-hidden="true" />
                    </button>
                  ))}
                  {!error && current && !current.dirs.length && (
                    <p className="pick-empty">No subfolders here.</p>
                  )}
                </div>
              </div>
            )}
          </div>
        </section>

        <section className="thread-agent thread-step" aria-labelledby="thread-agent-title">
          <div className="thread-step-head">
            <span className="thread-step-number" aria-hidden="true">2</span>
            <div>
              <h3 id="thread-agent-title">Choose AI</h3>
              <p>You can use a different agent for each thread.</p>
            </div>
          </div>
          <div className="thread-agent-options" role="radiogroup" aria-labelledby="thread-agent-title">
            {AGENT_OPTIONS.map((option) => (
              <label
                key={option.id}
                className={option.id === agent ? "thread-agent-option selected" : "thread-agent-option"}
              >
                <input
                  type="radio"
                  name="thread-agent"
                  value={option.id}
                  checked={option.id === agent}
                  disabled={creating}
                  onChange={() => setAgent(option.id)}
                />
                <span className="thread-agent-radio" aria-hidden="true" />
                <span>{option.label}</span>
              </label>
            ))}
          </div>
        </section>

        <footer className="pick-acts">
          <button
            type="button"
            className="btn-ghost"
            title="Run where the CLI was started (or the bot's directory)"
            disabled={creating}
            onClick={() => pick(null)}
          >
            Use default
          </button>
          <div className="spacer" />
          <button type="button" className="btn-secondary" disabled={creating} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={!current || loading || creating}
            onClick={() => current && pick(current.path)}
          >
            {creating ? "Creating…" : "Create thread"}
          </button>
        </footer>
      </div>
    </div>
  );
}

function JumpChip({
  icon,
  label,
  hint,
  path,
  active,
  disabled,
  onJump,
}: {
  icon: ReactNode;
  label: string;
  hint: string;
  path: string;
  active: boolean;
  disabled: boolean;
  onJump: (path: string) => void;
}) {
  return (
    <button
      type="button"
      className={active ? "jump-chip selected" : "jump-chip"}
      title={path}
      aria-pressed={active}
      disabled={disabled}
      onClick={() => onJump(path)}
    >
      <span className="jump-chip-icon" aria-hidden="true">{icon}</span>
      <span className="jump-chip-copy">
        <strong>{label}</strong>
        <small>{hint}</small>
      </span>
      {active && <IconCheck className="jump-chip-check" size={16} stroke={2} aria-hidden="true" />}
    </button>
  );
}
