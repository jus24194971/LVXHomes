"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * Top bar for the /studio back office. Add a tool by dropping a route under
 * app/studio and a line in LINKS. Identity + sign-out come from Cloudflare
 * Access's own endpoints, so there's no app-level auth to maintain.
 */
const LINKS: { href: string; label: string; exact?: boolean }[] = [
  { href: "/studio", label: "Dashboard", exact: true },
  { href: "/studio/library", label: "Library" },
  { href: "/studio/tours", label: "Tours" },
  { href: "/studio/plan", label: "Floorplans" },
  { href: "/studio/measure", label: "Measure" },
  { href: "/studio/pins", label: "Pins" },
  { href: "/studio/render", label: "Render" },
  { href: "/studio/lab", label: "Lab" },
];

export function StudioNav() {
  const pathname = usePathname() ?? "";
  const [email, setEmail] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/cdn-cgi/access/get-identity", { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (alive && d?.email) setEmail(d.email as string);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const active = (href: string, exact?: boolean) =>
    exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);

  return (
    <header className="sticky top-0 z-50 border-b border-champagne/20 bg-ink/95 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-[1400px] items-center gap-5 px-5 sm:px-8">
        <Link href="/studio" className="flex shrink-0 items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-champagne" aria-hidden />
          <span className="font-display text-sm uppercase tracking-[0.22em] text-paper">
            LVX <span className="text-champagne">Studio</span>
          </span>
        </Link>

        <nav
          aria-label="Studio"
          className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
        >
          {LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              aria-current={active(l.href, l.exact) ? "page" : undefined}
              className={cn(
                "shrink-0 rounded-full px-3 py-1.5 font-sans text-[0.75rem] uppercase tracking-[0.14em] transition-colors",
                active(l.href, l.exact)
                  ? "bg-champagne/15 text-champagne"
                  : "text-paper/55 hover:text-paper",
              )}
            >
              {l.label}
            </Link>
          ))}
        </nav>

        <div className="flex shrink-0 items-center gap-4">
          {email && (
            <span
              className="hidden max-w-[14rem] truncate font-sans text-[0.7rem] tracking-wide text-paper/40 lg:inline"
              title={email}
            >
              {email}
            </span>
          )}
          <Link
            href="/"
            className="hidden font-sans text-[0.7rem] uppercase tracking-[0.14em] text-paper/50 transition-colors hover:text-champagne sm:inline"
          >
            View site
          </Link>
          <a
            href="/cdn-cgi/access/logout"
            className="font-sans text-[0.7rem] uppercase tracking-[0.14em] text-paper/50 transition-colors hover:text-champagne"
          >
            Sign out
          </a>
        </div>
      </div>
    </header>
  );
}
