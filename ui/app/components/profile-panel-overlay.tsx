"use client";

export default function ProfilePanelOverlay({ open, children, className = "" }: {
  open: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`user-overlay${open ? " open" : ""}${className ? ` ${className}` : ""}`} aria-hidden={!open}>
      {open && children}
    </div>
  );
}
