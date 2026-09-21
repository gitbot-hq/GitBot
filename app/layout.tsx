import type { Metadata } from "next";
import "./globals.css";
import "./components/mascot-depth.css";
import { MascotDepthDefs } from "./components/mascot-depth";

export const metadata: Metadata = {
  title: {
    default: "GitBot | Git workflows, simplified",
    template: "%s | GitBot",
  },
  description: "GitBot helps teams turn Git workflows into momentum.",
  metadataBase: new URL("https://gitbot.example"),
  icons: {
    icon: [
      {
        url: "/favicon-light.svg",
        type: "image/svg+xml",
        media: "(prefers-color-scheme: light)",
      },
      {
        url: "/favicon-dark.svg",
        type: "image/svg+xml",
        media: "(prefers-color-scheme: dark)",
      },
    ],
  },
};

// Runs before paint: restores saved theme, else follows the OS.
// Prevents a light/dark flash on load.
const themeInit = `(function(){try{var s=localStorage.getItem("gitbot-theme");var t=s||(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light");document.documentElement.dataset.theme=t;}catch(e){}})();`;

// Runs before paint: restores saved v2 panel widths as CSS vars so the
// first paint already uses them. React leaves widths unset (null) until
// the user drags, so these vars own the width — no resize flash, and no
// hydration mismatch (the server renders the same unset markup).
// Keep the clamp ranges in sync with app/v2/page.tsx.
const widthsInit = `(function(){try{function w(k,f,mn,mx){var v=Number(localStorage.getItem(k));if(!isFinite(v))return f;return Math.min(mx,Math.max(mn,v));}var s=document.documentElement.style;s.setProperty("--v2-side-w",w("gitbot-v2-side-width",260,240,420)+"px");s.setProperty("--v2-threads-w",w("gitbot-v2-threads-width",248,200,480)+"px");}catch(e){}})();`;

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInit }} />
        <script dangerouslySetInnerHTML={{ __html: widthsInit }} />
      </head>
      <body>
        <MascotDepthDefs />
        {children}
      </body>
    </html>
  );
}
