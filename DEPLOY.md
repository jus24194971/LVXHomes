# Deploying LVX Homes to Cloudflare Workers

Stack: **Next.js 16 + `@opennextjs/cloudflare`** (the OpenNext Cloudflare
adapter). The Worker bundle has been verified to build cleanly on Next 16 — no
downgrade needed.

**Why Cloudflare:** one account you already control — Cloudflare Stream (video) +
this site + the inventory app — and it sidesteps the tangled Vercel account.

---

## One-time setup

### 1. Push the repo to GitHub
The repo `github.com/jus24194971/LVXHomes` already exists. From the project folder:
```
git remote add origin https://github.com/jus24194971/LVXHomes.git
git push -u origin main
```

### 2. Connect to Cloudflare — git-connected builds (recommended)
Dashboard → **Workers & Pages → Create → Workers → Import a repository** → pick
`LVXHomes`.
- **Build command:** `npx opennextjs-cloudflare build`
- **Deploy command:** `npx wrangler deploy` (or leave default — it reads `wrangler.jsonc`)
- **Branch:** `main` → auto-deploys on every push.

> ⚠️ Build on Cloudflare's **Linux** CI, not native Windows — OpenNext warns it
> isn't fully supported on Windows. (If you ever build locally, use **WSL**.)

### 3. Environment variables & secrets
In the Worker's **Settings → Variables and Secrets**:

| Name | Kind | Why | Value |
|------|------|-----|-------|
| `NEXT_PUBLIC_CF_STREAM_CUSTOMER_CODE` | Build variable | inlined at **build time**, public | your Stream customer code |
| `RESEND_API_KEY` | Secret | runtime | from resend.com |
| `CONTACT_TO_EMAIL` | Secret/Var | runtime | where inquiries land (your Gmail to start) |
| `CONTACT_FROM_EMAIL` | Variable | runtime | e.g. `LVX Homes <onboarding@resend.dev>` until lvxhomes.com is verified in Resend |

`NEXT_PUBLIC_*` is baked in **when Cloudflare builds**, so it must be a *build*
variable. The Resend values are read at **runtime** — set them as secrets.

### 4. Custom domains
Worker → **Settings → Domains & Routes → Add → Custom Domain**:
- `lvxhomes.com` and `www.lvxhomes.com`.
  - DNS already on Cloudflare → a couple of clicks.
  - DNS still at GoDaddy → move the nameservers to Cloudflare (recommended), or
    follow Cloudflare's CNAME instructions.
- `lvxvip.com` → add a **Redirect Rule** → `https://lvxhomes.com/vip` (per the brief).

---

## Alternative: manual deploy (use WSL on Windows)
```
npx wrangler login
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put CONTACT_TO_EMAIL
npm run deploy
```

## Local preview in the real Workers runtime
```
npm run preview   # builds the Worker bundle + serves it locally
```
(`npm run dev` remains your normal fast Next dev server.)

---

## Launch checklist
- [ ] Real Stream UIDs in `data/projects.ts` + `lib/stream.ts` (`HERO_STREAM_UID`).
- [ ] `NEXT_PUBLIC_CF_STREAM_CUSTOMER_CODE` set → hero reel + players go live automatically.
- [ ] `RESEND_API_KEY` + `CONTACT_TO_EMAIL` set → contact form delivers for real.
- [ ] Replace TODO content: pricing, ≥1 testimonial (name + brokerage + price),
      headshot, social handles, the two films' agent/brokerage credits, insurance line.
- [ ] Update each film's `VideoObject` `uploadDate` in `app/work/[slug]/page.tsx`.
- [ ] Run Lighthouse on the live URL (target 95+ performance & accessibility).

## Notes / future upgrades
- The contact rate-limiter is in-memory (per-isolate on Workers) — fine for v1.
  Upgrade to Cloudflare KV or a Durable Object if you start getting abuse.
- The OG card (`app/opengraph-image.tsx`) uses next/og's default font; embed
  Cinzel later if you want the exact wordmark in social previews.
