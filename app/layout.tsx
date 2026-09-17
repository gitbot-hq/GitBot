import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "GitBot | Git workflows, simplified",
    template: "%s | GitBot",
  },
  description: "GitBot helps teams turn Git workflows into momentum.",
  metadataBase: new URL("https://gitbot.example"),
};

// Runs before paint: restores saved theme, else follows the OS.
// Prevents a light/dark flash on load.
const themeInit = `(function(){try{var s=localStorage.getItem("gitbot-theme");var t=s||(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light");document.documentElement.dataset.theme=t;}catch(e){}})();`;

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInit }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
