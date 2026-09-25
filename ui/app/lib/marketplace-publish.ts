// Verbatim copy of docs/publish-prompt.md from https://github.com/gitbot-hq/Library.
import publishGuideLines from "./publish-prompt.json" with { type: "json" };

export const MARKETPLACE_REPO_URL = "https://github.com/gitbot-hq/Library";
export const MARKETPLACE_PUBLISH_GUIDE_URL = `${MARKETPLACE_REPO_URL}/blob/main/docs/publish-prompt.md`;

// The prompt is the Library guide, unchanged: it works out with the agent which
// bot to publish, so nothing here depends on a bot chosen in the app.
export const MARKETPLACE_PUBLISH_PROMPT = publishGuideLines.join("\n");

export type MarketplaceListing = {
  name: string;
  description: string;
  slug?: string;
  emoji?: string;
  agent?: string;
  model?: string;
  permissionMode?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  mascot?: string | { body: string; color: string; activity: string };
  color?: string;
  category?: string;
  tags?: string[];
  about?: string;
  features?: string[];
  capabilities?: string[];
  examplePrompt?: string;
  starterPrompt?: string;
  author?: { github: string; name: string };
  instructions?: string;
  setupInstructions?: string;
};

export function parseMarketplaceListing(value: string): MarketplaceListing | null {
  try {
    const listing = JSON.parse(value) as Record<string, unknown>;
    if (!listing || typeof listing.name !== "string" || typeof listing.description !== "string") return null;
    const strings = ["slug", "emoji", "agent", "model", "permissionMode", "color", "category", "about", "examplePrompt", "starterPrompt", "instructions", "setupInstructions"];
    if (strings.some((key) => listing[key] !== undefined && typeof listing[key] !== "string")) return null;
    if (["allowedTools", "disallowedTools", "tags", "features", "capabilities"].some((key) => listing[key] !== undefined && (!Array.isArray(listing[key]) || !(listing[key] as unknown[]).every((item) => typeof item === "string")))) return null;
    if (listing.mascot !== undefined && typeof listing.mascot !== "string" && !isStringRecord(listing.mascot, ["body", "color", "activity"])) return null;
    if (listing.author !== undefined && !isStringRecord(listing.author, ["github", "name"])) return null;
    return listing as MarketplaceListing;
  } catch {
    return null;
  }
}

function isStringRecord(value: unknown, keys: string[]): boolean {
  return !!value && typeof value === "object" && keys.every((key) => typeof (value as Record<string, unknown>)[key] === "string");
}
