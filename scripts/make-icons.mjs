// Makes the PNG app icons (ui/public/icons/) from the mascot SVG, for the web
// app manifest and iOS's apple-touch-icon. The PNGs are committed; run this
// again only when the mascot changes. Needs rsvg-convert (librsvg).
//
//   node scripts/make-icons.mjs
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "ui", "public", "icons");
// The white mascot, drawn for dark backgrounds.
const mark = readFileSync(join(root, "ui", "public", "favicon-dark.svg"), "utf-8");
const inner = mark.slice(mark.indexOf(">") + 1, mark.lastIndexOf("</svg>"));
// The dark theme's --bg (ui/app/globals.css). Icons are opaque: iOS fills
// transparency in a home-screen icon with black anyway.
const BG = "#121211";
const MARK_W = 333;
const MARK_H = 244;

/** A square icon with the mascot centred, `scale` of the width wide. */
function iconSvg(size, scale) {
  const w = size * scale;
  const h = (w * MARK_H) / MARK_W;
  const x = (size - w) / 2;
  // A touch below centre: the mascot's ears make it look high otherwise.
  const y = (size - h) / 2 + size * 0.02;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
<rect width="${size}" height="${size}" fill="${BG}"/>
<svg x="${x}" y="${y}" width="${w}" height="${h}" viewBox="0 0 ${MARK_W} ${MARK_H}" fill="none">${inner}</svg>
</svg>`;
}

const ICONS = [
  // iOS rounds the corners itself.
  { file: "apple-touch-icon.png", size: 180, scale: 0.7 },
  { file: "icon-192.png", size: 192, scale: 0.7 },
  { file: "icon-512.png", size: 512, scale: 0.7 },
  // Maskable: the platform may crop to a circle of 80% of the width, so the
  // mascot stays well inside it.
  { file: "icon-maskable-512.png", size: 512, scale: 0.55 },
];

mkdirSync(outDir, { recursive: true });
for (const { file, size, scale } of ICONS) {
  execFileSync("rsvg-convert", ["--format", "png", "--output", join(outDir, file), "/dev/stdin"], {
    input: iconSvg(size, scale),
  });
  console.log(`[make-icons] ${file} (${size}×${size})`);
}
