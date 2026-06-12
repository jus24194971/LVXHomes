# LVX 360 Tours — the flight pipeline

The differentiator: an interactive 360 flythrough a buyer flies themselves —
free look during video, gold hotspot rings that step off into still 360 room
panos, all white-label on lvxhomes.com. Built and proven on synthetic assets
(Phases 1–2, verified on PC + iPhone) before the DJI Avata 360 arrived.

## Architecture

```
data/tours.ts                      one entry per tour: video + panos + hotspots
app/tours/[slug]/page.tsx          tour pages (prerendered from TOURS)
components/tour/viewer.tsx         the engine — one Three.js sphere, two modes
media.lvxhomes.com  (R2 lvx-media) all media: flight MP4s, pano JPGs, posters
```

- **One sphere, two modes.** The equirect video is a texture on the inside of a
  sphere; tapping a hotspot ink-fades and swaps the texture to a still pano,
  "Resume the flight" swaps back and the video resumes where it paused.
- **Hotspots are DOM buttons** projected into the scene each frame — clickable,
  accessible, styled with site tokens. Each is `{start, end, yaw, pitch, panoId}`:
  seconds into the flight when it appears, and where it hangs on the sphere
  (yaw 0 = the center of the equirect frame, pitch + = up).
- **Media lives on R2, never in the repo / Workers assets.** R2's custom domain
  serves real HTTP 206 range responses (iOS requires them), bucket CORS allows
  lvxhomes.com (WebGL textures require it), egress is $0. The Workers asset
  layer does NOT honor range requests — only the tiny synthetic test clip lives
  there, as a fallback.

## Drone-day runbook (per home)

1. **Shoot** the 360 pass with the Avata + still 360 panos in the key rooms.
2. **Stitch/export** the flight as an equirectangular MP4 master (highest res
   the software offers), and each room pano as an equirect JPG.
3. **Encode + upload the flight** (from the repo root):
   ```powershell
   .\scripts\encode-tour.ps1 -Source "D:\footage\<slug>-master.mp4" -Slug <slug> -Upload
   ```
   Produces a universal 4K H.264 tier, a 5.7K HEVC tier when the master is
   ≥5K wide, and a poster — then uploads and prints the live URLs.
4. **Upload the room panos** (4096×2048+ JPG, ~80–85 quality):
   ```powershell
   npx wrangler r2 object put "lvx-media/tours/<slug>/pano-kitchen.jpg" --file <file> --content-type "image/jpeg" --cache-control "public, max-age=31536000, immutable" --remote
   ```
5. **Add the tour entry** to `data/tours.ts` (copy the test tour's shape; use
   the printed URLs with `?v=1`). Leave `hidden: true` until it's client-ready.
6. **Author the hotspots** at `lvxhomes.com/tours/<slug>?author=1` — fly to the
   moment, click where the ring should hang, Copy JSON, convert each mark to a
   hotspot (`start ≈ time − 2`, `end ≈ time + 4`, label + panoId), paste into
   the tour entry.
7. Push. Live in ~3 minutes.

## Gotchas (paid for in blood, do not relearn)

- **`wrangler r2 object put` writes to a LOCAL simulator unless you pass
  `--remote`.** The upload "succeeds" either way. Always `--remote`.
- **The CDN negative-caches 404s.** If you request a key before it exists, the
  404 sticks for a few minutes. We version every URL (`?v=1`) so a fresh query
  string always bypasses a poisoned cache — bump the version on re-upload.
- **Workers static assets ignore `Range` headers** (200, never 206). Desktop
  players tolerate it; iPhones often won't. Real media → R2 only.
- **iOS device-motion needs a user-gesture permission prompt** — the Motion
  button handles `DeviceOrientationEvent.requestPermission()`. Don't autostart.
- **Cross-origin video-as-WebGL-texture needs both halves:** `crossOrigin =
  "anonymous"` on the element AND the bucket CORS policy (set; includes
  localhost:3000 for dev).
- **Resolution math:** viewers see ~a quarter of the sphere, so delivered
  resolution ÷ 4 ≈ perceived quality. 4K equirect ≈ 1080p feel — that's the
  *floor*, which is why the 5.7K tier exists.

## Status / roadmap

- [x] Phase 1 — sphere engine (drag/inertia, zoom, keys, iOS gyro), R2 +
      media.lvxhomes.com proven (206 + CORS), synthetic 4K test world.
- [x] Phase 2 — hotspots → pano stops → resume; tour data model;
      `?author=1` click-to-place authoring; verified on PC + iPhone.
- [ ] Phase 3 — polish + integration: HEVC/4K tier switching, intro animation,
      tours on Work pages + packages ("The 360 Flight" add-on), public tours in
      the sitemap, real-footage tuning.
- [ ] Phase 4 — per-room analytics for agents, floorplan minimap, WebXR.
