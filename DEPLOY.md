# Deploying LVX Homes

Stack: **Next.js 16 + `@opennextjs/cloudflare`**, deployed to **Cloudflare
Workers**. Video via **Cloudflare Stream**, transactional email via **Resend**.

Live: <https://lvxhomes.com> · vanity <https://lvxvip.com> → `/vip`
Repo: `github.com/jus24194971/LVXHomes` · local working copy: `C:\Users\jus24\dev\lvx-homes`

---

## ⛔ The one rule: deploy from Cloudflare's CI, never from Windows

**Just `git push` to `main`.** Cloudflare's git-connected **Workers Build** runs
`npx opennextjs-cloudflare build` on **Linux** and deploys — live in ~3 minutes.

Do **NOT** run `npm run deploy` / `opennextjs-cloudflare deploy` on Windows. We
proved it fails three different ways:

1. **OneDrive** dehydrates `node_modules`/`.next` into stubs and corrupts the
   repo → keep the working copy **outside OneDrive** (`C:\Users\jus24\dev\lvx-homes`).
2. **`next/og`'s WASM** can't be bundled by OpenNext on Windows (path mangling) —
   this is why the OG image is now a static PNG (see below).
3. Even when a Windows build *succeeds*, the resulting Worker **crashes at
   runtime — every route 500s.** OpenNext only warns it's "not fully supported on
   Windows"; in practice it's unusable for deploys.

If you ever must deploy from this machine, use **WSL** (real Linux). Otherwise:
push and let CI do it.

---

## How the pipeline works

```
git push origin main
        │
        ▼
Cloudflare Workers Build (Linux)        ← Worker → Settings → Build
  build:  npx opennextjs-cloudflare build
  deploy: npx wrangler deploy
        │
        ▼
https://lvxhomes.com   (live ~3 min later)
```

### ⚠️ The gotcha that cost us hours: the GitHub App must see the repo
Builds only trigger if the **Cloudflare GitHub App** has access to `LVXHomes`.
Check: GitHub → Settings → Applications → **Cloudflare Workers and Pages** →
**Repository access** → `LVXHomes` must be listed (or "All repositories"). If it
isn't, pushes are invisible to Cloudflare, nothing deploys, and the Worker's
**Settings → Build** shows *"disconnected from your Git account."*

Production branch is **`main`** (Worker → Settings → Build → Branch control).

To deploy a one-off without a code change: `git commit --allow-empty -m "redeploy" && git push`.

---

## Secrets & environment

### Stream customer code — baked in, no env var
The **public** Stream customer code (`n5hwfs53ea1n75e6`) is hardcoded as the
default in `lib/stream.ts` (it appears in every embed URL, so it's not secret).
No build variable needed.

> Note: the Cloudflare **Account ID** (`a61cc14…`) is *not* the Stream customer
> code. The customer code is the `customer-XXXX` subdomain in a video's embed URL.

### Runtime secrets — Worker → Settings → Variables and Secrets
| Name | Kind | Value |
|------|------|-------|
| `RESEND_API_KEY` | **Secret** | from resend.com |
| `CONTACT_TO_EMAIL` | Plaintext | where inquiries land (your Gmail) |
| `CONTACT_FROM_EMAIL` | Plaintext (optional) | e.g. `LVX Homes <hello@lvxhomes.com>` once the domain is verified in Resend; defaults to `onboarding@resend.dev` |

**Two gotchas — both handled in code, but know them:**
1. **OpenNext does NOT expose these on `process.env` at runtime.** The contact
   route reads them via **`getCloudflareContext().env`** (`app/api/contact/route.ts`),
   with a `process.env` fallback for local dev. Read any new runtime secret the
   same way, or it'll read as `undefined` on the Worker.
2. **Secrets bind at deploy time.** After adding/changing a dashboard secret,
   **redeploy** (push a commit) or the running Worker won't pick it up.

---

## Custom domains (all configured)
Worker → Settings → Domains & Routes:
- `lvxhomes.com` + `www.lvxhomes.com` — **Custom Domains** (auto DNS + SSL).
- `lvxvip.com` — a **Redirect Rule** *in the lvxvip.com zone* →
  `https://lvxhomes.com/vip`, backed by a proxied placeholder DNS record
  (`AAAA  @  100::`, orange-cloud) so traffic reaches Cloudflare's edge.
- SSL is automatic (Universal SSL); **Always Use HTTPS** is on.

A domain must be an **active zone** in this Cloudflare account (nameservers moved
off GoDaddy) before it can be attached — Worker Custom Domains can't use a
registrar CNAME. When attaching, delete GoDaddy's leftover parking `A`/`CNAME`
records first or the custom domain refuses to bind.

---

## OpenGraph image — static PNG (not next/og)
`app/opengraph-image.png` (1200×630) is a static asset, with alt text in
`app/opengraph-image.alt.txt`. We dropped the dynamic `next/og` route because its
WASM dependency broke OpenNext bundling on Windows **and** 500'd at runtime on
Workers. To change the card, just replace the PNG.

---

## Local development
```
npm run dev      # fast Next dev server — your normal workflow
npm run build    # verify a production build compiles (SAFE on Windows)
```
`npm run build` works fine on Windows — it's only the *deploy* that doesn't. Run
it before pushing to catch TypeScript/compile errors early.

For local email testing, put `RESEND_API_KEY` / `CONTACT_TO_EMAIL` in `.dev.vars`
(or `.env.local`).

---

## Launch checklist
- [x] Real Stream UIDs wired (San Tan Valley, Tucson) + correct customer code.
- [x] Film thumbnails fixed (per-video poster timestamp in `lib/stream.ts`).
- [x] Contact form delivers (Resend + secrets via `getCloudflareContext`).
- [x] Custom domains + SSL (`lvxhomes.com`, `www`, `lvxvip.com` → `/vip`).
- [x] OG card (static gold PNG).
- [ ] Verify `lvxhomes.com` in Resend → send from `hello@lvxhomes.com` + auto-reply to inquirers.
- [ ] Replace TODO content: pricing, ≥1 real testimonial, headshot, social handles.
- [ ] Real `uploadDate` per film in `app/work/[slug]/page.tsx` VideoObject schema.
- [ ] Optional: a 45–75s hero showreel → set `HERO_STREAM_UID` in `lib/stream.ts`.
- [ ] Run Lighthouse on the live URL (target 95+ perf & a11y).

## Notes / future upgrades
- Contact rate-limiter is in-memory (per-isolate on Workers) — fine for v1;
  upgrade to Cloudflare KV or a Durable Object if you start seeing abuse.
- `HERO_STREAM_UID` is still a placeholder → the hero shows the gold LVX crest
  until you set a real showreel UID.
