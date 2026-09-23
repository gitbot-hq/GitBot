"use client";

import { useState } from "react";
import BotMascot, { type BotMascotProps } from "./bot-maker/BotMascot";

// Quiet curiosity at rest; a welcoming smile when someone approaches.
export default function MarketplaceMascot(props: Omit<BotMascotProps, "expression">) {
  const [hovered, setHovered] = useState(false);
  return <span style={{ display: "inline-flex" }} onPointerEnter={() => setHovered(true)} onPointerLeave={() => setHovered(false)}>
    <BotMascot {...props} expression={hovered ? "happy" : "looking-around"} />
  </span>;
}
