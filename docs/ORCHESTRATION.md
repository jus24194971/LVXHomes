# LVX Homes — Orchestration Guide

*The end-to-end operating manual: capture → reconstruction → registration → deliverables → publish.
Written 2026-07-16 from the Tucson Castilla production run (the first property to exercise every stage).
Update this file whenever a stage changes — it is the source of truth for "how do we run the pipeline."*

---

## 0. System map

| Piece | What | Where |
|---|---|---|
| Web app | Next.js on Cloudflare Pages/Workers | `dev/lvx-homes`, deploy = push `main` → CF CI (~2-4 min) |
| Content DB | D1 `lvx-content`, table `doc(kind,id,body,…)` | LIVE truth for `tour` + `plan` docs — edits go live instantly, **no deploy** |
| Media | R2 bucket `lvx-media` → `media.lvxhomes.com` | plans/, tours/, projects/, ortho/, vslam/, layout/ |
| GPU pipeline | Modal app | `pipeline/cloud/modal_app.py`; volume `lvx-vslam-scratch` |
| Films | Cloudflare Stream | portfolio /work only — NOT the tour player |
| Working dir | session scratchpad | registration scripts, fits (json), composites |

**Slug discipline:** one product slug ties everything (`tucson-castilla`): capture project, tour doc id,
plan doc id, `plan.tourSlug`, R2 folders. VSLAM runs get suffixed slugs (`tucson-castilla-nadir1`).

---

## 1. Capture (see docs/capture-protocol.md for the field checklist)

- Nadir video pass(es) + cinematic 360 flight + one 360 hero still per room (two in large rooms).
- **SRT pre-check**: Video Subtitles ON — no SRT = no GPS weld.
- Laser (Bosch GLM): 2–3 wall spans per key room + ceiling height. **The laser is the only scale that
  never lies** (see §5 — drone GPS failed twice on the same property).
- Multiple flights must **share an overlap room** (Castilla: kitchen/great room) — it is the weld bridge.

## 2. Ingest → R2

```
projects/<slug>/video/<uuid>.mp4      # cine 360 flight (raw)
projects/<slug>/nadir/<name>.mp4      # nadir passes
projects/<slug>/still/<uuid>.jpg      # full-res hero panos (15520×7760)
projects/<slug>/telemetry/<id>.srt    # per-frame GPS + gb_yaw @30fps
```

Uploads from local disk: `modal run modal_app.py::presignput --key <key>` → curl `-T file --fail '<url>'`.
**Gotchas:** R2 single PUT caps at ~4.995 GB (bigger → encode first or multipart); `cmd.exe` eats `%2F`
in presigned URLs (use bash/ps1); always `--fail` (curl exits 0 on HTTP errors otherwise).

## 3. VSLAM (Modal, GPU)

- `modal run modal_app.py::vslam --key <r2 video key> --slug <slug>` (or Studio → Process).
- Outputs on volume + `vslam/<slug>/` in R2: `<slug>.ply` (dense cloud), `frame_trajectory.txt`
  (TUM: t x y z qx qy qz qw; t in video seconds), `slam.mp4`, `mask.png`.
- **Trajectory rows are parallel to `orthometa.traj_px`** — the join to SRT GPS is `round(t*30)`.
- Handheld/cine walkthroughs drift monocular scale (~7× collapse at door thresholds on Castilla) —
  fine for frames/panos, **not for top-downs**. Use nadir flights for orthos.

## 4. Proxies & the tour mezzanine

- `::proxy --slug <s>` → `hires.mp4` on the volume (4K H.264 tight-GOP; needed by trueortho texture pass).
- Tour player video: ≤4K H.264 `-movflags +faststart`, **no audio**, at
  `tours/<slug>/flight.mp4?v=N`. Server-side: `::mezzanine --src-key … --out-key …`.
  Local (faster for big sources): NVENC via imageio-ffmpeg —
  `-hwaccel cuda -vf "scale=3840:-2,format=yuv420p" -c:v h264_nvenc -preset p5 -cq 19 -g 30 -bf 0 -movflags +faststart -an`.
- **Bump `?v=` in the tour doc after every replacement** — that is the cache invalidation.

## 5. Scale & registration (the metrology chain)

**Rule zero: laser > everything. Plan is topology only. Drone GPS is shape, never scale.**

Evidence from Castilla (keep citing these):
- GPS-umeyama vs ceiling-laser scale agreed **0.8%** (whole house) — the dual-scale gate.
- nadir2's EKF GPS: self-consistent 0.2 ft RMS yet **~30% scale-biased**.
- Cine interior scale collapsed ~7× across the threshold.
- The builder plan is non-uniformly scaled — never fit to plan-derived points.

Chain (scripts in scratchpad, fits saved as json):
1. `::orthometa --slug <s> [--bounds-pctl --pad-ft]` → traj_px + extents + fpu
   (**params must match the trueortho render exactly**).
2. GPS fit (`fit_gps.py`): SRT lat/lon → EN ft ↔ traj_px, umeyama + trim worst 30% → scale/rot/rms.
3. Laser anchor (`solve_anchor.py` → `anchor_fit2.json`): **fix scale to the GPS/laser value**, solve
   rotation+translation from 2+ coherent laser-room correspondences; validate on held-out points;
   report residuals in feet. Castilla: living 0.2 ft, dining 0.2 ft; needs `flipH` (det −1) like Scottsdale.
4. Second flight → first flight: **ORB+RANSAC on the shared-room overlap crops**
   (never hand-read 3 points — small residuals can hide a wrong scale). Validate: a physical object
   from both flights must land at the same sheet point (rug: 0.3 ft).
5. Aerial (site) → sheet: 3 roof↔plan anchors (entry, wing tip, far corner), sanity on pool/driveway.

## 6. True-ortho top-downs

`::trueortho --slug <s> --ceiling-ft 10.83 --n-frames 3000 --ceil-cut 0.62 --max-off-deg 40 --bounds-pctl 0.1 --pad-ft 4`
- Per-ray dewarp at each cell's DSM height (no flat-floor layover). Output `ortho/<slug>_trueortho.png` + `_gap.png`.
- `--ceil-cut 0.62` drops ceiling fans (floor beneath renders; hole → inpaint later).
- `--bounds-pctl/--pad-ft` un-clip sparse edge rooms (the music room sat ON the 1–99% canvas edge).
- Aerial site ortho: reproject the high-altitude 360 still straight down
  (`equi2persp(eq, 0, -90, fov 100, out 3400)`) — don't reuse low-res crops.

## 7. The dollhouse plansheet (`compose_dollhouse.py`)

Order matters: paper → **aerial in exterior** (feathered, 12% paper haze) → *base checkpoint* →
interior photo fills → inpaint → clip rooms to `base` (not white!) → plan lines/fixtures on top →
extension boundary strokes → room tags.
- Trace is a **photo of paper**: threshold with illumination flattening (`gray / GaussianBlur(σ51) < 0.72
  & gray<175`) — a plain low threshold thins walls and the flood fill leaks (whole core goes white).
- Rooms = flood-fill from border over dilated lines; coverage gate 0.18; border-touching comps = crop leak.
- Inpaint only inside covered rooms and ≤ ~5 ft from real pixels; NS at 0.25×, blend 38% to room median.
  **Save the inpaint mask — provenance is product and IP.**
- Plan text stripped by size-filter + explicit label boxes; our tags at hero-marker coords.
- Canvas extends where reality does (east +32u guest wing, north +30u pool) — update the plan-doc layer
  x/y/w/h to match every time extents change.

## 8. Panos & heroes

- `::panoprep --stills-prefix projects/<slug>/still/ --out-prefix tours/<slug>/` → `pano-<short8>.jpg` (≤4K).
- Hero↔room mapping: sort still UUIDs ascending = hero_0…N order (Castilla census: 0 living, 1 closet,
  2 bath, 3 dining, 4 bdrm3, 5 kitchen, 6 master, 7 great, 8 foyer, 9 main office, 10 vanity, 11 guest office).

## 9. Flight census (rings, path, labels)

Extract frames (`fps=1/8, scale=1600:800`) → parallel VLM agents (10 frames each, forced schema:
room/confidence/transition/evidence, **presence-only**) → stitch into a room timeline.
Feeds: path waypoints (segment midpoints at room coords), hotspot time windows (±4–8 s margins,
repeat visits = duplicate hotspot ids `hs-<pano>-<n>`), tour chaptering, QA.

## 10. Docs (D1) — the live product

Push: build body JSON → escape `'`→`''` → `INSERT … ON CONFLICT(kind,id) DO UPDATE` →
`npx wrangler d1 execute lvx-content --remote --file=…` (wrangler is OAuth-authed locally).
- **SQLITE_TOOBIG** → externalize inline data-URLs to R2 first (350 KB doc → 6 KB).
- **Never clobber authored content**: read the live doc, merge, write back (Justin's laser walls live in
  the plan doc — they are the spine).

**Plan doc** (`kind='plan'`): sheets[{ width/height (must hug real content — the viewer fits to
sheet ∪ visible layers), walls (laser, verbatim), zones (hero markers: small octagons, label + panoId),
layers (trace hidden / floor hidden / plansheet visible, cache-busted), paths.{chapterId}
([{t,x,y,h}] — **h is CONSTANT for heading-stabilized video** (Castilla −54); tangent heading = swimming
rings), geo bbox }.

**Tour doc** (`kind='tour'`): chapters[{ video.src `?v=N`, `startYaw` (frame-1 equirect: house-direction
x/W → (x/W−0.5)·360; Castilla 68), `northYaw` (front→compass north; Castilla 90 — powers the compass HUD),
hotspots [{anchor{x,y,h:0.6}, fadeNear/fadeFar (8/30 open plan, 5/14 small rooms), start/end (census
windows), panoId}] }], panos, `hidden:true` until approved (direct link works while hidden).

## 11. Viewer conventions (components/tour/)

- `FRONT_LON=180`; look.lon = FRONT + startYaw; compass needle = −(yaw − northYaw).
- Anchored rings need `paths` for the pose; the gold you-are-here orb + view cone ride the same path.
- Plan pop-out fits **sheet ∪ visible layers** and fills the stage; minimap in the corner otherwise.
- Fullscreen ladder: native API (with rejection AND sync-throw fallbacks) → CSS overlay (`pseudoFs`,
  fixed inset-0 h-dvh); iPhone never gets the native API, iPad masquerades as Mac (maxTouchPoints check).
  On any fullscreen exit: re-show controls + scrollIntoView the player. Controls bar carries
  `pb-[max(1rem,env(safe-area-inset-bottom))]`. Inline player is height-capped
  (`max-h-[calc(100svh-7rem)]`) so portrait never buries the buttons.

## 12. Publish checklist (new property)

1. Slug + capture project; upload raw to `projects/<slug>/…`.
2. VSLAM nadir (+ cine if wanted) → proxy → trueortho(s) → orthometa.
3. Laser walls in Studio (`/studio/plan`, trace underlay) — the metric spine.
4. Registration chain (§5) → plansheet compose (§7) → upload `plans/<slug>-{floor,plansheet,trace}.jpg`.
5. Panoprep + mezzanine → `tours/<slug>/…`.
6. Census → path + windows; plan doc merge (walls preserved) + tour doc → wrangler d1.
7. Verify live (DOM reads beat screenshots when 4K video chokes the pane): viewBox, video?v, ring labels.
8. Show hidden link → unhide in `/studio/tours` when approved.

## 13. Failure ledger (hard-won — read before debugging)

- Small fit residuals can hide a wrong scale (3-point hand-reads) → always hold out a validation point.
- EKF GPS is shape-true, scale-false, per-flight. Magnetometer/heading drifts indoors — never trust it for north.
- Outdoor GPS prefixes are too short-baseline to fit rotation (23 ft span → ±90° swings).
- `emit_ortho_meta` bounds MUST mirror `make_trueortho` bounds or traj_px is in the wrong frame.
- The sheet rect participates in the viewer's fit — oversize it and you ship dead space.
- Duplicate Modal entrypoint names crash `modal run`; `modal run` prints returns only via `local_entrypoint`s.
- Windows consoles need `PYTHONUTF8=1` for Modal's ✓ glyphs.
- Chapter start view field is `startYaw` — `initialYaw` belongs to panos and is silently ignored.
