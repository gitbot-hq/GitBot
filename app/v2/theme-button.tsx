"use client";

import { useEffect, useState } from "react";
import { IconMoon, IconSun } from "@tabler/icons-react";

type Theme = "light" | "dark";

// v2 top-bar theme switch, next to the user chip. Same mechanics as the
// shared ThemeToggle (documentElement dataset + localStorage, restored
// before paint by layout.tsx) — icon-button presentation for the bar.
export default function ThemeButton() {
  const [theme, setTheme] = useState<Theme>("dark");

  useEffect(() => {
    setTheme(
      document.documentElement.dataset.theme === "light" ? "light" : "dark",
    );
  }, []);

  function toggle() {
    const next: Theme = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("gitbot-theme", next);
    } catch {
      // private mode — theme just won't persist
    }
    setTheme(next);
  }

  return (
    <button
      type="button"
      className="theme-btn"
      onClick={toggle}
      aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
    >
      {theme === "dark" ? (
        <IconSun size={18} stroke={2} aria-hidden="true" />
      ) : (
        <IconMoon size={18} stroke={2} aria-hidden="true" />
      )}
    </button>
  );
}
