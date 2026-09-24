import type { NextConfig } from "next";

// Static export: `next build` writes plain HTML/CSS/JS to `out/`, which the
// gitbot CLI bundles and serves itself — there is no Next server at runtime.
const nextConfig: NextConfig = {
  output: "export",
  // No Next server means no image optimizer: next/image must emit the plain
  // file path, or every <Image> requests /_next/image?… and 404s.
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
