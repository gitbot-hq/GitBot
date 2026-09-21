import { IconChevronDown } from "@tabler/icons-react";

// User profile trigger: avatar + name + dropdown chevron.
// Hover reveals a container behind it. Menu wiring comes next.
export default function UserChip({ name }: { name: string }) {
  const initials = name
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return (
    <button type="button" className="user-chip">
      <span className="user-chip-avatar" aria-hidden="true">
        {initials}
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
