"use client";

import { useEffect, useState } from "react";
import { getAnalysis, getAgents, runAnalysisNow, saveAnalysis } from "../lib/api";
import type { AnalysisInput, AnalysisSchedule, Bot, ThreadFull } from "../lib/gitbot";

export default function AnalysisControls({ bot, onOpenThread }: { bot: Bot; onOpenThread: (thread: ThreadFull) => void }) {
  const [input, setInput] = useState<AnalysisInput | null>(null);
  const [schedule, setSchedule] = useState<AnalysisSchedule | null>(null);
  const [lastThread, setLastThread] = useState<ThreadFull | null>(null);
  const [timezone, setTimezone] = useState("");
  const [agentMissing, setAgentMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const setupPending = !!bot.setupInstructions?.trim() && bot.setupStatus !== "complete";
  useEffect(() => {
    let live = true;
    async function load(first: boolean) {
      try {
        const result = await getAnalysis(bot.id);
        if (!live) return;
        setSchedule(result.schedule);
        setLastThread(result.lastThread);
        setTimezone(result.timezone);
        if (first) setInput(result.schedule ?? {
          repoPath: result.defaultRepoPath, branch: "HEAD", prompt: "Review this branch for risks and suggest verification steps. Report findings without changing files.", time: "09:00", enabled: false,
        });
      } catch (e) { if (live) setError(e instanceof Error ? e.message : String(e)); }
    }
    void load(true);
    getAgents().then(({ agents }) => { if (live) setAgentMissing(!agents.includes(bot.agent || "claude-code")); }, () => {});
    const timer = setInterval(() => void load(false), 15000);
    return () => { live = false; clearInterval(timer); };
  }, [bot.id, bot.agent]);

  function change(patch: Partial<AnalysisInput>) {
    setInput(current => current ? { ...current, ...patch } : current);
    setNotice("");
    setError("");
  }
  async function submit(runNow: boolean) {
    if (!input || busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      if (runNow) {
        const { thread } = await runAnalysisNow(bot.id, input);
        onOpenThread(thread);
      } else {
        const { schedule: saved } = await saveAnalysis(bot.id, input);
        setSchedule(saved);
        setInput(saved);
        setNotice(saved.enabled ? "Daily schedule saved" : "Schedule saved · daily runs paused");
      }
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  function date(iso: string) {
    return new Date(iso).toLocaleString(undefined, { timeZone: timezone || undefined, dateStyle: "medium", timeStyle: "short" });
  }
  return (
    <section className="analysis-controls" aria-label={`Analysis for ${bot.name}`}>
      <header>
        <h3>Analysis for {bot.name}</h3>
        <p>Run a check now or once a day. Each result gets its own thread.</p>
      </header>
      <p className="analysis-boundary"><strong>Plan only</strong> · Manual follow-up<br />Analysis reports findings. It does not run tests, edit files, or start follow-up work.</p>
      {!input ? <p role="status">Loading analysis settings…</p> : (
        <form onSubmit={event => { event.preventDefault(); void submit(false); }}>
          <fieldset disabled={busy}>
            <div className="field">
              <label htmlFor={`analysis-folder-${bot.id}`}>Repository folder</label>
              <input id={`analysis-folder-${bot.id}`} value={input.repoPath} required onChange={event => change({ repoPath: event.target.value })} />
            </div>
            <div className="field">
              <label htmlFor={`analysis-branch-${bot.id}`}>Local branch or Git ref</label>
              <input id={`analysis-branch-${bot.id}`} value={input.branch} required onChange={event => change({ branch: event.target.value })} />
              <p className="hint">HEAD means the current commit. GitBot does not check out branches or fetch updates.</p>
            </div>
            <div className="field">
              <label htmlFor={`analysis-task-${bot.id}`}>Analysis task</label>
              <textarea id={`analysis-task-${bot.id}`} value={input.prompt} rows={3} required maxLength={20000} onChange={event => change({ prompt: event.target.value })} />
            </div>
            <div className="analysis-timing">
              <label><input type="checkbox" checked={input.enabled} onChange={event => change({ enabled: event.target.checked })} /> Run daily</label>
              <label>Daily time <input type="time" value={input.time} required onChange={event => change({ time: event.target.value })} /></label>
              <span>{timezone}</span>
            </div>
            <p className="analysis-note">GitBot must be running and this computer awake. Missed runs are skipped; analyses for this bot do not overlap.</p>
            <div className="analysis-actions">
              <button type="submit" className="btn-secondary">{busy ? "Working…" : "Save schedule"}</button>
              <button type="button" className="btn-primary" disabled={setupPending || agentMissing || lastThread?.analysis?.status === "running"} onClick={() => void submit(true)}>Run analysis now</button>
            </div>
          </fieldset>
        </form>
      )}
      {(setupPending || agentMissing) && <p className="field-warn">{setupPending ? "Finish bot setup before running analysis." : "Install this bot's agent before running analysis."}</p>}
      {notice && <p role="status">{notice}</p>}
      {error && <p className="chat-error" role="alert">{error}</p>}
      {schedule && <p className="analysis-note">{schedule.enabled && schedule.nextRunAt ? `Next run: ${date(schedule.nextRunAt)} (${timezone})` : "Daily schedule paused"}</p>}
      {schedule?.lastError && <p className="chat-error" role="alert">Last run: {schedule.lastError}</p>}
      {lastThread && <div className="analysis-result">
        <div><strong>Latest analysis · {lastThread.analysis?.status}</strong><p>{lastThread.analysis?.branch} · {lastThread.analysis?.commit.slice(0, 8)}{schedule?.lastRunAt ? ` · ${date(schedule.lastRunAt)}` : ""}</p></div>
        <button type="button" className="btn-secondary" onClick={() => onOpenThread(lastThread)}>Open result thread</button>
      </div>}
    </section>
  );
}
