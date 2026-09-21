import type { NextConfig } from "next";

// Static export: `next build` writes plain HTML/CSS/JS to `out/`, which the
// gitbot CLI bundles and serves itself — there is no Next server at runtime.
const nextConfig: NextConfig = {
  output: "export",
  // This app lives in a subfolder of the CLI's repo, which has its own
  // lockfile. Pin the root here so Next doesn't guess the parent folder.
  outputFileTracingRoot: __dirname,
  turbopack: { root: __dirname },
};

export default nextConfig;
