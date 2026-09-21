"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import TopBar from "../components/top-bar";
import ThemeButton from "../v2/theme-button";
import BotForm from "../components/bot-form";
import { ImportModal } from "../components/share-modals";
import { useToast } from "../components/toast";
import { LogoMark } from "../components/logo";
import { IconArrowLeft, IconPhoto } from "@tabler/icons-react";
import { createBot } from "../lib/api";
import { setAvatarPref } from "../lib/avatar-prefs";
import "../v2/v2-theme.css";
import "./onboarding.css";

const SLIDES = [
  {
    title: "Your AI, your job",
    body: "A bot is an AI with a system prompt and a job you write, running on your own Claude or Codex plan.",
  },
  {
    title: "One code to share",
    body: "Send any bot to a friend with a single code. It carries prompts and setup steps — never keys, logins, or history.",
  },
  {
    title: "A marketplace",
    body: "A public shelf of bots worth stealing. Opening soon.",
  },
  {
    title: "Get listed",
    body: "The marketplace is a repo, one folder per bot. A PR gets you listed.",
  },
];

// Onboarding: first-run experience for users with no bots or threads yet.
// A hero (mascot, the four points, three actions), then the real bot
// studio inline. Creating or importing hands off to /v2, which boots with
// the new bot selected.
export default function Onboarding() {
  const [studio, setStudio] = useState(false);
  const [importing, setImporting] = useState(false);
  const [slide, setSlide] = useState(0);
  const { toast, view: toastView } = useToast();
  const router = useRouter();

  return (
    <div className="page v2">
      <TopBar actions={<ThemeButton />} />
      <div className="page-body">
        {studio ? (
          <div className="form-pane">
            <button type="button" className="back-btn" onClick={() => setStudio(false)}>
              <IconArrowLeft size={16} stroke={2} aria-hidden="true" />
              Back
            </button>
            <BotForm
              bot={null}
              onClose={() => setStudio(false)}
              onSaved={(saved, pref) => {
                setAvatarPref(saved.id, pref);
                router.push("/v2");
              }}
              onDeleted={() => setStudio(false)}
              onShare={() => {}}
            />
          </div>
        ) : (
          <main className="onboarding" aria-label="Welcome to GitBot">
            <LogoMark height={156} />
            <div
              className="onboarding-panel"
              aria-roledescription="carousel"
              aria-label="What GitBot is"
            >
              <div
                className="onboarding-track"
                style={{ transform: `translateX(-${slide * 100}%)` }}
              >
                {SLIDES.map((s, i) => (
                  <section
                    key={s.title}
                    className="onboarding-slide"
                    aria-roledescription="slide"
                    aria-label={`${i + 1} of ${SLIDES.length}`}
                    aria-hidden={i !== slide}
                  >
                    <div className="onboarding-ph" aria-hidden="true">
                      <IconPhoto size={28} stroke={1.5} />
                    </div>
                    <div>
                      <h2>{s.title}</h2>
                      <p>{s.body}</p>
                    </div>
                  </section>
                ))}
              </div>
            </div>
            <div className="onboarding-dots" aria-label="Choose slide">
              {SLIDES.map((s, i) => (
                <button
                  key={s.title}
                  type="button"
                  className={i === slide ? "dot active" : "dot"}
                  aria-label={`Go to slide ${i + 1}: ${s.title}`}
                  aria-current={i === slide || undefined}
                  onClick={() => setSlide(i)}
                />
              ))}
            </div>
            <div className="onboarding-acts">
              <button
                type="button"
                className="btn-primary"
                onClick={() => setStudio(true)}
              >
                Make your first bot
              </button>
              <button
                type="button"
                className="btn-secondary"
                disabled
                title="Coming soon"
              >
                Start from marketplace
              </button>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setImporting(true)}
              >
                Import from share code
              </button>
            </div>
          </main>
        )}
      </div>
      {toastView}
      {importing && (
        <ImportModal
          onClose={() => setImporting(false)}
          onAdd={(parsed) => {
            setImporting(false);
            createBot({
              name: String(parsed.name),
              emoji: typeof parsed.emoji === "string" ? parsed.emoji : undefined,
              description: typeof parsed.description === "string" ? parsed.description : undefined,
              instructions: typeof parsed.instructions === "string" ? parsed.instructions : undefined,
              setupInstructions:
                typeof parsed.setupInstructions === "string" ? parsed.setupInstructions : undefined,
              model: typeof parsed.model === "string" ? parsed.model : undefined,
              permissionMode: typeof parsed.permissionMode === "string" ? parsed.permissionMode : undefined,
              allowedTools: Array.isArray(parsed.allowedTools)
                ? (parsed.allowedTools as string[])
                : undefined,
              disallowedTools: Array.isArray(parsed.disallowedTools)
                ? (parsed.disallowedTools as string[])
                : undefined,
              agent: typeof parsed.agent === "string" ? parsed.agent : undefined,
            }).then(
              ({ bot: added }) => {
                setAvatarPref(added.id, { mascot: "ghost", color: "var(--brand-sun)" });
                router.push("/v2");
              },
              (e) => toast(e instanceof Error ? e.message : String(e)),
            );
          }}
        />
      )}
    </div>
  );
}
