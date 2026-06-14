import Link from "next/link";
import { Container } from "@/components/ui/container";
import { Logo } from "@/components/ui/logo";
import { NAV_LINKS, SITE, TAGLINES } from "@/data/site";

function InstagramIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="5" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="12" cy="12" r="4" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="17.4" cy="6.6" r="1" fill="currentColor" />
    </svg>
  );
}

function YouTubeIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="2" y="5" width="20" height="14" rx="4" stroke="currentColor" strokeWidth="1.4" />
      <path d="M10 9.3l5.2 2.7-5.2 2.7V9.3z" fill="currentColor" />
    </svg>
  );
}

function TikTokIcon() {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M16.5 3c.31 2.04 1.62 3.62 3.5 3.86v2.52c-1.27 0-2.46-.4-3.45-1.07v5.79c0 2.94-2.39 5.32-5.32 5.32a5.32 5.32 0 0 1-5.32-5.32c0-2.74 2.06-4.99 4.72-5.28v2.62a2.7 2.7 0 0 0-2.02 2.61 2.62 2.62 0 1 0 5.24 0V3h2.97z" />
    </svg>
  );
}

const SOCIAL = [
  { label: "Instagram", url: SITE.social.instagram.url, Icon: InstagramIcon },
  { label: "YouTube", url: SITE.social.youtube.url, Icon: YouTubeIcon },
  { label: "TikTok", url: SITE.social.tiktok.url, Icon: TikTokIcon },
];

export function Footer() {
  const year = new Date().getFullYear();

  return (
    <footer className="bg-espresso text-paper">
      <Container className="py-16 sm:py-20">
        <div className="flex flex-col gap-12 md:flex-row md:items-start md:justify-between">
          {/* Brand + tagline */}
          <div className="max-w-sm">
            <Logo href="/" className="text-3xl text-champagne" />
            <p className="mt-5 font-serif text-xl italic leading-snug text-paper/80">
              {TAGLINES.becomesCinema}
            </p>
            <p className="mt-6 font-sans text-xs uppercase tracking-[0.22em] text-paper/50">
              {SITE.locations.join("  ·  ")}
            </p>
          </div>

          {/* Nav repeat */}
          <nav aria-label="Footer" className="flex flex-col gap-3">
            {NAV_LINKS.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                className="font-sans text-sm uppercase tracking-[0.16em] text-paper/70 transition-colors hover:text-champagne"
              >
                {l.label}
              </Link>
            ))}
          </nav>

          {/* Contact + social */}
          <div className="flex flex-col gap-3">
            <a
              href={`https://${SITE.domain}`}
              className="font-sans text-sm tracking-wide text-paper/70 transition-colors hover:text-champagne"
            >
              {SITE.domain}
            </a>
            <a
              href={SITE.social.instagram.url}
              target="_blank"
              rel="noopener noreferrer"
              className="font-sans text-sm tracking-wide text-paper/70 transition-colors hover:text-champagne"
            >
              {SITE.social.instagram.handle}
            </a>
            <div className="mt-2 flex items-center gap-5">
              {SOCIAL.map(({ label, url, Icon }) => (
                <a
                  key={label}
                  href={url}
                  aria-label={label}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-paper/70 transition-colors hover:text-champagne"
                >
                  <Icon />
                </a>
              ))}
            </div>
          </div>
        </div>

        <div aria-hidden className="my-10 h-px w-full bg-paper/15" />

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="font-sans text-xs tracking-wide text-paper/45">{SITE.part107}</p>
          <p className="font-sans text-xs tracking-wide text-paper/45">
            © {year} {SITE.name}. All rights reserved.
          </p>
        </div>

        <div className="mt-6 flex justify-center sm:justify-end">
          <Link
            href="/studio"
            className="font-sans text-[0.65rem] uppercase tracking-[0.24em] text-paper/25 transition-colors hover:text-champagne"
          >
            Studio
          </Link>
        </div>
      </Container>
    </footer>
  );
}
