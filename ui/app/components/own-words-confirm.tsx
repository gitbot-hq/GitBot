"use client";

import { OWN_WORDS_CONFIRM } from "../lib/schedule-when";

/**
 * Asked before a save that takes a Jarvis "own-words" schedule out of
 * Jarvis's hands (D2): Change anyway saves, Open Jarvis thread goes to the
 * thread that made it (when it still exists), Cancel goes back to the form.
 * Shown in place of the form's buttons.
 */
export default function OwnWordsConfirm({
  busy,
  onConfirm,
  onOpenJarvis,
  onCancel,
}: {
  busy: boolean;
  onConfirm: () => void;
  onOpenJarvis?: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="schedule-own-confirm" role="alertdialog" aria-label="Change a schedule Jarvis made">
      <p>{OWN_WORDS_CONFIRM}</p>
      <div className="schedule-form-actions">
        <button type="button" className="btn-secondary" onClick={onCancel} autoFocus>
          Cancel
        </button>
        {onOpenJarvis && (
          <button type="button" className="btn-secondary" onClick={onOpenJarvis}>
            Open Jarvis thread
          </button>
        )}
        <button type="button" className="btn-primary" disabled={busy} onClick={onConfirm}>
          {busy ? "Saving…" : "Change anyway"}
        </button>
      </div>
    </div>
  );
}
