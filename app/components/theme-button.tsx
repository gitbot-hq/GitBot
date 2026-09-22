"use client";

import AnimatedActionIcon from "./animated-action-icon";
import { MoonIcon } from "@animateicons/react/lucide/moon-icon";
import { SunIcon } from "@animateicons/react/lucide/sun-icon";

import { useEffect, useState } from "react";

type Theme = "light" | "dark";

// Top-bar theme switch. layout.tsx restores the saved theme before paint.
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
      data-tip={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
    >
      {theme === "dark" ? (
        <AnimatedActionIcon icon={SunIcon} size={18} aria-hidden="true" />
      ) : (
        <AnimatedActionIcon icon={MoonIcon} size={18} aria-hidden="true" />
      )}
    </button>
  );
}
