# Plan-extract — flight data → floor/site plans

Turn DJI Avata 360 capture data into LVX `data/plans.ts` sheets you refine in the
Floorplan Studio. Two complementary tracks, by environment:

| | Method | Why |
|---|---|---|
| **Outdoor** (grounds, aerial) | **GPS + satellite _or_ aerial-360 base** (Stage 1–2) | GPS locks outdoors → real-world-accurate path + imagery |
| **Indoor** (units) | **VSLAM + telemetry** (Stage 3) | GPS is `0,0` indoors → recover motion from the 360 video |

Source files per clip (on the SD card / in your capture folder): `*.SRT`
(telemetry), `*.OSV` (raw dual-fisheye), `*.LRF` (proxy).

---

## Stage 1–2 · Outdoor: SRT → georeferenced site plan ✅ working

`srt-to-plan.mjs` (pure Node ≥18, no deps). Parses the SRT, and when GPS is
present projects the flight to local metres, writes a `site` PlanSheet with the
flight **path**, dwell-detected amenity **stops**, and a Google Maps satellite
link for the property.

```bash
node srt-to-plan.mjs "<clip>.SRT" --slug the-george --label "Grounds" --out the-george.plan.json
```

Verified on the exterior George clip → **2,750 GPS frames**, a **195 × 135 m**
site sheet, **184 path keys** over the real parcel (`33.3889, -111.6804`).

Amenity **zones are auto-placed from the 360 stills' EXIF GPS** (`exif-gps.mjs`,
pure-Node EXIF reader) — every `.JPG` in the SRT's folder that carries a GPS fix
inside the parcel becomes a labeled zone at its real position. Also emits a
`geo` bbox so the base imagery can be cut to the exact footprint.

**Use it (near-zero-touch):**
1. Run the tool → `the-george.plan.json` (path + GPS amenities + `geo`).
2. Push to D1: `node push-d1.mjs the-george.plan.json the-george` → `npx wrangler d1 execute lvx-content --remote --file=_push.sql`.
3. **`/studio/plan` → Load from site** → the **Studio auto-stitches Esri World Imagery** to the `geo` bbox (tile proxy `app/studio/api/sat`, capped z19 = deepest real tiles; saved to `sheet.satUrl`), and the path + amenity dots are already on it.
4. Reshape/relabel zones; **Save to site**.

Options: `--pad 0.15` (bbox margin), `--dwell 2` (min hover seconds for a stop).
Indoor clips (GPS `0,0`) print a heading/altitude summary and point here → Stage 3.

---

## Stage 2b · Aerial-360 base — when satellite is stale ✅ working

New construction (like The George) often isn't in the satellite layer yet, or the
imagery is months out of date. If you fly **one high-altitude 360 that frames the
whole property**, `aerial-to-base.mjs` reprojects its downward hemisphere onto the
ground plane and drops it in as the base — perfectly georeferenced, so the same
GPS-driven path + amenity dots line up on it.

```bash
# 1. reproject the high 360 into the plan's GPS bbox (writes <slug>-base.jpg + sets satUrl)
node aerial-to-base.mjs "DJI_…_0015_D.JPG" the-george.plan.json
# 2. eyeball registration (aerial + gold path + amenity crosshairs)
node preview-plan.mjs the-george.plan.json the-george.aerial-preview.png
# 3. host the base on R2 (data-URLs blow D1's statement-size cap), then push the lean plan
npx wrangler r2 object put lvx-media/plan-base/the-george.jpg --file=the-george-base.jpg --content-type image/jpeg --remote
node push-d1.mjs the-george.plan.json the-george --satUrl "https://media.lvxhomes.com/plan-base/the-george.jpg"
npx wrangler d1 execute lvx-content --remote --file=_push.sql
```

How it works: each output pixel → its lat/lon → metre offset from the drone's GPS
→ depression `α = atan2(H, d)` (H = `RelativeAltitude` from XMP) and azimuth, which
index the equirect (nadir = bottom row; **centre column = drone nose**, i.e.
`FlightYawDegree`). `readDjiMeta()` pulls GPS + height + heading + dims from
EXIF/XMP. Pick the **highest** shot (most top-down → least parallax); the ground
plane (pools, courts, walkways, lawns) is accurate, building tops lean outward a
little (single-vantage parallax — cosmetic). Heading knobs if it looks rotated:
`--heading <deg>`, `--flip`. Verified on The George shot `0015` (78 m AGL, heading
`-90.4°`, no flip) → 100 % coverage, amenity dots landing on the real courts/pool.

---

## Stage 3 · Indoor: 360 VSLAM ✅ post-processor built, awaiting first real run

GPS-denied, so recover the camera trajectory **and** room geometry from the
equirectangular video with monocular equirectangular SLAM, then drop it in as an
interior sheet (top-down point-cloud base + flight route) — same Studio UX as a
grounds sheet. Full runbook + the SLAM-build decision (dense GPU vs sparse CPU),
config, scale/orient strategy, and capture tips: **[`VSLAM.md`](./VSLAM.md)**.

- `vslam/equirectangular.yaml` — tuned camera config (the key bit: mask the drone
  body at the nadir or ORB locks onto the props).
- `slam-to-plan.mjs` — SLAM trajectory (TUM) + point cloud (PLY) → interior `Plan`
  (gravity-align → top-down density base + route). **Proven** end-to-end on a
  synthetic tilted-room fixture: `node slam-to-plan.mjs --selftest`.

Runs offline on your machine (dense fork uses the RTX 2080S; sparse is CPU) — not
Cloudflare. The only piece left is the SLAM run on real footage.

---

## Capture tip for future shoots

GPS logged on the exterior here but only **after the first ~seconds** (satellite
lock). For future outdoor flights: enable GPS and **wait for a solid fix before
recording** — that gives a complete, accurate track from frame 1. Indoors, GPS
will always be `0,0`; that's expected (Stage 3 handles it).
