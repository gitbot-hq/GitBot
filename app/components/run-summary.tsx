"use client";

import AnimatedActionIcon from "./animated-action-icon";
import { ChevronDownIcon } from "@animateicons/react/lucide/chevron-down-icon";

import { useState } from "react";
import { createPortal } from "react-dom";
import { IconBolt } from "@tabler/icons-react";
import {
  extractChangedFiles,
  groupAllTools,
  TOOL_ICONS,
  toolSummary,
  type ToolChip,
} from "../lib/tool-ui";

// One activity row: 28px, tool icon that swaps to a chevron on hover
// (or while open), medium label, and the key detail in an inline mono
// chip. Detail expands below on a left rail.
export function ActionRow({
  group,
  open,
  onToggle,
  archived,
}: {
  group: { name: string; items: ToolChip[] };
  open: boolean;
  onToggle: () => void;
  /** History records: always expanded, no toggle chrome. */
  archived?: boolean;
}) {
  const Icon = TOOL_ICONS[group.name] ?? IconBolt;
  const multi = group.items.length > 1;
  const chip = toolSummary(group.items[0].input);
  const head = (
    <>
      <span className="act-icon" aria-hidden="true">
        <span className="act-glyph">
          <Icon size={13} stroke={2} aria-hidden="true" />
        </span>
        {!archived && (
          <AnimatedActionIcon icon={ChevronDownIcon}
            size={12}
            aria-hidden="true"
            className={open ? "act-swap open" : "act-swap"}
          />
        )}
      </span>
      <span className="act-name">{group.name}</span>
      {chip ? <span className="act-chip">{chip}</span> : null}
    </>
  );
  return (
    <div className="act-row">
      {multi && !archived ? (
        <button
          type="button"
          className="act-head"
          onClick={onToggle}
          aria-expanded={open}
        >
          {head}
        </button>
      ) : (
        <div className="act-head static">{head}</div>
      )}
      {(open || archived || !multi) && group.items.length > 1 && (
        <div className="act-items">
          {group.items.map((t, i) => (
            <span key={i} className="act-item" title={toolSummary(t.input)}>
              {toolSummary(t.input)}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// End-of-turn consolidation: every tool call of a finished turn in one
// collapsed card — grouped rows plus the files it changed. Durations come
// from the turn; diff counts/lines need the backend and render when
// present. Collapsed by default; the live timeline stays expanded.
export default function RunSummary({
  tools,
  secs,
  stopped,
}: {
  tools: ToolChip[];
  secs?: number;
  stopped?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [openRows, setOpenRows] = useState<Record<string, boolean>>({});
  // Hover preview: the tool calls behind a file, flipped above/below to
  // fit. Rendered in a body portal so reply transforms can't trap it.
  // (Diff lines slot into this same preview when the backend provides
  // them; until then it shows what each call actually did.)
  const [preview, setPreview] = useState<{
    file: string;
    x: number;
    top?: number;
    bottom?: number;
  } | null>(null);
  const groups = groupAllTools(tools);
  const files = extractChangedFiles(tools);
  const bits = [`${tools.length} tool call${tools.length === 1 ? "" : "s"}`];
  if (secs != null) bits.push(`${secs}s`);
  const header = (stopped ? "Stopped · " : "") + bits.join(" · ");

  const related = (file: string) =>
    tools.filter(
      (t) => (t.input as { path?: unknown } | null)?.path === file,
    );

  const openPreview =
    (file: string) => (event: React.SyntheticEvent) => {
      const target = (event.currentTarget as Element).closest("[data-diffchip]");
      if (!target) return;
      const rect = target.getBoundingClientRect();
      const rows = related(file).length;
      const previewHeight = 44 + rows * 26;
      const fitsBelow = rect.bottom + 6 + previewHeight <= window.innerHeight - 12;
      setPreview({
        file,
        x: Math.max(12, Math.min(rect.left, window.innerWidth - 300)),
        ...(fitsBelow
          ? { top: rect.bottom + 6 }
          : { bottom: window.innerHeight - rect.top + 6 }),
      });
    };
  const closePreview = (file: string) => () =>
    setPreview((current) => (current?.file === file ? null : current));

  return (
    <div className="run-card">
      <button
        type="button"
        className="run-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <AnimatedActionIcon icon={ChevronDownIcon}
          size={13}
          aria-hidden="true"
          className={open ? "act-chev open" : "act-chev"}
        />
        <span className="tabular-nums">{header}</span>
      </button>
      <div className={open ? "run-body open" : "run-body"}>
        <div className="run-clip">
          {groups.map((g) => (
            <ActionRow
              key={g.name}
              group={g}
              open={!!openRows[g.name]}
              onToggle={() =>
                setOpenRows((prev) => ({ ...prev, [g.name]: !prev[g.name] }))
              }
            />
          ))}
          {files.length > 0 && (
            <div className="file-chips">
              <span className="file-label">Changed files</span>
              {files.map((f, i) => (
                <span
                  key={f}
                  data-diffchip
                  onMouseEnter={openPreview(f)}
                  onMouseLeave={closePreview(f)}
                >
                  <button
                    type="button"
                    className="file-chip"
                    style={{ animationDelay: `${i * 80}ms` }}
                    aria-expanded={preview?.file === f}
                    aria-label={`Calls behind ${f}`}
                    onFocus={openPreview(f)}
                    onBlur={closePreview(f)}
                  >
                    <span>{f}</span>
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
      {preview && typeof document !== "undefined" &&
        createPortal(
          <div
            className="diff-preview"
            style={{
              left: preview.x,
              top: preview.top,
              bottom: preview.bottom,
            }}
          >
            <div className="diff-preview-head">
              <span>{preview.file}</span>
            </div>
            <div className="diff-preview-body">
              {related(preview.file).map((t, i) => {
                const RelatedIcon = TOOL_ICONS[t.name] ?? IconBolt;
                return (
                  <div key={i} className="diff-preview-row">
                    <RelatedIcon size={13} stroke={2} aria-hidden="true" />
                    <span>{t.name}</span>
                    <span className="diff-preview-input">
                      {toolSummary(t.input)}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
