"use client";

import AnimatedActionIcon from "../components/animated-action-icon";
import { ArrowLeftIcon } from "@animateicons/react/lucide/arrow-left-icon";
import { ArrowRightIcon } from "@animateicons/react/lucide/arrow-right-icon";
import { ArrowUpRightIcon } from "@animateicons/react/lucide/arrow-up-right-icon";
import { DownloadIcon } from "@animateicons/react/lucide/download-icon";


import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import Link from "../components/page-link";
import { useUserProfile } from "../components/app-providers";

import { UsersIcon, type UsersIconHandle } from "@animateicons/react/lucide/users-icon";
import { ShieldCheckIcon, type ShieldCheckIconHandle } from "@animateicons/react/lucide/shield-check-icon";
import { BoltIcon, type BoltIconHandle } from "@animateicons/react/lucide/bolt-icon";
import { useScrollEdge } from "../lib/use-scroll-edge";
import MarketplaceAuthor from "../components/marketplace-author";
import ThemeButton from "../components/theme-button";
import TopBar from "../components/top-bar";
import UserProfile from "../components/user-profile";
import MarketplaceMascot from "../components/marketplace-mascot";
import MarketplaceBotDetails, { type MarketplaceBot } from "../components/marketplace-bot-details";

import "../v2-theme.css";
import "./marketplace.css";

type PopularBot = MarketplaceBot;

const POPULAR_BOTS: PopularBot[] = [
  { name: "PR Guardian", description: "Reviews pull requests for risks before you merge.", installs: "2.4k installs", author: "Maya Chen", authorPhoto: "https://i.pravatar.cc/80?img=47", body: "bear", color: "var(--brand-sun)", activity: "thinking" },
  { name: "Commit Composer", description: "Turns your changes into clear, useful commit messages.", installs: "1.8k installs", author: "Tomas Reed", authorPhoto: "https://i.pravatar.cc/80?img=12", body: "birdy-3", color: "var(--brand-sky)", activity: "working" },
  { name: "Release Notes", description: "Writes polished release notes from merged work.", installs: "1.5k installs", author: "Leila Park", authorPhoto: "https://i.pravatar.cc/80?img=44", body: "flower", color: "var(--brand-candy)", activity: "success" },
  { name: "Dependency Scout", description: "Keeps an eye on outdated and risky dependencies.", installs: "1.3k installs", author: "Noah Singh", authorPhoto: "https://i.pravatar.cc/80?img=13", body: "doggy", color: "var(--brand-leaf)", activity: "listening" },
  { name: "Branch Cleaner", description: "Finds stale branches and keeps the workspace tidy.", installs: "980 installs", author: "Ari Morgan", authorPhoto: "https://i.pravatar.cc/80?img=49", body: "moon", color: "var(--brand-honey)", activity: "idle" },
  { name: "Codebase Guide", description: "Answers questions about unfamiliar parts of a repo.", installs: "840 installs", author: "Sofia Ruiz", authorPhoto: "https://i.pravatar.cc/80?img=45", body: "ghost", color: "var(--brand-ember)", activity: "thinking" },
];

const GITBOT_TEAM_BOTS: PopularBot[] = [
  { name: "GitBot Review", description: "Brings a dependable first pass to every pull request.", installs: "3.2k installs", author: "GitBot", authorPhoto: "/favicon-light.svg", body: "cat", color: "var(--brand-sky)", activity: "thinking", verified: true },
  { name: "GitBot Release", description: "Turns merged work into polished release notes, ready to share.", installs: "2.7k installs", author: "GitBot", authorPhoto: "/favicon-light.svg", body: "birdy-3", color: "var(--brand-sun)", activity: "success", verified: true },
];

// 0.5s: One confident promise in generous space, followed by three quiet reasons to trust it.
export default function MarketplacePage() {
  const marketplaceBodyRef = useRef<HTMLDivElement>(null);
  const usersIconRef = useRef<UsersIconHandle>(null);
  const shieldIconRef = useRef<ShieldCheckIconHandle>(null);
  const boltIconRef = useRef<BoltIconHandle>(null);
  const { user, saveUser: savedUser } = useUserProfile();
  const [userOpen, setUserOpen] = useState(false);
  const scrollEdge = useScrollEdge(marketplaceBodyRef);
  const [selectedBot, setSelectedBot] = useState<MarketplaceBot | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);


  // Match each icon's movement to its card's entrance in the one-second sequence.
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const timers = [
      window.setTimeout(() => usersIconRef.current?.startAnimation(), 340),
      window.setTimeout(() => shieldIconRef.current?.startAnimation(), 420),
      window.setTimeout(() => boltIconRef.current?.startAnimation(), 500),
    ];
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, []);



  function trackMarketplaceBot(event: ReactPointerEvent<HTMLSpanElement>) {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const bot = event.currentTarget.querySelector<HTMLElement>(".bot-mascot");
    if (!bot) return;

    const bounds = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - (bounds.left + bounds.width / 2)) / bounds.width;
    const y = (event.clientY - (bounds.top + bounds.height / 2)) / bounds.height;
    const magnitude = Math.min(1, Math.hypot(x, y) * 1.5) * 2.4;
    const length = Math.hypot(x, y) || 1;

    event.currentTarget.dataset.pointerTracking = "true";
    bot.style.setProperty("--marketplace-gaze-x", `${((x / length) * magnitude).toFixed(2)}px`);
    bot.style.setProperty("--marketplace-gaze-y", `${((y / length) * magnitude).toFixed(2)}px`);
  }

  function resetMarketplaceBot(event: ReactPointerEvent<HTMLSpanElement>) {
    const bot = event.currentTarget.querySelector<HTMLElement>(".bot-mascot");
    delete event.currentTarget.dataset.pointerTracking;
    bot?.style.removeProperty("--marketplace-gaze-x");
    bot?.style.removeProperty("--marketplace-gaze-y");
  }

  function closeDetailsOutsidePanel(event: ReactPointerEvent<HTMLDivElement>) {
    if (!detailsOpen || event.button !== 0) return;
    const target = event.target;
    if (target instanceof Element && target.closest(".bot-details")) return;
    setDetailsOpen(false);
  }

  return (
    <div
      className={`page v2 marketplace-page${detailsOpen ? " has-bot-details" : ""}`}
      onPointerDown={closeDetailsOutsidePanel}
    >
      <div className="marketplace-stage">
      <TopBar
        className="marketplace-topbar"
        actions={
          <>
            <Link href="/" className="text-action topbar-marketplace-btn" aria-label="Back to workspace">
              <AnimatedActionIcon icon={ArrowLeftIcon} size={16} aria-hidden="true" />
              <span>Back to workspace</span>
            </Link>
            <span className="topbar-action-separator" aria-hidden="true" />
            <ThemeButton />
          </>
        }
        userName={user.name}
        userPhoto={user.photo}
        onProfile={() => { if (!userOpen) setDetailsOpen(false); setUserOpen((open) => !open); }}
      />
      <div className={`chat-scroll-edge chat-scroll-edge-top${scrollEdge === "top" && !userOpen ? " is-visible" : ""}`} aria-hidden="true" />
      <div ref={marketplaceBodyRef} className={`page-body marketplace-body${userOpen ? " is-profile-open" : ""}`} inert={userOpen} aria-hidden={userOpen}>
        <main className="marketplace-content" aria-labelledby="marketplace-heading">
          <section className="marketplace-hero">
            <div className="marketplace-mark" role="group" aria-label="Four community GitBots">
              <span className="marketplace-mark-bot" onPointerEnter={trackMarketplaceBot} onPointerMove={trackMarketplaceBot} onPointerLeave={resetMarketplaceBot}>
                <MarketplaceMascot body="ghost" color="var(--brand-sun)" activity="success" size={29} label="Yellow ghost GitBot" />
              </span>
              <span className="marketplace-mark-bot" onPointerEnter={trackMarketplaceBot} onPointerMove={trackMarketplaceBot} onPointerLeave={resetMarketplaceBot}>
                <MarketplaceMascot body="cat" color="var(--brand-sky)" activity="thinking" size={29} label="Blue cat GitBot" />
              </span>
              <span className="marketplace-mark-bot" onPointerEnter={trackMarketplaceBot} onPointerMove={trackMarketplaceBot} onPointerLeave={resetMarketplaceBot}>
                <MarketplaceMascot body="cloud" color="var(--brand-leaf)" activity="idle" size={29} label="Green cloud GitBot" />
              </span>
              <span className="marketplace-mark-bot" onPointerEnter={trackMarketplaceBot} onPointerMove={trackMarketplaceBot} onPointerLeave={resetMarketplaceBot}>
                <MarketplaceMascot body="heart" color="var(--brand-ember)" activity="listening" size={29} label="Orange heart GitBot" />
              </span>
            </div>
            <h1 id="marketplace-heading">Find GitBots you can trust.</h1>
            <p>
              Discover GitBots for your workflow. Explore their instructions and make them your own.
            </p>
          </section>

          <section className="marketplace-benefits" aria-label="Marketplace benefits">
            <article className="marketplace-benefit">
              <UsersIcon ref={usersIconRef} size={20} duration={0.45} color="var(--text)" aria-hidden="true" />
              <h2>Community-built, GitBot-ready</h2>
              <p>Useful helpers made by people who understand the work around a repo.</p>
            </article>
            <article className="marketplace-benefit">
              <ShieldCheckIcon ref={shieldIconRef} size={20} duration={0.45} color="var(--text)" aria-hidden="true" />
              <h2>Permissions you control</h2>
              <p>New marketplace installs start with permission checks enabled.</p>
            </article>
            <article className="marketplace-benefit">
              <BoltIcon ref={boltIconRef} size={20} duration={0.45} color="var(--text)" aria-hidden="true" />
              <h2>Install in a few clicks</h2>
              <p>Bring a new GitBot into your workspace without breaking your flow.</p>
            </article>
          </section>

          <section className="marketplace-popular" aria-labelledby="popular-bots-heading">
            <div className="marketplace-section-heading">
              <div>
                <h2 id="popular-bots-heading">Top popular bots</h2>
                <p>The community’s most-installed GitBots this week.</p>
              </div>
              <button className="text-action popular-bots-see-all" type="button">
                See all
                <AnimatedActionIcon icon={ArrowRightIcon} size={15} aria-hidden="true" />
              </button>
            </div>
            <div className="popular-bot-grid">
              {POPULAR_BOTS.map((bot) => (
                <article className="popular-bot-card" key={bot.name}>
                  <div className="popular-bot-avatar">
                    <MarketplaceMascot
                      body={bot.body}
                      color={bot.color}
                      activity={bot.activity}
                      size={47}
                      label={`${bot.name} GitBot`}
                    />
                  </div>
                  <div className="popular-bot-copy">
                    <h3>{bot.name}</h3>
                    <p>{bot.description}</p>
                  </div>
                  <div className="popular-bot-meta">
                    <span><AnimatedActionIcon icon={DownloadIcon} size={13} aria-hidden="true" />{bot.installs}</span>
                    <MarketplaceAuthor name={bot.author} photo={bot.authorPhoto} verified={bot.verified} />
                    <button
                      className="btn-primary btn-compact popular-bot-open"
                      type="button"
                      aria-label={`Open ${bot.name}`}
                      aria-haspopup="dialog"
                      aria-controls="marketplace-bot-details"
                      onClick={() => { setSelectedBot(bot); setDetailsOpen(true); }}




                    >
                      Open
                      <AnimatedActionIcon icon={ArrowUpRightIcon} size={16} aria-hidden="true" />
                    </button>
                  </div>
                </article>
              ))}
            </div>
          </section>

          <section className="marketplace-share" aria-labelledby="share-bot-heading">
            <div>
              <h2 id="share-bot-heading">Share your bot<br />with the marketplace</h2>
            </div>
            <button className="btn-primary marketplace-share-cta" type="button">
              Share bot
              <AnimatedActionIcon icon={ArrowUpRightIcon} size={16} aria-hidden="true" />
            </button>
          </section>
          <aside className="marketplace-share-privacy" aria-label="Privacy when sharing a bot">
            <AnimatedActionIcon icon={ShieldCheckIcon} className="marketplace-share-privacy-icon" size={17} aria-hidden="true" />
            <p>Bot instructions are shared. Chat history isn’t. Check the instructions for private details.</p>
            <button className="text-action marketplace-share-privacy-learn-more" type="button">
              Learn more
              <AnimatedActionIcon icon={ArrowRightIcon} size={15} aria-hidden="true" />
            </button>
          </aside>

          <section className="marketplace-team" aria-labelledby="gitbot-team-heading">
            <div className="marketplace-section-heading">
              <div>
                <h2 id="gitbot-team-heading">From the GitBot team</h2>
              </div>
            </div>
            <div className="popular-bot-grid">
              {GITBOT_TEAM_BOTS.map((bot) => (
                <article className="popular-bot-card" key={bot.name}>
                  <div className="popular-bot-avatar">
                    <MarketplaceMascot body={bot.body} color={bot.color} activity={bot.activity} size={47} label={`${bot.name} GitBot`} />
                  </div>
                  <div className="popular-bot-copy">
                    <h3>{bot.name}</h3>
                    <p>{bot.description}</p>
                  </div>
                  <div className="popular-bot-meta">
                    <span><AnimatedActionIcon icon={DownloadIcon} size={13} aria-hidden="true" />{bot.installs}</span>
                    <MarketplaceAuthor name={bot.author} photo={bot.authorPhoto} verified={bot.verified} />
                    <button
                      className="btn-primary btn-compact popular-bot-open"
                      type="button"
                      aria-label={`Open ${bot.name}`}
                      aria-haspopup="dialog"
                      aria-controls="marketplace-bot-details"
                      onClick={() => { setSelectedBot(bot); setDetailsOpen(true); }}




                    >
                      Open
                      <AnimatedActionIcon icon={ArrowUpRightIcon} size={16} aria-hidden="true" />
                    </button>
                  </div>
                </article>
              ))}
            </div>
          </section>
        </main>
      </div>
        <div
          className={userOpen ? "user-overlay open" : "user-overlay"}
          aria-hidden={!userOpen}
        >
          {userOpen && (
            <UserProfile
              user={user}
              onBack={() => setUserOpen(false)}
              onSaved={savedUser}
            />
          )}
        </div>
      <div className={`chat-scroll-edge chat-scroll-edge-bottom${scrollEdge === "bottom" && !userOpen ? " is-visible" : ""}`} aria-hidden="true" />
      </div>
      <MarketplaceBotDetails bot={selectedBot} open={detailsOpen} onClose={() => setDetailsOpen(false)} />
    </div>
  );
}
