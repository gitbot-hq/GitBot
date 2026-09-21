// Bot share codes. Verbatim logic from the original client: a bot is
// portable — behaviour travels, machine-local state (repoPath,
// setupStatus, setupThreadId) stays behind.

const SHARE_PREFIX = "gitbot:v1:";
const LEGACY_SHARE_PREFIXES = ["grassbot:v1:"];
const SHARE_FIELDS = [
  "name",
  "emoji",
  "description",
  "instructions",
  "agent",
  "setupInstructions",
  "model",
  "permissionMode",
  "allowedTools",
  "disallowedTools",
];

function toB64(str: string) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  let out = btoa(bin).split("+").join("-").split("/").join("_");
  while (out.charAt(out.length - 1) === "=") out = out.slice(0, -1);
  return out;
}

function fromB64(str: string) {
  const b = str.split("-").join("+").split("_").join("/");
  const padded = b + "=".repeat((4 - (b.length % 4)) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export function sharePrefix() {
  return SHARE_PREFIX;
}

export function shareCode(bot: Record<string, unknown>) {
  const payload: Record<string, unknown> = {};
  SHARE_FIELDS.forEach((k) => {
    if (bot[k] !== undefined && bot[k] !== null && bot[k] !== "") payload[k] = bot[k];
  });
  return SHARE_PREFIX + toB64(JSON.stringify(payload));
}

/** Accepts a share code or the bare JSON inside one. Returns null if neither. */
export function parseShare(text: string): Record<string, unknown> | null {
  const raw = String(text || "").trim();
  if (!raw) return null;
  let json = raw;
  const prefixes = [SHARE_PREFIX].concat(LEGACY_SHARE_PREFIXES);
  for (const p of prefixes) {
    const at = raw.indexOf(p);
    if (at === -1) continue;
    // Tolerate a code that picked up quotes or a wrapping sentence in transit.
    const code = raw.slice(at + p.length).split(/[^A-Za-z0-9_-]/)[0];
    try {
      json = fromB64(code);
    } catch {
      return null;
    }
    break;
  }
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(json);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object" || typeof obj.name !== "string" || !obj.name.trim())
    return null;

  // Only known fields cross the boundary, each checked for its own shape.
  const bot: Record<string, unknown> = { name: obj.name.trim() };
  ["emoji", "description", "instructions", "setupInstructions", "model"].forEach((k) => {
    if (typeof obj[k] === "string") bot[k] = obj[k];
  });
  if (["claude-code", "opencode", "codex"].indexOf(obj.agent as string) !== -1) {
    bot.agent = obj.agent;
  }
  if (["ask-permissions", "auto-approve", "plan"].indexOf(obj.permissionMode as string) !== -1) {
    bot.permissionMode = obj.permissionMode;
  }
  ["allowedTools", "disallowedTools"].forEach((k) => {
    if (Array.isArray(obj[k])) {
      const tools = (obj[k] as unknown[]).filter(
        (t) => typeof t === "string" && (t as string).trim(),
      );
      if (tools.length) bot[k] = tools;
    }
  });
  return bot;
}
