import { test } from "node:test";
import assert from "node:assert/strict";
import { contentTypeFor } from "../src/static-ui";

test("the web app manifest, icons and service worker go out with the types browsers insist on", () => {
  // iOS and Chrome ignore a manifest served as application/octet-stream.
  assert.equal(contentTypeFor("/ui/manifest.webmanifest"), "application/manifest+json; charset=utf-8");
  assert.equal(contentTypeFor("/ui/icons/apple-touch-icon.png"), "image/png");
  // A service worker must be JavaScript, or registering it fails.
  assert.equal(contentTypeFor("/ui/sw.js"), "text/javascript; charset=utf-8");
  assert.equal(contentTypeFor("/ui/unknown.xyz"), "application/octet-stream");
});
