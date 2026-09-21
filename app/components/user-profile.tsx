"use client";

import { useEffect, useRef, useState } from "react";
import { IconArrowLeft, IconCamera, IconMapPin, IconPhoto, IconTrash } from "@tabler/icons-react";
import type { UserPref } from "../lib/user-prefs";
import { userInitials } from "../lib/user-prefs";

const PHOTO_MAX_BYTES = 1024 * 1024; // 1MB — localStorage quota is ~5MB

function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="field">
      <label htmlFor={htmlFor}>
        {label}
        {hint ? <span className="hint">{hint}</span> : null}
      </label>
      {children}
    </div>
  );
}

// Scalloped verified mark (provided art). Gradient ids are file-scoped
// and unique to this one render site.
function VerifiedBadge() {
  return (
    <svg
      width="18"
      height="20"
      viewBox="0 0 18 20"
      fill="none"
      aria-hidden="true"
      className="verify-mark"
    >
      <path d="M4.75314 2.29581C6.6665 -0.765342 11.2039 -0.7652 13.1174 2.29581C16.7252 2.42232 18.9927 6.35129 17.2981 9.53898C18.9933 12.727 16.725 16.6563 13.1164 16.7821C11.2029 19.8431 6.66748 19.8433 4.75411 16.7821C1.14589 16.656 -1.12246 12.7269 0.572474 9.53898C-1.12185 6.35146 1.14564 2.42264 4.75314 2.29581ZM12.3918 3.03019C10.8542 0.231374 6.70254 0.32514 5.33908 3.31046L5.02658 3.29191C1.83408 3.22416 -0.160818 6.86557 1.7424 9.53898C-0.222613 12.2986 1.96666 16.0904 5.33908 15.7685C6.74649 18.8499 11.1239 18.8498 12.5315 15.7685C15.9039 16.0904 18.0932 12.2986 16.1281 9.53898C18.093 6.77933 15.9039 2.98854 12.5315 3.31046L12.3918 3.03019Z" fill="url(#vb-edge)"/>
      <path d="M5.33908 3.31046C6.7465 0.228879 11.124 0.228879 12.5315 3.31046C15.9039 2.98854 18.093 6.77933 16.1281 9.53898C18.0932 12.2986 15.9039 16.0904 12.5315 15.7685C11.1239 18.8498 6.74649 18.8499 5.33908 15.7685C1.96666 16.0904 -0.222613 12.2986 1.7424 9.53898C-0.222198 6.77935 1.96677 2.98855 5.33908 3.31046ZM13.2798 6.55427C12.8768 6.17661 12.2434 6.19718 11.8657 6.60016L7.53367 11.2222L5.98289 9.67145C5.59237 9.28093 4.95935 9.28093 4.56883 9.67145C4.17844 10.062 4.17835 10.695 4.56883 11.0855L6.85008 13.3668C7.04158 13.5582 7.30298 13.6641 7.57371 13.6597C7.84445 13.6553 8.10241 13.5409 8.28758 13.3433L13.3257 7.96735C13.7028 7.56447 13.6823 6.93182 13.2798 6.55427Z" fill="url(#vb-face)"/>
      <defs>
        <linearGradient id="vb-edge" x1="8.9355" y1="0.998938" x2="8.9355" y2="18.0796" gradientUnits="userSpaceOnUse">
          <stop stopColor="#004E82"/>
          <stop offset="1" stopColor="#0098FF"/>
        </linearGradient>
        <linearGradient id="vb-face" x1="8.93532" y1="0.998047" x2="8.93532" y2="18.0783" gradientUnits="userSpaceOnUse">
          <stop stopColor="#1D9BF0"/>
          <stop offset="1" stopColor="#4ED3FF"/>
        </linearGradient>
      </defs>
    </svg>
  );
} // reveals the form inline — the profile → studio relationship, collapsed
// into one panel. Option A: everything is stored on this device only;
// email verification is server-owned and lands later (backend: Madhan).
export default function UserProfile({
  user,
  onBack,
  onSaved,
}: {
  user: UserPref;
  onBack: () => void;
  onSaved: (user: UserPref) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(user.name);
  const [email, setEmail] = useState(user.email);
  const [bio, setBio] = useState(user.bio);
  const [location, setLocation] = useState(user.location);
  const [photo, setPhoto] = useState<string | null>(user.photo);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const nameRef = useRef<HTMLInputElement | null>(null);

  // Escape backs out one level: edit → view, view → close.
  useEffect(() => {
    function esc(ev: KeyboardEvent) {
      if (ev.key !== "Escape") return;
      if (editing) setEditing(false);
      else onBack();
    }
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [editing, onBack]);

  // Entering edit lands focus in Name (no scroll jump).
  useEffect(() => {
    if (editing) nameRef.current?.focus({ preventScroll: true });
  }, [editing]);

  function startEdit() {
    setName(user.name);
    setEmail(user.email);
    setBio(user.bio);
    setLocation(user.location);
    setPhoto(user.photo);
    setError(null);
    setEditing(true);
  }

  function pickPhoto(file: File | undefined) {
    if (!file || reading) return;
    if (!file.type.startsWith("image/")) {
      setError("That file isn't an image — pick a PNG or JPEG.");
      return;
    }
    if (file.size > PHOTO_MAX_BYTES) {
      setError("Keep the photo under 1MB so it fits in local storage.");
      return;
    }
    setReading(true);
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result ?? "");
      if (url.startsWith("data:image/")) {
        setPhoto(url);
        setError(null);
      } else {
        setError("Couldn't read that image — try another file.");
      }
      setReading(false);
    };
    reader.onerror = () => {
      setError("Couldn't read that image — try another file.");
      setReading(false);
    };
    reader.readAsDataURL(file);
  }

  function save() {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Name can't be blank.");
      nameRef.current?.focus({ preventScroll: true });
      return;
    }
    const mail = email.trim();
    if (mail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) {
      setError("That email doesn't look right — check it and try again.");
      return;
    }
    onSaved({ name: trimmed, email: mail, bio: bio.trim(), location: location.trim(), emailVerified: user.emailVerified, photo });
    setEditing(false);
  }

  const draftName = name.trim() || user.name;
  // Head mirrors the bot profile: name + one-liner (bio first, email as
  // fallback) underneath.
  const shownLine = user.bio || user.email;

  function openPicker() {
    if (!reading) fileRef.current?.click();
  }

  return (
    <div className="profile-pane" aria-label="Your profile">
      <button type="button" className="back-btn" onClick={onBack}>
        <IconArrowLeft size={16} stroke={2} aria-hidden="true" />
        Back
      </button>
      <div className="profile-pane-inner">
        <div className="profile-cover-wrap">
          <div
            className="profile-cover"
            style={{
              background: `linear-gradient(115deg, var(--brand-sun) 0%, color-mix(in srgb, var(--brand-sun) 45%, var(--surface)) 100%)`,
            }}
            aria-hidden="true"
          />
          {editing ? (
            <button
              type="button"
              className="profile-avatar avatar-upload"
              onClick={openPicker}
              aria-label={photo ? "Change profile photo" : "Upload profile photo"}
              title={photo ? "Change profile photo" : "Upload profile photo"}
            >
              {photo ? (
                <img src={photo} alt="" className="profile-avatar-img" />
              ) : (
                <span className="profile-avatar-initials">
                  {userInitials(draftName)}
                </span>
              )}
              <span className="avatar-camera" aria-hidden="true">
                <IconCamera size={14} stroke={2} />
              </span>
            </button>
          ) : (
            <span className="profile-avatar" aria-hidden="true">
              {user.photo ? (
                <img src={user.photo} alt="" className="profile-avatar-img" />
              ) : (
                <span className="profile-avatar-initials">
                  {userInitials(user.name)}
                </span>
              )}
            </span>
          )}
        </div>
        {editing ? (
          <form
            key="edit"
            className="profile-edit profile-swap"
            aria-label="Edit profile"
            onSubmit={(e) => {
              e.preventDefault();
              save();
            }}
          >
            <h2 className="profile-edit-title">Edit profile</h2>
            <Field label="Name" htmlFor="up-name">
              <input
                ref={nameRef}
                id="up-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Your name"
                autoComplete="name"
                required
                maxLength={60}
              />
            </Field>
            <Field label="Email" htmlFor="up-email">
              <input
                id="up-email"
                type="email"
                inputMode="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                autoComplete="email"
                maxLength={254}
              />
            </Field>
            <Field label="Bio" htmlFor="up-bio">
              <textarea
                id="up-bio"
                value={bio}
                onChange={(e) => setBio(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") save();
                }}
                placeholder="One line about you"
                rows={2}
                maxLength={160}
              />
            </Field>
            <Field label="Location" htmlFor="up-location">
              <input
                id="up-location"
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                placeholder="City, Country"
                autoComplete="address-level2"
                maxLength={80}
              />
            </Field>
            <Field label="Photo">
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp"
                hidden
                onChange={(e) => {
                  pickPhoto(e.target.files?.[0]);
                  e.target.value = "";
                }}
                aria-label="Upload profile photo"
              />
              <div className="photo-row">
                {reading ? (
                  <span className="skel photo-loading" aria-label="Reading photo">
                    <i />
                  </span>
                ) : photo ? (
                  <img
                    key={photo}
                    src={photo}
                    alt=""
                    className="photo-preview photo-in"
                  />
                ) : (
                  <span className="photo-empty" aria-hidden="true">
                    <IconPhoto size={18} stroke={1.8} />
                  </span>
                )}
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={reading}
                  onClick={openPicker}
                >
                  {photo ? "Change" : "Upload"}
                </button>
                {photo && !reading && (
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => setPhoto(null)}
                    aria-label="Remove profile photo"
                  >
                    <IconTrash size={15} stroke={2} aria-hidden="true" />
                  </button>
                )}
              </div>
              <span className="hint" id="up-photo-hint">
                Stored on this device only. Email verification arrives with the
                backend — nothing to confirm yet.
              </span>
            </Field>
            {error && (
              <p className="chat-error" role="alert">
                {error}
              </p>
            )}
            <div className="profile-acts">
              <div className="spacer" />
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setEditing(false)}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="btn-primary"
                disabled={!name.trim()}
              >
                Save
              </button>
            </div>
          </form>
        ) : (
          <div key="view" className="profile-swap">
            <div className="profile-head">
              <div>
                <h2 className="user-name-row">
                  {user.name}
                  {/* Verified and unverified are mutually exclusive, driven by
                      the server-provided flag (backend: Madhan). */}
                  {user.email && !user.emailVerified && (
                    <span
                      className="user-badge"
                      title="Email verification arrives with the backend"
                    >
                      Unverified
                    </span>
                  )}
                  {user.email && user.emailVerified && (
                    <span
                      className="verify-pill"
                      role="img"
                      aria-label="Email verified"
                      title="Email verified"
                      tabIndex={0}
                    >
                      <VerifiedBadge />
                      <span className="verify-label" aria-hidden="true">
                        Email verified
                      </span>
                    </span>
                  )}
                </h2>
                {shownLine ? (
                  <p className="user-bio">{shownLine}</p>
                ) : (
                  <p>Add your email below</p>
                )}
                {user.location && (
                  <div className="user-sub">
                    <span className="user-loc">
                      <IconMapPin size={14} stroke={2} aria-hidden="true" />
                      {user.location}
                    </span>
                  </div>
                )}
              </div>
              <div className="profile-acts">
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={startEdit}
                >
                  Edit
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
