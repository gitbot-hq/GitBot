import {
  IconBolt,
  IconFilePlus,
  IconFileText,
  IconFolder,
  IconHelpCircle,
  IconPencil,
  IconSearch,
  IconTerminal2,
} from "@tabler/icons-react";

// Shared vocabulary for rendering tool calls: icons, verbs, grouping,
// file extraction. Live and history replies draw the same rows, so a turn
// reads the same alive and archived; the end-of-turn footer adds the files.

export type ToolChip = { name: string; input: unknown };

// Tool input preview, mirroring the original client: raw string as-is,
// otherwise JSON, capped at 200 chars (the command, the folder, …).
export function toolSummary(input: unknown) {
  const s = typeof input === "string" ? input : JSON.stringify(input ?? {});
  return s.slice(0, 200);
}

// One icon per tool. Unknown tools get the bolt.
export const TOOL_ICONS: Record<string, typeof IconBolt> = {
  Bash: IconTerminal2,
  Read: IconFileText,
  Grep: IconSearch,
  Glob: IconFolder,
  Edit: IconPencil,
  Write: IconFilePlus,
  AskUserQuestion: IconHelpCircle,
};

// Verb + singular/plural noun per known tool for grouped rows.
// Unknown tools fall back to their own name ("MyTool ×3").
const VERB_MAP: Record<string, [string, string, string]> = {
  Read: ["Reading", "file", "files"],
  Grep: ["Searching", "search", "searches"],
  Glob: ["Finding", "path", "paths"],
  Bash: ["Running", "command", "commands"],
  Edit: ["Editing", "edit", "edits"],
  Write: ["Writing", "file", "files"],
  AskUserQuestion: ["Asking", "question", "questions"],
};

export function pluralNoun(name: string, count: number): string {
  const verb = VERB_MAP[name];
  if (!verb) return count === 1 ? "" : `×${count}`;
  return count === 1 ? verb[1] : `${count} ${verb[2]}`;
}

/** Consecutive same-tool calls collapse into one row, order preserved. */
export function groupTools(
  tools: ToolChip[],
): { name: string; items: ToolChip[] }[] {
  const groups: { name: string; items: ToolChip[] }[] = [];
  for (const t of tools) {
    const last = groups[groups.length - 1];
    if (last && last.name === t.name) last.items.push(t);
    else groups.push({ name: t.name, items: [t] });
  }
  return groups;
}

/** The file an edit or write touched, or null for any other call.
 *  Inputs arrive as the server's one-line labels — the path, or for Claude's
 *  Write "path (N chars)" — or, from older records, as `{ path }`. */
export function changedPath(t: ToolChip): string | null {
  if (!/^(edit|write|multiedit)$/i.test(t.name)) return null;
  const input = t.input;
  let p: unknown = null;
  if (typeof input === "string") p = input.replace(/ \([^()]* chars\)$/, "").trim();
  else if (input && typeof input === "object") {
    const o = input as { path?: unknown; file_path?: unknown };
    p = o.path ?? o.file_path;
  }
  // A labeler with nothing to say falls back to the tool's own name.
  return typeof p === "string" && p && p.toLowerCase() !== t.name.toLowerCase() ? p : null;
}

/** Files a turn changed (edits + writes), unique, in order. Reads stay
 *  rows, not chips. Diffs/counts need the backend. */
export function extractChangedFiles(tools: ToolChip[]): string[] {
  const out: string[] = [];
  for (const t of tools) {
    const p = changedPath(t);
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}
