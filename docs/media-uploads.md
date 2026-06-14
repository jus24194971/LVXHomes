# Media library — uploads provisioning

The Studio **Library** (`/studio/library`) browses, uploads, and manages every
video + pano. Films go to **Cloudflare Stream** (auto-transcoded); 360 clips and
panos upload straight to **R2** via short-lived signed URLs. This needs two API
tokens (as Worker secrets) and a bucket CORS rule.

Already done:
- `migrations/0002_asset.sql` applied to the remote DB (the `asset` table).
- `wrangler.jsonc`: R2 binding `MEDIA → lvx-media`, and vars `CF_ACCOUNT_ID`,
  `R2_BUCKET=lvx-media`, `R2_PUBLIC_HOST=media.lvxhomes.com`.
- **R2 CORS** on `lvx-media` now allows `GET, HEAD, PUT` (existing range-serving
  rules preserved). ← step 4 below is complete.

Until the secrets below are set, the Library still loads — uploads just return
"not configured."

## 1. Stream API token → `CF_API_TOKEN`

Dashboard → **My Profile → API Tokens → Create Token → Create Custom Token**:
- Permissions: **Account · Stream · Edit**
- Account Resources: include your account
- Create, copy the token.

## 2. R2 S3 token → `R2_ACCESS_KEY_ID` + `R2_SECRET_ACCESS_KEY`

Dashboard → **R2 → Manage R2 API Tokens → Create API Token**:
- Permissions: **Object Read & Write** (optionally scope to `lvx-media`)
- Create. It shows an **Access Key ID** and a **Secret Access Key** — copy both
  (the secret is shown once).

## 3. Set the secrets

From the repo root (targets the deployed `lvxhomes` Worker; they persist across
git-push deploys):

```bash
wrangler secret put CF_API_TOKEN          # paste the Stream token
wrangler secret put R2_ACCESS_KEY_ID      # paste the R2 Access Key ID
wrangler secret put R2_SECRET_ACCESS_KEY  # paste the R2 Secret Access Key
```

## 4. R2 bucket CORS — ✅ DONE

Applied via `wrangler r2 bucket cors set lvx-media` (added `PUT`, kept the
existing `GET/HEAD` range-serving rules). To re-check: `wrangler r2 bucket cors
list lvx-media`. The wrangler file format is Cloudflare-native:

```json
{ "rules": [ { "allowed": { "origins": ["https://lvxhomes.com"],
  "methods": ["GET","HEAD","PUT"], "headers": ["range","content-type"] },
  "exposeHeaders": ["content-range","accept-ranges","content-length"],
  "maxAgeSeconds": 86400 } ] }
```

## 5. Deploy

```bash
git add -A && git commit -m "Add media library (Stream + R2 uploads)" && git push
```

## Notes

- **Films > ~200 MB:** the in-Studio uploader uses a basic POST (fine to ~200 MB).
  For larger films, upload via the Stream dashboard — the Library auto-imports
  every Stream video and shows it here.
- **360 re-encode:** none needed if DJI exports H.264. Workers can't run ffmpeg;
  if a clip ever needs transcoding, use Stream or a one-time local pass.
- **Delete vs archive:** Archive hides an asset (reversible); Delete removes the
  underlying Stream video / R2 object too.
