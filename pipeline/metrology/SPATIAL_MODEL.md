# The LVX Property Spatial Model

*Defined in principle 2026-07-10, first instantiated on apartment-1112.*

One property = one **plan frame** + three registries (**places**, **measurements**,
**media**). Anything that can be drawn, measured, or photographed is an entry in a
registry, and every entry either carries coordinates in the plan frame or a
transform into it. That is the entire overlay contract: **if it's registered, it
overlays the floorplan at true scale and orientation; if it isn't, it doesn't
render.** No exceptions, no per-artifact hand-scaling.

## 1 · The plan frame

- **Origin**: a physical, permanent, laser-able, photographable point on the
  property, named and described so a person can put a fingertip on it
  (e.g. `datum:front-door.threshold.hinge-corner`). Chosen once, never moved.
- **Axes**: X along a named wall direction (the building's Manhattan grid),
  Y perpendicular, Z = height above finished floor at the origin. The relation
  of +Y to true north is recorded when known (from GPS/aerial), so outdoor and
  indoor georeferencing meet here.
- **Units**: decimal feet. Everywhere. Display formatting (8' 11⅞") is a view
  concern, never a storage concern.
- Every other coordinate system — VSLAM frame, pano poses, sheet pixels,
  ortho rasters, GPS — enters via a **transform object**: `{from, to, type
  (similarity/affine/SE3), parameters, method, residual, date}`. Transforms are
  first-class, versioned, and carry their own error. A media item is "aligned"
  exactly when its chain of transforms to the plan frame exists.

## 2 · Places registry

Every named spatial thing, with a stable ID and a **status**:

- `room:*` — closed floor polygons (usually rectangles) with wall references.
- `wall:*` — segments with two faces and a thickness; a wall shared by two
  rooms is ONE entity with two faces (measurements bind to *faces*).
- `opening:*` — doors, windows, pass-throughs: parent wall, width, height,
  sill, position along the wall.
- `feature:*` — counters, showers, closets, built-ins: footprint + heights.
- `datum:*` — the physical measurement anchors (corners, thresholds, jambs).

Statuses: **measured** (laser-verified) · **derived** (solved from
measurements, e.g. by the wall-skeleton constraint solve) · **estimated**
(capture-only, carries the capture confidence grade) · **unmeasured** (drawn
dashed; the 1112 closet rule — never silently invented).

## 2b · Objects registry — anything that isn't architecture

Every physical object is a first-class entity, not scenery: furniture,
appliances, fixtures, decor, equipment, packaging. Objects move; walls don't —
so an object's placement is a time-stamped **pose list**, not a coordinate.

```
{ id, category, label,
  identity: { product?: SKU/brand match, method: user|visual-search|tag-ocr },
  dims_ft: [L, W, H] + provenance (per-dimension instrument + uncertainty),
  poses: [{ date, transform-ref | room-ref + position, evidence }],
  observations: [capture-refs that see it],
  reference: known-dims object usable as a scale anchor? (credit card,
             product packaging, standard outlet/door — the Zebra Cakes rule) }
```

- Objects **cite the captures that observe them** and are measurable by any
  instrument (the sectional: Bosch 127.47" long; mask-cloud ingest −5.1%).
- Known-size objects are *calibration citizens*: a registered reference
  object in frame upgrades every measurement sharing that frame.
- This registry IS the "Make It Their Own" library substrate — a buyer's
  couch enters the same way the seller's does.

## 3 · Measurements registry

A measurement is a relation between datums, never a bare number:

```
{ id, type: span|height|diagonal|opening|feature|object-dim,
  from: datum-ref, to: datum-ref,          // datums may belong to places OR objects
  value_ft, uncertainty_ft,
  instrument: <any evidence source, below>,
  date, operator, notes }
```

**Evidence sources — the complete taxonomy** (every instrument carries its
measured error character, from the 2026-07-10 calibration):

| class | sources | character |
|---|---|---|
| human | Bosch GLM laser, tape, typed dims, drawn zones, pins, labels | laser = truth (1/32"); zones = tap-targets, NEVER dimensional |
| sensor | GPS (±2–3 m), barometer (±0.5 ft, drifts), IMU/accelerometer, magnetometer (indoor-hostile), gimbal encoders, per-frame timestamps | absolute but coarse; welds frames together |
| imagery | 360 video frames, 360 stills, phone photos, portrait-mode embedded depth | raw evidence; EXIF (focal, GPS) is part of the capture |
| derived | VSLAM poses+cloud (mm relative, unscaled), HorizonNet layouts (lengths ±3%, over-spans openings +16–47%), metric depth (lateral ±1–7%, depth-axis −20–35%), detection/segmentation masks, LoFTR dense matches (5–30× ORB), splat geometry, product/visual match, tag OCR | each with a scored error model; ensembles beat members (2-pano diagonal −0.05%) |
| external | MLS/county records, CubiCasa plans, satellite/aerial, product spec sheets | reference-grade, provenance noted |

Rules learned the hard way and now law:
- **Datums or it didn't happen** (the sectional taught this; ANSI exists for it).
- Laser values are exact to the instrument; capture values carry the measured
  error model (pano lengths ±3%, capture widths min-of-methods, over-span
  always positive through openings).
- Predictions are **locked before truth** and never edited after — scored,
  not overwritten. The registry keeps both; the floorplan renders the best.

## 4 · Captures registry (media AND telemetry)

Every recorded artifact is an entry — imagery *and* sensor streams. A video is
two captures welded by timestamps: the pixel stream and its telemetry track
(SRT: GPS/baro/gimbal per frame). The VSLAM trajectory is a *derived* capture
citing both.

```
{ id, kind: pano|video|photo|raster|render|telemetry|pose-track|
        depth-map|mask|match-set|generated,
  source (R2 key/URL), captured (date, device), cites: [capture-refs],
  registration: transform-ref | "pending",
  provenance: captured | derived | GENERATED  }
```

- `GENERATED` content (lama fill, gen-3D, synthesized closet interiors) is
  always labeled through to the final render. Honesty is a schema field.
- Registration methods, in ascending precision: name/zone association →
  complex-similarity fit (proven 1.49 ft mean) → dense tile-matching wall
  points (LoFTR weld, proven 2026-07-10).

## 5 · The overlay contract (what "one floorplan" means)

The floorplan is not an image; it is the **plan frame rendered**. The base
raster, wall vectors, dimension annotations, media pins, texture composites,
and dollhouse extrusions (walls to true ceiling height, openings cut at true
door height) are all *views* of the registries. The Studio's existing
`PlanLayer` system is the display vehicle: one layer per registry view, all
inheriting scale and orientation from the frame, none carrying private scale.

## 6 · File conventions

Per property: `<slug>_registry.json` (the three registries + frame + transforms)
lives beside `_ground_truth.json` / `_predictions.json` in `pipeline/metrology/`
during the lab phase; graduates to D1 (`doc kind:"registry"`) when the Studio
learns to read it.
