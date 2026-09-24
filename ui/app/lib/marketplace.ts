// Client for the marketplace API. The gitbot server proxies `/marketplace/*`
// to the gitbot-api service, so these requests stay on the current origin.
// Unlike the gitbot API, errors arrive as `{ error: { code, message } }`.
const BASE = "/marketplace";

export type MarketplaceAgent = "claude-code" | "codex" | "opencode";
export type MarketplacePermissionMode = "ask-permissions" | "auto-approve" | "plan";
export type MarketplaceCategory =
  | "Code review" | "Developer workflow" | "Releases" | "Maintenance"
  | "Repository care" | "Code exploration" | "Testing" | "Documentation";

export type MarketplaceBotCard = {
  slug: string;
  name: string;
  description: string;
  category: MarketplaceCategory;
  emoji: string;
  author: { github: string; name: string; avatarUrl: string };
  mascot: { body: string; color: string; cssColor: string; activity: string };
  agent: MarketplaceAgent;
  permissionMode: MarketplacePermissionMode;
  verified: boolean;
  featured: boolean;
  featuredRank: number | null;
  hasSetup: boolean;
  installCount: number;
  createdAt: string;
  updatedAt: string;
};

export type MarketplaceBotDetail = MarketplaceBotCard & {
  about: string;
  features: string[];
  examplePrompt: string;
  model: string | null;
  allowedTools: string[] | null;
  disallowedTools: string[] | null;
  instructions: string;
  setupInstructions: string | null;
  shareCode: string;
};

export type MarketplaceListParams = {
  q?: string;
  category?: MarketplaceCategory;
  agent?: MarketplaceAgent;
  verified?: boolean;
  featured?: boolean;
  sort?: "featured" | "newest" | "updated" | "popular" | "name";
  limit?: number;
  offset?: number;
};

export class MarketplaceError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
  /** The API itself could not be reached (proxy 502 or network failure). */
  get unavailable() {
    return this.status === 502 || this.status === 0;
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, init);
  } catch {
    throw new MarketplaceError(0, "NETWORK", "Marketplace is unavailable right now");
  }
  const body = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } } & Record<string, unknown>;
  if (!res.ok || body.error) {
    throw new MarketplaceError(res.status, body.error?.code ?? "REQUEST_FAILED", body.error?.message ?? `Request failed (${res.status})`);
  }
  return body as T;
}

export function listMarketplaceBots(params: MarketplaceListParams = {}) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "" && v !== null) qs.set(k, String(v));
  }
  const query = qs.toString();
  return req<{ bots: MarketplaceBotCard[]; total: number; limit: number; offset: number }>(`/v1/bots${query ? `?${query}` : ""}`);
}

export function getMarketplaceBot(slug: string) {
  return req<{ bot: MarketplaceBotDetail }>(`/v1/bots/${encodeURIComponent(slug)}`);
}

export function getMarketplaceCategories() {
  return req<{ categories: { name: MarketplaceCategory; count: number }[] }>("/v1/categories");
}

export function getMarketplaceIndex() {
  return req<{ index: { runId: number; source: string; commitSha: string | null; indexedAt: string; botCount: number } | null }>("/v1/index");
}

/** Anonymous install counter. Fire-and-forget: a failure must never block an install. */
export function recordMarketplaceInstall(slug: string, agent?: MarketplaceAgent) {
  return req<{ slug: string; installCount: number }>(`/v1/bots/${encodeURIComponent(slug)}/installs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(agent ? { agent } : {}),
  });
}
