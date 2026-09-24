"use client";

import AnimatedActionIcon from "./animated-action-icon";
import { CheckIcon } from "@animateicons/react/lucide/check-icon";
import { CopyIcon } from "@animateicons/react/lucide/copy-icon";
import { RefreshCwIcon } from "@animateicons/react/lucide/refresh-cw-icon";
import { ShieldCheckIcon } from "@animateicons/react/lucide/shield-check-icon";
import { PlayIcon } from "@animateicons/react/lucide/play-icon";
import { SlidersHorizontalIcon } from "@animateicons/react/lucide/sliders-horizontal-icon";
import { LaptopIcon } from "@animateicons/react/lucide/laptop-icon";

import { useCallback, useEffect, useRef, useState } from "react";

import { BackButton } from "./panel-controls";
import Link from "./page-link";
import { createBot, getAgents, getBots } from "../lib/api";
import { setAvatarPref } from "../lib/avatar-prefs";
import { useScrollEdge } from "../lib/use-scroll-edge";
import { getMarketplaceBot, recordMarketplaceInstall, type MarketplaceAgent, type MarketplaceBotCard, type MarketplaceBotDetail } from "../lib/marketplace";
import MarketplaceInstallButton from "./marketplace-install-button";
import MarketplaceAuthor from "./marketplace-author";
import MarketplaceMascot from "./marketplace-mascot";
import type { BotActivity } from "./bot-maker/registry";
import type { Bot } from "../lib/gitbot";

const AGENT_LABELS: Record<MarketplaceAgent, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
};

const PERMISSION_COPY: Record<MarketplaceBotDetail["permissionMode"], { label: string; detail: string }> = {
  "ask-permissions": { label: "Asks before each tool", detail: "You approve every command and file change." },
  "auto-approve": { label: "Published as auto-approve", detail: "Installs as ask-before-each-tool. You can loosen it later in the bot's settings." },
  plan: { label: "Plan only", detail: "Reads and thinks, but never edits files." },
};

/** What an installed copy carries. Published auto-approve is downgraded: a stranger's bot never starts with a free hand. */
function installPermissionMode(mode: MarketplaceBotDetail["permissionMode"]): Bot["permissionMode"] {
  return mode === "auto-approve" ? "ask-permissions" : mode;
}

type DetailState =
  | { status: "loading"; detail: null }
  | { status: "ready"; detail: MarketplaceBotDetail }
  | { status: "error"; detail: null; message: string };

export default function MarketplaceBotDetails({ bot, open, onClose }: {
  bot: MarketplaceBotCard | null;
  open: boolean;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<DetailState>({ status: "loading", detail: null });
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const [installs, setInstalls] = useState<Record<string, "installing" | "completing" | "installed">>({});
  const [installTiming, setInstallTiming] = useState<Record<string, { startedAt: number; duration: number }>>({});
  const [installErrors, setInstallErrors] = useState<Record<string, string>>({});
  const [savedBots, setSavedBots] = useState<Bot[]>([]);
  const pendingInstalls = useRef(new Set<string>());
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const slug = bot?.slug ?? null;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open) {
      if (!dialog.open) dialog.show();
      if (scrollRef.current) scrollRef.current.scrollTop = 0;
      return;
    }
    const timer = window.setTimeout(() => dialog.close(), window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 420);
    return () => window.clearTimeout(timer);
  }, [open]);

  const loadDetail = useCallback(() => {
    if (!slug) return;
    const current = slug;
    setState({ status: "loading", detail: null });
    getMarketplaceBot(current)
      .then(({ bot: detail }) => { if (slug === current) setState({ status: "ready", detail }); })
      .catch((error) => setState({ status: "error", detail: null, message: error instanceof Error ? error.message : "Could not load this bot" }));
  }, [slug]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    setCopied(false);
    setCopyError(false);
    if (copyTimer.current) clearTimeout(copyTimer.current);
    if (open) loadDetail();
  }, [slug, open, loadDetail]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    getBots().then(({ bots }) => {
      if (!cancelled) setSavedBots(bots);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        onClose();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  useEffect(() => () => {
    if (copyTimer.current) clearTimeout(copyTimer.current);
  }, []);

  const scrollEdge = useScrollEdge(scrollRef, `${open}:${slug ?? ""}`);

  const detail = state.status === "ready" ? state.detail : null;
  // The installed copy is the one whose instructions match the library verbatim.
  const installedBot = bot && detail
    ? savedBots.find((candidate) => candidate.name === bot.name && candidate.instructions === detail.instructions)
    : null;
  const pendingState = slug ? installs[slug] : undefined;
  const installState = pendingState === "installing" || pendingState === "completing"
    ? pendingState
    : installedBot ? "installed" : "idle";

  async function installBot() {
    if (!bot || !detail || pendingInstalls.current.has(bot.slug) || installedBot) return;
    const selected = detail;
    const key = bot.slug;
    const color = dialogRef.current
      ? getComputedStyle(dialogRef.current).getPropertyValue(`--${selected.mascot.color}`).trim() || selected.mascot.cssColor
      : selected.mascot.cssColor;
    const startedAt = performance.now();
    const duration = 2000 + Math.random() * 500;
    pendingInstalls.current.add(key);
    setInstallTiming((previous) => ({ ...previous, [key]: { startedAt, duration } }));
    setInstalls((previous) => ({ ...previous, [key]: "installing" }));
    setInstallErrors((previous) => ({ ...previous, [key]: "" }));
    try {
      const { agents } = await getAgents();
      if (!agents.includes(selected.agent)) {
        throw new Error(`Install ${AGENT_LABELS[selected.agent]} to add this bot. It was written for that agent.`);
      }
      const { bots } = await getBots();
      setSavedBots(bots);
      const existing = bots.find((candidate) => candidate.name === selected.name && candidate.instructions === selected.instructions);
      if (!existing) {
        const { bot: created } = await createBot({
          name: selected.name,
          description: selected.description,
          emoji: selected.emoji,
          agent: selected.agent,
          instructions: selected.instructions,
          permissionMode: installPermissionMode(selected.permissionMode),
          ...(selected.model ? { model: selected.model } : {}),
          ...(selected.setupInstructions ? { setupInstructions: selected.setupInstructions } : {}),
          ...(selected.allowedTools?.length ? { allowedTools: selected.allowedTools } : {}),
          ...(selected.disallowedTools?.length ? { disallowedTools: selected.disallowedTools } : {}),
        });
        setAvatarPref(created.id, { mascot: selected.mascot.body as Parameters<typeof setAvatarPref>[1]["mascot"], color });
        setSavedBots((previous) => [...previous, created]);
        // A count, nothing more. Never let it block or fail the install.
        recordMarketplaceInstall(selected.slug, selected.agent).catch(() => {});
      }
      // Keep the presentation at least 2–2.5s, but never finish before the API.
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, duration - 180 - (performance.now() - startedAt))));
      setInstalls((previous) => ({ ...previous, [key]: "completing" }));
      await new Promise((resolve) => setTimeout(resolve, 180));
      setInstalls((previous) => ({ ...previous, [key]: "installed" }));
    } catch (error) {
      setInstalls((previous) => {
        const next = { ...previous };
        delete next[key];
        return next;
      });
      setInstallErrors((previous) => ({ ...previous, [key]: error instanceof Error ? error.message : "Could not install this bot. Please try again." }));
    } finally {
      pendingInstalls.current.delete(key);
    }
  }

  async function copyPrompt() {
    if (!detail) return;
    try {
      await navigator.clipboard.writeText(detail.examplePrompt);
      setCopied(true);
      setCopyError(false);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopyError(true);
    }
  }

  const permission = detail ? PERMISSION_COPY[detail.permissionMode] : null;

  return (
    <dialog ref={dialogRef} id="marketplace-bot-details" className={`bot-details${open ? " is-open" : ""}`}
      aria-labelledby="bot-details-title" aria-modal="false">
      {bot && <div className="bot-details-inner">
        <header className="bot-details-toolbar">
          <BackButton onClick={onClose} autoFocus />
        </header>
        <div className="bot-details-viewport">
        <div className={`chat-scroll-edge chat-scroll-edge-top${scrollEdge === "top" ? " is-visible" : ""}`} aria-hidden="true" />
        <div className="bot-details-scroll" ref={scrollRef} key={bot.slug} aria-busy={state.status === "loading"}>
          <div className="bot-details-hero">
            <div className="bot-details-art"><MarketplaceMascot body={bot.mascot.body} color={bot.mascot.cssColor} activity={bot.mascot.activity as BotActivity} size={112} label={`${bot.name} mascot`} /></div>
            <span className="bot-details-category">{bot.category}</span>
            <h2 id="bot-details-title">{bot.name}</h2>
            <p>{bot.description}</p>
            <div className="bot-details-author"><MarketplaceAuthor name={bot.author.name} photo={bot.author.avatarUrl} verified={bot.verified} caption="Created by" /></div>
            <div className="bot-details-install-area">
              <MarketplaceInstallButton
                state={detail ? installState : "idle"}
                timing={installTiming[bot.slug]}
                onInstall={installBot}
              />
              {detail && installState !== "idle" && <div className="bot-details-install-status" role="status">
                {installState === "installed" && installedBot ? (
                  <>
                    {/* Installing never starts anything. The workspace runs setup the
                        first time this bot is opened there, so the link does not
                        pre-select it. */}
                    <span>{detail.setupInstructions
                      ? "Installed. Setup runs on your machine the first time you open this bot. "
                      : "Installed. "}</span>
                    <Link href="/">Open workspace →</Link>
                  </>
                ) : "Installing…"}
              </div>}
              {installErrors[bot.slug] && <p className="bot-details-install-error" role="alert">{installErrors[bot.slug]}</p>}
            </div>
          </div>

          {state.status === "error" && (
            <section className="bot-details-section bot-details-load-error" role="alert">
              <h3>Couldn’t load this bot</h3>
              <p>{state.message}</p>
              <button type="button" className="btn-secondary btn-compact" onClick={loadDetail}>
                <AnimatedActionIcon icon={RefreshCwIcon} size={15} aria-hidden="true" />
                Try again
              </button>
            </section>
          )}

          {state.status === "loading" && (
            <section className="bot-details-section" aria-hidden="true">
              <span className="marketplace-skeleton marketplace-skeleton-title" />
              <span className="marketplace-skeleton marketplace-skeleton-line" />
              <span className="marketplace-skeleton marketplace-skeleton-line" />
              <span className="marketplace-skeleton marketplace-skeleton-line is-short" />
            </section>
          )}

          {detail && permission && <>
            <section className="bot-details-section"><h3>About this bot</h3><p>{detail.about}</p></section>
            <section className="bot-details-section"><h3>What it can help with</h3><ul>{detail.features.map((feature) => <li key={feature}><AnimatedActionIcon icon={CheckIcon} size={16} aria-hidden="true" /><span>{feature}</span></li>)}</ul></section>

            <section className="bot-details-section bot-details-facts" aria-labelledby="bot-facts-heading">
              <h3 id="bot-facts-heading">How it runs</h3>
              <dl>
                <div><dt>Agent</dt><dd>{AGENT_LABELS[detail.agent]}{detail.model ? <small>{detail.model}</small> : null}</dd></div>
                <div><dt>Permissions</dt><dd>{permission.label}<small>{permission.detail}</small></dd></div>
                {detail.allowedTools?.length ? <div><dt>Allowed tools</dt><dd>{detail.allowedTools.join(", ")}<small>The only tools it may use.</small></dd></div> : null}
                {detail.disallowedTools?.length ? <div><dt>Blocked tools</dt><dd>{detail.disallowedTools.join(", ")}</dd></div> : null}
                <div><dt>Setup</dt><dd>{detail.setupInstructions ? "Needs a one-time setup" : "None"}{detail.setupInstructions ? <small>Runs once on your machine, the first time you open this bot, and can ask you for what it needs.</small> : null}</dd></div>
              </dl>
            </section>

            <section className="bot-details-section bot-details-text" aria-labelledby="bot-instructions-heading">
              <details className="bot-details-disclosure" data-testid="bot-instructions">
                <summary><h3 id="bot-instructions-heading">Instructions</h3><span>Read the standing job this bot runs under, word for word.</span></summary>
                <div className="bot-details-prose">{detail.instructions}</div>
              </details>
            </section>

            {detail.setupInstructions && (
              <section className="bot-details-section bot-details-text" aria-labelledby="bot-setup-heading">
                <details className="bot-details-disclosure" data-testid="bot-setup">
                  <summary><h3 id="bot-setup-heading">Setup steps</h3><span>What it prepares on your machine before its first job.</span></summary>
                  <div className="bot-details-prose">{detail.setupInstructions}</div>
                </details>
              </section>
            )}

            <section className="bot-details-section bot-details-safety" aria-labelledby="bot-safety-heading">
              <h3 id="bot-safety-heading">Install with confidence</h3>
              <ul>
                <li><AnimatedActionIcon icon={LaptopIcon} size={17} aria-hidden="true" /><div><strong>At home on your computer</strong><p>Your bot’s setup is saved locally.</p></div></li>
                <li><AnimatedActionIcon icon={PlayIcon} size={17} aria-hidden="true" /><div><strong>Starts when you’re ready</strong><p>Installing won’t run tasks or upload project files.</p></div></li>
                <li><AnimatedActionIcon icon={ShieldCheckIcon} size={17} aria-hidden="true" /><div><strong>Permission checks built in</strong><p>New installs start with approvals enabled.</p></div></li>
                <li><AnimatedActionIcon icon={SlidersHorizontalIcon} size={17} aria-hidden="true" /><div><strong>Always yours to manage</strong><p>Change its settings or remove it anytime.</p></div></li>
              </ul>
              <p className="bot-details-provider-note">When you chat, your chosen AI provider processes your prompts and relevant task context.</p>
            </section>
            <section className="bot-details-section bot-details-example">
              <h3>Start with a simple ask</h3>
              <p>“{detail.examplePrompt}”</p>
              <div className="bot-details-example-footer">
                <span className="bot-details-copy-status" role="status">{copyError ? "Select the prompt to copy it." : copied ? "Copied to clipboard" : "Example prompt"}</span>
                <button type="button" onClick={copyPrompt} aria-label={copied ? "Prompt copied" : "Copy prompt"}>{copied ? <AnimatedActionIcon icon={CheckIcon} size={14} aria-hidden="true" /> : <AnimatedActionIcon icon={CopyIcon} size={14} aria-hidden="true" />}<span>{copied ? "Copied" : "Copy prompt"}</span></button>
              </div>
            </section>
          </>}
        </div>
        <div className={`chat-scroll-edge chat-scroll-edge-bottom${scrollEdge === "bottom" ? " is-visible" : ""}`} aria-hidden="true" />
        </div>
      </div>}
    </dialog>
  );
}
