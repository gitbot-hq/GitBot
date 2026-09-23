"use client";

// The user's own profile (top-right chip → user profile panel).
// Frontend-only, same pattern as avatar-prefs.ts: kept in localStorage,
// the server never sees or stores these.
//
// Email verification is server-owned (backend: Madhan). `emailVerified`
// is a placeholder for the flag the server will supply — default false,
// never set it client-side outside of demos. When the backend lands,
// fill it from the API (app/lib/api.ts) instead of localStorage.
export type UserPref = {
  name: string;
  email: string;
  /** Short bio, shown under the name. Plain text, ~160 chars. */
  bio: string;
  /** Free-text location, e.g. "Berlin, DE". Shown in the facts list. */
  location: string;
  /** Server-provided verification flag. Local placeholder until then. */
  emailVerified: boolean;
  /** Data-URL profile photo, or null. Capped at save time (~1MB). */
  photo: string | null;
};

/** Generic display name before the user sets their own. */
export const DEFAULT_USER_NAME = "User";

const KEY = "gitbot-user";

const DEFAULTS: UserPref = { name: DEFAULT_USER_NAME, email: "", bio: "", location: "", emailVerified: false, photo: null };

export function getUserPref(): UserPref {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<UserPref>;
    return {
      name: typeof raw.name === "string" && raw.name.trim() ? raw.name : DEFAULTS.name,
      email: typeof raw.email === "string" ? raw.email : DEFAULTS.email,
      bio: typeof raw.bio === "string" ? raw.bio : DEFAULTS.bio,
      location: typeof raw.location === "string" ? raw.location : DEFAULTS.location,
      emailVerified: raw.emailVerified === true,
      photo: typeof raw.photo === "string" && raw.photo.startsWith("data:image/") ? raw.photo : null,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function setUserPref(pref: UserPref) {
  try {
    localStorage.setItem(KEY, JSON.stringify(pref));
  } catch {
    // private mode or quota (large photo) — profile just won't persist
  }
}

/** "Sunny Patel" → "SP". Falls back to "U" for the generic default. */
export function userInitials(name: string): string {
  const initials = name
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return initials || "U";
}
