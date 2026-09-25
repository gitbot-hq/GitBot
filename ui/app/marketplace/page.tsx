"use client";

import AnimatedActionIcon from "../components/animated-action-icon";
import { ArrowLeftIcon } from "@animateicons/react/lucide/arrow-left-icon";
import { ArrowRightIcon } from "@animateicons/react/lucide/arrow-right-icon";
import { ArrowUpRightIcon } from "@animateicons/react/lucide/arrow-up-right-icon";
import { RefreshCwIcon } from "@animateicons/react/lucide/refresh-cw-icon";
import { SearchIcon } from "@animateicons/react/lucide/search-icon";
import { UsersIcon } from "@animateicons/react/lucide/users-icon";
import { ZapIcon } from "@animateicons/react/lucide/zap-icon";

import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import Link from "../components/page-link";
import { useUserProfile } from "../components/app-providers";

import { ShieldCheckIcon } from "@animateicons/react/lucide/shield-check-icon";
import { useScrollEdge } from "../lib/use-scroll-edge";
import MarketplaceAuthor from "../components/marketplace-author";
import ThemeButton from "../components/theme-button";
import TopBar from "../components/top-bar";
import UserProfile from "../components/user-profile";
import ProfilePanelOverlay from "../components/profile-panel-overlay";
import LearnMorePanel from "../components/learn-more-panel";
import MarketplaceMascot from "../components/marketplace-mascot";
import MarketplaceBotDetails from "../components/marketplace-bot-details";
import { ShareModal } from "../components/share-modals";
import { useToast } from "../components/toast";
import { getBots } from "../lib/api";
import type { Bot } from "../lib/gitbot";
import type { BotActivity } from "../components/bot-maker/registry";
import { listMarketplaceBots, MarketplaceError, type MarketplaceBotCard, type MarketplaceCategory } from "../lib/marketplace";

import "../v2-theme.css";
import "./marketplace.css";

// The library is small enough to load in one request; search and category
// filters then run locally so typing never round-trips to the server.
const PAGE_SIZE = 100;
const FEATURED_FALLBACK = 6;
const SKELETONS = 4;

type LoadState =
  | { status: "loading"; bots: MarketplaceBotCard[] }
  | { status: "ready"; bots: MarketplaceBotCard[] }
  | { status: "error"; bots: MarketplaceBotCard[]; message: string; unavailable: boolean };

function readBotParam(): string | null {
  try {
    return new URLSearchParams(window.location.search).get("bot");
  } catch {
    return null;
  }
}

function writeBotParam(slug: string | null) {
  try {
    const url = new URL(window.location.href);
    if (slug) url.searchParams.set("bot", slug);
    else url.searchParams.delete("bot");
    window.history.replaceState(window.history.state, "", url);
  } catch {}
}

function matches(card: MarketplaceBotCard, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  return [card.name, card.description, card.author.name, card.author.github, card.category].some((s) => s.toLowerCase().includes(q));
}

function BotCard({ bot, onOpen }: { bot: MarketplaceBotCard; onOpen: (bot: MarketplaceBotCard) => void }) {
  return (
    <article className="popular-bot-card" data-slug={bot.slug}>
      <div className="popular-bot-avatar">
        <MarketplaceMascot
          body={bot.mascot.body}
          color={bot.mascot.cssColor}
          activity={bot.mascot.activity as BotActivity}
          size={47}
          label={`${bot.name} GitBot`}
        />
      </div>
      <div className="popular-bot-copy">
        <h3>{bot.name}</h3>
        <p>{bot.description}</p>
      </div>
      <div className="popular-bot-meta">
        <MarketplaceAuthor name={bot.author.name} photo={bot.author.avatarUrl} verified={bot.verified} />
        <button
          className="btn-primary btn-compact popular-bot-open"
          type="button"
          aria-label={`Open ${bot.name}`}
          aria-haspopup="dialog"
          aria-controls="marketplace-bot-details"
          onClick={() => onOpen(bot)}
        >
          Open
          <AnimatedActionIcon icon={ArrowUpRightIcon} size={16} aria-hidden="true" />
        </button>
      </div>
    </article>
  );
}

function SkeletonCards() {
  return (
    <div className="popular-bot-grid" aria-hidden="true">
      {Array.from({ length: SKELETONS }, (_, i) => (
        <article className="popular-bot-card is-skeleton" key={i}>
          <div className="popular-bot-avatar"><span className="marketplace-skeleton marketplace-skeleton-avatar" /></div>
          <div className="popular-bot-copy">
            <span className="marketplace-skeleton marketplace-skeleton-title" />
            <span className="marketplace-skeleton marketplace-skeleton-line" />
            <span className="marketplace-skeleton marketplace-skeleton-line is-short" />
          </div>
          <div className="popular-bot-meta"><span className="marketplace-skeleton marketplace-skeleton-author" /></div>
        </article>
      ))}
    </div>
  );
}

const MARKETPLACE_BENEFITS = [
  { kind: "community", icon: UsersIcon, short: "Built for GitBot", summary: "Community-made helpers", title: "Community-built, GitBot-ready", description: "Useful helpers made by people who understand the work around a repo." },
  { kind: "permissions", icon: ShieldCheckIcon, short: "Safe by default", summary: "Permissions stay in your hands", title: "Permissions you control", description: "New marketplace installs start with permission checks enabled." },
  { kind: "install", icon: ZapIcon, short: "Ready in minutes", summary: "Add one without breaking flow", title: "Install in a few clicks", description: "Bring a new GitBot into your workspace without breaking your flow." },
] as const;

// 0.5s: One confident promise in generous space, followed by three quiet reasons to trust it.
export default function MarketplacePage() {
  const marketplaceBodyRef = useRef<HTMLDivElement>(null);
  const learnMoreButtonRef = useRef<HTMLButtonElement>(null);
  const { user, saveUser: savedUser } = useUserProfile();
  const [userOpen, setUserOpen] = useState(false);
  const [learnMoreOpen, setLearnMoreOpen] = useState(false);
  const scrollEdge = useScrollEdge(marketplaceBodyRef);
  const [selectedBot, setSelectedBot] = useState<MarketplaceBotCard | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [load, setLoad] = useState<LoadState>({ status: "loading", bots: [] });
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<MarketplaceCategory | null>(null);
  const pendingDeepLink = useRef<string | null>(null);
  const [publishBots, setPublishBots] = useState<Bot[]>([]);
  const [publishOpen, setPublishOpen] = useState(false);
  const { toast, view: toastView } = useToast();

  function openPublish() {
    getBots().then(({ bots }) => {
      if (!bots.length) {
        toast("Create a bot before publishing to Marketplace.");
        return;
      }
      closeBot();
      setLearnMoreOpen(false);
      setUserOpen(false);
      setPublishBots(bots);
      setPublishOpen(true);
    }, (error) => toast(error instanceof Error ? error.message : "Could not load your bots"));
  }

  const loadBots = useCallback(() => {
    setLoad((prev) => ({ status: "loading", bots: prev.bots }));
    listMarketplaceBots({ sort: "featured", limit: PAGE_SIZE })
      .then(({ bots }) => setLoad({ status: "ready", bots }))
      .catch((error) => setLoad((prev) => ({
        status: "error",
        bots: prev.bots,
        message: error instanceof Error ? error.message : "Could not load the marketplace",
        unavailable: error instanceof MarketplaceError && error.unavailable,
      })));
  }, []);

  useEffect(() => {
    pendingDeepLink.current = readBotParam();
    loadBots();
  }, [loadBots]);

  const openBot = useCallback((bot: MarketplaceBotCard) => {
    setSelectedBot(bot);
    setDetailsOpen(true);
    writeBotParam(bot.slug);
  }, []);

  const closeBot = useCallback(() => {
    setDetailsOpen(false);
    writeBotParam(null);
  }, []);

  // ?bot=<slug> opens that bot once the list is in. An unknown slug is ignored.
  useEffect(() => {
    if (load.status !== "ready" || !pendingDeepLink.current) return;
    const slug = pendingDeepLink.current;
    pendingDeepLink.current = null;
    const bot = load.bots.find((b) => b.slug === slug);
    if (bot) openBot(bot);
    else writeBotParam(null);
  }, [load, openBot]);

  const featured = useMemo(() => {
    const picked = load.bots.filter((b) => b.featured).sort((a, b) => (a.featuredRank ?? 0) - (b.featuredRank ?? 0));
    if (picked.length) return picked;
    return [...load.bots].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, FEATURED_FALLBACK);
  }, [load.bots]);
  const hasFeatured = load.bots.some((b) => b.featured);
  const team = useMemo(() => load.bots.filter((b) => b.verified), [load.bots]);
  const categories = useMemo(() => {
    const counts = new Map<MarketplaceCategory, number>();
    for (const b of load.bots) counts.set(b.category, (counts.get(b.category) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [load.bots]);
  const filtered = useMemo(
    () => load.bots.filter((b) => (!category || b.category === category) && matches(b, query.trim())),
    [load.bots, category, query],
  );
  const showError = load.status === "error" && load.bots.length === 0;
  const showSkeleton = load.status === "loading" && load.bots.length === 0;

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
    closeBot();
  }

  const statusBlock = showError ? (
    <div className="marketplace-status" role="alert">
      <strong>{load.status === "error" && load.unavailable ? "Marketplace is unavailable right now" : "Couldn’t load the marketplace"}</strong>
      <p>{load.status === "error" && load.unavailable ? "Check your connection, then try again." : load.status === "error" ? load.message : ""}</p>
      <button type="button" className="btn-secondary btn-compact" onClick={loadBots}>
        <AnimatedActionIcon icon={RefreshCwIcon} size={15} aria-hidden="true" />
        Try again
      </button>
    </div>
  ) : null;

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
        onProfile={() => { if (!userOpen) closeBot(); setLearnMoreOpen(false); setUserOpen((open) => !open); }}
      />
      <div className={`chat-scroll-edge chat-scroll-edge-top${scrollEdge === "top" && !userOpen && !learnMoreOpen ? " is-visible" : ""}`} aria-hidden="true" />
      <div ref={marketplaceBodyRef} className={`page-body marketplace-body${userOpen || learnMoreOpen ? " is-profile-open" : ""}`} inert={userOpen || learnMoreOpen || publishOpen} aria-hidden={userOpen || learnMoreOpen || publishOpen}>
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
              Explore each GitBot&apos;s instructions before making it your own.
            </p>
            <div className="marketplace-benefit-strip" aria-label="Marketplace benefits">
              {MARKETPLACE_BENEFITS.map((benefit) => (
                <div className="marketplace-benefit-summary" key={benefit.kind}>
                  <span className={`marketplace-benefit-icon ${benefit.kind}`} aria-hidden="true"><AnimatedActionIcon icon={benefit.icon} size={17} /></span>
                  <span><strong>{benefit.short}</strong>{benefit.summary}</span>
                </div>
              ))}
            </div>
          </section>

          {statusBlock}

          {!showError && (
            <section className="marketplace-popular" aria-labelledby="popular-bots-heading" aria-busy={showSkeleton}>
              <div className="marketplace-section-heading">
                <div>
                  <h2 id="popular-bots-heading">{hasFeatured ? "Featured bots" : "New in the library"}</h2>
                  <p>{hasFeatured ? "A few GitBots to explore and make your own." : "The latest GitBots to explore and make your own."}</p>
                </div>
              </div>
              {showSkeleton ? <SkeletonCards /> : (
                <div className="popular-bot-grid">
                  {featured.map((bot) => <BotCard key={bot.slug} bot={bot} onOpen={openBot} />)}
                </div>
              )}
            </section>
          )}

          <section className="marketplace-benefits-section" aria-labelledby="marketplace-benefits-heading">
            <div className="marketplace-section-heading">
              <div>
                <h2 id="marketplace-benefits-heading">Built for your workspace</h2>
                <p>Useful bots, clear permissions, and a quick path to getting started.</p>
              </div>
            </div>
            <div className="marketplace-benefits">
              {MARKETPLACE_BENEFITS.map((benefit) => (
                <article className="marketplace-benefit" key={benefit.kind}>
                  <span className={`marketplace-benefit-art ${benefit.kind}`} aria-hidden="true" />
                  <h3>{benefit.title}</h3>
                  <p>{benefit.description}</p>
                </article>
              ))}
            </div>
          </section>

          <section className="marketplace-share" aria-labelledby="share-bot-heading">
            <div>
              <h2 id="share-bot-heading">Share your bot<br />with the marketplace</h2>
            </div>
            <button type="button" className="btn-primary marketplace-share-cta" onClick={openPublish}>
              Publish your bot
              <AnimatedActionIcon icon={ArrowUpRightIcon} size={16} aria-hidden="true" />
            </button>
          </section>
          <aside className="marketplace-share-privacy" aria-label="Privacy when sharing a bot">
            <AnimatedActionIcon icon={ShieldCheckIcon} className="marketplace-share-privacy-icon" size={17} aria-hidden="true" />
            <p>Bot instructions are shared. Chat history isn’t. Check the instructions for private details.</p>
            <button ref={learnMoreButtonRef} className="text-action marketplace-share-privacy-learn-more" type="button" onClick={() => { closeBot(); setLearnMoreOpen(true); }}>
              Learn more
              <AnimatedActionIcon icon={ArrowRightIcon} size={15} aria-hidden="true" />
            </button>
          </aside>

          {team.length > 0 && (
            <section className="marketplace-team" aria-labelledby="gitbot-team-heading">
              <div className="marketplace-section-heading">
                <div>
                  <h2 id="gitbot-team-heading">From the GitBot team</h2>
                </div>
              </div>
              <div className="popular-bot-grid">
                {team.map((bot) => <BotCard key={bot.slug} bot={bot} onOpen={openBot} />)}
              </div>
            </section>
          )}

          {!showError && (
            <section className="marketplace-all" aria-labelledby="all-bots-heading" aria-busy={showSkeleton}>
              <div className="marketplace-section-heading">
                <div>
                  <h2 id="all-bots-heading">All bots</h2>
                  <p>{load.status === "ready" ? `${load.bots.length} GitBot${load.bots.length === 1 ? "" : "s"} in the library.` : "Everything in the library."}</p>
                </div>
              </div>
              <div className="marketplace-toolbar">
                <label className="marketplace-search">
                  <AnimatedActionIcon icon={SearchIcon} size={16} aria-hidden="true" />
                  <input
                    type="search"
                    placeholder="Search bots"
                    aria-label="Search bots"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    disabled={showSkeleton}
                  />
                </label>
                {categories.length > 1 && (
                  <div className="marketplace-chips" role="group" aria-label="Filter by category">
                    <button type="button" className="marketplace-chip" aria-pressed={category === null} onClick={() => setCategory(null)}>All</button>
                    {categories.map(([name, count]) => (
                      <button key={name} type="button" className="marketplace-chip" aria-pressed={category === name} onClick={() => setCategory(category === name ? null : name)}>
                        {name}<span className="marketplace-chip-count">{count}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {showSkeleton ? <SkeletonCards /> : filtered.length ? (
                <div className="popular-bot-grid">
                  {filtered.map((bot) => <BotCard key={bot.slug} bot={bot} onOpen={openBot} />)}
                </div>
              ) : (
                <p className="marketplace-empty" role="status">
                  {load.bots.length === 0 ? "No bots in the library yet. Be the first to publish one." : "No bots match. Try another word or clear the filter."}
                </p>
              )}
            </section>
          )}
        </main>
      </div>
        <ProfilePanelOverlay open={userOpen}>
          {userOpen && (
            <UserProfile
              user={user}
              onBack={() => setUserOpen(false)}
              onSaved={savedUser}
            />
          )}
        </ProfilePanelOverlay>
        <ProfilePanelOverlay open={learnMoreOpen} className="learn-more-overlay">
          {learnMoreOpen && <LearnMorePanel kind="marketplace" onBack={() => {
            setLearnMoreOpen(false);
            requestAnimationFrame(() => learnMoreButtonRef.current?.focus({ preventScroll: true }));
          }} />}
        </ProfilePanelOverlay>
      <div className={`chat-scroll-edge chat-scroll-edge-bottom${scrollEdge === "bottom" && !userOpen && !learnMoreOpen ? " is-visible" : ""}`} aria-hidden="true" />
      </div>
      <MarketplaceBotDetails bot={selectedBot} open={detailsOpen} onClose={closeBot} />
      {publishOpen && publishBots[0] && (
        <ShareModal bot={publishBots[0]} bots={publishBots} initialView="publish" onClose={() => setPublishOpen(false)} />
      )}
      {toastView}
    </div>
  );
}
