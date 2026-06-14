# Plan-extract — flight data → floor/site plans

Turn DJI Avata 360 capture data into LVX `data/plans.ts` sheets you refine in the
Floorplan Studio. Two complementary tracks, by environment:

| | Method | Why |
|---|---|---|
| **Outdoor** (grounds, aerial) | **GPS + satellite** (Stage 1–2) | GPS locks outdoors → real-world-accurate path + imagery |
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

**Use it:**
1. **`/studio/plan` → Import JSON** → paste `the-george.plan.json` → the flight path renders.
2. Open the printed **Maps satellite link**, screenshot the grounds, **Trace image…** to import it, then **Move/Size** to align it under the path.
3. Drop amenity **zones** on the now-accurate base; **Save to site**.

Options: `--pad 0.15` (bbox margin), `--dwell 2` (min hover seconds for a stop).
Indoor clips (GPS `0,0`) print a heading/altitude summary and point here → Stage 3.

### Planned enhancements
- **Auto-place amenities** from the tour's authored ring keyframe times (path position at each ring's `t` → labeled zone) — no manual placement.
- **Per-still GPS**: each 360 amenity still carries its own GPS (EXIF) → exact amenity pins.
- **Exact-bbox satellite PNG** (tile-stitch Esri World Imagery, or a Mapbox/Google key) so the trace aligns 1:1 with no manual nudging.

---

## Stage 3 · Indoor: 360 VSLAM (the spike)

GPS-denied, so recover the camera trajectory + a sparse 3D map from the
equirectangular video with **stella_vslam** (equirectangular camera model).

1. **Re-export non-stabilized equirect** from the `.OSV` in DJI Studio
   (HorizonSteady/EIS OFF — note the SRT already shows `eis: close`, so the raw
   footage is clean). Stabilization removes the camera rotation SLAM needs.
2. **Run stella_vslam** (Dockerized, equirectangular config) on the clip →
   `trajectory.txt` (per-frame 6DoF poses) + `map.msg` (sparse point cloud).
   See `RoblabWh/stella_vslam_dense` for a 360-action-cam-on-UAV-tuned build.
3. **Post-process** (Stage-3 script, to build) → our schema:
   - trajectory, projected top-down → `paths` (the traveling dot),
   - point cloud, top-down density → wall lines → `zones`/`strokes`,
   - **scale**: monocular SLAM is up-to-scale — anchor with one known measurement
     (a measured wall) or the barometer / IMU,
   - **orient/label**: SRT `gb_yaw` heading constrains rotation; the room you shot
     a 360 still in labels each segment.
4. **Import** the resulting `plan.json` in `/studio/plan` and refine.

Heavy offline GPU compute (your RTX 2080S) — not Cloudflare. Build stella_vslam
via its Docker image; the post-processor reads its msgpack/txt outputs.

---

## Capture tip for future shoots

GPS logged on the exterior here but only **after the first ~seconds** (satellite
lock). For future outdoor flights: enable GPS and **wait for a solid fix before
recording** — that gives a complete, accurate track from frame 1. Indoors, GPS
will always be `0,0`; that's expected (Stage 3 handles it).
