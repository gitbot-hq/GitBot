import { readFileSync } from "node:fs";
import { join } from "node:path";
import Image from "next/image";
import type { Metadata } from "next";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import styles from "./readme-preview.module.css";

export const metadata: Metadata = {
  title: "README draft",
  robots: { index: false, follow: false },
};

const screenshots: Record<string, { width: number; height: number }> = {
  "assets/screenshots/hub.png": { width: 2880, height: 1800 },
  "assets/screenshots/bot-studio.png": { width: 2880, height: 1800 },
  "assets/screenshots/approval.png": { width: 1200, height: 610 },
  "assets/screenshots/create-menu.png": { width: 1044, height: 570 },
  "assets/screenshots/create-bot-form.png": { width: 2904, height: 1590 },
  "assets/screenshots/create-thread.png": { width: 2234, height: 1494 },
  "assets/screenshots/share-menu.png": { width: 2026, height: 972 },
  "assets/screenshots/share-code.png": { width: 1510, height: 1226 },
  "assets/screenshots/publish-marketplace.png": { width: 1470, height: 1376 },
};

const slug = (value: React.ReactNode) => String(value).toLowerCase().replace(/[^a-z0-9 -]/g, "").trim().replace(/ +/g, "-");

export default function ReadmePreview() {
  const markdown = readFileSync(join(process.cwd(), "..", "README.draft.md"), "utf8");

  return (
    <div className={styles.page}>
      <div className={styles.previewBar}>
        <span><strong>README draft</strong><span className={styles.previewState}>Local preview. Not published.</span></span>
        <a href="/">Back to GitBot</a>
      </div>
      <main className={styles.content}>
        <article className={styles.prose}>
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
            h1: ({ children }) => <h1 id={slug(children)}>{children}</h1>,
            h2: ({ children }) => <h2 id={slug(children)}>{children}</h2>,
            h3: ({ children }) => <h3 id={slug(children)}>{children}</h3>,
            a: ({ href, children }) => <a href={href && !href.startsWith("#") && !href.startsWith("http") ? `https://github.com/gitbot-hq/GitBot/blob/main/${href}` : href}>{children}</a>,
            img: ({ src, alt }) => {
              const screenshot = typeof src === "string" ? screenshots[src] : undefined;
              return screenshot
                ? <Image src={`data:image/png;base64,${readFileSync(join(process.cwd(), "..", src)).toString("base64")}`} width={screenshot.width} height={screenshot.height} alt={alt ?? ""} unoptimized />
                : typeof src === "string" && src.startsWith("https://img.shields.io/")
                  ? <img src={src} alt={alt ?? ""} />
                : <span role="img" aria-label={alt ?? "Image to add"}>{alt ?? "Image to add"}</span>;
            },
          }}>{markdown}</ReactMarkdown>
        </article>
      </main>
    </div>
  );
}
