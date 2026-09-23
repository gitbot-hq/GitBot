"use client";

import { useEffect } from "react";

export default function LegacyV2() {
  useEffect(() => {
    window.location.replace("/");
  }, []);

  return <a href="/">Open GitBot</a>;
}
