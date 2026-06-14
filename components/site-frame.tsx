"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { Nav } from "@/components/nav";

/**
 * Renders the public marketing chrome (top Nav + Footer) across the site, but
 * NOT on the gated /studio back office, which supplies its own Studio nav and
 * dark shell. Keeping this in one client component lets the server root layout
 * stay simple while the chrome reacts to the route.
 */
export function SiteFrame({
  children,
  footer,
}: {
  children: ReactNode;
  footer: ReactNode;
}) {
  const path = usePathname() ?? "";
  // The gated /studio back office and the chromeless /embed player both supply
  // their own shell — no public marketing nav/footer on either.
  const bare = path.startsWith("/studio") || path.startsWith("/embed");
  return (
    <>
      {!bare && <Nav />}
      <main id="main" className="flex-1">
        {children}
      </main>
      {!bare && footer}
    </>
  );
}
