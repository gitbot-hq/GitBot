"use client";

import { useEffect, useRef, useState } from "react";
import { IconQuestionMark } from "@tabler/icons-react";
import { PanelBack, CloseButton } from "./panel-controls";
import { createBot, deleteBot, patchBot, type BotInput } from "../lib/api";
import type { Bot } from "../lib/gitbot";
import { getAvatarPref, resolveAvatar, defaultMascotFor, type AvatarMascot, type AvatarPref } from "../lib/avatar-prefs";
import { bodies } from "./bot-maker/registry";
import { botTile, BRAND_TILES } from "./bot-avatar";
import BotFace from "./bot-face";
import BotName from "./bot-name";
import { useMascotPointerFollow } from "../lib/use-mascot-pointer-follow";

function Field({
  label,
  tip,
  children,
}: {
  label: string;
  tip?: string | null;
  children: React.ReactNode;
}) {
  return (
    <div className="field">
      <label>
        {label}
        {tip ? (
          <span className="tip" tabIndex={0} aria-label={tip}>
            <IconQuestionMark size={10} stroke={2.5} aria-hidden="true" />
            <span className="tip-bubble" role="tooltip">
              {tip}
            </span>
          </span>
        ) : null}
      </label>
      {children}
    </div>
  );
}

const MASCOT_OPTIONS = bodies.map((b) => b.id);
const BODY_LABELS: Record<string, string> = Object.fromEntries(
  bodies.map((b) => [b.id, b.label]),
);

const AGENT_OPTIONS = [
  { id: "claude-code", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "opencode", label: "OpenCode" },
];

function fallbackPref(id: string): AvatarPref {
  return {
    mascot: defaultMascotFor(id),
    color: botTile(id),
  };
}

// New bot / Edit bot as a two-panel studio: live preview with mascot +
// color pickers on the left, a progressive form on the right (essentials
// first, power settings behind Advanced). Labels, hints, and
// placeholders are the original's words verbatim.
//
// Bot switching: app-shell sets `switchTo` when the user picks another bot
// mid-edit. If the form is clean the switch applies straight through;
// if dirty a guard dialog offers Save / Discard / Cancel.
export default function BotForm({
  bot,
  onClose,
  onSaved,
  onDeleted,
  onShare,
  switchTo,
  onSwitched,
  onSwitchDiscard,
  onSwitchCancel,
  active = true,
}: {
  bot: Bot | null;
  active?: boolean;
  onClose: () => void;
  onSaved: (bot: Bot, pref: AvatarPref) => void;
  onDeleted: (id: string) => void;
  onShare: (bot: Bot) => void;
  /** Pending bot-switch target from the sidebar; null when none.
   *  Optional — only the main shell drives switches. */
  switchTo?: Bot | null;
  /** A guarded save completed — list is fresh, apply the switch. */
  onSwitched?: (bot: Bot, pref: AvatarPref) => void;
  /** Apply the pending switch without saving (clean form or Discard). */
  onSwitchDiscard?: () => void;
  /** User cancelled the switch — stay on this bot. */
  onSwitchCancel?: () => void;
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
    bot ? bot.permissionMode : "auto-approve",
  );
  const [allowedTools, setAllowedTools] = useState(
    bot && bot.allowedTools ? bot.allowedTools.join(", ") : "",
  );
  const [mascot, setMascot] = useState<AvatarMascot>(
    () => (bot ? resolveAvatar(getAvatarPref(bot.id), fallbackPref(bot.id)).mascot : "ghost"),
  );
  const [color, setColor] = useState<string>(
    () => (bot ? resolveAvatar(getAvatarPref(bot.id), fallbackPref(bot.id)).color : "var(--brand-sun)"),
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [guard, setGuard] = useState(false);
  const studioRef = useRef<HTMLDivElement | null>(null);
  useMascotPointerFollow({ root: studioRef });

  // Snapshot of the opened bot (or blank defaults for "new") — the guard
  // compares live field state against this.
  const initial = useRef({
    emoji, name, description, agent, instructions, setupInstructions,
    repoPath, model, permissionMode, allowedTools, mascot, color,
  });

  function isDirty(): boolean {
    const s = initial.current;
    return (
      emoji !== s.emoji ||
      name !== s.name ||
      description !== s.description ||
      agent !== s.agent ||
      instructions !== s.instructions ||
      setupInstructions !== s.setupInstructions ||
      repoPath !== s.repoPath ||
      model !== s.model ||
      permissionMode !== s.permissionMode ||
      allowedTools !== s.allowedTools ||
      mascot !== s.mascot ||
      color !== s.color
    );
  }

  // A sidebar switch request lands here: clean forms pass through, dirty
  // ones raise the guard dialog. No-ops when the host doesn't drive
  // switches (legacy/demo surfaces).
  useEffect(() => {
    if (!switchTo) return;
    if (isDirty()) setGuard(true);
    else onSwitchDiscard?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [switchTo]);

  useEffect(() => {
    function esc(ev: KeyboardEvent) {
      if (ev.key === "Escape" && !guard && active) onClose();
    }
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [guard, active, onClose]);

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
    const pref = { mascot, color };
    const req = editing && bot ? patchBot(bot.id, body()) : createBot(body());
    req.then(
      (d) => onSaved(d.bot, pref),
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

  /** Guard "Save": persist this bot, then hand the fresh record to the
   *  pending sidebar switch. */
  function guardSave() {
    if (!name.trim()) {
      setError("Name your bot before saving.");
      return;
    }
    setBusy(true);
    setError(null);
    const pref = { mascot, color };
    const req = editing && bot ? patchBot(bot.id, body()) : createBot(body());
    req.then(
      (d) => {
        setBusy(false);
        setGuard(false);
        onSwitched?.(d.bot, pref);
      },
      (e) => {
        setBusy(false);
        setError(e instanceof Error ? e.message : "Save failed");
      },
    );
  }

  function cancelGuard() {
    setGuard(false);
    onSwitchCancel?.();
  }

  function discardGuard() {
    setGuard(false);
    onSwitchDiscard?.();
  }

  // Guard Escape closes the dialog (stays in the editor); the form-level
  // Escape above already stands down while the guard is open.
  useEffect(() => {
    if (!guard || !active) return;
    function esc(ev: KeyboardEvent) {
      if (ev.key === "Escape") cancelGuard();
    }
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guard, active]);

  return (
    <>
    <PanelBack onClick={onClose} disabled={busy} />
    <div className="modal inline" aria-label={editing ? "Edit bot" : "Create bot"}>
      {guard && switchTo && (
        <div className="backdrop" onClick={(event) => { if (event.target === event.currentTarget && !busy) cancelGuard(); }}>
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label="Unsaved changes"
          >
            <div className="modal-head">
              <h2>Unsaved changes</h2>
              <CloseButton disabled={busy} onClick={cancelGuard} />
            </div>
            <p className="guard-text">
              {editing && bot ? <BotName color={color}>{bot.name}</BotName> : "Your new bot"} has unsaved
              changes. Save them before switching to{" "}
              <BotName color={resolveAvatar(getAvatarPref(switchTo.id), fallbackPref(switchTo.id)).color}>
                {switchTo.name}
              </BotName>?
            </p>
            {error && <p className="chat-error">{error}</p>}
            <div className="acts">
              <button
                type="button"
                className="btn-danger"
                disabled={busy}
                onClick={discardGuard}
              >
                Discard
              </button>
              <div className="spacer" />
              <button
                type="button"
                className="btn-secondary"
                disabled={busy}
                onClick={cancelGuard}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn-primary"
                disabled={busy}
                onClick={guardSave}
              >
                Save changes
              </button>
            </div>
          </div>
        </div>
      )}
      <div className="modal-head">
        <h2>{editing ? "Edit bot" : "Create bot"}</h2>
      </div>
      <div className="studio" ref={studioRef}>
        <div className="studio-side">
          <div className="studio-preview">
            <BotFace mascot={mascot} size={112} color={color} ambient={false} follow />
            <b>{name.trim() || "Name your bot"}</b>
            <small>{description.trim() || "One line about what it does"}</small>
          </div>
          <p className="pick-label">Mascot</p>
          <div className="pick-grid" role="radiogroup" aria-label="Mascot">
            {MASCOT_OPTIONS.map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={m === mascot}
                aria-label={`Mascot ${BODY_LABELS[m] ?? m}`}
                className={m === mascot ? "pick-tile selected" : "pick-tile"}
                onClick={() => setMascot(m)}
              >
                <BotFace mascot={m} size={44} color={color} ambient={false} follow still />
              </button>
            ))}
          </div>
          <p className="pick-label">Color</p>
          <div className="swatches" role="radiogroup" aria-label="Color">
            {BRAND_TILES.map((tile) => (
              <button
                key={tile}
                type="button"
                role="radio"
                aria-checked={tile === color}
                aria-label={tile}
                className={tile === color ? "swatch selected" : "swatch"}
                style={{ background: tile }}
                onClick={() => setColor(tile)}
              />
            ))}
          </div>
        </div>
        <div className="studio-main">
        <Field label="Name">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Doc Spot"
            aria-label="Name"
          />
        </Field>
          <Field label="Description" tip="one line, shown on the card">
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Keeps documentation in sync with the code"
            />
          </Field>
          <Field label="Agent" tip="the coding harness that runs this bot">
            <div className="seg-row" role="radiogroup" aria-label="Agent">
              {AGENT_OPTIONS.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  role="radio"
                  aria-checked={a.id === agent}
                  className={a.id === agent ? "seg-btn selected" : "seg-btn"}
                  onClick={() => setAgent(a.id)}
                >
                  {a.label}
                </button>
              ))}
            </div>
          </Field>
          <Field label="Instructions" tip="appended to the selected agent's system prompt">
            <textarea
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder="You keep documentation in sync with the code. On each run, read the latest commit and update the docs it affects."
            />
          </Field>
          <Field label="Permissions">
            <select value={permissionMode} onChange={(e) => setPermissionMode(e.target.value)}>
              <option value="ask-permissions">Ask before each tool</option>
              <option value="auto-approve">Auto-approve tools</option>
              <option value="plan">Plan only (no edits)</option>
            </select>
          </Field>
          <Field label="Setup instructions" tip="run once per machine — blank means no setup">
            <textarea
              value={setupInstructions}
              onChange={(e) => setSetupInstructions(e.target.value)}
              placeholder="This bot needs ffmpeg on PATH. Check for it and install it with the machine's package manager if it is missing."
            />
          </Field>
          <Field label="Working directory" tip="default for new threads">
            <input
              value={repoPath}
              onChange={(e) => setRepoPath(e.target.value)}
              placeholder="blank uses the server's directory"
            />
          </Field>
          <Field label="Model" tip="optional">
            <input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="claude-sonnet-4-6"
            />
          </Field>
          <Field label="Allowed tools" tip="comma-separated; blank means all">
            <input
              value={allowedTools}
              onChange={(e) => setAllowedTools(e.target.value)}
              placeholder="Read, Grep, Edit, Bash"
            />
          </Field>
          {error && <p className="chat-error">{error}</p>}
          <div className="acts">
            {editing && bot && (
              <button type="button" className="btn-ghost" disabled={busy} onClick={() => onShare(bot)}>
                Share bot
              </button>
            )}
            {editing && (
              <button type="button" className="btn-danger" disabled={busy} onClick={remove}>
                Delete
              </button>
            )}
            <div className="spacer" />
            <button type="button" className="btn-secondary" disabled={busy} onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={busy || !name.trim()}
              onClick={save}
            >
              {editing ? "Save" : "Create bot"}
            </button>
          </div>
        </div>
      </div>
    </div>
    </>
  );
}
