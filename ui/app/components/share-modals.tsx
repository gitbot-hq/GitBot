"use client";

import AnimatedActionIcon from "./animated-action-icon";
import BotFace from "./bot-face";
import BotName from "./bot-name";
import { botTile } from "./bot-avatar";
import { defaultMascotFor, getAvatarPref, resolveAvatar } from "../lib/avatar-prefs";
import { ArrowRightIcon } from "@animateicons/react/lucide/arrow-right-icon";
import { CheckIcon } from "@animateicons/react/lucide/check-icon";
import { CopyIcon } from "@animateicons/react/lucide/copy-icon";
import { CodeIcon } from "@animateicons/react/lucide/code-icon";
import { StoreIcon } from "@animateicons/react/lucide/store-icon";
import { ShieldCheckIcon } from "@animateicons/react/lucide/shield-check-icon";

import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { BackButton, CloseButton } from "./panel-controls";
import { parseShare, shareCode, sharePrefix } from "../lib/share";
import { MARKETPLACE_REPO_URL, marketplacePublishPrompt } from "../lib/marketplace-publish";
import botAuthorPromptLines from "../lib/bot-author-prompt.json";
import { useScrollEdge } from "../lib/use-scroll-edge";
import type { Bot } from "../lib/gitbot";

function Shell({
  title,
  onClose,
  onBack,
  inactive = false,
  headerContent,
  children,
}: {
  title: string;
  onClose: () => void;
  onBack?: () => void;
  inactive?: boolean;
  headerContent?: React.ReactNode;
  children: React.ReactNode;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    return () => { if (opener?.isConnected) opener.focus(); };
  }, []);
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    (dialog?.querySelector<HTMLElement>("[data-initial-focus]") ?? dialog?.querySelector<HTMLElement>("button"))?.focus();
  }, [title]);

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not(:disabled), a[href], textarea:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])',
    ) ?? []);
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  }
  return (
    <div className="backdrop" inert={inactive} aria-hidden={inactive} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={dialogRef} className="modal" role="dialog" aria-modal={!inactive} aria-label={title} onKeyDown={handleKeyDown}>
        <div className="modal-head">
          {onBack && <BackButton onClick={onBack} aria-label="Back to sharing options">{null}</BackButton>}
          <h2>{title}</h2>
          <CloseButton onClick={onClose} />
          {headerContent}
        </div>
        {children}
      </div>
    </div>
  );
}

export function CreateBotWithAgentModal({ onClose }: { onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const [hubUrl, setHubUrl] = useState("http://localhost:3000");
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const prompt = botAuthorPromptLines.join("\n").replaceAll("{{GITBOT_URL}}", hubUrl);
  const scrollEdge = useScrollEdge(promptRef, prompt);

  useEffect(() => setHubUrl(window.location.origin), []);

  async function copyPrompt() {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    } catch {
      promptRef.current?.focus();
      promptRef.current?.select();
    }
  }

  return (
    <Shell title="Create bot with an agent" onClose={onClose}>
      <div className="agent-create-content">
        <p className="agent-create-intro">Copy this prompt into Claude Code, Codex, or OpenCode. The agent will ask a few questions, show the complete bot for review, and only add it after you approve.</p>
        <div className="field share-code-field agent-create-prompt">
          <label htmlFor="bot-author-prompt">Agent prompt<span className="share-code-format">Markdown</span></label>
          <div className="share-code-viewport">
            <div className={`chat-scroll-edge chat-scroll-edge-top${scrollEdge === "top" ? " is-visible" : ""}`} aria-hidden="true" />
            <textarea
              ref={promptRef}
              id="bot-author-prompt"
              className="code"
              readOnly
              spellCheck={false}
              value={prompt}
              onFocus={(event) => event.target.select()}
            />
            <div className={`chat-scroll-edge chat-scroll-edge-bottom${scrollEdge === "bottom" ? " is-visible" : ""}`} aria-hidden="true" />
          </div>
        </div>
        <div className="share-copy-actions">
          <div className="share-copy-privacy">
            <span className="share-privacy-icon" style={{ color: "var(--brand-sun)" }} aria-hidden="true">
              <AnimatedActionIcon icon={ShieldCheckIcon} size={22} />
            </span>
            <p>The agent must show you the complete definition before adding it through your running GitBot.</p>
          </div>
          <button type="button" className="btn-primary share-copy-button" data-initial-focus data-copied={copied} onClick={copyPrompt} aria-label={copied ? "Prompt copied" : "Copy agent prompt"}>
            <span aria-hidden="true"><AnimatedActionIcon icon={CopyIcon} size={16} />Copy prompt</span>
            <span aria-hidden="true"><AnimatedActionIcon icon={CheckIcon} size={16} />Prompt copied</span>
          </button>
        </div>
      </div>
    </Shell>
  );
}

// Sharing is explicit: opening the dialog never changes the clipboard.
export function ShareModal({
  bot,
  bots,
  onClose,
  onLearnMore,
  inactive = false,
  initialView = "options",
}: {
  bot: Bot;
  bots?: Bot[];
  onClose: () => void;
  onLearnMore?: () => void;
  inactive?: boolean;
  initialView?: "options" | "code" | "publish";
}) {
  const [view, setView] = useState<"options" | "code" | "publish">(initialView);
  const [botId, setBotId] = useState(bot.id);
  const activeBot = bots?.find((item) => item.id === botId) ?? bot;
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const [promptCopied, setPromptCopied] = useState(false);
  const [promptCopyError, setPromptCopyError] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (copyTimer.current) clearTimeout(copyTimer.current); }, []);
  const codeRef = useRef<HTMLTextAreaElement>(null);
  const scrollEdge = useScrollEdge(codeRef, `${view}:${activeBot.id}`);
  const code = shareCode(activeBot as unknown as Record<string, unknown>);
  async function copyCode() {
    try {
      await navigator.clipboard.writeText(code);
      setCopyError(false);
      setCopied(true);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 2500);
    } catch {
      setCopied(false);
      setCopyError(true);
      codeRef.current?.focus();
      codeRef.current?.select();
    }
  }
  const avatar = resolveAvatar(getAvatarPref(activeBot.id), { mascot: defaultMascotFor(activeBot.id), color: botTile(activeBot.id) });
  const publishPrompt = marketplacePublishPrompt(activeBot, avatar);
  async function copyPublishPrompt() {
    try {
      await navigator.clipboard.writeText(publishPrompt);
      setPromptCopyError(false);
      setPromptCopied(true);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setPromptCopied(false), 2500);
    } catch {
      setPromptCopied(false);
      setPromptCopyError(true);
    }
  }
  return (
    <Shell
      title={view === "code" ? "Share with code" : view === "publish" ? "Publish to Marketplace" : `Share ${activeBot.name}`}
      headerContent={view === "code" ? (
          <div className="share-code-intro">
            <p>Copy this code to share <BotName color={avatar.color}>{activeBot.name}</BotName> with anyone. {onLearnMore && <button type="button" className="text-action share-learn-more" onClick={onLearnMore}>Learn more</button>}</p>
          </div>
      ) : undefined}
      onClose={onClose}
      inactive={inactive}
      onBack={view !== "options" && initialView === "options" ? () => setView("options") : undefined}
    >
      {view === "options" ? (
        <>
          <p className="share-intro">Choose how you want to share this bot.</p>
          <div className="share-methods">
            <button type="button" className="share-method" onClick={() => setView("code")} data-initial-focus>
              <span className="share-method-icon" aria-hidden="true">
                <AnimatedActionIcon icon={CodeIcon} size={19} />
              </span>
              <span className="share-method-copy">
                <strong>Share with code</strong>
                <span>Send a code someone else can use to import the bot.</span>
              </span>
              <AnimatedActionIcon icon={ArrowRightIcon} className="share-method-arrow" size={17} aria-hidden="true" />
            </button>
            <button type="button" className="share-method" onClick={() => setView("publish")}>
              <span className="share-method-icon" aria-hidden="true">
                <AnimatedActionIcon icon={StoreIcon} size={19} />
              </span>
              <span className="share-method-copy">
                <strong>Publish to Marketplace</strong>
                <span>Make your bot discoverable by the GitBot community.</span>
              </span>
              <AnimatedActionIcon icon={ArrowRightIcon} className="share-method-arrow" size={17} aria-hidden="true" />
            </button>
          </div>
        </>
      ) : view === "code" ? (
        <>
          <div className="share-bot-summary">
            <BotFace mascot={avatar.mascot} color={avatar.color} size={72} />
            <div>
              <h3>{activeBot.name}</h3>
              {activeBot.description?.trim() && <p>{activeBot.description}</p>}
            </div>
          </div>
          <div className="share-code-content">
            <div className="field share-code-field">
              <label htmlFor="bot-share-code">Bot code<span className="share-code-format">Base64URL</span></label>
              <div className="share-code-viewport">
              <div className={`chat-scroll-edge chat-scroll-edge-top${scrollEdge === "top" ? " is-visible" : ""}`} aria-hidden="true" />
              <textarea
                ref={codeRef}
                id="bot-share-code"
                className="code"
                readOnly
                rows={3}
                spellCheck={false}
                value={code}
                onFocus={(e) => e.target.select()}
                aria-describedby="share-code-privacy"
              />
              <div className={`chat-scroll-edge chat-scroll-edge-bottom${scrollEdge === "bottom" ? " is-visible" : ""}`} aria-hidden="true" />
              </div>
            </div>
          </div>
          <div className="share-copy-actions">
            <div className="share-copy-privacy">
              <span className="share-privacy-icon" style={{ color: avatar.color }} aria-hidden="true">
                <AnimatedActionIcon icon={ShieldCheckIcon} size={22} />
              </span>
              <div>
                <p id="share-code-privacy">Only bot settings and instructions are shared.<br />Chats and local files stay private.</p>
                <span className="share-copy-status" role="status">{copyError ? "Select the code and copy it manually." : ""}</span>
              </div>
            </div>
            <button type="button" className="btn-primary share-copy-button" data-initial-focus data-copied={copied} onClick={copyCode} aria-label={copied ? "Copied" : "Copy code"}>
              <span aria-hidden="true"><AnimatedActionIcon icon={CopyIcon} size={16} />Copy code</span>
              <span aria-hidden="true"><AnimatedActionIcon icon={CheckIcon} size={16} />Copied</span>
            </button>
          </div>
        </>
      ) : (
        <div className="publish-content">
          {bots && bots.length > 1 && (
            <div className="field publish-bot-field">
              <label htmlFor="marketplace-publish-bot">Bot to publish</label>
              <select id="marketplace-publish-bot" value={activeBot.id} onChange={(event) => setBotId(event.target.value)}>
                {bots.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
            </div>
          )}
          <div className="publish-options">
            <section className="publish-option">
              <div className="publish-option-head">
                <span className="share-method-icon" aria-hidden="true"><AnimatedActionIcon icon={StoreIcon} size={19} /></span>
                <div>
                  <span className="share-method-status">Recommended</span>
                  <h3>Ask this bot to publish</h3>
                </div>
              </div>
              <p>Copy a guided prompt. The bot drafts missing listing details, checks the final diff, and waits for approval before creating a PR.</p>
              <button type="button" className="btn-primary share-copy-button" data-initial-focus data-copied={promptCopied} onClick={copyPublishPrompt} aria-label={promptCopied ? "Publishing prompt copied" : "Copy publishing prompt"}>
                <span aria-hidden="true"><AnimatedActionIcon icon={CopyIcon} size={16} />Copy prompt</span>
                <span aria-hidden="true"><AnimatedActionIcon icon={CheckIcon} size={16} />Prompt copied</span>
              </button>
            </section>

            <section className="publish-option">
              <div className="publish-option-head">
                <span className="share-method-icon" aria-hidden="true"><AnimatedActionIcon icon={CodeIcon} size={19} /></span>
                <div><h3>Create manually</h3></div>
              </div>
              <p>Open the GitBot repository, add the listing under <code>library/</code>, and submit a pull request for review.</p>
              <a className="btn-secondary publish-repo-link" href={MARKETPLACE_REPO_URL} target="_blank" rel="noreferrer">Open GitHub repository<AnimatedActionIcon icon={ArrowRightIcon} size={16} aria-hidden="true" /></a>
            </section>
          </div>
          <p className="publish-note" role="status">{promptCopyError ? "Could not copy the prompt. Check clipboard access and try again." : "Automated checks can miss sensitive information. Review the final diff before approving the PR."}</p>
        </div>
      )}
    </Shell>
  );
}

// Import bot. Copy verbatim from the original.
export function ImportModal({
  onClose,
  onAdd,
  onLearnMore,
  inactive = false,
}: {
  onClose: () => void;
  onAdd: (bot: Record<string, unknown>) => void;
  onLearnMore?: () => void;
  inactive?: boolean;
}) {
  const [text, setText] = useState("");
  const codeRef = useRef<HTMLTextAreaElement>(null);
  const scrollEdge = useScrollEdge(codeRef);
  const parsed = text.trim() ? parseShare(text) : null;
  const bad = text.trim() !== "" && !parsed;
  return (
    <Shell title="Import bot" onClose={onClose} inactive={inactive} headerContent={
      <div className="share-code-intro">
        <p>Paste a bot code to preview it before importing. {onLearnMore && <button type="button" className="text-action share-learn-more" onClick={onLearnMore}>Learn more</button>}</p>
      </div>
    }>
      <div className="import-content">
      <div className="share-code-content">
        <div className="field share-code-field">
          <label htmlFor="bot-import-code">Bot code<span className="share-code-format">Base64URL / JSON</span></label>
          <div className="share-code-viewport">
            <div className={`chat-scroll-edge chat-scroll-edge-top${scrollEdge === "top" ? " is-visible" : ""}`} aria-hidden="true" />
            <textarea
              ref={codeRef}
              id="bot-import-code"
              className="code"
              data-initial-focus
              spellCheck={false}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={`${sharePrefix()}…`}
              aria-invalid={bad}
              aria-describedby={bad ? "bot-import-error" : undefined}
            />
            <div className={`chat-scroll-edge chat-scroll-edge-bottom${scrollEdge === "bottom" ? " is-visible" : ""}`} aria-hidden="true" />
          </div>
        </div>
      </div>
      {bad && <p className="chat-error" id="bot-import-error" role="alert">This code isn’t valid. Check that you copied the entire bot code.</p>}
      {parsed && (
        <div className="share-bot-summary" aria-live="polite">
          <span className="share-method-icon" aria-hidden="true"><AnimatedActionIcon icon={CodeIcon} size={24} /></span>
          <div>
            <h3>{String(parsed.name)}</h3>
            {typeof parsed.description === "string" && parsed.description.trim() && <p>{parsed.description}</p>}
            {typeof parsed.setupInstructions === "string" && parsed.setupInstructions.trim() !== "" && (
              <p>Needs setup on this machine — a setup thread starts when you add it.</p>
            )}
          </div>
        </div>
      )}
      <div className="share-copy-actions">
        <div className="share-copy-privacy">
          <span className="share-privacy-icon" style={{ color: "var(--brand-sun)" }} aria-hidden="true">
            <AnimatedActionIcon icon={ShieldCheckIcon} size={22} />
          </span>
          <p>Only bot settings and instructions are imported.<br />No chat history or local files are transferred.</p>
        </div>
        <button type="button" className="btn-primary" disabled={!parsed} onClick={() => parsed && onAdd(parsed)}>
          Import bot
        </button>
      </div>
      </div>
    </Shell>
  );
}
