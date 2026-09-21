import type { ReactNode } from "react";
import Logo from "./logo";
import UserChip from "./user-chip";

// Top bar: logo on the left, user profile on the right.
// Presentational only. Pages may pass `actions` (e.g. a theme switch) to
// render immediately left of the user chip; omitted by default.
export default function TopBar({ actions }: { actions?: ReactNode }) {
  return (
    <header className="topbar">
      <span className="logo">
        <Logo height={24} />
      </span>
      {actions}
      <UserChip name="Revise" />
    </header>
  );
}
