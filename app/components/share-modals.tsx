"use client";

import AnimatedActionIcon from "./animated-action-icon";
import { ArrowRightIcon } from "@animateicons/react/lucide/arrow-right-icon";
import { CheckIcon } from "@animateicons/react/lucide/check-icon";
import { CodeIcon } from "@animateicons/react/lucide/code-icon";
import { CopyIcon } from "@animateicons/react/lucide/copy-icon";
import { StoreIcon } from "@animateicons/react/lucide/store-icon";

import { useEffect, useState } from "react";

import { BackButton, CloseButton } from "./panel-controls";
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
          <CloseButton onClick={onClose} />
        </div>
        {children}
      </div>
    </div>
  );
}

// Sharing is explicit: opening the dialog never changes the clipboard.
export function ShareModal({
  bot,
  onClose,
  initialView = "options",
}: {
  bot: Bot;
  onClose: () => void;
  initialView?: "options" | "code";
}) {
  const [view, setView] = useState<"options" | "code">(initialView);
  const [blocked, setBlocked] = useState(false);
  const [copiedCode, setCopiedCode] = useState<string | null>(null);
  const code = shareCode(bot as unknown as Record<string, unknown>);
  async function copyCode() {
    setBlocked(false);
    try {
      await navigator.clipboard.writeText(code);
      setCopiedCode(code);
    } catch {
      setCopiedCode(null);
      setBlocked(true);
    }
  }
  return (
    <Shell title={`Share ${bot.name}`} onClose={onClose}>
      {view === "options" ? (
        <>
          <p className="share-intro">Choose how you want to share this bot.</p>
          <div className="share-methods">
            <button type="button" className="share-method" onClick={() => setView("code")} autoFocus>
              <span className="share-method-icon" aria-hidden="true">
                <AnimatedActionIcon icon={CodeIcon} size={19} />
              </span>
              <span className="share-method-copy">
                <strong>Share with code</strong>
                <span>Copy a private code someone else can use to import the bot.</span>
              </span>
              <AnimatedActionIcon icon={ArrowRightIcon} className="share-method-arrow" size={17} aria-hidden="true" />
            </button>
            <button type="button" className="share-method" disabled aria-describedby="marketplace-share-status">
              <span className="share-method-icon" aria-hidden="true">
                <AnimatedActionIcon icon={StoreIcon} size={19} />
              </span>
              <span className="share-method-copy">
                <span className="share-method-title">
                  <strong>Publish to Marketplace</strong>
                  <span className="share-method-status" id="marketplace-share-status">Coming soon</span>
                </span>
                <span>Make your bot discoverable by the GitBot community.</span>
              </span>
            </button>
          </div>
        </>
      ) : (
        <>
          <BackButton className="share-flow-back" onClick={() => setView("options")}>Sharing options</BackButton>
          {blocked && (
            <p className="chat-error" role="alert">
              Copying was blocked by the browser. Select the code below and copy it manually.
            </p>
          )}
          <div className="field share-code-field">
            <label htmlFor="bot-share-code">Share code</label>
            <textarea
              id="bot-share-code"
              className="code"
              readOnly
              value={code}
              onFocus={(e) => e.target.select()}
              aria-label="Share code"
            />
          </div>
          <p className="copy-status" role="status">{copiedCode === code ? "Code copied to clipboard" : "Anyone with this code can import the bot. Chat history is not included."}</p>
          <div className="acts">
            <div className="spacer" />
            <button type="button" className="btn-primary" onClick={copyCode}>
              {copiedCode === code ? <AnimatedActionIcon icon={CheckIcon} size={16} aria-hidden="true" /> : <AnimatedActionIcon icon={CopyIcon} size={16} aria-hidden="true" />}
              {copiedCode === code ? "Copied" : "Copy code"}
            </button>
            <button type="button" className="btn-secondary" onClick={onClose}>
              Done
            </button>
          </div>
        </>
      )}
    </Shell>
  );
}

// Import bot. Copy verbatim from the original.
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
    <Shell title="Import bot" onClose={onClose}>
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
          Import bot
        </button>
      </div>
    </Shell>
  );
}
