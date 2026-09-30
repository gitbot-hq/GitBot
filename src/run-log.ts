import { execFileSync } from "child_process";
import { addRun, listRuns, type RunFinding, type RunRecord } from "./bot-store";
import type { SessionStore } from "./server-common";

// Run records for bots that repeat the same check. A tracked bot ends each run
// with a fenced `gitbot-run` block; gitbot reads it when the turn finishes,
// compares it with the bot's previous run in the same folder and branch, and
// saves the result. The previous run's findings are handed to the next run so
// the bot can reuse their keys — that is what makes "recurring" and "resolved"
// mean something without fuzzy matching.

const FENCE = "gitbot-run";
const MAX_FINDINGS = 200;
const MAX_FILES = 500;
/** Enough for the bot to recognise its earlier findings without flooding the prompt. */
const MAX_PROMPT_FINDINGS = 60;

/** The latest run this bot made in this folder, on this branch when it has one. */
export function previousRun(botId: string, repoPath: string): RunRecord | undefined {
  const branch = gitInfo(repoPath).branch;
  const runs = listRuns({ botId, repoPath });
  return runs.find((r) => r.branch === branch) ?? runs[0];
}

/** The prompt section that asks for the report and shows the previous run. */
export function runRecordPrompt(previous: RunRecord | undefined): string {
  const lines = [
    "RUN RECORD:",
    "This bot keeps a record of its runs. When a run of your job is finished, end your",
    `final message with one fenced code block whose language is \`${FENCE}\`, holding JSON:`,
    "",
    "```" + FENCE,
    '{"summary": "<one or two sentences on this run>",',
    ' "changedFiles": ["<path relative to the repo>", ...],',
    ' "findings": [{"key": "<short-kebab-slug>", "title": "<one line>", "file": "<path>", "line": 42, "severity": "high|medium|low"}]}',
    "```",
    "",
    "changedFiles are the files the run looked at because they changed. findings are",
    "the problems still present now; leave out anything already fixed. key names the",
    "issue itself, not its position, so the same problem keeps the same key from run",
    "to run even when its line moves. file, line and severity are optional. Write the",
    "block once per run, only when the job has actually run — not while chatting,",
    "not as an example. An empty findings list is a valid result.",
  ];
  if (previous) {
    lines.push(
      "",
      `The previous run (${previous.createdAt.slice(0, 16).replace("T", " ")} UTC) reported:`,
    );
    if (!previous.findings.length) lines.push("- no findings");
    for (const f of previous.findings.slice(0, MAX_PROMPT_FINDINGS)) {
      const where = f.file ? ` (${f.file}${f.line ? `:${f.line}` : ""})` : "";
      lines.push(`- ${f.key}: ${f.title}${where}`);
    }
    if (previous.findings.length > MAX_PROMPT_FINDINGS) {
      lines.push(`- …and ${previous.findings.length - MAX_PROMPT_FINDINGS} more`);
    }
    lines.push(
      "When one of these is still present, report it again with the same key. Do not",
      "report it if it has been fixed; gitbot marks it resolved.",
    );
  }
  return lines.join("\n");
}

/**
 * Saves the run a tracked bot just reported, if it reported one. Reads only the
 * turn's own top-level `assistant` events, like the setup verdict; the last
 * block wins. Call it when the turn ends, before `done`.
 */
export function recordRunFromEvents(store: SessionStore): RunRecord | undefined {
  const preset = store.botPreset;
  if (!preset?.trackRuns || preset.setup || !store.threadId) return undefined;
  const text = store.events
    .filter((e) => e.type === "assistant" && !(e as any).parent_tool_use_id)
    .map((e) => String((e as any).content ?? ""))
    .join("\n");
  const report = parseRunReport(text);
  if (!report) return undefined;

  try {
    const git = gitInfo(store.repoPath);
    const previous = previousRun(preset.id, store.repoPath);
    const { findings, resolved } = compareFindings(report.findings, previous?.findings ?? []);
    const changedFiles = report.changedFiles.length
      ? report.changedFiles
      : changedSince(store.repoPath, previous?.head);
    return addRun({
      botId: preset.id,
      threadId: store.threadId,
      repoPath: store.repoPath,
      ...(git.branch ? { branch: git.branch } : {}),
      ...(git.head ? { head: git.head } : {}),
      summary: report.summary,
      changedFiles,
      findings,
      resolved,
      ...(previous ? { previousRunId: previous.id } : {}),
    });
  } catch (err: any) {
    console.error(`[run-log] could not record run: ${err.message}`);
    return undefined;
  }
}

type RunReport = { summary: string; changedFiles: string[]; findings: RunFinding[] };

/** The last well-formed `gitbot-run` block in the text, cleaned; null if none. */
export function parseRunReport(text: string): RunReport | null {
  const blocks = [...text.matchAll(new RegExp("```" + FENCE + "[^\\n]*\\n([\\s\\S]*?)```", "g"))];
  for (let i = blocks.length - 1; i >= 0; i--) {
    let raw: any;
    try { raw = JSON.parse(blocks[i][1]); } catch { continue; }
    if (!raw || typeof raw !== "object") continue;
    const findings: RunFinding[] = [];
    const seen = new Set<string>();
    for (const f of Array.isArray(raw.findings) ? raw.findings : []) {
      const title = str(f?.title, 300);
      if (!title) continue;
      const file = str(f?.file, 500);
      const base = slug(str(f?.key, 80) || `${file ?? ""} ${title}`);
      // Two findings under one key would collapse into one; keep both.
      let key = base;
      for (let n = 2; seen.has(key); n++) key = `${base}-${n}`;
      seen.add(key);
      const line = Number.isInteger(f?.line) && f.line > 0 ? f.line : undefined;
      const severity = str(f?.severity, 20)?.toLowerCase();
      findings.push({ key, title, ...(file ? { file } : {}), ...(line ? { line } : {}), ...(severity ? { severity } : {}) });
      if (findings.length >= MAX_FINDINGS) break;
    }
    const changedFiles = (Array.isArray(raw.changedFiles) ? raw.changedFiles : [])
      .map((p: unknown) => str(p, 500))
      .filter((p: string | undefined): p is string => !!p)
      .filter((p: string, idx: number, all: string[]) => all.indexOf(p) === idx)
      .slice(0, MAX_FILES);
    return { summary: str(raw.summary, 1000) ?? "", changedFiles, findings };
  }
  return null;
}

/**
 * Marks each finding new or recurring against the previous run, and returns the
 * previous findings that are gone. A key match is the rule; the same title on
 * the same file also counts, for a bot that drifted on a key.
 */
export function compareFindings(current: RunFinding[], previous: RunFinding[]) {
  const matched = new Set<RunFinding>();
  const findings = current.map((f) => {
    const before =
      previous.find((p) => !matched.has(p) && p.key === f.key) ??
      previous.find((p) => !matched.has(p) && p.file === f.file && norm(p.title) === norm(f.title));
    if (before) matched.add(before);
    return { ...f, status: before ? ("recurring" as const) : ("new" as const) };
  });
  const resolved = previous.filter((p) => !matched.has(p)).map(({ status: _s, ...f }) => f);
  return { findings, resolved };
}

function gitInfo(repoPath: string): { branch?: string; head?: string } {
  const branch = git(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const head = git(repoPath, ["rev-parse", "HEAD"]);
  return {
    ...(branch && branch !== "HEAD" ? { branch } : {}),
    ...(head ? { head } : {}),
  };
}

/** Files committed since `head` plus what is uncommitted now, for a bot that listed none. */
function changedSince(repoPath: string, head: string | undefined): string[] {
  const committed = head ? git(repoPath, ["diff", "--name-only", `${head}..HEAD`]) : undefined;
  // Porcelain lines are "XY path"; the status column can start with a space,
  // so this output must not be trimmed before slicing.
  const dirty = git(repoPath, ["status", "--porcelain"], false)
    ?.split("\n")
    .map((l) => l.slice(3).split(" -> ").pop()!.trim());
  const all = [...(committed?.split("\n") ?? []), ...(dirty ?? [])].filter(Boolean);
  return [...new Set(all)].slice(0, MAX_FILES);
}

function git(cwd: string, args: string[], trim = true): string | undefined {
  try {
    const out = execFileSync("git", args, { cwd, encoding: "utf-8", stdio: "pipe", timeout: 5000 });
    return (trim ? out.trim() : out.replace(/\n+$/, "")) || undefined;
  } catch {
    return undefined;
  }
}

function str(v: unknown, max: number): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "finding";
}

function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}
