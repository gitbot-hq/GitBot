import { createReadStream, existsSync, statSync } from "fs";
import { extname, join, normalize, sep } from "path";
import http from "node:http";

// The web UI is a Next.js static export (ui/ → `next build` → ui/out), copied
// to dist/ui at build time. Published installs read dist/ui; running from
// source with `npm run dev` falls back to the export folder itself.
const UI_DIR: string | undefined = [join(__dirname, "ui"), join(__dirname, "..", "ui", "out")].find((dir) =>
  existsSync(join(dir, "index.html")),
);

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  // Next's client-navigation payloads; the router accepts text/plain for exports.
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export function uiAvailable(): boolean {
  return UI_DIR !== undefined;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Maps a request path to a file inside the UI folder, or null when the path
 * isn't a UI asset (so the API router should take it). `/` is index.html, and
 * extensionless page URLs resolve to their export: `/v2` → v2.html.
 */
function resolveUiFile(urlPath: string): string | null {
  if (!UI_DIR) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;

  const relative = decoded === "/" || decoded === "" ? "/index.html" : decoded;
  const candidate = normalize(join(UI_DIR, relative));
  // normalize() has collapsed any `..`; anything that escaped the folder is refused.
  if (!candidate.startsWith(UI_DIR + sep)) return null;

  if (isFile(candidate)) return candidate;
  if (isFile(candidate + ".html")) return candidate + ".html";
  return null;
}

/**
 * The UI file a request is for, or null when it belongs to the API. Both
 * request listeners ask this, so exactly one of them answers each request.
 */
export function uiFileFor(method: string | undefined, url: string | undefined): string | null {
  if (method !== "GET" && method !== "HEAD") return null;
  return resolveUiFile((url ?? "/").split("?")[0]);
}

export function serveUiFile(req: http.IncomingMessage, res: http.ServerResponse, file: string): void {
  // Files under _next/static carry a content hash in their name, so they can be
  // cached forever; pages must revalidate or an upgrade would keep the old UI.
  const immutable = file.includes(`${sep}_next${sep}static${sep}`);
  res.writeHead(200, {
    "Content-Type": CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
    "Content-Length": statSync(file).size,
    "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  const stream = createReadStream(file);
  stream.on("error", () => res.destroy());
  stream.pipe(res);
}
