import type { IRequest, IResponse } from "./server-common";

/**
 * Forwards the UI's `/marketplace/*` requests to the gitbot marketplace API
 * (the gitbot-api service that indexes gitbot-hq/Library). The UI is served
 * from this origin, so going through here means no CORS and no API URL baked
 * into the static export. Only the public read routes and the install counter
 * are forwarded; the API's admin routes are never reachable this way.
 */
export const DEFAULT_MARKETPLACE_API = "https://uat.revise.network/gitbot/api";

const PREFIX = "/marketplace";
const TIMEOUT_MS = 10_000;
const FORWARDED_RESPONSE_HEADERS = ["content-type", "etag", "cache-control"];

export function marketplaceApiBase(): string {
  return (process.env.GITBOT_MARKETPLACE_API || DEFAULT_MARKETPLACE_API).replace(/\/+$/, "");
}

/** GET /marketplace/v1/... and POST /marketplace/v1/bots/:slug/installs only. */
function allowed(method: string, path: string): boolean {
  if (method === "GET") return /^\/v1\/[a-z0-9/_-]*$/i.test(path);
  if (method === "POST") return /^\/v1\/bots\/[a-z0-9-]+\/installs$/.test(path);
  return false;
}

function readRaw(req: IRequest): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk: Buffer | string) => { data += chunk; });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

/** Returns true when the request was a marketplace request (answered here). */
export async function handleMarketplaceRoutes(req: IRequest, res: IResponse): Promise<boolean> {
  const url = req.url ?? "/";
  const [fullPath, search = ""] = url.split(/\?(.*)/s);
  if (fullPath !== PREFIX && !fullPath.startsWith(PREFIX + "/")) return false;
  const method = req.method ?? "GET";
  const path = fullPath.slice(PREFIX.length) || "/";

  if (!allowed(method, path)) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { code: "NOT_FOUND", message: "Route not found" } }));
    return true;
  }

  const headers: Record<string, string> = { Accept: "application/json" };
  const ifNoneMatch = req.headers["if-none-match"];
  if (typeof ifNoneMatch === "string") headers["If-None-Match"] = ifNoneMatch;
  let body: string | undefined;
  if (method === "POST") {
    body = await readRaw(req);
    if (body) headers["Content-Type"] = "application/json";
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${marketplaceApiBase()}${path}${search ? `?${search}` : ""}`, {
      method,
      headers,
      body: body || undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err: any) {
    console.warn(`[marketplace] ${method} ${path}: ${err?.message ?? err}`);
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { code: "MARKETPLACE_UNAVAILABLE", message: "Marketplace is unavailable right now" } }));
    return true;
  }

  const out: Record<string, string> = {};
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) out[name] = value;
  }
  res.writeHead(upstream.status, out);
  if (upstream.status === 304 || method === "HEAD") { res.end(); return true; }
  res.end(await upstream.text());
  return true;
}
