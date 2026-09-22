"use client";

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import Link from "next/link";
import { IconArrowLeft, IconArrowRight, IconArrowUpRight, IconDownload, IconShieldCheck, IconUser } from "@tabler/icons-react";
import { UsersIcon, type UsersIconHandle } from "@animateicons/react/lucide/users-icon";
import { ShieldCheckIcon, type ShieldCheckIconHandle } from "@animateicons/react/lucide/shield-check-icon";
import { BoltIcon, type BoltIconHandle } from "@animateicons/react/lucide/bolt-icon";
import { ArrowUpRightIcon, type ArrowUpRightIconHandle } from "@animateicons/react/lucide/arrow-up-right-icon";
import ThemeButton from "../components/theme-button";
import TopBar from "../components/top-bar";
import UserProfile from "../components/user-profile";
import BotMascot from "../components/bot-maker/BotMascot";
import type { BotActivity } from "../components/bot-maker/registry";
import {
  DEFAULT_USER_NAME,
  getUserPref,
  setUserPref,
  type UserPref,
} from "../lib/user-prefs";
import "../v2-theme.css";
import "./marketplace.css";

type PopularBot = {
  name: string;
  description: string;
  installs: string;
  author: string;
  body: string;
  color: string;
  activity: BotActivity;
  verified?: boolean;
};

const POPULAR_BOTS: PopularBot[] = [
  { name: "PR Guardian", description: "Reviews pull requests for risks before you merge.", installs: "2.4k installs", author: "Maya Chen", body: "bear", color: "var(--brand-sun)", activity: "thinking" },
  { name: "Commit Composer", description: "Turns your changes into clear, useful commit messages.", installs: "1.8k installs", author: "Tomas Reed", body: "birdy-3", color: "var(--brand-sky)", activity: "working" },
  { name: "Release Notes", description: "Writes polished release notes from merged work.", installs: "1.5k installs", author: "Leila Park", body: "flower", color: "var(--brand-candy)", activity: "success" },
  { name: "Dependency Scout", description: "Keeps an eye on outdated and risky dependencies.", installs: "1.3k installs", author: "Noah Singh", body: "doggy", color: "var(--brand-leaf)", activity: "listening" },
  { name: "Branch Cleaner", description: "Finds stale branches and keeps the workspace tidy.", installs: "980 installs", author: "Ari Morgan", body: "moon", color: "var(--brand-honey)", activity: "idle" },
  { name: "Codebase Guide", description: "Answers questions about unfamiliar parts of a repo.", installs: "840 installs", author: "Sofia Ruiz", body: "ghost", color: "var(--brand-ember)", activity: "thinking" },
];

const GITBOT_TEAM_BOTS: PopularBot[] = [
  { name: "GitBot Review", description: "Brings a dependable first pass to every pull request.", installs: "3.2k installs", author: "GitBot", body: "cat", color: "var(--brand-sky)", activity: "thinking", verified: true },
  { name: "GitBot Release", description: "Turns merged work into polished release notes, ready to share.", installs: "2.7k installs", author: "GitBot", body: "birdy-3", color: "var(--brand-sun)", activity: "success", verified: true },
];

function GitBotVerifiedBadge() {
  return (
    <svg width="18" height="20" viewBox="0 0 18 20" fill="none" aria-hidden="true" className="verify-mark">
      <path d="M4.75314 2.29581C6.6665 -0.765342 11.2039 -0.7652 13.1174 2.29581C16.7252 2.42232 18.9927 6.35129 17.2981 9.53898C18.9933 12.727 16.725 16.6563 13.1164 16.7821C11.2029 19.8431 6.66748 19.8433 4.75411 16.7821C1.14589 16.656 -1.12246 12.7269 0.572474 9.53898C-1.12185 6.35146 1.14564 2.42264 4.75314 2.29581ZM12.3918 3.03019C10.8542 0.231374 6.70254 0.32514 5.33908 3.31046L5.02658 3.29191C1.83408 3.22416 -0.160818 6.86557 1.7424 9.53898C-0.222613 12.2986 1.96666 16.0904 5.33908 15.7685C6.74649 18.8499 11.1239 18.8498 12.5315 15.7685C15.9039 16.0904 18.0932 12.2986 16.1281 9.53898C18.093 6.77933 15.9039 2.98854 12.5315 3.31046L12.3918 3.03019Z" fill="url(#marketplace-verified-edge)" />
      <path d="M5.33908 3.31046C6.7465 0.228879 11.124 0.228879 12.5315 3.31046C15.9039 2.98854 18.093 6.77933 16.1281 9.53898C18.0932 12.2986 15.9039 16.0904 12.5315 15.7685C11.1239 18.8498 6.74649 18.8499 5.33908 15.7685C1.96666 16.0904 -0.222613 12.2986 1.7424 9.53898C-0.222198 6.77935 1.96677 2.98855 5.33908 3.31046ZM13.2798 6.55427C12.8768 6.17661 12.2434 6.19718 11.8657 6.60016L7.53367 11.2222L5.98289 9.67145C5.59237 9.28093 4.95935 9.28093 4.56883 9.67145C4.17844 10.062 4.17835 10.695 4.56883 11.0855L6.85008 13.3668C7.04158 13.5582 7.30298 13.6641 7.57371 13.6597C7.84445 13.6553 8.10241 13.5409 8.28758 13.3433L13.3257 7.96735C13.7028 7.56447 13.6823 6.93182 13.2798 6.55427Z" fill="url(#marketplace-verified-face)" />
      <defs>
        <linearGradient id="marketplace-verified-edge" x1="8.9355" y1="0.998938" x2="8.9355" y2="18.0796" gradientUnits="userSpaceOnUse"><stop stopColor="#004E82" /><stop offset="1" stopColor="#0098FF" /></linearGradient>
        <linearGradient id="marketplace-verified-face" x1="8.93532" y1="0.998047" x2="8.93532" y2="18.0783" gradientUnits="userSpaceOnUse"><stop stopColor="#1D9BF0" /><stop offset="1" stopColor="#4ED3FF" /></linearGradient>
      </defs>
    </svg>
  );
}

// 0.5s: One confident promise in generous space, followed by three quiet reasons to trust it.
export default function MarketplacePage() {
  const usersIconRef = useRef<UsersIconHandle>(null);
  const shieldIconRef = useRef<ShieldCheckIconHandle>(null);
  const boltIconRef = useRef<BoltIconHandle>(null);
  const popularOpenIconRefs = useRef<Array<ArrowUpRightIconHandle | null>>([]);
  const teamOpenIconRefs = useRef<Array<ArrowUpRightIconHandle | null>>([]);
  const [user, setUser] = useState<UserPref>({
    name: DEFAULT_USER_NAME,
    email: "",
    bio: "",
    location: "",
    emailVerified: false,
    photo: null,
  });
  const [userOpen, setUserOpen] = useState(false);

  useEffect(() => {
    setUser(getUserPref());
  }, []);

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

  function savedUser(next: UserPref) {
    setUserPref(next);
    setUser(next);
  }

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

  return (
    <div className="page v2 marketplace-page">
      <TopBar
        actions={
          <>
            <Link href="/" className="topbar-marketplace-btn">
              <IconArrowLeft size={16} stroke={2} aria-hidden="true" />
              <span>Back to workspace</span>
            </Link>
            <span className="topbar-action-separator" aria-hidden="true" />
            <ThemeButton />
          </>
        }
        userName={user.name}
        userPhoto={user.photo}
        onProfile={() => setUserOpen((open) => !open)}
      />
      <div className="page-body marketplace-body">
        <main className="marketplace-content" aria-labelledby="marketplace-heading">
          <section className="marketplace-hero">
            <div className="marketplace-mark" role="group" aria-label="Four community GitBots">
              <span className="marketplace-mark-bot" onPointerEnter={trackMarketplaceBot} onPointerMove={trackMarketplaceBot} onPointerLeave={resetMarketplaceBot}>
                <BotMascot body="ghost" color="var(--brand-sun)" activity="success" size={29} label="Yellow ghost GitBot" />
              </span>
              <span className="marketplace-mark-bot" onPointerEnter={trackMarketplaceBot} onPointerMove={trackMarketplaceBot} onPointerLeave={resetMarketplaceBot}>
                <BotMascot body="cat" color="var(--brand-sky)" activity="thinking" size={29} label="Blue cat GitBot" />
              </span>
              <span className="marketplace-mark-bot" onPointerEnter={trackMarketplaceBot} onPointerMove={trackMarketplaceBot} onPointerLeave={resetMarketplaceBot}>
                <BotMascot body="cloud" color="var(--brand-leaf)" activity="idle" size={29} label="Green cloud GitBot" />
              </span>
              <span className="marketplace-mark-bot" onPointerEnter={trackMarketplaceBot} onPointerMove={trackMarketplaceBot} onPointerLeave={resetMarketplaceBot}>
                <BotMascot body="heart" color="var(--brand-ember)" activity="listening" size={29} label="Orange heart GitBot" />
              </span>
            </div>
            <h1 id="marketplace-heading">Find GitBots you can trust.</h1>
            <p>
              Discover community-built GitBots. Every listing is reviewed and verified before it reaches the marketplace.
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
              <h2>Reviewed before publishing</h2>
              <p>Every listing is checked before it becomes available in the marketplace.</p>
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
              <button className="popular-bots-see-all" type="button">
                See all
                <IconArrowRight size={15} stroke={1.8} aria-hidden="true" />
              </button>
            </div>
            <div className="popular-bot-grid">
              {POPULAR_BOTS.map((bot, index) => (
                <article className="popular-bot-card" key={bot.name}>
                  <div className="popular-bot-avatar">
                    <BotMascot
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
                    <span><IconDownload size={13} stroke={1.8} aria-hidden="true" />{bot.installs}</span>
                    <span><IconUser size={13} stroke={1.8} aria-hidden="true" />{bot.author}</span>
                    <button
                      className="popular-bot-open"
                      type="button"
                      onMouseEnter={() => popularOpenIconRefs.current[index]?.startAnimation()}
                      onMouseLeave={() => popularOpenIconRefs.current[index]?.stopAnimation()}
                      onFocus={() => popularOpenIconRefs.current[index]?.startAnimation()}
                      onBlur={() => popularOpenIconRefs.current[index]?.stopAnimation()}
                    >
                      Open
                      <ArrowUpRightIcon
                        ref={(node) => { popularOpenIconRefs.current[index] = node; }}
                        size={13}
                        duration={0.45}
                        aria-hidden="true"
                      />
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
            <button className="marketplace-share-cta" type="button">
              Share your bot
              <IconArrowUpRight size={16} stroke={1.8} aria-hidden="true" />
            </button>
          </section>
          <aside className="marketplace-share-privacy" aria-label="Privacy when sharing a bot">
            <IconShieldCheck className="marketplace-share-privacy-icon" size={17} stroke={1.8} aria-hidden="true" />
            <p><strong>Private by design.</strong> Share your bot’s setup, never your keys, prompts, or personal data.</p>
            <button className="marketplace-share-privacy-learn-more" type="button">
              Learn more
              <IconArrowRight size={15} stroke={1.8} aria-hidden="true" />
            </button>
          </aside>

          <section className="marketplace-team" aria-labelledby="gitbot-team-heading">
            <div className="marketplace-section-heading">
              <div>
                <h2 id="gitbot-team-heading">From the GitBot team</h2>
              </div>
            </div>
            <div className="popular-bot-grid">
              {GITBOT_TEAM_BOTS.map((bot, index) => (
                <article className="popular-bot-card" key={bot.name}>
                  <div className="popular-bot-avatar">
                    <BotMascot body={bot.body} color={bot.color} activity={bot.activity} size={47} label={`${bot.name} GitBot`} />
                  </div>
                  <div className="popular-bot-copy">
                    <h3>{bot.name}</h3>
                    <p>{bot.description}</p>
                  </div>
                  <div className="popular-bot-meta">
                    <span><IconDownload size={13} stroke={1.8} aria-hidden="true" />{bot.installs}</span>
                    <span className="popular-bot-maker">
                      <IconUser size={13} stroke={1.8} aria-hidden="true" />
                      {bot.author}
                      {bot.verified && (
                        <span className="verify-pill" role="img" aria-label="GitBot verified" title="GitBot verified" tabIndex={0}>
                          <GitBotVerifiedBadge />
                          <span className="verify-label" aria-hidden="true">GitBot verified</span>
                        </span>
                      )}
                    </span>
                    <button
                      className="popular-bot-open"
                      type="button"
                      onMouseEnter={() => teamOpenIconRefs.current[index]?.startAnimation()}
                      onMouseLeave={() => teamOpenIconRefs.current[index]?.stopAnimation()}
                      onFocus={() => teamOpenIconRefs.current[index]?.startAnimation()}
                      onBlur={() => teamOpenIconRefs.current[index]?.stopAnimation()}
                    >
                      Open
                      <ArrowUpRightIcon ref={(node) => { teamOpenIconRefs.current[index] = node; }} size={13} duration={0.45} aria-hidden="true" />
                    </button>
                  </div>
                </article>
              ))}
            </div>
          </section>
        </main>
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
      </div>
    </div>
  );
}
