"use client";

import { useEffect, useRef } from "react";
import { ArrowRightIcon } from "@animateicons/react/lucide/arrow-right-icon";
import AnimatedActionIcon from "./animated-action-icon";
import { PanelBack } from "./panel-controls";

export type LearnMoreKind = "marketplace" | "share" | "import" | "permissions";

const sharingSections = [
  {
    title: "What the code includes",
    text: "A share code contains the bot’s name, description, instructions, setup steps, model, permission mode, and tool settings. The person who imports it gets a separate copy; later changes to your bot do not update theirs.",
  },
  {
    title: "What stays with you",
    text: "Your conversations, local files, workspace path, and completed setup status are not included. The code does not create an ongoing connection to your bot or workspace.",
  },
  {
    title: "Check it before sending",
    text: "The code is encoded for easy copying, not encrypted. Anyone with it can read the bot’s settings and instructions. Remove passwords, tokens, or private details before you share it.",
  },
] as const;

const content = {
  marketplace: {
    title: "What happens when you share a bot",
    lead: "A share code lets someone make their own copy of a bot. It shares the bot’s setup, not your conversations with it.",
    light: "/marketplace/learn-more-marketplace-light.webp",
    dark: "/marketplace/learn-more-marketplace-dark.webp",
    sections: sharingSections,
    note: "Open your bot’s Share menu and choose Publish to Marketplace. GitBot gives you a reviewed prompt that prepares the listing and pull request.",
    back: "Back to Marketplace",
  },
  share: {
    title: "Before you share a bot code",
    lead: "Anyone with the code can import a copy of this bot. Your conversations and files do not go with it, but its instructions do.",
    light: "/marketplace/learn-more-share-light.webp",
    dark: "/marketplace/learn-more-share-dark.webp",
    sections: sharingSections,
    back: "Back to sharing",
  },
  import: {
    title: "Before you import a bot",
    lead: "Importing a code adds a new bot based on someone else’s setup. That setup can shape how the bot behaves in your workspace.",
    light: "/marketplace/learn-more-import-light.webp",
    dark: "/marketplace/learn-more-import-dark.webp",
    sections: [
      { title: "What the code can set", text: "It may include the bot’s instructions, setup steps, model, permission mode, and tool settings. These settings affect what the imported bot is asked to do." },
      { title: "What does not come with it", text: "The sender’s conversations, local files, workspace path, and completed setup status do not transfer. The bot will use your workspace when you run it." },
      { title: "Review before you add it", text: "The current preview shows basic details, not every setting inside the code. Import only from someone you trust. If the bot needs setup, that process may start as soon as you add it." },
    ],
    back: "Back to import",
  },
  permissions: {
    title: "Choose how your bot works",
    lead: "Permissions control which actions run directly and which need your approval. The exact boundary depends on the agent behind your bot.",
    light: "/marketplace/learn-more-permissions-light.webp",
    dark: "/marketplace/learn-more-permissions-dark.webp",
    sections: [
      { title: "Ask when needed", text: "Safe actions can run without a prompt. Claude Code and OpenCode ask when a tool requires approval. Codex can read freely but asks before writing or crossing its read-only boundary." },
      { title: "Allow more", text: "Allow edits skips approval for file edits in Claude Code and OpenCode. In Codex, Allow workspace edits also lets commands run inside the workspace sandbox; blocked access does not get an approval prompt. Run without asking grants Codex full access, so use it only for a trusted task." },
      { title: "Plan or read only", text: "Claude Code and OpenCode can plan without edits. Codex uses a read-only sandbox: it can inspect and answer, but cannot write files. Read actions can still run." },
    ],
    note: "A change stays in this conversation, not the bot default. Codex and Plan changes wait for the next message. Claude Code and OpenCode can also apply a broader mode to approvals already waiting in this reply.",
    back: "Back to conversation",
  },
} as const;

export default function LearnMorePanel({ kind, onBack }: { kind: LearnMoreKind; onBack: () => void }) {
  const panelRef = useRef<HTMLDivElement>(null);
  const backRef = useRef(onBack);
  backRef.current = onBack;
  const item = content[kind];

  useEffect(() => {
    panelRef.current?.querySelector<HTMLButtonElement>(".back-btn")?.focus({ preventScroll: true });
    function handleOutsideClick(event: PointerEvent) {
      if (event.target instanceof Node && !panelRef.current?.parentElement?.contains(event.target)) {
        backRef.current();
      }
    }
    function handleEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      backRef.current();
    }
    document.addEventListener("pointerdown", handleOutsideClick);
    document.addEventListener("keydown", handleEscape, true);
    return () => {
      document.removeEventListener("pointerdown", handleOutsideClick);
      document.removeEventListener("keydown", handleEscape, true);
    };
  }, []);

  function keepFocus(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Tab") return;
    const buttons = Array.from(panelRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
    const first = buttons[0];
    const last = buttons[buttons.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  }

  return (
    <div ref={panelRef} className="profile-pane learn-more-pane" role="dialog" aria-modal="true" aria-labelledby="learn-more-title" onKeyDown={keepFocus}>
      <PanelBack onClick={onBack} aria-label={item.back} />
      <div className="profile-pane-inner">
        {"light" in item && <>
          <img className="learn-more-cover-image light" src={item.light} alt="" width={1360} height={433} />
          <img className="learn-more-cover-image dark" src={item.dark} alt="" width={1360} height={433} />
        </>}
        <article className="learn-more-article">
          <header className="learn-more-head">
            <h2 id="learn-more-title">{item.title}</h2>
            <p>{item.lead}</p>
          </header>
          {item.sections.map(({ title, text }) => (
            <section className="learn-more-section" key={title}>
              <AnimatedActionIcon icon={ArrowRightIcon} className="learn-more-section-arrow" size={16} />
              <div><h3>{title}</h3><p>{text}</p></div>
            </section>
          ))}
          {"note" in item && <p className="learn-more-note">{item.note}</p>}
        </article>
      </div>
    </div>
  );
}
