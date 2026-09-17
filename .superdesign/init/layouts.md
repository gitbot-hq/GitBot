# Shared layouts

## Root layout

`app/layout.tsx` — imports global CSS and renders the route children.

```tsx
import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "GitBot | Git workflows, simplified", template: "%s | GitBot" },
  description: "GitBot helps teams turn Git workflows into momentum.",
  metadataBase: new URL("https://gitbot.example"),
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
```
