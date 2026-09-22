"use client";

import AnimatedActionIcon from "./animated-action-icon";
import { ChevronDownIcon } from "@animateicons/react/lucide/chevron-down-icon";

import { useUserProfile } from "./app-providers";

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
  const { ready } = useUserProfile();
  return (
    <button
      type="button"
      className="user-chip"
      data-profile-ready={ready}
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
      <span className="user-chip-name">{name}</span>
      <AnimatedActionIcon icon={ChevronDownIcon}
        size={16}
        className="user-chip-chevron"
        aria-hidden="true"
      />
    </button>
  );
}
