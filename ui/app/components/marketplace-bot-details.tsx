"use client";

import AnimatedActionIcon from "./animated-action-icon";
import { CheckIcon } from "@animateicons/react/lucide/check-icon";
import { CopyIcon } from "@animateicons/react/lucide/copy-icon";
import { ShieldCheckIcon } from "@animateicons/react/lucide/shield-check-icon";
import { PlayIcon } from "@animateicons/react/lucide/play-icon";
import { SlidersHorizontalIcon } from "@animateicons/react/lucide/sliders-horizontal-icon";
import { LaptopIcon } from "@animateicons/react/lucide/laptop-icon";

import { useEffect, useRef, useState } from "react";

import { BackButton } from "./panel-controls";
import Link from "./page-link";
import { createBot, getAgents, getBots } from "../lib/api";
import { setAvatarPref } from "../lib/avatar-prefs";
import { useScrollEdge } from "../lib/use-scroll-edge";
import MarketplaceInstallButton from "./marketplace-install-button";
import MarketplaceAuthor from "./marketplace-author";
import MarketplaceMascot from "./marketplace-mascot";
import type { BotActivity } from "./bot-maker/registry";
import type { Bot } from "../lib/gitbot";

export type MarketplaceBot = {
  name: string;
  description: string;
  author: string;
  authorPhoto?: string;
  body: string;
  color: string;
  activity: BotActivity;
  verified?: boolean;
};

const DETAILS: Record<string, { category: string; about: string; features: string[]; prompt: string }> = {
  "PR Guardian": {
    category: "Code review",
    about: "A thoughtful second pair of eyes for your next pull request. Get a focused review that helps you understand what changed and where to look closer.",
    features: ["Spot potential bugs and edge cases", "Understand risky changes in context", "Get clear, actionable review suggestions"],
    prompt: "Review my current changes. Focus on bugs, edge cases, and anything I should address before merging.",
  },
  "Commit Composer": {
    category: "Developer workflow",
    about: "Give every change a clear story. Turn a working diff into a concise commit message that makes your project’s history easier to follow.",
    features: ["Summarize the intent behind a diff", "Draft a concise subject and useful body", "Keep commit messages consistent"],
    prompt: "Write a commit message for my staged changes. Keep the subject concise and explain why the change matters.",
  },
  "Release Notes": {
    category: "Releases",
    about: "Turn a collection of merged changes into a release people can understand. Bring the useful details forward, with less time spent writing.",
    features: ["Group changes into readable sections", "Highlight features and fixes", "Translate technical changes into plain language"],
    prompt: "Draft release notes for the changes since the last tag. Group them into features, improvements, and fixes.",
  },
  "Dependency Scout": {
    category: "Maintenance",
    about: "Make sense of your project’s dependencies. Find the packages that need attention and get a practical starting point for your next update.",
    features: ["Review the project’s dependency versions", "Flag updates that deserve a closer look", "Outline a manageable upgrade plan"],
    prompt: "Review this repo’s dependencies and suggest an upgrade plan. Highlight possible breaking changes.",
  },
  "Branch Cleaner": {
    category: "Repository care",
    about: "A little order for a busy repository. Find branches that may have served their purpose and review what is safe to tidy up.",
    features: ["Identify merged and inactive branches", "Explain which branches need review", "Plan a cleanup before making changes"],
    prompt: "Find stale and merged branches in this repo. Suggest a cleanup plan without deleting anything.",
  },
  "Codebase Guide": {
    category: "Code exploration",
    about: "Find your footing in an unfamiliar project. Follow the connections between files, understand the architecture, and know where to begin.",
    features: ["Map the main parts of a codebase", "Trace how a feature works", "Find the right files for your next change"],
    prompt: "Give me a tour of this repo. Explain its architecture, main entry points, and how to run it locally.",
  },
  "GitBot Review": {
    category: "Code review",
    about: "A focused review companion from the GitBot team. Work through your changes with clear explanations and useful next steps before you merge.",
    features: ["Review changes against their intent", "Surface potential regressions", "Prioritize actionable feedback"],
    prompt: "Review this branch against the main branch. Prioritize correctness and regressions, with file references for each finding.",
  },
  "GitBot Release": {
    category: "Releases",
    about: "Bring your release together with a writing companion from the GitBot team. Turn merged work into a clear account of what’s new.",
    features: ["Summarize work since your last release", "Organize highlights and bug fixes", "Prepare a readable release draft"],
    prompt: "Prepare a release summary from the merged work since the last release. Lead with the changes users will notice.",
  },
};

function instructionsFor(bot: MarketplaceBot, details: (typeof DETAILS)[string]) {
  return [
    `You are ${bot.name}. ${bot.description}`,
    "Help the user with these tasks:",
    ...details.features.map((feature) => `- ${feature}`),
    "Inspect the relevant repository context before making recommendations. Explain findings clearly and reference files where useful. Ask before destructive changes or publishing anything.",
    `Example request: ${details.prompt}`,
  ].join("\n");
}

export default function MarketplaceBotDetails({ bot, open, onClose }: {
  bot: MarketplaceBot | null;
  open: boolean;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const [installs, setInstalls] = useState<Record<string, "installing" | "completing" | "installed">>({});
  const [installTiming, setInstallTiming] = useState<Record<string, { startedAt: number; duration: number }>>({});
  const [installErrors, setInstallErrors] = useState<Record<string, string>>({});
  const [savedBots, setSavedBots] = useState<Bot[]>([]);
  const pendingInstalls = useRef(new Set<string>());
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    setCopied(false);
    setCopyError(false);
    if (copyTimer.current) clearTimeout(copyTimer.current);
  }, [bot?.name]);

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

  const scrollEdge = useScrollEdge(scrollRef, `${open}:${bot?.name ?? ""}`);

  const details = bot ? DETAILS[bot.name] : null;
  const installedBot = bot && details
    ? savedBots.find((candidate) => candidate.name === bot.name && candidate.instructions === instructionsFor(bot, details))
    : null;
  const pendingState = bot ? installs[bot.name] : undefined;
  const installState = pendingState === "installing" || pendingState === "completing"
    ? pendingState
    : installedBot ? "installed" : "idle";

  async function installBot() {
    if (!bot || !details || pendingInstalls.current.has(bot.name) || installedBot) return;
    const selected = bot;
    const name = selected.name;
    const color = dialogRef.current
      ? getComputedStyle(dialogRef.current).getPropertyValue(selected.color.replace(/^var\((.*)\)$/, "$1")).trim() || selected.color
      : selected.color;
    const startedAt = performance.now();
    const duration = 2000 + Math.random() * 500;
    pendingInstalls.current.add(name);
    setInstallTiming((previous) => ({ ...previous, [name]: { startedAt, duration } }));
    setInstalls((previous) => ({ ...previous, [name]: "installing" }));
    setInstallErrors((previous) => ({ ...previous, [name]: "" }));
    const instructions = instructionsFor(selected, details);
    try {
      const { agents } = await getAgents();
      if (!agents.length) throw new Error("Install Claude Code, Codex, or OpenCode before adding a bot.");
      const { bots } = await getBots();
      setSavedBots(bots);
      const existing = bots.find((candidate) => candidate.name === name && candidate.instructions === instructions);
      if (!existing) {
        const { bot: created } = await createBot({
          name,
          description: selected.description,
          emoji: "🤖",
          agent: agents[0],
          instructions,
          permissionMode: "ask-permissions",
        });
        setAvatarPref(created.id, { mascot: selected.body, color });
        setSavedBots((previous) => [...previous, created]);
      }
      // Keep the presentation at least 2–2.5s, but never finish before the API.
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, duration - 180 - (performance.now() - startedAt))));
      setInstalls((previous) => ({ ...previous, [name]: "completing" }));
      await new Promise((resolve) => setTimeout(resolve, 180));
      setInstalls((previous) => ({ ...previous, [name]: "installed" }));
    } catch (error) {
      setInstalls((previous) => {
        const next = { ...previous };
        delete next[name];
        return next;
      });
      setInstallErrors((previous) => ({ ...previous, [name]: error instanceof Error ? error.message : "Could not install this bot. Please try again." }));
    } finally {
      pendingInstalls.current.delete(name);
    }
  }

  async function copyPrompt() {
    if (!details) return;
    try {
      await navigator.clipboard.writeText(details.prompt);
      setCopied(true);
      setCopyError(false);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopyError(true);
    }
  }

  return (
    <dialog ref={dialogRef} id="marketplace-bot-details" className={`bot-details${open ? " is-open" : ""}`}
      aria-labelledby="bot-details-title" aria-modal="false">
      {bot && details && <div className="bot-details-inner">
        <header className="bot-details-toolbar">
          <BackButton onClick={onClose} autoFocus />
        </header>
        <div className="bot-details-viewport">
        <div className={`chat-scroll-edge chat-scroll-edge-top${scrollEdge === "top" ? " is-visible" : ""}`} aria-hidden="true" />
        <div className="bot-details-scroll" ref={scrollRef} key={bot.name}>
          <div className="bot-details-hero">
            <div className="bot-details-art"><MarketplaceMascot body={bot.body} color={bot.color} activity={bot.activity} size={112} label={`${bot.name} mascot`} /></div>
            <span className="bot-details-category">{details.category}</span>
            <h2 id="bot-details-title">{bot.name}</h2>
            <p>{bot.description}</p>
            <div className="bot-details-author"><MarketplaceAuthor name={bot.author} photo={bot.authorPhoto} verified={bot.verified} caption="Created by" /></div>
            <div className="bot-details-install-area">
              <MarketplaceInstallButton
                state={installState}
                timing={installTiming[bot.name]}
                onInstall={installBot}
              />
              {installState !== "idle" && <div className="bot-details-install-status" role="status">
                {installState === "installed" && installedBot ? (
                  <Link href="/" onClick={() => {
                    try { sessionStorage.setItem("gitbot-marketplace-installed-bot", installedBot.id); } catch {}
                  }}>Open workspace →</Link>
                ) : "Installing…"}
              </div>}
              {installErrors[bot.name] && <p className="bot-details-install-error" role="alert">{installErrors[bot.name]}</p>}
            </div>
          </div>
          <section className="bot-details-section"><h3>About this bot</h3><p>{details.about}</p></section>
          <section className="bot-details-section"><h3>What it can help with</h3><ul>{details.features.map((feature) => <li key={feature}><AnimatedActionIcon icon={CheckIcon} size={16} aria-hidden="true" /><span>{feature}</span></li>)}</ul></section>
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
            <p>“{details.prompt}”</p>
            <div className="bot-details-example-footer">
              <span className="bot-details-copy-status" role="status">{copyError ? "Select the prompt to copy it." : copied ? "Copied to clipboard" : "Example prompt"}</span>
              <button type="button" onClick={copyPrompt} aria-label={copied ? "Prompt copied" : "Copy prompt"}>{copied ? <AnimatedActionIcon icon={CheckIcon} size={14} aria-hidden="true" /> : <AnimatedActionIcon icon={CopyIcon} size={14} aria-hidden="true" />}<span>{copied ? "Copied" : "Copy prompt"}</span></button>
            </div>
          </section>
        </div>
        <div className={`chat-scroll-edge chat-scroll-edge-bottom${scrollEdge === "bottom" ? " is-visible" : ""}`} aria-hidden="true" />
        </div>
      </div>}
    </dialog>
  );
}
