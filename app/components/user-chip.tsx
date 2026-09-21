import { IconChevronDown } from "@tabler/icons-react";
import { userInitials } from "../lib/user-prefs";

// User profile trigger: avatar + name + dropdown chevron.
// Hover reveals a container behind it. Click opens the user profile.
export default function UserChip({
  name,
  photo,
  onClick,
}: {
  name: string;
  photo?: string | null;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      className="user-chip"
      onClick={onClick}
      aria-label={`${name} — open profile`}
    >
      <span className="user-chip-avatar" aria-hidden="true">
        {photo ? (
          <img src={photo} alt="" className="user-chip-photo" />
        ) : (
          userInitials(name)
        )}
      </span>
      {name}
      <IconChevronDown
        size={16}
        stroke={2}
        className="user-chip-chevron"
        aria-hidden="true"
      />
    </button>
  );
}
