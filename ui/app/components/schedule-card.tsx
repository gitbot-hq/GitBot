"use client";

import { useState } from "react";
import { deleteSchedule, patchSchedule, runScheduleNow } from "../lib/api";
import type { ScheduleNotify, ScheduleView } from "../lib/gitbot";
import {
  cardWhere,
  fullTime,
  lastRuns,
  madeBy,
  nextRunsText,
  NOTIFY_OPTIONS,
  OWN_WORDS_HINT,
  runText,
  scheduleActions,
  scheduleState,
  shortTime,
  statusText,
} from "../lib/schedules";

/** What a card's buttons ask for. The parent runs it (scheduleCall) and re-reads. */
export type CardAction =
  | { kind: "pause" | "resume" | "run" | "delete" }
  | { kind: "notify"; notify: ScheduleNotify };

/** The API call for a card's action. */
export function scheduleCall(id: string, action: CardAction): Promise<unknown> {
  switch (action.kind) {
    case "pause":
      return patchSchedule(id, { enabled: false });
    case "resume":
      return patchSchedule(id, { enabled: true });
    case "run":
      return runScheduleNow(id);
    case "delete":
      return deleteSchedule(id);
    case "notify":
      return patchSchedule(id, { notify: action.notify });
  }
}

/**
 * One schedule, in full: when, where (linked), status, its next 3 runs,
 * notify, who made it and its last runs, with Pause or Resume, Run now and
 * Delete (asked first, in place). Shared by the open thread's panel
 * (`threadId`: links to that thread are left out) and the Schedules view.
 * No model or effort: a schedule has none.
 */
export default function ScheduleCard({
  s,
  threadId,
  busy,
  highlight,
  onAction,
  onOpen,
}: {
  s: ScheduleView;
  /** The thread whose panel shows the card, if any. */
  threadId?: string;
  busy: boolean;
  /** Deep-linked to (`/?schedule=<id>`): drawn out. */
  highlight?: boolean;
  onAction: (action: CardAction) => void;
  /** Opens a thread under its bot. */
  onOpen: (botId: string, threadId: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const state = scheduleState(s);
  const can = scheduleActions(s);
  const where = cardWhere(s, threadId);
  const by = madeBy(s, threadId);
  const next = nextRunsText(s);
  const runs = lastRuns(s);
  return (
    <li data-schedule-id={s.id} className={`schedule schedule-${state}${highlight ? " highlight" : ""}`}>
      <div className="schedule-head">
        <b className="schedule-name">{s.name}</b>
        <span className="schedule-when">{s.describe ?? s.when.kind}</span>
      </div>
      <div className="schedule-status" title={s.nextRunAt && state === "active" ? fullTime(s.nextRunAt) : undefined}>
        {statusText(s)}
        {s.attention?.kind === "failed" && <span className="schedule-attention"> · {s.attention.text}</span>}
      </div>
      {next && (
        <div className="schedule-next" title={s.nextRuns.map((at) => fullTime(at)).join("\n")}>
          Next runs: {next}
        </div>
      )}
      <div className="schedule-meta">
        {where && (
          <span>
            {where.lead}
            {where.link && (
              <>
                {" "}
                <button type="button" className="schedule-link" onClick={() => onOpen(where.link!.botId, where.link!.threadId)}>
                  <b>{where.title}</b> · {where.tail}
                </button>
              </>
            )}
          </span>
        )}
        <span>
          {by.lead}
          {by.link && (
            <>
              {" "}
              <button type="button" className="schedule-link" onClick={() => onOpen(by.link!.botId, by.link!.threadId)}>
                {by.title}
              </button>
            </>
          )}
        </span>
        {can.notify ? (
          <label className="schedule-notify">
            notify{" "}
            <select
              value={s.notify}
              disabled={busy}
              onChange={(e) => onAction({ kind: "notify", notify: e.target.value as ScheduleNotify })}
            >
              {NOTIFY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </label>
        ) : (
          <span>notify {s.notify}</span>
        )}
      </div>
      {s.ownWords && <div className="schedule-own-words">{OWN_WORDS_HINT}</div>}
      {runs.length > 0 && (
        <ol className="schedule-runs" aria-label={`Last runs of ${s.name}`}>
          {runs.map((r, i) => (
            <li key={`${r.at}-${i}`}>
              <span className="schedule-run-at" title={fullTime(r.at)}>{shortTime(r.at)}</span>{" "}
              {r.threadId && r.botId && r.threadId !== threadId ? (
                <button type="button" className="schedule-link" onClick={() => onOpen(r.botId!, r.threadId!)}>
                  {runText(r)}
                </button>
              ) : (
                <span>{runText(r)}</span>
              )}
            </li>
          ))}
        </ol>
      )}
      <div className="schedule-actions">
        {confirming ? (
          <>
            <span className="schedule-confirm">Delete “{s.name}”? Its runs’ threads are kept.</span>
            <button
              type="button"
              className="schedule-delete danger"
              disabled={busy}
              onClick={() => {
                setConfirming(false);
                onAction({ kind: "delete" });
              }}
            >
              Delete
            </button>
            <button type="button" onClick={() => setConfirming(false)} autoFocus>
              Cancel
            </button>
          </>
        ) : (
          <>
            {can.pause && (
              <button type="button" disabled={busy} onClick={() => onAction({ kind: "pause" })}>
                Pause
              </button>
            )}
            {can.resume && (
              <button type="button" disabled={busy} onClick={() => onAction({ kind: "resume" })}>
                Resume
              </button>
            )}
            {can.runNow && (
              <button
                type="button"
                disabled={busy}
                title={s.ownWords ? "This run is treated as information, not as your request" : undefined}
                onClick={() => onAction({ kind: "run" })}
              >
                Run now
              </button>
            )}
            <button type="button" className="schedule-delete" disabled={busy} onClick={() => setConfirming(true)}>
              Delete
            </button>
          </>
        )}
      </div>
    </li>
  );
}
