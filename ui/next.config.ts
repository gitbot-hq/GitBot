import type { NextConfig } from "next";

// Static export: `next build` writes plain HTML/CSS/JS to `out/`, which the
// gitbot CLI bundles and serves itself — there is no Next server at runtime.
const nextConfig: NextConfig = {
  output: "export",
  // There is no Next server to run the image optimizer, so `next/image` must
  // emit plain asset paths; otherwise it points at /_next/image and 404s.
  images: { unoptimized: true },
  // This app lives in a subfolder of the CLI's repo, which has its own
  // lockfile. Pin the root here so Next doesn't guess the parent folder.
  outputFileTracingRoot: __dirname,
  turbopack: { root: __dirname },
  ...(process.env.NODE_ENV === "development"
    ? {
        async rewrites() {
          return [{ source: "/:path*", destination: "http://127.0.0.1:3100/:path*" }];
        },
      }
    : {}),
};

export default nextConfig;
