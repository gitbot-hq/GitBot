"use client";

import { useEffect, useId, useState } from "react";
import { getProjects } from "../lib/api";
import type { ProjectFolder } from "../lib/gitbot";
import { projectMatches } from "../lib/schedule-when";

/**
 * The new-thread target's project: a searchable list from GET /projects
 * (read once on open). A project whose folder is gone is shown disabled,
 * "folder not found". Adding a folder has no route yet.
 */
export default function ProjectPicker({
  value,
  onChange,
}: {
  value: ProjectFolder | null;
  onChange: (project: ProjectFolder) => void;
}) {
  const [projects, setProjects] = useState<ProjectFolder[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const name = useId();

  useEffect(() => {
    let live = true;
    getProjects().then(
      (r) => live && setProjects(r.projects),
      (e) => live && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, []);

  const matches = projects ? projectMatches(projects, query) : [];

  return (
    <div className="thread-picker">
      <input
        type="search"
        className="thread-picker-search"
        placeholder="Search projects"
        aria-label="Search projects"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          // Enter never reaches the form: it picks the match when there is exactly one.
          if (e.key !== "Enter") return;
          e.preventDefault();
          const present = matches.filter((p) => p.present);
          if (present.length === 1) onChange(present[0]);
        }}
      />
      <div className="thread-picker-list" role="radiogroup" aria-label="Project">
        {error && <p className="schedule-form-error">{error}</p>}
        {!projects && !error && <p className="schedules-view-note">Loading…</p>}
        {projects && projects.length === 0 && (
          <p className="schedules-view-note">No projects yet. Open a thread in a folder, or ask Jarvis to add one.</p>
        )}
        {projects && projects.length > 0 && matches.length === 0 && <p className="schedules-view-note">No projects match.</p>}
        {matches.map((p) => (
          <label
            key={`${p.id}:${p.path}`}
            className={`thread-picker-row${value?.id === p.id ? " selected" : ""}${p.present ? "" : " disabled"}`}
            title={p.path}
          >
            <input type="radio" name={name} disabled={!p.present} checked={value?.id === p.id} onChange={() => onChange(p)} />
            <span>
              {p.name}
              {!p.present && <em> · folder not found</em>}
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}
