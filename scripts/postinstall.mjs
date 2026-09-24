// Printed once, on the user's machine, when gitbot is installed. Unlike the
// other scripts here this one ships in the package (see `files`), because npm
// runs it from the installed tree.
//
// Two rules, both load-bearing:
//   1. It must never throw. A failing postinstall aborts `npm i -g gitbot`,
//      so a banner would cost someone the install. Hence the catch-all and
//      the unconditional exit 0.
//   2. It stays quiet unless a human is watching. An install banner in a CI
//      log is noise nobody asked for.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = "https://github.com/gitbot-hq/GitBot";

try {
  if (!process.env.CI && process.stdout.isTTY) {
    const pkg = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    const { version } = JSON.parse(readFileSync(pkg, "utf8"));
    const star = (s) => `\x1b[33m${s}\x1b[0m`;
    const dim = (s) => `\x1b[2m${s}\x1b[0m`;

    console.log("");
    console.log(`  ${star("★")}  gitbot v${version} installed — run \`gitbot start\` to open the hub.`);
    console.log("");
    console.log("     Star the repo if it's useful. It's how other people find it:");
    console.log(`     ${dim(REPO)}`);
    console.log("");
  }
} catch {}

process.exit(0);
