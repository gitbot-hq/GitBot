import type { Bot } from "../lib/gitbot";
import MascotFigure, { EXPRESSION_KEYS } from "./mascot-art";

// Brand tiles in BRANDING.md order. Assigned by stable hash of bot id —
// color is identity, so it must be the same on every render and reload.
export const BRAND_TILES = [
  "var(--brand-sun)",
  "var(--brand-candy)",
  "var(--brand-ember)",
  "var(--brand-leaf)",
  "var(--brand-sky)",
  "var(--brand-honey)",
] as const;

function hashId(id: string, seed: number): number {
  let hash = seed;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  }
  return hash;
}

export function botColorIndex(id: string): number {
  return hashId(id, 0) % BRAND_TILES.length;
}

export function botTile(id: string): string {
  return BRAND_TILES[botColorIndex(id)];
}

export function botExpression(id: string): string {
  return EXPRESSION_KEYS[hashId(id, 7) % EXPRESSION_KEYS.length];
}

// Presentational only: the mascot body takes the bot's brand color.
// Pass `expression` to override the id-hashed default.
export default function BotAvatar({
  bot,
  size = 40,
  expression,
}: {
  bot: Pick<Bot, "id" | "name">;
  size?: number;
  expression?: string;
}) {
  return (
    <span
      className="bot-avatar"
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <MascotFigure expression={expression ?? botExpression(bot.id)} color={botTile(bot.id)} />
    </span>
  );
}
