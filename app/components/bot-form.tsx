"use client";

import { useEffect, useState } from "react";
import { createBot, deleteBot, patchBot, type BotInput } from "../lib/api";
import type { Bot } from "../lib/gitbot";

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string | null;
  children: React.ReactNode;
}) {
  return (
    <div className="field">
      <label>
        {label}
        {hint ? <span className="hint"> {hint}</span> : null}
      </label>
      {children}
    </div>
  );
}

// New bot / Edit bot as an inline studio pane (not a modal).
// Labels, hints, and placeholders are the original's words verbatim.
export default function BotForm({
  bot,
  onClose,
  onSaved,
  onDeleted,
  onShare,
}: {
  bot: Bot | null;
  onClose: () => void;
  onSaved: (bot: Bot) => void;
  onDeleted: (id: string) => void;
  onShare: (bot: Bot) => void;
}) {
  const editing = !!bot;
  const [emoji, setEmoji] = useState(bot ? bot.emoji : "🤖");
  const [name, setName] = useState(bot ? bot.name : "");
  const [description, setDescription] = useState(bot ? bot.description : "");
  const [agent, setAgent] = useState(bot ? bot.agent || "claude-code" : "codex");
  const [instructions, setInstructions] = useState(bot ? bot.instructions : "");
  const [setupInstructions, setSetupInstructions] = useState(bot ? bot.setupInstructions || "" : "");
  const [repoPath, setRepoPath] = useState(bot ? bot.repoPath || "" : "");
  const [model, setModel] = useState(bot ? bot.model || "" : "");
  const [permissionMode, setPermissionMode] = useState(
    bot ? bot.permissionMode : "ask-permissions",
  );
  const [allowedTools, setAllowedTools] = useState(
    bot && bot.allowedTools ? bot.allowedTools.join(", ") : "",
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    function esc(ev: KeyboardEvent) {
      if (ev.key === "Escape") onClose();
    }
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [onClose]);

  function body(): BotInput {
    const tools = allowedTools
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    return {
      name: name.trim(),
      emoji: emoji.trim() || "🤖",
      description: description.trim(),
      agent,
      instructions,
      setupInstructions: setupInstructions.trim() || undefined,
      repoPath: repoPath.trim() || undefined,
      model: model.trim() || undefined,
      permissionMode,
      allowedTools: tools.length ? tools : undefined,
    };
  }

  function save() {
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    const req = editing && bot ? patchBot(bot.id, body()) : createBot(body());
    req.then(
      (d) => onSaved(d.bot),
      (e) => {
        setBusy(false);
        setError(e instanceof Error ? e.message : "Save failed");
      },
    );
  }

  function remove() {
    if (!bot) return;
    if (!confirm(`Delete ${bot.name} and all of its threads?`)) return;
    setBusy(true);
    deleteBot(bot.id).then(
      () => onDeleted(bot.id),
      (e) => {
        setBusy(false);
        setError(e instanceof Error ? e.message : "Delete failed");
      },
    );
  }

  return (
    <div className="modal inline" aria-label={editing ? "Edit bot" : "New bot"}>
      <div className="modal-head">
        <h2>{editing ? "Edit bot" : "New bot"}</h2>
      </div>
        <Field label="Name">
          <div className="row2">
            <input
              value={emoji}
              onChange={(e) => setEmoji(e.target.value)}
              aria-label="Emoji"
              className="emoji"
            />
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Doc Spot"
              aria-label="Name"
            />
          </div>
        </Field>
        <Field label="Description" hint="one line, shown on the card">
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Keeps documentation in sync with the code"
          />
        </Field>
        <Field label="Agent" hint="the coding harness that runs this bot">
          <select value={agent} onChange={(e) => setAgent(e.target.value)}>
            <option value="claude-code">Claude Code</option>
            <option value="codex">Codex</option>
            <option value="opencode">OpenCode</option>
          </select>
        </Field>
        <Field label="Instructions" hint="appended to the selected agent's system prompt">
          <textarea
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            placeholder="You keep documentation in sync with the code. On each run, read the latest commit and update the docs it affects."
          />
        </Field>
        <Field label="Setup instructions" hint="run once per machine — blank means no setup">
          <textarea
            value={setupInstructions}
            onChange={(e) => setSetupInstructions(e.target.value)}
            placeholder="This bot needs ffmpeg on PATH. Check for it and install it with the machine's package manager if it is missing."
          />
        </Field>
        <Field label="Working directory" hint="default for new threads">
          <input
            value={repoPath}
            onChange={(e) => setRepoPath(e.target.value)}
            placeholder="blank uses the server's directory"
          />
        </Field>
        <Field label="Model" hint="optional">
          <input
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="claude-sonnet-4-6"
          />
        </Field>
        <Field label="Permissions">
          <select value={permissionMode} onChange={(e) => setPermissionMode(e.target.value)}>
            <option value="ask-permissions">Ask before each tool</option>
            <option value="auto-approve">Auto-approve tools</option>
            <option value="plan">Plan only (no edits)</option>
          </select>
        </Field>
        <Field label="Allowed tools" hint="comma-separated; blank means all">
          <input
            value={allowedTools}
            onChange={(e) => setAllowedTools(e.target.value)}
            placeholder="Read, Grep, Edit, Bash"
          />
        </Field>
        {error && <p className="chat-error">{error}</p>}
        <div className="acts">
          {editing && bot && (
            <button type="button" className="btn" disabled={busy} onClick={() => onShare(bot)}>
              Share
            </button>
          )}
          {editing && (
            <button type="button" className="btn danger" disabled={busy} onClick={remove}>
              Delete
            </button>
          )}
          <div className="spacer" />
          <button type="button" className="btn" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={busy || !name.trim()}
            onClick={save}
          >
            {editing ? "Save" : "Create bot"}
          </button>
        </div>
    </div>
  );
}
