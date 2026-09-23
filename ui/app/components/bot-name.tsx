import type { ReactNode } from "react";

export default function BotName({ children, color }: { children: ReactNode; color?: string }) {
  return <strong style={color ? { color } : undefined}>{children}</strong>;
}
