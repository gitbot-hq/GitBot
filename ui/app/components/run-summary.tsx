"use client";

import AnimatedActionIcon from "./animated-action-icon";
import { ChevronDownIcon } from "@animateicons/react/lucide/chevron-down-icon";

import { useState } from "react";
import { createPortal } from "react-dom";
import { IconBolt } from "@tabler/icons-react";
import {
  changedPath,
  extractChangedFiles,
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

// End-of-turn footer: how many calls, how long, which files changed. The
// calls themselves sit inline in the reply, where they happened (see
// SegmentList in chat.tsx), so this does not list them again. Hovering a
// file chip previews the calls behind it. Diff counts/lines need the
// backend and slot into that preview when it provides them.
export default function RunSummary({
  tools,
  secs,
  stopped,
}: {
  tools: ToolChip[];
  secs?: number;
  stopped?: boolean;
}) {
  // Hover preview, flipped above/below to fit. Rendered in a body portal
  // so reply transforms can't trap it.
  const [preview, setPreview] = useState<{
    file: string;
    x: number;
    top?: number;
    bottom?: number;
  } | null>(null);
  const files = extractChangedFiles(tools);
  const bits = [`${tools.length} tool call${tools.length === 1 ? "" : "s"}`];
  if (secs != null) bits.push(`${secs}s`);
  if (files.length > 0) bits.push(`${files.length} file${files.length === 1 ? "" : "s"} changed`);
  const line = (stopped ? "Stopped · " : "") + bits.join(" · ");

  const related = (file: string) => tools.filter((t) => changedPath(t) === file);

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
      <p className="run-foot tabular-nums">{line}</p>
      {files.length > 0 && (
        <div className="file-chips">
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
