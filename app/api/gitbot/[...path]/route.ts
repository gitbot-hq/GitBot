import { NextRequest } from "next/server";

// Same-origin proxy to the live GitBot server. The browser talks to us;
// we talk to GitBot server-side (curl-compatible, no CORS/browser quirks).
const UPSTREAM = process.env.GITBOT_URL ?? "http://localhost:3100";

async function forward(req: NextRequest, path: string[]) {
  const url = new URL(req.url);
  const target = `${UPSTREAM}/${path.join("/")}${url.search}`;
  const init: RequestInit = { method: req.method, redirect: "manual" };
  if (req.method !== "GET" && req.method !== "HEAD") {
    const text = await req.text();
    if (text) {
      init.body = text;
      init.headers = { "Content-Type": "application/json" };
    }
  }
  if (req.headers.has("last-event-id")) {
    init.headers = { ...(init.headers ?? {}), "last-event-id": req.headers.get("last-event-id") as string };
  }
  const upstream = await fetch(target, init);
  const headers = new Headers();
  const contentType = upstream.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  if (contentType?.includes("text/event-stream")) {
    headers.set("cache-control", "no-cache");
    headers.set("connection", "keep-alive");
  }
  return new Response(upstream.body, { status: upstream.status, headers });
}

export function GET(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  return ctx.params.then(({ path }) => forward(req, path));
}

export function POST(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  return ctx.params.then(({ path }) => forward(req, path));
}

export function PATCH(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  return ctx.params.then(({ path }) => forward(req, path));
}

export function DELETE(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  return ctx.params.then(({ path }) => forward(req, path));
}
