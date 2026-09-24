"use client";

import { useEffect, useId, useRef } from "react";
import AnimatedActionIcon from "./animated-action-icon";
import { ShareIcon } from "@animateicons/react/lucide/share-icon";
import { CodeIcon } from "@animateicons/react/lucide/code-icon";
import { StoreIcon } from "@animateicons/react/lucide/store-icon";

export function moveMenuFocus(event: React.KeyboardEvent<HTMLDivElement>) {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not(:disabled), button[role="menuitemradio"]:not(:disabled)'),
    );
    if (!items.length) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home"
      ? 0
      : event.key === "End"
        ? items.length - 1
        : event.key === "ArrowUp"
          ? (current <= 0 ? items.length - 1 : current - 1)
          : (current + 1) % items.length;
    items[next]?.focus();
  }


export default function ShareDropdown({ open, onOpenChange, onShare, label = false }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onShare: (view: "code" | "publish") => void;
  label?: boolean;
}) {
  const id = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus());
    function escape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onOpenChange(false);
      buttonRef.current?.focus();
    }
    document.addEventListener("keydown", escape);
    return () => { cancelAnimationFrame(frame); document.removeEventListener("keydown", escape); };
  }, [open, onOpenChange]);
  return (
    <div className="chat-toolbar-action">
      <button ref={buttonRef} type="button" className={label ? "btn-primary" : `icon-btn${open ? " is-active" : ""}`} onClick={() => onOpenChange(!open)} aria-label="Share bot" aria-expanded={open} aria-haspopup="menu" aria-controls={id} data-tip={label ? undefined : "Share bot"}>
        {label ? "Share bot" : <AnimatedActionIcon icon={ShareIcon} size={17} />}
      </button>
      {open && <>
        <div ref={menuRef} id={id} className="chat-options-menu chat-share-menu" role="menu" aria-label="Share bot" onKeyDown={moveMenuFocus}>
          <button type="button" role="menuitem" onClick={() => { onOpenChange(false); buttonRef.current?.focus(); onShare("code"); }}>
            <AnimatedActionIcon icon={CodeIcon} size={15} />
            <span className="chat-menu-label">Share with code</span>
          </button>
          <button type="button" role="menuitem" onClick={() => { onOpenChange(false); buttonRef.current?.focus(); onShare("publish"); }}>
            <AnimatedActionIcon icon={StoreIcon} size={15} />
            <span className="chat-menu-label">Publish to Marketplace</span>
          </button>
        </div>
        <button type="button" className="menu-scrim" onClick={() => onOpenChange(false)} aria-label="Close menu" tabIndex={-1} />
      </>}
    </div>
  );
}
