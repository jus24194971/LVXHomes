# Authoring backend (D1) behind Zero Trust

The studios (Ring Editor, Floorplan Studio, Pin Studio) now **Save straight to the
live site** instead of copy-pasting JSON into the repo. Data lives in a Cloudflare
**D1** database; writes go through `/api/author/*`, which sits behind a Cloudflare
**Access** (Zero Trust) policy so only you can author.

Reads fall back to the baked `data/*.ts` until you Save, so the site never breaks:
an un-edited tour renders from the repo; the first Save makes D1 the source of truth
for that entity.

## One-time setup

Run these from the repo root (`dev/lvx-homes`). You need `wrangler` logged in.

### 1. Create the database

```bash
wrangler d1 create lvx-content
```

Copy the printed `database_id` into **`wrangler.jsonc`** →
`d1_databases[0].database_id`, replacing `PASTE_DATABASE_ID_FROM_wrangler_d1_create`.

> ⚠️ Do this **before** the first push — a placeholder id fails the deploy.

### 2. Create the tables

```bash
wrangler d1 migrations apply lvx-content --remote
```

`--remote` targets the deployed database (what the Worker uses). Use `--local` only
for `next dev`/miniflare testing.

### 3. Create the Access application (Zero Trust)

In the Cloudflare dashboard → **Zero Trust → Access → Applications → Add an
application → Self-hosted**:

- **Name:** `LVX Studio`
- **Session duration:** your call (e.g. 24h, or up to a month for convenience).
- **Application paths** — add BOTH of these to the same app (one login then covers
  both), on your domain:
  - `lvxhomes.com/studio`
  - `lvxhomes.com/api/author`
  Do **not** add `/tours` — those are public (hidden = unlisted, but viewable by link).
- **Identity / login method:** *One-time PIN* (emails you a code — zero setup) or
  *Google* (one-click, if you wire up the Google IdP).
- **Policy:** Action **Allow**, Include → **Emails** → `jus2419497@gmail.com`
  (add teammates as needed).

Save, then open the app's **Overview** and copy the **Application Audience (AUD)
Tag**.

### 4. Turn on in-Worker verification (recommended)

Defense-in-depth on top of the edge policy. In **`wrangler.jsonc`** → `vars`:

- `ACCESS_TEAM_DOMAIN` = your team domain, e.g. `yourteam.cloudflareaccess.com`
  (Zero Trust → Settings shows your team name).
- `ACCESS_AUD` = the AUD tag from step 3.
- `AUTHOR_ALLOWLIST` = `jus2419497@gmail.com` (optional; pins the exact writer).

Leaving these blank is fine — the edge Access policy still protects everything; the
Worker just won't *additionally* verify the JWT. With them set, a request must carry
a valid, unexpired Access token for your app or it's rejected 403.

### 5. Deploy

```bash
git add -A && git commit -m "Add Zero Trust D1 authoring backend" && git push
```

Cloudflare CI builds + deploys (~2–3 min).

## Using it

1. Visit `https://lvxhomes.com/studio/plan` once and sign in — this sets the
   Access cookie for the whole domain.
2. Author anywhere and hit **Save to site**:
   - **Ring Editor** — `/tours/<slug>?author=1` → keyframe rings → Save. (Opens
     seeded with the tour's live rings now, not blank.)
   - **Floorplan Studio** — `/studio/plan` → edit zones/paths → Save / Load from site.
   - **Pin Studio** — `/studio/pins` → drop pins → Save / Load from site.
3. The change is live immediately (tour pages read D1 per-request, cached lightly).
4. Every Save snapshots a **revision**. In the Ring Editor, **History** lists them
   and one click restores. (Floorplan/Pin restore via *Load from site* = latest.)

`Copy JSON` still works everywhere as a manual backup, and edits also autosave to
the browser as an offline draft.

## Notes & limits

- **Local `next dev`:** Save/Load call the Access-gated API, so they 403 unless you
  run with a local D1 + the Access vars. Easiest is to author on the deployed site.
- The Worker reads bindings via `getCloudflareContext()`; if D1 is missing it falls
  back to baked data rather than erroring.
- To revert the whole thing to baked-only: remove the `d1_databases` block and the
  `/api/author` Access path. The editors degrade to Copy-JSON.
