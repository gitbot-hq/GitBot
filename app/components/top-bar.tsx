import type { ReactNode } from "react";
import Logo from "./logo";
import UserChip from "./user-chip";
import { DEFAULT_USER_NAME } from "../lib/user-prefs";

// Top bar: logo on the left, user profile on the right.
// Presentational only. Pages may pass `actions` (e.g. a theme switch) to
// render immediately left of the user chip; omitted by default.
// The chip shows the generic default until the user sets their own name
// (app-shell wires the stored pref + profile panel via onProfile).
export default function TopBar({
  actions,
  userName = DEFAULT_USER_NAME,
  userPhoto = null,
  onProfile,
  className,
}: {
  actions?: ReactNode;
  userName?: string;
  userPhoto?: string | null;
  onProfile?: () => void;
  className?: string;
}) {
  return (
    <header className={className ? `topbar ${className}` : "topbar"}>
      <span className="logo">
        <Logo height={24} />
      </span>
      {actions}
      <UserChip name={userName} photo={userPhoto} onClick={onProfile} />
    </header>
  );
}
