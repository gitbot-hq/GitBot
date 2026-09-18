import { readFileSync } from "fs";
import { dirname, join } from "path";

/** marked (GFM markdown) + DOMPurify (sanitiser), inlined into the page.
 *  The hub is usually reached over a LAN or a tunnel, often with no internet,
 *  so a CDN tag would leave the transcript unformatted. Read once, cached. */
let cached: string | undefined;

/** Reads a file sitting next to a package entry point. Resolving through an
 *  entry rather than a bare path keeps this working from anywhere npm chose to
 *  hoist the dependency; dompurify doesn't export its package.json, so its
 *  main entry is the anchor. */
function readVendor(entry: string, file: string): string {
  return readFileSync(join(dirname(require.resolve(entry)), file), "utf8");
}

export function vendorScripts(): string {
  if (cached !== undefined) return cached;
  try {
    const marked = readVendor("marked/package.json", "lib/marked.umd.js");
    const purify = readVendor("dompurify", "purify.min.js");
    cached = `<script>${marked}</script>\n<script>${purify}</script>`;
  } catch (err: any) {
    // Missing deps shouldn't take the hub down — the client falls back to
    // plain text when marked/DOMPurify aren't on the page.
    console.warn(`  Markdown renderer unavailable (${err?.message ?? err}); showing plain text.`);
    cached = "";
  }
  return cached;
}
