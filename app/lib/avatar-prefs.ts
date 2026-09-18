"use client";

import { bodies } from "../components/bot-maker/registry";

// Per-bot avatar picks, kept in localStorage keyed by bot id.
// Frontend-only: the server never sees or stores these.
// `mascot` is one of the 18 bot-maker body ids. Very old prefs stored a
// numeric studio variant, older ones the retired alternate-mascot names —
// resolveAvatar() maps both forward (old art is gone).
export type AvatarMascot = string;

export type AvatarPref = { mascot: AvatarMascot; color: string };

type LegacyPref = { variant: number; color: string };

const KEY = "gitbot-avatars";

const ALL_BODIES: AvatarMascot[] = bodies.map((b) => b.id);

// Retired alternate-mascot names → closest new bodies.
const OLD_TO_NEW: Record<string, AvatarMascot> = {
  frog: "belly",
  spider: "flower",
  ghost: "ghost",
  bunny: "bunny",
  horned: "cat",
  spiky: "star",
};

const LEGACY_VARIANT_TO_MASCOT: Record<number, AvatarMascot> = {
  53: "belly",
  54: "flower",
  55: "ghost",
  57: "bunny",
  58: "cat",
  59: "star",
};

// Stable default spread for bots with no saved pick.
export const DEFAULT_MASCOT_ORDER: AvatarMascot[] = [
  "bear",
  "bunny",
  "cat",
  "ghost",
  "fire",
  "star",
];

const KNOWN = new Set(ALL_BODIES);

function hashId(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  }
  return hash;
}

/** Stable fallback body for a bot id, spread across the full set. */
export function defaultMascotFor(id: string): AvatarMascot {
  return ALL_BODIES[hashId(id) % ALL_BODIES.length];
}

function readAll(): Record<string, AvatarPref | LegacyPref> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<
      string,
      AvatarPref | LegacyPref
    >;
  } catch {
    return {};
  }
}

function isLegacy(pref: AvatarPref | LegacyPref): pref is LegacyPref {
  return typeof (pref as LegacyPref).variant === "number";
}

export function resolveAvatar(
  raw: AvatarPref | LegacyPref | null | undefined,
  fallback: AvatarPref,
): AvatarPref {
  if (!raw) return fallback;
  const pref: AvatarPref = isLegacy(raw)
    ? {
        mascot: LEGACY_VARIANT_TO_MASCOT[raw.variant] ?? fallback.mascot,
        color: raw.color || fallback.color,
      }
    : raw;
  const mascot =
    OLD_TO_NEW[pref.mascot] ??
    (KNOWN.has(pref.mascot) ? pref.mascot : fallback.mascot);
  return { mascot, color: pref.color || fallback.color };
}

export function getAvatarPref(id: string): AvatarPref | LegacyPref | null {
  try {
    return readAll()[id] ?? null;
  } catch {
    return null;
  }
}

export function setAvatarPref(id: string, pref: AvatarPref) {
  try {
    const all = readAll();
    all[id] = pref;
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // private mode — picks just won't persist
  }
}
