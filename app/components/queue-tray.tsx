"use client";

import AnimatedActionIcon from "./animated-action-icon";
import { ArrowRightIcon } from "@animateicons/react/lucide/arrow-right-icon";
import { CheckIcon } from "@animateicons/react/lucide/check-icon";
import { CopyIcon } from "@animateicons/react/lucide/copy-icon";
import { CornerUpLeftIcon } from "@animateicons/react/lucide/corner-up-left-icon";
import { EllipsisIcon } from "@animateicons/react/lucide/ellipsis-icon";
import { PencilIcon } from "@animateicons/react/lucide/pencil-icon";
import { TrashIcon } from "@animateicons/react/lucide/trash-icon";

import { useEffect, useRef, useState } from "react";

// Queued-message tray: a single compact card docked above the composer,
// speaking the composer's own visual language (surface, border, radius,
// type). The preview truncates to one line; the full text rides along in
// the title tooltip and the overflow menu. Pure presentational shell over
// the queue state Chat owns — no behavior changes here.
export default function QueueTray({
  text,
  onSteer,
  onEdit,
  onDiscard,
}: {
  /** Queued text, or null when the slot is empty. */
  text: string | null;
  /** Abort the running turn and send the queued text now. */
  onSteer: () => void;
  /** Load the text back into the composer for editing. */
  onEdit: () => void;
  /** Drop the queued text entirely. */
  onDiscard: () => void;
}) {
  const [render, setRender] = useState(text != null);
  const [leaving, setLeaving] = useState(false);
  const [shown, setShown] = useState(text ?? "");
  const [menu, setMenu] = useState(false);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<number | null>(null);

  // Enter instantly; exit plays a short fade before unmounting. The shown
  // text freezes while leaving so the card never flashes empty.
  useEffect(() => {
    if (text != null) {
      setRender(true);
      setLeaving(false);
      setShown(text);
      return;
    }
    if (!render) return;
    setLeaving(true);
    setMenu(false);
    const t = window.setTimeout(() => {
      setRender(false);
      setLeaving(false);
    }, 180);
    return () => window.clearTimeout(t);
  }, [text, render]);

  useEffect(
    () => () => {
      if (copyTimer.current) window.clearTimeout(copyTimer.current);
    },
    [],
  );

  useEffect(() => {
    if (!menu) return;
    function esc(ev: KeyboardEvent) {
      if (ev.key === "Escape") setMenu(false);
    }
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [menu]);

  function copyFull() {
    navigator.clipboard.writeText(shown).catch(() => {});
    setCopied(true);
    if (copyTimer.current) window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => {
      setCopied(false);
      setMenu(false);
    }, 1200);
  }

  if (!render) return null;

  return (
    <div
      className={leaving ? "queue-tray leaving" : "queue-tray msg-in"}
      role="status"
      aria-label="Queued message"
    >
      <span className="queue-tray-icon" aria-hidden="true">
        <AnimatedActionIcon icon={CornerUpLeftIcon} size={14} />
      </span>
      <span className="queue-tray-text" title={shown}>
        {shown}
      </span>
      <span className="queue-tray-acts">
        <button
          type="button"
          className="queue-steer"
          onClick={onSteer}
          aria-label="Stop current work and send queued message"
        >
          <AnimatedActionIcon icon={ArrowRightIcon} size={13} aria-hidden="true" />
          Steer
        </button>
        <button
          type="button"
          className="queue-icon-btn"
          onClick={onDiscard}
          aria-label="Discard queued message"
          data-tip="Discard"
        >
          <AnimatedActionIcon icon={TrashIcon} size={13} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="queue-icon-btn"
          onClick={() => setMenu((v) => !v)}
          aria-label="Queued message options"
          aria-expanded={menu}
          aria-haspopup="menu"
          data-tip="More options"
        >
          <AnimatedActionIcon icon={EllipsisIcon} size={14} aria-hidden="true" />
        </button>
      </span>
      {menu && (
        <>
          <button
            type="button"
            className="menu-scrim"
            onClick={() => setMenu(false)}
            aria-hidden="true"
            tabIndex={-1}
          />
          <div className="queue-menu" role="menu" aria-label="Queued message options">
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenu(false);
                onEdit();
              }}
            >
              <AnimatedActionIcon icon={PencilIcon} size={14} aria-hidden="true" />
              Edit in composer
            </button>
            <button type="button" role="menuitem" onClick={copyFull}>
              {copied ? (
                <AnimatedActionIcon icon={CheckIcon} size={14} aria-hidden="true" />
              ) : (
                <AnimatedActionIcon icon={CopyIcon} size={14} aria-hidden="true" />
              )}
              {copied ? "Copied" : "Copy full message"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
