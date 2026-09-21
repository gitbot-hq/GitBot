"use client";

import { useEffect, useRef, useState } from "react";
import { IconQuestionMark } from "@tabler/icons-react";
import { createBot, deleteBot, getAgents, patchBot, type BotInput } from "../lib/api";
import type { Bot } from "../lib/gitbot";
import { getAvatarPref, resolveAvatar, defaultMascotFor, type AvatarMascot, type AvatarPref } from "../lib/avatar-prefs";
import { bodies } from "./bot-maker/registry";
import { botTile, BRAND_TILES } from "./bot-avatar";
import BotFace from "./bot-face";

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

const MODEL_PLACEHOLDER: Record<string, string> = {
  "claude-code": "claude-sonnet-4-6",
  opencode: "anthropic/claude-haiku-4-5",
  codex: "blank uses Codex's default",
};

const AGENT_OPTIONS = [
  { value: "claude-code", label: "Claude Code" },
  { value: "opencode", label: "OpenCode" },
  { value: "codex", label: "Codex" },
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
export default function BotForm({
  bot,
  onClose,
  onSaved,
  onDeleted,
  onShare,
}: {
  bot: Bot | null;
  onClose: () => void;
  onSaved: (bot: Bot, pref: AvatarPref) => void;
  onDeleted: (id: string) => void;
  onShare: (bot: Bot) => void;
}) {
  const editing = !!bot;
  const [emoji, setEmoji] = useState(bot ? bot.emoji : "🤖");
  const [name, setName] = useState(bot ? bot.name : "");
  const [description, setDescription] = useState(bot ? bot.description : "");
  const [agent, setAgent] = useState(bot ? bot.agent || "claude-code" : "claude-code");
  // Agents installed on this machine; null until the server answers. A new
  // bot starts on the first one, unless the user already picked.
  const [installed, setInstalled] = useState<string[] | null>(null);
  const agentTouched = useRef(false);
  useEffect(() => {
    let alive = true;
    getAgents()
      .then(({ agents }) => {
        if (!alive) return;
        setInstalled(agents);
        if (!bot && !agentTouched.current && agents.length > 0) setAgent(agents[0]);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const agentMissing = installed !== null && installed.indexOf(agent) === -1;
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
  const [mascot, setMascot] = useState<AvatarMascot>(
    () => (bot ? resolveAvatar(getAvatarPref(bot.id), fallbackPref(bot.id)).mascot : "ghost"),
  );
  const [color, setColor] = useState<string>(
    () => (bot ? resolveAvatar(getAvatarPref(bot.id), fallbackPref(bot.id)).color : "var(--brand-sun)"),
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const studioRef = useRef<HTMLDivElement | null>(null);

  // Studio mascots watch the cursor: each followed face steers toward
  // the pointer (capped travel, eased). Reduced-motion users never opt in.
  useEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let raf = 0;
    let cx = window.innerWidth / 2;
    let cy = window.innerHeight / 2;
    const apply = () => {
      raf = 0;
      studioRef.current
        ?.querySelectorAll(".bot-avatar.follow .bot-mascot")
        .forEach((el) => {
          const r = el.getBoundingClientRect();
          const dx = (cx - (r.left + r.width / 2)) / r.width;
          const dy = (cy - (r.top + r.height / 2)) / r.height;
          const len = Math.hypot(dx, dy) || 1;
          const mag = Math.min(1, len * 1.5) * 3;
          (el as HTMLElement).style.setProperty("--px", `${((dx / len) * mag).toFixed(2)}px`);
          (el as HTMLElement).style.setProperty("--py", `${((dy / len) * mag).toFixed(2)}px`);
        });
    };
    const onMove = (e: MouseEvent) => {
      cx = e.clientX;
      cy = e.clientY;
      if (!raf) raf = requestAnimationFrame(apply);
    };
    window.addEventListener("mousemove", onMove);
    return () => {
      window.removeEventListener("mousemove", onMove);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

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

  return (
    <div className="modal inline" aria-label={editing ? "Edit bot" : "New bot"}>
      <div className="modal-head">
        <h2>{editing ? "Edit bot" : "New bot"}</h2>
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
            <select
              value={agent}
              onChange={(e) => {
                agentTouched.current = true;
                setAgent(e.target.value);
              }}
            >
              {AGENT_OPTIONS.map((a) => {
                const missing = installed !== null && installed.indexOf(a.value) === -1;
                return (
                  // A missing agent stays selectable only while it is the current
                  // value, so an imported bot shows what it was built for.
                  <option key={a.value} value={a.value} disabled={missing && a.value !== agent}>
                    {missing ? `${a.label} (not installed)` : a.label}
                  </option>
                );
              })}
            </select>
            {agent === "opencode" && model.trim().indexOf("/") === -1 && (
              <small className="field-warn">
                OpenCode needs a model as provider/model (under Advanced), e.g.
                anthropic/claude-haiku-4-5. Without one it uses its free model, which
                refuses requests from gitbot.
              </small>
            )}
            {agentMissing && (
              <small className="field-warn">
                Not installed on this machine — this bot cannot run until it is.
              </small>
            )}
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
          <details className="advanced">
            <summary>Advanced</summary>
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
                placeholder={MODEL_PLACEHOLDER[agent] ?? ""}
              />
            </Field>
            <Field
              label="Allowed tools"
              tip="comma-separated; the only tools this bot can use — blank means all. Setup runs are not limited."
            >
              <input
                value={allowedTools}
                onChange={(e) => setAllowedTools(e.target.value)}
                placeholder="Read, Grep, Edit, Bash"
              />
              {agent === "codex" && allowedTools.trim() && (
                <small className="field-warn">
                  Codex cannot limit its tools, so this list is ignored for this bot. Use
                  Claude Code or OpenCode if the limit matters.
                </small>
              )}
            </Field>
          </details>
          {error && <p className="chat-error">{error}</p>}
          <div className="acts">
            {editing && bot && (
              <button type="button" className="btn-ghost" disabled={busy} onClick={() => onShare(bot)}>
                Share
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
  );
}
