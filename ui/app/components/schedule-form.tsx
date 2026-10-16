"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createSchedule, patchSchedule, previewSchedule, type NewScheduleBody, type SchedulePreview } from "../lib/api";
import type { Bot, Schedule, ScheduleNotify, SchedulePatch, ScheduleView } from "../lib/gitbot";
import { fullTime } from "../lib/schedules";
import {
  askJarvisDraft,
  browserTimeZone,
  diffSchedule,
  editInit,
  IN_CHIPS,
  JARVIS_TARGET_NOTE,
  notifySuggestion,
  patchDemotes,
  sameWhen,
  suggestName,
  timeZoneOptions,
  tomorrowAt,
  toWhen,
  WEEKDAY_LABELS,
  zonedToIso,
  type FormTarget,
  type WhenChoice,
} from "../lib/schedule-when";
import OwnWordsConfirm from "./own-words-confirm";
import ThreadPicker from "./thread-picker";

const PROMPT_MAX = 4000;
const PREVIEW_DEBOUNCE_MS = 300;
/** Next times the preview line lists. */
const PREVIEW_RUNS = 3;

const NOTIFY_CHOICES: { value: ScheduleNotify; label: string }[] = [
  { value: "always", label: "Every run" },
  { value: "on-failure", label: "Only if it fails" },
  { value: "never", label: "Never" },
];

type OnceChip = "in15" | "in60" | "tomorrow" | "pick";
type RepeatKind = "daily" | "weekdays" | "weekly" | "monthly" | "every" | "cron";

const REPEATS: { value: RepeatKind; label: string }[] = [
  { value: "daily", label: "Every day" },
  { value: "weekdays", label: "Weekdays" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
  { value: "every", label: "Every N min/hours" },
];

/** The form's when fields for a choice (edit's prefill); the rest keep their defaults. */
function whenFields(c: WhenChoice) {
  const f = {
    mode: "once" as "once" | "repeats",
    onceChip: "tomorrow" as OnceChip,
    picked: "",
    repeat: "daily" as RepeatKind,
    time: "09:00",
    days: [1],
    monthDay: 1,
    amount: 30,
    unit: "minutes" as "minutes" | "hours",
    cron: "",
  };
  switch (c.preset) {
    case "in":
      return { ...f, onceChip: (c.minutes === 15 ? "in15" : "in60") as OnceChip };
    case "once":
      return { ...f, onceChip: "pick" as OnceChip, picked: c.localDateTime };
    case "daily":
    case "weekdays":
      return { ...f, mode: "repeats" as const, repeat: c.preset, time: c.time };
    case "weekly":
      return { ...f, mode: "repeats" as const, repeat: "weekly" as RepeatKind, time: c.time, days: c.days };
    case "monthly":
      return { ...f, mode: "repeats" as const, repeat: "monthly" as RepeatKind, time: c.time, monthDay: c.day };
    case "every":
      return { ...f, mode: "repeats" as const, repeat: "every" as RepeatKind, amount: c.amount, unit: c.unit };
    case "cron":
      return { ...f, mode: "repeats" as const, repeat: "cron" as RepeatKind, cron: c.expr };
  }
}

/** Where an edited schedule runs, in words (the target can't change here). */
function runsOn(s: ScheduleView): string {
  const w = s.where;
  if (w.kind === "thread") return `${w.title} · ${w.botName}`;
  if (w.kind === "new-thread") return `a new thread each run · ${w.botName} · ${w.projectName}`;
  return "a thread that is gone";
}

/**
 * A new schedule on a thread, or (`edit`) a change to one: message, name (suggested), when (presets, or a
 * cron under Advanced), where, and who hears of runs. The server says what
 * the times mean (POST /schedules/preview, debounced) and checks the save
 * (POST /schedules); the form works out no cron itself. Nothing here sets
 * createdBy or notesTo: the route records the user. No model or effort.
 */
export default function ScheduleForm({
  target: preset,
  bots,
  onCancel,
  onSaved,
  onAskJarvis,
  edit,
  onEdited,
  onOpen,
}: {
  /** Edit this schedule: prefilled, saved as a PATCH of only what changed. */
  edit?: ScheduleView;
  /** Saved (and resumed, with Save and resume). */
  onEdited?: (schedule: Schedule & { nextRuns: string[] }, resumed: boolean) => void;
  /** Opens a thread under its bot: the own-words confirmation's Open Jarvis thread. */
  onOpen?: (botId: string, threadId: string) => void;
  /** The thread it was opened from, if any: "This thread". */
  target?: FormTarget;
  bots: readonly Bot[];
  onCancel: () => void;
  onSaved: (schedule: Schedule & { nextRuns: string[] }) => void;
  /** Closes the form and opens the Jarvis thread with this draft in its composer. */
  onAskJarvis: (target: FormTarget, draft: string) => void;
}) {
  const id = useId();
  // Edit: the schedule's own values, read once (a re-read of the list
  // while the form is open doesn't overwrite what is being typed).
  const [init] = useState(() => {
    const at = edit ? editInit(edit, browserTimeZone()) : null;
    return { at, fields: whenFields(at?.choice ?? { preset: "once", localDateTime: "" }) };
  });
  const base = init.at;
  const start = edit ? init.fields : whenFields({ preset: "in", minutes: 0 });
  const [prompt, setPrompt] = useState(edit?.prompt ?? "");
  const [name, setName] = useState(edit?.name ?? "");
  const [nameEdited, setNameEdited] = useState(!!edit);
  const [mode, setMode] = useState<"once" | "repeats">(start.mode);
  const [onceChip, setOnceChip] = useState<OnceChip>(edit ? start.onceChip : "tomorrow");
  const [picked, setPicked] = useState(start.picked);
  const [repeat, setRepeat] = useState<RepeatKind>(start.repeat);
  const [time, setTime] = useState(start.time);
  const [days, setDays] = useState<number[]>(start.days);
  const [monthDay, setMonthDay] = useState(start.monthDay);
  const [amount, setAmount] = useState(start.amount);
  const [unit, setUnit] = useState<"minutes" | "hours">(start.unit);
  const [cron, setCron] = useState(start.cron);
  const [target, setTarget] = useState<FormTarget | null>(preset ?? null);
  const [picking, setPicking] = useState(!preset && !edit);
  const [notify, setNotify] = useState<ScheduleNotify | null>(edit?.notify ?? null);
  const [advanced, setAdvanced] = useState(!!edit && (edit.maxRuns != null || !!edit.endsAt || edit.overlap === "skip" || edit.when.kind === "cron"));
  const [maxRuns, setMaxRuns] = useState(edit?.maxRuns != null ? String(edit.maxRuns) : "");
  const [endsLocal, setEndsLocal] = useState(base?.endsLocal ?? "");
  const [overlap, setOverlap] = useState<"queue" | "skip">(edit?.overlap ?? "queue");
  const [tz, setTz] = useState(() => base?.tz ?? browserTimeZone());
  const zones = useMemo(() => timeZoneOptions(tz), [tz]);
  const [preview, setPreview] = useState<SchedulePreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // The own-words confirmation, holding the save it asks about.
  const [confirming, setConfirming] = useState<{ resume: boolean } | null>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    promptRef.current?.focus({ preventScroll: true });
  }, []);

  const choice: WhenChoice = (() => {
    if (mode === "once") {
      if (onceChip === "in15") return { preset: "in", minutes: 15 };
      if (onceChip === "in60") return { preset: "in", minutes: 60 };
      if (onceChip === "tomorrow") return { preset: "once", localDateTime: tomorrowAt("09:00", tz) };
      return { preset: "once", localDateTime: picked };
    }
    switch (repeat) {
      case "daily": return { preset: "daily", time };
      case "weekdays": return { preset: "weekdays", time };
      case "weekly": return { preset: "weekly", days, time };
      case "monthly": return { preset: "monthly", day: monthDay, time };
      case "every": return { preset: "every", amount, unit };
      case "cron": return { preset: "cron", expr: cron };
    }
  })();

  // How it ends, for repeats only; null for a value that can't be sent.
  const limits = (() => {
    if (mode === "once") return {};
    const out: { maxRuns?: number; endsAt?: string } = {};
    if (maxRuns.trim()) out.maxRuns = Number(maxRuns);
    if (endsLocal) {
      const at = zonedToIso(endsLocal, tz);
      if (!at) return null;
      out.endsAt = at;
    }
    return out;
  })();

  // The preview's input, as a key: the same choice in the same zone asks once
  // (an "in" chip is worked out again when it is sent).
  const previewKey = JSON.stringify({ choice, tz, limits });
  useEffect(() => {
    const when = toWhen(choice, tz);
    setPreview(null);
    if (!when) {
      setPreviewError(choice.preset === "once" && picked ? "That time doesn't exist in this time zone" : null);
      return;
    }
    if (!limits) {
      setPreviewError("The end date doesn't exist in this time zone");
      return;
    }
    setPreviewError(null);
    const ctrl = new AbortController();
    const timer = window.setTimeout(() => {
      previewSchedule({ when, tz, ...limits }, ctrl.signal).then(
        (p) => setPreview(p),
        (e) => {
          if (!ctrl.signal.aborted) setPreviewError(e instanceof Error ? e.message : String(e));
        },
      );
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      ctrl.abort();
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewKey]);

  function changePrompt(text: string) {
    setPrompt(text);
    if (!nameEdited) setName(suggestName(text));
  }

  const effectiveNotify = notify ?? preview?.defaultNotify ?? null;
  const ready = !!prompt.trim() && !!name.trim() && (!!target || !!edit) && !previewError && !!toWhen(choice, tz) && !!limits;

  // Edit: the times count as changed only when they differ from the
  // prefill's (so a cron in another zone, or a once's seconds, is never
  // re-sent by an edit that didn't touch them). The same for the end date.
  const baseWhen = base ? toWhen(base.choice, base.tz) : null;
  const nowWhen = toWhen(choice, tz);
  const whenChanged = !!edit && !!nowWhen && !(baseWhen && sameWhen(baseWhen, nowWhen));
  function editPatch(): SchedulePatch | null {
    if (!edit || !limits) return null;
    const baseEnds = base?.endsLocal ? zonedToIso(base.endsLocal, base.tz) : undefined;
    const endsAt = limits.endsAt && limits.endsAt === baseEnds ? edit.endsAt : limits.endsAt;
    return diffSchedule(edit, {
      name,
      prompt,
      when: whenChanged ? toWhen(choice, tz, Date.now()) ?? undefined : undefined,
      notify: notify ?? edit.notify,
      overlap,
      maxRuns: limits.maxRuns,
      endsAt,
    });
  }
  const patch = edit ? editPatch() : null;
  const changed = !!patch && Object.keys(patch).length > 0;
  const suggestion = edit ? notifySuggestion(whenChanged, preview, notify ?? edit.notify) : null;
  // Save and resume: a paused schedule that can run again after the edit.
  const canSaveResume = !!edit && edit.state === "paused" && (preview?.nextRuns.length ?? 0) > 0;

  /** Edit: PATCH only what changed (with enabled for Save and resume), asking first if it demotes an own-words schedule. */
  function saveEdit(resume: boolean, confirmed = false) {
    const body = editPatch();
    if (!edit || !body) return;
    if (resume) body.enabled = true;
    if (Object.keys(body).length === 0) return;
    if (edit.ownWords && patchDemotes(body) && !confirmed) {
      setConfirming({ resume });
      return;
    }
    setSaving(true);
    setSaveError(null);
    patchSchedule(edit.id, body).then(
      (saved) => onEdited?.(saved, resume),
      (e) => {
        setConfirming(null);
        setSaveError(e instanceof Error ? e.message : String(e));
        setSaving(false);
      },
    );
  }

  function save() {
    const when = toWhen(choice, tz, Date.now());
    if (!when || !target || !limits) return;
    const body: NewScheduleBody = {
      name: name.trim(),
      prompt,
      when,
      target: { kind: "thread", threadId: target.threadId },
      ...(notify ? { notify } : {}),
      ...(overlap !== "queue" ? { overlap } : {}),
      ...limits,
    };
    setSaving(true);
    setSaveError(null);
    createSchedule(body).then(
      (created) => onSaved(created),
      (e) => {
        setSaveError(e instanceof Error ? e.message : String(e));
        setSaving(false);
      },
    );
  }

  function toggleDay(d: number) {
    setDays((prev) => (prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d].sort((a, b) => a - b)));
  }

  const needsTime = mode === "repeats" && (repeat === "daily" || repeat === "weekdays" || repeat === "weekly" || repeat === "monthly");

  return (
    <form
      className="schedule-form"
      aria-label={edit ? "Edit schedule" : "New schedule"}
      // Only the Save button saves: Enter in a field (Name, the thread
      // search, a time) must never create the schedule.
      onSubmit={(e) => e.preventDefault()}
    >
      <h3 className="schedule-form-title">{edit ? `Edit “${edit.name}”` : "New schedule"}</h3>

      <label className="schedule-field" htmlFor={`${id}-prompt`}>
        <span className="schedule-field-label">Message</span>
        <textarea
          id={`${id}-prompt`}
          ref={promptRef}
          rows={4}
          maxLength={PROMPT_MAX}
          value={prompt}
          placeholder="What should the thread be sent?"
          onChange={(e) => changePrompt(e.target.value)}
        />
        <span className="schedule-field-hint">{prompt.length}/{PROMPT_MAX}</span>
      </label>

      <label className="schedule-field" htmlFor={`${id}-name`}>
        <span className="schedule-field-label">Name</span>
        <input
          id={`${id}-name`}
          type="text"
          maxLength={60}
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setNameEdited(true);
          }}
        />
      </label>

      <fieldset className="schedule-field">
        <legend className="schedule-field-label">When</legend>
        <div className="schedule-seg" role="group" aria-label="Once or repeats">
          <button type="button" aria-pressed={mode === "once"} onClick={() => setMode("once")}>Once</button>
          <button type="button" aria-pressed={mode === "repeats"} onClick={() => setMode("repeats")}>Repeats</button>
        </div>
        {mode === "once" && (
          <div className="schedule-chips">
            {IN_CHIPS.map((c) => {
              const key: OnceChip = c.minutes === 15 ? "in15" : "in60";
              return (
                <button key={key} type="button" aria-pressed={onceChip === key} onClick={() => setOnceChip(key)}>{c.label}</button>
              );
            })}
            <button type="button" aria-pressed={onceChip === "tomorrow"} onClick={() => setOnceChip("tomorrow")}>Tomorrow 09:00</button>
            <button type="button" aria-pressed={onceChip === "pick"} onClick={() => setOnceChip("pick")}>Pick…</button>
            {onceChip === "pick" && (
              <input type="datetime-local" aria-label="Date and time" value={picked} onChange={(e) => setPicked(e.target.value)} />
            )}
          </div>
        )}
        {mode === "repeats" && (
          <div className="schedule-repeat">
            <select aria-label="Repeats" value={repeat} onChange={(e) => setRepeat(e.target.value as RepeatKind)}>
              {REPEATS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
              {repeat === "cron" && <option value="cron">Custom (cron)</option>}
            </select>
            {repeat === "weekly" && (
              <span className="schedule-days" role="group" aria-label="Days">
                {WEEKDAY_LABELS.map((label, d) => (
                  <button key={label} type="button" aria-pressed={days.includes(d)} onClick={() => toggleDay(d)}>{label}</button>
                ))}
              </span>
            )}
            {repeat === "monthly" && (
              <label className="schedule-inline">
                Day
                <input type="number" min={1} max={31} value={monthDay} onChange={(e) => setMonthDay(Number(e.target.value))} />
              </label>
            )}
            {repeat === "every" && (
              <span className="schedule-inline">
                Every
                <input type="number" min={1} aria-label="Amount" value={amount} onChange={(e) => setAmount(Number(e.target.value))} />
                <select aria-label="Unit" value={unit} onChange={(e) => setUnit(e.target.value as "minutes" | "hours")}>
                  <option value="minutes">minutes</option>
                  <option value="hours">hours</option>
                </select>
              </span>
            )}
            {repeat === "cron" && (
              <input type="text" aria-label="Cron pattern" placeholder="0 9 * * 1-5" value={cron} onChange={(e) => setCron(e.target.value)} />
            )}
            {needsTime && <input type="time" aria-label="Time" value={time} onChange={(e) => setTime(e.target.value)} />}
          </div>
        )}
        <div className="schedule-preview" aria-live="polite">
          {previewError && <p className="schedule-form-error">{previewError}</p>}
          {!previewError && preview && (
            <>
              <p>
                {preview.describe}
                {preview.nextRuns.length > 0 && ` · next ${preview.nextRuns.slice(0, PREVIEW_RUNS).map((at) => fullTime(at)).join(", ")}`}
              </p>
              {preview.warning && <p className="schedule-form-warning">{preview.warning}</p>}
            </>
          )}
        </div>
      </fieldset>

      <fieldset className="schedule-field">
        <legend className="schedule-field-label">Where</legend>
        {edit ? (
          <p className="schedule-where">Runs on <b>{runsOn(edit)}</b></p>
        ) : !picking && target ? (
          <p className="schedule-where">
            This thread: <b>{target.title}</b> · {target.botName}{" "}
            <button type="button" className="schedule-link" onClick={() => setPicking(true)}>Change</button>
          </p>
        ) : (
          <ThreadPicker bots={bots} value={target} onChange={setTarget} />
        )}
        {!edit && target?.jarvis && (
          <div className="schedule-jarvis-note" role="note">
            <p>{JARVIS_TARGET_NOTE}</p>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => onAskJarvis(target, askJarvisDraft(prompt, preview?.describe))}
            >
              Ask Jarvis instead
            </button>
          </div>
        )}
      </fieldset>

      <fieldset className="schedule-field">
        <legend className="schedule-field-label">Tell me</legend>
        <div className="schedule-seg" role="radiogroup" aria-label="Tell me">
          {NOTIFY_CHOICES.map((n) => (
            <label key={n.value} className={effectiveNotify === n.value ? "selected" : undefined}>
              <input
                type="radio"
                name={`${id}-notify`}
                checked={effectiveNotify === n.value}
                onChange={() => setNotify(n.value)}
              />
              {n.label}
              {notify === null && preview?.defaultNotify === n.value && " (default)"}
            </label>
          ))}
        </div>
        {suggestion && (
          <p className="schedule-suggest">
            {suggestion.text} ·{" "}
            <button type="button" className="schedule-link" onClick={() => setNotify(suggestion.notify)}>Use it</button>
          </p>
        )}
      </fieldset>

      <details className="schedule-advanced" open={advanced} onToggle={(e) => setAdvanced((e.target as HTMLDetailsElement).open)}>
        <summary>Advanced</summary>
        {mode === "repeats" && (
          <>
            <label className="schedule-inline">
              Stop after
              <input type="number" min={1} aria-label="Stop after N runs" value={maxRuns} onChange={(e) => setMaxRuns(e.target.value)} />
              runs
            </label>
            <label className="schedule-inline">
              End on
              <input type="datetime-local" aria-label="End on" value={endsLocal} onChange={(e) => setEndsLocal(e.target.value)} />
            </label>
          </>
        )}
        <label className="schedule-inline">
          If the thread is busy
          <select value={overlap} onChange={(e) => setOverlap(e.target.value as "queue" | "skip")}>
            <option value="queue">wait</option>
            <option value="skip">skip</option>
          </select>
        </label>
        <label className="schedule-inline">
          Time zone
          <select value={tz} onChange={(e) => setTz(e.target.value)}>
            {zones.map((z) => <option key={z} value={z}>{z}</option>)}
          </select>
        </label>
        <button
          type="button"
          className="schedule-link"
          onClick={() => {
            setMode("repeats");
            setRepeat("cron");
          }}
        >
          Custom (cron)…
        </button>
      </details>

      {saveError && <p className="schedule-form-error" role="alert">{saveError}</p>}
      {edit && confirming ? (
        <OwnWordsConfirm
          busy={saving}
          onConfirm={() => saveEdit(confirming.resume, true)}
          onOpenJarvis={edit.createdIn && onOpen ? () => onOpen(edit.createdIn!.botId, edit.createdIn!.threadId) : undefined}
          onCancel={() => setConfirming(null)}
        />
      ) : edit ? (
        <div className="schedule-form-actions">
          <button type="button" className="btn-secondary" onClick={onCancel}>Cancel</button>
          {canSaveResume && (
            <button type="button" className="btn-secondary" disabled={!ready || saving} onClick={() => ready && !saving && saveEdit(true)}>Save and resume</button>
          )}
          <button type="button" className="btn-primary" disabled={!ready || !changed || saving} onClick={() => ready && changed && !saving && saveEdit(false)}>{saving ? "Saving…" : "Save"}</button>
        </div>
      ) : (
        <div className="schedule-form-actions">
          <button type="button" className="btn-secondary" onClick={onCancel}>Cancel</button>
          <button type="button" className="btn-primary" disabled={!ready || saving} onClick={() => ready && !saving && save()}>{saving ? "Saving…" : "Save"}</button>
        </div>
      )}
    </form>
  );
}
