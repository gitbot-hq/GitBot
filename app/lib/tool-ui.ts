import {
  IconBolt,
  IconFilePlus,
  IconFileText,
  IconFolder,
  IconPencil,
  IconSearch,
  IconTerminal2,
} from "@tabler/icons-react";

// Shared vocabulary for rendering tool calls: icons, verbs, grouping,
// file extraction. Both the live timeline and the end-of-turn run card
// speak this language, so a turn reads the same alive and archived.

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

/** All calls grouped by tool, first-seen order (end-of-turn card). */
export function groupAllTools(
  tools: ToolChip[],
): { name: string; items: ToolChip[] }[] {
  const groups: { name: string; items: ToolChip[] }[] = [];
  const at = new Map<string, number>();
  for (const t of tools) {
    const i = at.get(t.name);
    if (i === undefined) {
      at.set(t.name, groups.length);
      groups.push({ name: t.name, items: [t] });
    } else {
      groups[i].items.push(t);
    }
  }
  return groups;
}

/** Files a turn changed (edits + writes with a path input), unique, in
 *  order. Reads stay rows, not chips. Diffs/counts need the backend. */
export function extractChangedFiles(tools: ToolChip[]): string[] {
  const out: string[] = [];
  for (const t of tools) {
    if (t.name !== "Edit" && t.name !== "Write") continue;
    const p = (t.input as { path?: unknown } | null)?.path;
    if (typeof p === "string" && p && !out.includes(p)) out.push(p);
  }
  return out;
}
