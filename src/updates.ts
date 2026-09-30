const CURRENT_VERSION: string = require("../package.json").version;
const INSTALL_COMMAND = "npm i -g @gitbot-hq/gitbot";
const CHECK_INTERVAL = 60 * 60 * 1000;
const LATEST_URL = "https://registry.npmjs.org/@gitbot-hq%2Fgitbot/latest";
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

// ponytail: stable npm latest only; add full SemVer comparison for prerelease channels.
export function isNewerStableRelease(current: string, latest: unknown): boolean {
  if (typeof latest !== "string" || latest.length > 100) return false;
  const before = VERSION.exec(current);
  const after = VERSION.exec(latest);
  if (!before || !after || after[4]) return false;
  for (let i = 1; i <= 3; i++) {
    if (BigInt(before[i]) !== BigInt(after[i])) return BigInt(after[i]) > BigInt(before[i]);
  }
  return !!before[4];
}

let cached: Promise<string | null> | undefined;
let checkedAt = 0;

async function latestVersion(): Promise<string | null> {
  try {
    const response = await fetch(LATEST_URL, { signal: AbortSignal.timeout(5000), headers: { Accept: "application/json" } });
    if (!response.ok) return null;
    const data = await response.json();
    const version = data?.version;
    if (typeof version !== "string" || version.length > 100) return null;
    const parsed = VERSION.exec(version);
    return parsed && !parsed[4] ? version : null;
  } catch {
    return null;
  }
}

export async function checkForUpdate() {
  if (!cached || Date.now() - checkedAt >= CHECK_INTERVAL) {
    checkedAt = Date.now();
    cached = latestVersion();
  }
  const latest = await cached;
  return {
    currentVersion: CURRENT_VERSION,
    latestVersion: latest,
    updateAvailable: isNewerStableRelease(CURRENT_VERSION, latest),
    installCommand: INSTALL_COMMAND,
  };
}
