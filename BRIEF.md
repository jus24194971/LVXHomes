# LVX Homes — Website Build Brief

> Source of truth for the LVX Homes site. Update this doc; don't re-explain.

## 0. Kickoff prompt

Build a production Next.js website for LVX Homes, a luxury real estate aerial
cinematography studio in Arizona. Read `BRIEF.md` in this repo for the complete
brand system, sitemap, page specs, and technical requirements, and follow it
precisely. Stack: Next.js (App Router) + TypeScript + Tailwind CSS, deployed to
Vercel, with video via Cloudflare Stream. Start by scaffolding the project,
wiring the brand tokens (fonts + palette) into Tailwind and a global stylesheet,
and building the shared layout (nav + footer). Then build the pages in the order
listed in Section 12. Use placeholder copy and a placeholder Cloudflare Stream
video UID where real assets aren't available yet, clearly marked with `TODO:`.
Prioritize restraint, whitespace, and typographic craft over visual noise.

## 1. The brand in one line

LVX makes a high-end listing feel like a film — a short, cinematic FPV flythrough
that shows a home from angles a buyer can't reach on foot: the layout, the flow,
and the beauty a flat gallery or a fifty-minute walkthrough never lands.
The site's job: make a $1M–$2M+ listing agent think "this is the most impressive
marketing I've seen, and it makes me look like a premium operator."

Positioning: classical, architectural, editorial — deliberately NOT the soft,
glossy "Luxe" look every competitor uses. LVX reads as a carved Latin word
(LVX = light), not a trendy spelling of "lux."

## 2. Brand system / design tokens

### Typography (load via `next/font/google`)

- **Cinzel** (weights 400, 500) — display only: the LVX wordmark, large hero
  headlines, section eyebrows. Roman-inscription capitals. Letter-spacing
  `0.1em`–`0.16em`. Never use for body.
- **Cormorant Garamond** (400, 500, + italic) — editorial serif: large
  statements, pull quotes, testimonial text, tagline moments. High-contrast and
  elegant.
- **Jost** (300, 400, 500) — functional sans: body copy, nav, buttons, labels,
  pricing, captions. Weight 300 for body, 400–500 for UI.

Expose as CSS variables and map in Tailwind:

```ts
// tailwind.config.ts → theme.extend.fontFamily
display: ['var(--font-cinzel)', 'serif'],
serif:   ['var(--font-cormorant)', 'serif'],
sans:    ['var(--font-jost)', 'sans-serif'],
```

### Color palette (warm neutrals + champagne)

```
--paper        #F5F0E6   /* primary background (ivory) */
--card         #FBF8F1   /* raised surfaces */
--sand         #E5DAC6   /* secondary background, dividers */
--champagne    #B7995C   /* accent */
--champagne-dk #A6863F   /* accent text on light bg (better contrast) */
--taupe        #8C7C62   /* muted labels, eyebrows */
--espresso     #3A3026   /* dark sections, secondary text */
--ink          #211C16   /* primary text, darkest */
```

- Default the site to light/editorial (paper background, ink text).
- Use full-bleed dark sections (`--espresso`/`--ink` background) around video so
  reels pop cinematically. Champagne is a seasoning, never a flood.
- Accent text on light backgrounds uses `--champagne-dk` for legibility; the
  brighter `--champagne` is for rules, borders, small marks.

### Layout & spacing

- Content max-width ~1200px; editorial text blocks narrower (~640–720px). Video
  and hero sections are full-bleed.
- Generous vertical rhythm — luxury reads as space. Sections breathe (large
  top/bottom padding).
- Hairline dividers (`0.5px`, `--sand`/`--champagne`) instead of heavy borders.
- Eyebrows: Cinzel or Jost, uppercase, `letter-spacing: 0.24em`, `--taupe`, ~11px.

### Voice & copy principles

- Understated and declarative. Short lines. Confident, not salesy.
- **Banned words:** stunning, elevate, premier, breathtaking, dream, nestled —
  the exact vocabulary competitors overuse. Let the work assert the luxury.
- Approved tagline bank: "Light, in motion." · "Where the listing becomes
  cinema." · "For homes that deserve more than photographs." · "Win the listing
  before you list it."

### Motion

- Subtle scroll reveals (fade + slight rise, ~0.6s ease-out). Slow, filmic — no
  bounce, no parallax overkill.
- Honor `prefers-reduced-motion` everywhere (disable autoplay loops and reveals).
- Use a small, well-built set (e.g. Framer Motion) — restraint over flash.

## 3. Global layout

**Nav** (sticky, transparent over hero → solid paper on scroll): `LVX` wordmark
(Cinzel) left · links right: Work, Services, About, Contact · a quiet "Inquire"
button (champagne outline). Mobile: minimal hamburger → full-screen overlay menu,
ink background, Cinzel links.

**Footer** (dark, `--espresso`): LVX monogram · tagline (Cormorant italic) · nav
repeat · `lvxhomes.com` · `@lvxhomes` · "Phoenix · Mesa · Scottsdale" ·
Instagram/YouTube/TikTok icons · Part 107 certified line · copyright.

## 4. Sitemap (v1 — full multi-page)

```
/                 Home
/work             Portfolio grid → /work/[slug] detail pages
/services         Packages (Signature / Showcase / Estate) + add-ons + process
/about            Justin's story, the FPV craft, credentials, trust
/contact          Inquiry form + booking
/vip              Dedicated Estate-tier landing (lvxvip.com points here)
```

## 5. Page: Home `/`

1. **Hero** — full-bleed Cloudflare Stream reel (autoplay, muted, loop, poster
   fallback), dark overlay scrim, Cinzel headline + one-line Cormorant tagline +
   quiet scroll cue. Reduced-motion → static poster.
2. **Intro statement** — one editorial paragraph (Cormorant, narrow column) on
   what LVX is. Restrained.
3. **The difference** — the value in 2–3 short points (no jargon dump): angles you
   can't walk to, the true layout understood at a glance (beyond photos and the
   long walkthrough), and a glimpse built to stop the scroll.
4. **Featured work** — 3 property films (Stream embeds in a clean grid), each with
   address + neighborhood + price tier label.
5. **Packages teaser** — 3 tiers named, one line each, → link to /services.
6. **Testimonials** — 2–3, each with agent name + brokerage + listing price
   (credibility is the names — never anonymous).
7. **CTA band** — dark section, "Win the listing before you list it." + Inquire
   button.

## 6. Page: Work `/work` + `/work/[slug]`

- Grid of property films (Stream thumbnails/posters). Optional filter by tier or
  neighborhood.
- Detail page `/work/[slug]`: large Stream player, property meta (address,
  beds/baths/sqft, neighborhood, agent + brokerage credit, tier), a short note on
  the shoot, next/prev navigation.
- Data source: a typed array in `/data/projects.ts` (no CMS for v1) — each
  project: `slug, title, address, neighborhood, price, beds, baths, sqft, agent,
  brokerage, streamUid, poster, tier`.
- Seed content: two real films exist — rebrand them. The address-titled one and
  the test shoot currently called "Parents House" (retitle to
  `Private Residence — Mesa, AZ`).

## 7. Page: Services `/services`

- The three tiers as cards (mirror the flyer): Signature $450 · Showcase $850
  (featured) · Estate $1,500 — all marked `TODO: confirm pricing`.
- Each: name, one-line positioning, price, "per listing", feature list.
- Add-ons row: Twilight +$200 · Rush 24hr +$150 · Extra social cut +$60 ·
  Matterport/floor plan +$175.
- "Founding-client rates" note (don't say "cheap" — say founding-client /
  introductory).
- Process strip: Book → Shoot → 48-hour delivery → You win the listing.

## 8. Page: About `/about`

- Justin's story: FPV pilot, Part 107 certified, background in deploying
  technology to demanding clients. The "why LVX" (LVX = light; light is the
  cinematographer's craft).
- Headshot or on-set still. Trust signals: certified, insured (TODO),
  Arizona-based.
- Keep it human and confident, not a résumé.

## 9. Page: VIP `/vip` (lvxvip.com → here)

- Focused landing for the Estate tier and $1M–$2M+ listings. The most cinematic,
  darkest, most restrained page. Single hero film, the Estate package, a short
  "by application / select listings" tone, direct inquiry CTA. This is the page
  you hand luxury agents.

## 10. Page: Contact `/contact`

- Inquiry form: name, email, phone, brokerage, listing address, price range
  (select), package interest (select), message.
- Submit via a Route Handler `app/api/contact/route.ts` → email through Resend
  (`RESEND_API_KEY`). Zero-backend alternative: Formspree. Add honeypot + basic
  rate limit; validate server-side.
- Show success/error states inline. Never use a raw HTML `<form>` POST — handle
  with React state + fetch.

## 11. Cloudflare Stream integration

- Public marketing videos → no signed tokens needed.
- Install `@cloudflare/stream-react`. Store the customer subdomain in
  `NEXT_PUBLIC_CF_STREAM_CUSTOMER_CODE`.
- Standard embed: `<Stream controls src={streamUid} poster={posterUrl} />`
- Hero loop: `<Stream src={uid} autoplay muted loop preload="auto" />` with a
  poster; swap to static `<img>` poster when `prefers-reduced-motion`.
- Poster URLs follow
  `https://customer-<CODE>.cloudflarestream.com/<UID>/thumbnails/thumbnail.jpg`.
- Lazy-load below-the-fold players (IntersectionObserver) so the page stays fast.
- Put a single `TODO: replace with real Stream UID` constant in
  `/data/projects.ts` so swapping in real videos is one place.

## 12. SEO, metadata, performance, a11y

- Per-page `metadata` (title, description, canonical) + Open Graph + Twitter
  cards. OG image = a branded hero frame.
- Schema.org: `LocalBusiness` (name LVX Homes, `areaServed`: Phoenix, Mesa,
  Scottsdale, Paradise Valley; service: real estate videography) on the homepage;
  `VideoObject` on each `/work/[slug]`.
- `sitemap.xml` + `robots.txt` (Next can generate both).
- `next/image` for all stills; AVIF/WebP. Fonts via `next/font` (no layout
  shift). Target Lighthouse 95+ on performance and accessibility.
- Semantic headings, focus states, alt text, color contrast (use
  `--ink`/`--champagne-dk` for text, never `--champagne` for body copy).

## 13. Build order (phases)

1. Scaffold (Next.js + TS + Tailwind), wire fonts + palette + global styles, set
   up layout (nav + footer).
2. Home page (with placeholder Stream UID + placeholder copy).
3. Services page (pricing cards + add-ons + process).
4. Work index + `[slug]` detail + `projects.ts` data file (seed 2 films).
5. About + VIP pages.
6. Contact form + Resend route.
7. SEO/metadata/schema/sitemap, performance pass, reduced-motion + mobile QA.
8. Deploy to Vercel; add env vars; connect `lvxhomes.com` (GoDaddy DNS → Vercel
   for now).

## 14. Assets Justin needs to provide (the real blockers)

- [ ] Showreel — 45–75s best-of cut for the hero (upload to Cloudflare Stream,
      grab UID).
- [ ] The two existing property films, retitled + uploaded to Stream.
- [ ] One testimonial minimum with agent name + brokerage + listing price
      (collect from the free shoots).
- [ ] Headshot or on-set still for About.
- [ ] Final pricing confirmation (replace the `TODO` flyer numbers).
- [ ] Cloudflare Stream account + customer code; Resend account + API key for the
      form.

## 15. Environment variables

```
NEXT_PUBLIC_CF_STREAM_CUSTOMER_CODE=   # Cloudflare Stream customer subdomain
RESEND_API_KEY=                        # for the contact form (or use Formspree)
CONTACT_TO_EMAIL=                      # where inquiries are delivered
```

Note: sending from an `@lvxhomes.com` address later needs email hosting (e.g.
Google Workspace) + domain verification in Resend — Cloudflare doesn't host email.

---

## Build log (implementation notes — Claude Code)

Stack as actually scaffolded (newer than the brief assumed; all brief features
remain achievable):

- **Next.js 16** (App Router) + **React 19** + **TypeScript** + **Tailwind v4**.
- Tailwind v4 is CSS-first: brand tokens live in `app/globals.css` under
  `@theme` (not a `tailwind.config.ts`). This produces the same utilities the
  brief's config snippet intended (`font-display`, `bg-paper`, `text-ink`,
  `text-champagne-dk`, …).
- Next 16 note: dynamic route `params`/`searchParams` are async (Promises) —
  `await` them in `/work/[slug]` page + `generateMetadata`.
- Positioning refresh (2026-06-05, per Justin): dropped the literal "single
  unbroken take / no cuts" claim — it over-promises, and editing/cutscenes are
  part of the craft. New hook: **the view a buyer can't get on foot** — angles a
  walkthrough or virtual tour can't reach, the true layout understood in a short
  cinematic glimpse (not a flat photo gallery, not a fifty-minute talking-head
  walkthrough). Section 1, Section 5.3, and all on-site copy updated to match.
- Host decision (2026-06-05): **Cloudflare Workers** via `@opennextjs/cloudflare`
  — verified the Next 16 app builds to a Worker bundle locally (no async_hooks /
  Proxy issue). Chosen for unification (Stream + inventory + site on one account)
  and to sidestep the tangled Vercel account. Config: `wrangler.jsonc`,
  `open-next.config.ts`; steps in `DEPLOY.md`. Build on Linux (Cloudflare CI /
  WSL), not native Windows.
