// Builds the web UI (ui/, a Next.js static export) and copies it to dist/ui,
// where the CLI serves it from. Run by `npm run build`; never shipped itself.
import { execSync } from "node:child_process";
import { cpSync, existsSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const uiDir = join(root, "ui");
const outDir = join(uiDir, "out");
const destDir = join(root, "dist", "ui");

// Internal design playgrounds: they stay in the repo but not in the package.
const DEMO_PAGES = ["blank", "bot-maker", "cta", "mascot", "mascot-lab", "mascots"];
// The pages users actually reach: `/` redirects to one of the other two.
const REQUIRED = ["index.html", "v2.html", "onboarding.html", "404.html", "_next"];

const run = (cmd) => execSync(cmd, { cwd: uiDir, stdio: "inherit" });

if (!existsSync(join(uiDir, "node_modules"))) {
  console.log("[build-ui] installing UI dependencies (npm ci)");
  run("npm ci");
}

console.log("[build-ui] building the UI");
rmSync(outDir, { recursive: true, force: true });
run("npm run build");

const demoEntries = new Set(DEMO_PAGES.flatMap((page) => [page, `${page}.html`, `${page}.txt`]));
rmSync(destDir, { recursive: true, force: true });
cpSync(outDir, destDir, {
  recursive: true,
  filter: (src) => {
    const relative = src.slice(outDir.length + 1);
    // Demo pages only ever sit at the top level of the export.
    return !demoEntries.has(relative.split(/[\\/]/)[0]) && !relative.endsWith(".DS_Store");
  },
});

const missing = REQUIRED.filter((entry) => !existsSync(join(destDir, entry)));
if (missing.length > 0) {
  console.error(`[build-ui] export is missing: ${missing.join(", ")}`);
  process.exit(1);
}
console.log(`[build-ui] dist/ui ready (${readdirSync(destDir).length} top-level entries)`);
