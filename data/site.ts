/**
 * Site-wide constants. Single source of truth for nav, contact, social, and
 * service areas. TODO-marked values are placeholders pending Justin's confirm.
 */

export const SITE = {
  name: "LVX Homes",
  shortName: "LVX",
  domain: "lvxhomes.com",
  url: "https://lvxhomes.com",
  description:
    "Luxury real estate aerial cinematography in Arizona — the home from angles you can't walk to, in a short film that shows the layout and beauty a tour can't.",

  // TODO: confirm real contact details
  email: "hello@lvxhomes.com",
  phone: "", // e.g. "(480) 555-0123"

  social: {
    instagram: { handle: "@lvxhomes", url: "https://instagram.com/lvxhomes" },
    youtube: { handle: "LVX Homes", url: "https://youtube.com/@lvxhomes" },
    tiktok: { handle: "@lvxhomes", url: "https://tiktok.com/@lvxhomes" },
  },

  // Footer line
  locations: ["Phoenix", "Mesa", "Scottsdale"] as const,
  // Schema.org areaServed
  serviceAreas: ["Phoenix", "Mesa", "Scottsdale", "Paradise Valley"] as const,

  part107: "FAA Part 107 certified · Arizona based",
} as const;

export const NAV_LINKS = [
  { href: "/work", label: "Work" },
  { href: "/services", label: "Services" },
  { href: "/about", label: "About" },
  { href: "/contact", label: "Contact" },
] as const;

export const TAGLINES = {
  lightInMotion: "Light, in motion.",
  becomesCinema: "Cinematic aerial films for Arizona's finest homes.",
  deserveMore: "For homes that deserve more than photographs.",
  winTheListing: "Some homes deserve a film. Let's make yours.",
} as const;

/**
 * Routes that render a full-bleed dark hero. The nav starts transparent with
 * light text over these, then turns solid paper on scroll. Everywhere else the
 * nav is solid paper from the top.
 */
export const HERO_ROUTES = new Set<string>(["/", "/vip"]);
