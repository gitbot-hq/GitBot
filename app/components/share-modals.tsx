"use client";

import { useEffect, useState } from "react";
import { IconX } from "@tabler/icons-react";
import { parseShare, shareCode, sharePrefix } from "../lib/share";
import type { Bot } from "../lib/gitbot";

function Shell({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    function esc(ev: KeyboardEvent) {
      if (ev.key === "Escape") onClose();
    }
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [onClose]);
  return (
    <div className="backdrop">
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button type="button" className="modal-x" onClick={onClose} aria-label="Close">
            <IconX size={18} stroke={2} aria-hidden="true" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

// Share {name}. Copy verbatim from the original.
export function ShareModal({ bot, onClose }: { bot: Bot; onClose: () => void }) {
  const [blocked, setBlocked] = useState(false);
  const code = shareCode(bot as unknown as Record<string, unknown>);
  useEffect(() => {
    navigator.clipboard?.writeText?.(code).catch(() => setBlocked(true));
  }, [code]);
  return (
    <Shell title={`Share ${bot.name}`} onClose={onClose}>
      {blocked && (
        <p className="chat-error">
          Copying was blocked by the browser. Copy this code and paste it into another gitbot.
        </p>
      )}
      <div className="field">
        <textarea
          className="code"
          readOnly
          value={code}
          onFocus={(e) => e.target.select()}
          aria-label="Share code"
        />
      </div>
      <div className="acts">
        <div className="spacer" />
        <button type="button" className="btn-primary" onClick={onClose}>
          Done
        </button>
      </div>
    </Shell>
  );
}

// Import a bot. Copy verbatim from the original.
export function ImportModal({
  onClose,
  onAdd,
}: {
  onClose: () => void;
  onAdd: (bot: Record<string, unknown>) => void;
}) {
  const [text, setText] = useState("");
  const parsed = text.trim() ? parseShare(text) : null;
  const bad = text.trim() !== "" && !parsed;
  return (
    <Shell title="Import a bot" onClose={onClose}>
      <div className="field">
        <label>
          Share code<span className="hint"> paste what someone shared with you</span>
        </label>
        <textarea
          className="code"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={`${sharePrefix()}…`}
          aria-label="Share code"
        />
      </div>
      {parsed && (
        <div className="preview">
          <div className="nm">{String(parsed.name)}</div>
          <div className="ds">{String(parsed.description || "No description.")}</div>
          {typeof parsed.setupInstructions === "string" && parsed.setupInstructions.trim() !== "" && (
            <div className="ds">Needs setup on this machine — a setup thread starts when you add it.</div>
          )}
        </div>
      )}
      {bad && <div className="preview"><div className="bad">That does not look like a bot share code.</div></div>}
      <div className="acts">
        <div className="spacer" />
        <button type="button" className="btn-secondary" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="btn-primary"
          disabled={!parsed}
          onClick={() => parsed && onAdd(parsed)}
        >
          Add bot
        </button>
      </div>
    </Shell>
  );
}
