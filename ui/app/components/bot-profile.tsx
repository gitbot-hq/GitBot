"use client";

import { useEffect, useState } from "react";
import { PanelBack } from "./panel-controls";
import ShareDropdown from "./share-dropdown";
import BotFace from "./bot-face";
import { getThreads } from "../lib/api";
import type { Bot, ThreadFull } from "../lib/gitbot";
import type { AvatarPref } from "../lib/avatar-prefs";

const AGENT_LABELS: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
};

const PERMISSION_LABELS: Record<string, string> = {
  "ask-permissions": "Ask when needed",
  "auto-approve": "Run without asking",
  plan: "Plan only",
};

function permissionLabel(bot: Bot): string {
  if (bot.agent === "codex") {
    if (bot.permissionMode === "ask-permissions") return "Ask to make changes";
    if (bot.permissionMode === "auto-approve") return "Full access";
    if (bot.permissionMode === "plan") return "Read only";
  }
  return PERMISSION_LABELS[bot.permissionMode] ?? bot.permissionMode ?? "—";
}

function timeAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

/** Contribution grid: one square per day, columns are weeks. Setup
 *  runs excluded. Future days come back null (left blank). */
const CONTRIB_WEEKS = 52;

function contributionBuckets(threads: ThreadFull[]) {
  const counts = new Map<string, number>();
  for (const t of threads) {
    if (t.kind === "setup") continue;
    const key = new Date(t.updatedAt).toISOString().slice(0, 10);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const total = CONTRIB_WEEKS * 7;
  const weeks: ({ date: Date; count: number } | null)[][] = [];
  for (let w = 0; w < CONTRIB_WEEKS; w++) {
    const col: ({ date: Date; count: number } | null)[] = [];
    for (let d = 0; d < 7; d++) {
      const date = new Date(today);
      date.setDate(date.getDate() - (total - 1 - (w * 7 + d)));
      col.push(
        date > today
          ? null
          : {
              date,
              count:
                counts.get(date.toISOString().slice(0, 10)) ?? 0,
            },
      );
    }
    weeks.push(col);
  }
  return weeks;
}

function levelColor(count: number, color: string): string {
  if (count <= 0) return "var(--surface-2)";
  if (count === 1) return `color-mix(in srgb, ${color} 35%, var(--surface-2))`;
  if (count <= 3) return `color-mix(in srgb, ${color} 65%, var(--surface-2))`;
  return color;
}

// Bot profile: cover, identity, facts, and its edit/share actions. Sharing
// owns both the portable-code and future marketplace paths. The cover is
// generative — the bot's own brand color — so
// there is nothing to store or upload.
export default function BotProfile({
  bot,
  pref,
  onBack,
  onEdit,
  onShare,
  active = true,
}: {
  bot: Bot;
  pref: AvatarPref;
  onBack: () => void;
  onEdit: () => void;
  onShare: (view: "code" | "publish") => void;
  active?: boolean;
}) {
  const [shareOpen, setShareOpen] = useState(false);
  useEffect(() => { if (!active) setShareOpen(false); }, [active]);
  const [threads, setThreads] = useState<ThreadFull[] | null>(null);

  useEffect(() => {
    let live = true;
    getThreads(bot.id).then(
      ({ threads }) => {
        if (live) setThreads(threads);
      },
      () => {
        if (live) setThreads([]);
      },
    );
    return () => {
      live = false;
    };
  }, [bot.id]);

  useEffect(() => {
    function esc(ev: KeyboardEvent) {
      if (active && !shareOpen && ev.key === "Escape") onBack();
    }
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [active, onBack, shareOpen]);

  const chat = (threads ?? []).filter((t) => t.kind !== "setup");
  const setupPending = !!bot.setupInstructions && bot.setupStatus !== "complete";
  const messages = chat.reduce((n, t) => n + (t.messageCount || 0), 0);
  const lastActive = chat.length
    ? timeAgo(
        chat.reduce((a, b) => (a.updatedAt > b.updatedAt ? a : b)).updatedAt,
      )
    : "—";
  const weeks = threads ? contributionBuckets(threads) : null;

  return (
    <div className="profile-pane" aria-label={`${bot.name} profile`}>
      <PanelBack onClick={onBack} />
      <div className="profile-pane-inner">
      <div className="profile-cover-wrap">
        <div
          className="profile-cover"
          style={{
            background: `linear-gradient(115deg, ${pref.color} 0%, color-mix(in srgb, ${pref.color} 45%, var(--surface)) 100%)`,
          }}
          aria-hidden="true"
        />
        <span className={`profile-avatar${setupPending ? " needs-setup" : ""}`}>
          <BotFace
            mascot={pref.mascot}
            size={88}
            color={pref.color}
            still={setupPending}
            unpowered={setupPending}
          />
        </span>
      </div>
      <div className="profile-head">
        <div>
          <h2>{bot.name}</h2>
          {setupPending ? (
            <p className="profile-setup-status">
              <i aria-hidden="true" />
              Needs setup
            </p>
          ) : null}
          {bot.description ? <p>{bot.description}</p> : null}
        </div>
        <div className="profile-acts">
          <ShareDropdown open={shareOpen} onOpenChange={setShareOpen} onShare={onShare} label />
          <button type="button" className="btn-secondary" onClick={onEdit}>
            Edit
          </button>
        </div>
      </div>
      {threads == null ? (
        <div className="skel profile-loading" aria-label="Loading activity">
          <i style={{ width: "70%" }} />
          <i style={{ width: "45%" }} />
        </div>
      ) : (
        <>
          <div className="profile-stats" aria-label="Activity totals">
            <div>
              <b>{chat.length}</b>
              <span>{chat.length === 1 ? "Thread" : "Threads"}</span>
            </div>
            <div>
              <b>{messages}</b>
              <span>{messages === 1 ? "Message" : "Messages"}</span>
            </div>
            <div>
              <b>{lastActive}</b>
              <span>Active</span>
            </div>
          </div>
          <div className="profile-contrib" aria-label="Activity grid">
            {weeks!.map((col, w) => (
              <span key={w} className="contrib-col">
                {col.map((cell, d) =>
                  cell == null ? (
                    <i key={d} className="contrib-blank" />
                  ) : (
                    <i
                      key={d}
                      title={`${cell.date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}: ${cell.count} thread${cell.count === 1 ? "" : "s"}`}
                      style={{ background: levelColor(cell.count, pref.color) }}
                    />
                  ),
                )}
              </span>
            ))}
          </div>
          <p className="profile-contrib-legend" aria-hidden="true">
            Less
            {[0, 1, 2, 3].map((l) => (
              <i
                key={l}
                style={{
                  background: levelColor(l === 0 ? 0 : l === 1 ? 1 : l === 2 ? 3 : 5, pref.color),
                }}
              />
            ))}
            More
          </p>
        </>
      )}
      <dl className="profile-meta">
        <div>
          <dt>Agent</dt>
          <dd>{AGENT_LABELS[bot.agent] ?? bot.agent ?? "—"}</dd>
        </div>
        <div>
          <dt>Model</dt>
          <dd>{bot.model || "Default"}</dd>
        </div>
        <div>
          <dt>Permissions</dt>
          <dd>{permissionLabel(bot)}</dd>
        </div>
        <div>
          <dt>Tools</dt>
          <dd title={bot.allowedTools?.join(", ")}>
            {bot.allowedTools?.length ? bot.allowedTools.join(", ") : "All tools"}
          </dd>
        </div>
      </dl>
      </div>
    </div>
  );
}
