import AppProviders from "./components/app-providers";
import DesktopNotice from "./components/desktop-notice";
import type { Metadata, Viewport } from "next";
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
    // iOS's home-screen icon (PNG, opaque; scripts/make-icons.mjs).
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  // Lets iOS (16.4+) add GitBot to the Home Screen as an app of its own, the
  // only place iOS allows web push. Every URL in it is relative to the
  // origin, so it works on localhost and behind an HTTPS proxy alike.
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "GitBot",
    // "default" lets the theme-color below tint the status bar; the app
    // doesn't pad for the notch, which "black-translucent" would need.
    statusBarStyle: "default",
  },
  // Next emits only the standard `mobile-web-app-capable`; iOS before 16.4
  // reads the Apple name.
  other: { "apple-mobile-web-app-capable": "yes" },
};

// Locks the page at 1x on Android, where the reported accidental pinching
// happened: Chrome honours `userScalable: false`. iOS Safari does NOT — it has
// ignored both `user-scalable` and `maximum-scale` for user-initiated pinch
// since iOS 10, and `touch-action` does not reach the page-level gesture
// either, so pinch still works there. `maximumScale: 1` does one thing on iOS:
// it suppresses the auto zoom-to-fit when an input under 16px takes focus.
// GitBot is a dense two-pane tool, not a document — an accidental pinch leaves
// the shell half off-screen with no obvious way back.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  // The status bar of the installed iOS app (and an installed Chrome window)
  // follows the OS theme; the surfaces' --bg in BRANDING.md.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f7f7f7" },
    { media: "(prefers-color-scheme: dark)", color: "#121211" },
  ],
};

// Runs before paint: restores saved theme, else follows the OS.
// Prevents a light/dark flash on load.
const themeInit = `(function(){try{var s=localStorage.getItem("gitbot-theme");var t=s||(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light");document.documentElement.dataset.theme=t;}catch(e){}})();`;

// Runs before paint: restores saved v2 panel widths as CSS vars so the
// first paint already uses them. React leaves widths unset (null) until
// the user drags, so these vars own the width — no resize flash, and no
// hydration mismatch (the server renders the same unset markup).
// Keep the clamp ranges in sync with app/components/app-shell.tsx.
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
        <DesktopNotice><AppProviders>{children}</AppProviders></DesktopNotice>
      </body>
    </html>
  );
}
