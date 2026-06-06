"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Logo } from "@/components/ui/logo";
import { HERO_ROUTES, NAV_LINKS } from "@/data/site";
import { cn } from "@/lib/utils";

/**
 * Sticky top nav. Over a full-bleed dark hero (HERO_ROUTES) it starts
 * transparent with light text, then turns to solid paper with ink text on
 * scroll. On every other route it is solid from the top — and renders a spacer
 * so page content clears the fixed header.
 */
export function Nav() {
  const pathname = usePathname();
  const overHero = HERO_ROUTES.has(pathname);
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);

  const solid = scrolled || !overHero;
  const onDark = overHero && !scrolled;

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Close the overlay whenever the route changes.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // Lock scroll + Escape-to-close while the overlay is open.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const linkColor = onDark
    ? "text-paper/80 hover:text-paper"
    : "text-espresso hover:text-champagne-dk";

  return (
    <>
      <header
        className={cn(
          "fixed inset-x-0 top-0 z-50 transition-colors duration-500",
          solid
            ? "border-b border-sand/60 bg-paper/90 backdrop-blur-md"
            : "border-b border-transparent bg-transparent",
        )}
      >
        <nav
          aria-label="Primary"
          className="mx-auto flex h-16 max-w-[1200px] items-center justify-between px-6 sm:h-20 sm:px-8"
        >
          <Logo
            className={cn(
              "text-xl transition-colors duration-500 sm:text-2xl",
              onDark ? "text-paper" : "text-ink",
            )}
          />

          {/* Desktop */}
          <div className="hidden items-center gap-9 md:flex">
            <ul className="flex items-center gap-9">
              {NAV_LINKS.map((link) => (
                <li key={link.href}>
                  <Link
                    href={link.href}
                    className={cn(
                      "font-sans text-[0.8125rem] font-normal uppercase tracking-[0.16em] transition-colors duration-300",
                      linkColor,
                    )}
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
            <Link
              href="/contact"
              className={cn(
                "inline-flex items-center border px-5 py-2.5 font-sans text-[0.75rem] font-normal uppercase tracking-[0.18em] transition-colors duration-300",
                onDark
                  ? "border-paper/50 text-paper hover:bg-paper hover:text-ink"
                  : "border-champagne text-champagne-dk hover:bg-champagne hover:text-ink",
              )}
            >
              Inquire
            </Link>
          </div>

          {/* Mobile trigger */}
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-label="Open menu"
            aria-expanded={open}
            aria-controls="mobile-menu"
            className={cn(
              "flex h-10 w-10 items-center justify-center md:hidden",
              onDark ? "text-paper" : "text-ink",
            )}
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M3 6h18M3 12h18M3 18h18" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
            </svg>
          </button>
        </nav>
      </header>

      {/* Spacer so content clears the fixed header on non-hero pages. */}
      {!overHero && <div aria-hidden className="h-16 sm:h-20" />}

      {/* Mobile full-screen overlay */}
      <div
        id="mobile-menu"
        aria-hidden={!open}
        className={cn(
          "fixed inset-0 z-[60] bg-ink text-paper transition-opacity duration-300 md:hidden",
          open ? "opacity-100" : "pointer-events-none opacity-0",
        )}
      >
        <div className="flex h-16 items-center justify-between px-6">
          <Logo className="text-xl text-paper" />
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close menu"
            className="flex h-10 w-10 items-center justify-center text-paper"
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <nav
          aria-label="Mobile"
          className="flex flex-col items-center gap-8 px-6 pt-[16vh]"
        >
          {NAV_LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="font-display text-2xl uppercase tracking-[0.18em] text-paper/90 transition-colors hover:text-champagne"
            >
              {link.label}
            </Link>
          ))}
          <Link
            href="/contact"
            className="mt-4 inline-flex items-center border border-champagne px-8 py-3 font-sans text-sm uppercase tracking-[0.18em] text-paper transition-colors hover:bg-champagne hover:text-ink"
          >
            Inquire
          </Link>
        </nav>
      </div>
    </>
  );
}
