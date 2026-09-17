import Logo from "./logo";
import UserChip from "./user-chip";

// Top bar: logo on the left, user profile on the right.
// Presentational only.
export default function TopBar() {
  return (
    <header className="topbar">
      <span className="logo">
        <Logo height={24} />
      </span>
      <UserChip name="Sunny" />
    </header>
  );
}
