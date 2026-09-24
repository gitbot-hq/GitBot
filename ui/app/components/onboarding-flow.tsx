"use client";

import Link from "./page-link";

import { useRef, useState } from "react";
import BotForm from "./bot-form";
import { ImportModal } from "./share-modals";
import { useToast } from "./toast";
import { LogoMark } from "./logo";
import { createBot } from "../lib/api";
import { setAvatarPref } from "../lib/avatar-prefs";

const SLIDES = [
  {
    title: "Your AI, your job",
    body: "A bot is an AI with a system prompt and a job you write, running on your own Claude or Codex plan.",
    image: "/onboarding/slide-1-ai-job.webp",
  },
  {
    title: "One code to share",
    body: "Send any bot to a friend with a single code. It carries prompts and setup steps — never keys, logins, or history.",
    image: "/onboarding/slide-2-one-code.webp",
  },
  {
    title: "A marketplace",
    body: "A public shelf of bots worth stealing. Read one, install it in a click.",
    image: "/onboarding/slide-3-marketplace.webp",
  },
  {
    title: "Get listed",
    body: "The marketplace is a repo, one folder per bot. A PR gets you listed.",
    image: "/onboarding/slide-4-get-listed.webp",
  },
];

// First-run flow: hero (mark, intro, explainer carousel, three actions)
// crossfading to the real bot studio. Creating or importing calls onDone
// (the host reloads bots and carries on); the flow itself never navigates.
export default function OnboardingFlow({ onDone, active = true }: { onDone: () => void; active?: boolean }) {
  const [studio, setStudio] = useState(false);
  const [importing, setImporting] = useState(false);
  const [slide, setSlide] = useState(0);
  const { toast, view: toastView } = useToast();
  const bodyRef = useRef<HTMLDivElement | null>(null);

  function goStudio() {
    bodyRef.current?.scrollTo({ top: 0 });
    setStudio(true);
  }

  function goHero() {
    bodyRef.current?.scrollTo({ top: 0 });
    setStudio(false);
  }

  return (
    <>
      <div className="ob-stack" ref={bodyRef}>
          <div className={studio ? "ob-pane ob-hero ob-hide" : "ob-pane ob-hero"}>
            <div className="ob-pane-inner">
          <main className="onboarding" aria-label="Welcome to GitBot">
            <LogoMark height={156} />
            <div className="onboarding-intro">
              <h1>Welcome to GitBot</h1>
              <p>Turn any job into a bot that runs on your machine.</p>
            </div>
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
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={s.image} alt="" loading={i === 0 ? "eager" : "lazy"} />
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
                onClick={goStudio}
              >
                Create bot
              </button>
              <div className="onboarding-acts-row">
                <Link href="/marketplace" className="btn-secondary">
                  Start from marketplace
                </Link>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => setImporting(true)}
                >
                  Import bot
                </button>
              </div>
            </div>
          </main>
            </div>
          </div>
          <div className={studio ? "ob-pane ob-studio" : "ob-pane ob-studio ob-hide"}>
            <div className="ob-pane-inner">
          <div className="form-pane">
            <BotForm
              active={active && studio && !importing}
              bot={null}
              onClose={goHero}
              onSaved={(saved, pref) => {
                setAvatarPref(saved.id, pref);
                onDone();
              }}
              onDeleted={goHero}
              onShare={() => {}}
            />
          </div>
            </div>
          </div>
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
                onDone();
              },
              (e) => toast(e instanceof Error ? e.message : String(e)),
            );
          }}
        />
      )}
    </>
  );
}
