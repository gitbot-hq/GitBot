"use client";

import Link from "next/link";
import type { ComponentProps } from "react";
import { usePageNavigation } from "./app-providers";

export default function PageLink({ href, ...props }: Omit<ComponentProps<typeof Link>, "href" | "onNavigate"> & { href: "/" | "/marketplace" }) {
  const navigate = usePageNavigation();
  return <Link {...props} href={href} prefetch onNavigate={(event) => {
    event.preventDefault();
    navigate(href);
  }} />;
}
