# The LVX Capture Protocol — fly-by, fly-in, measured

*One continuous flight, outside to inside, replicable on any property.
Every rule below exists because of a measured failure or a measured win
(citations: pipeline/metrology/, 2026-07-10 calibration day).*

The shot IS the dataset. The same take that becomes the cinematic tour also
becomes the VSLAM track, the splat, the floorplan, and the georeferenced
world frame. Nothing is filmed twice; everything is captured once, correctly.

---

## Phase 0 — Prep (10 minutes, before props spin)

- [ ] **Doors**: every door OPEN and propped — including closets. An unfilmed
      space is invisible to every pipeline layer forever (the 1112 closet rule).
- [ ] **Lights**: all interior lights ON (evens the exterior→interior exposure
      cliff at the threshold).
- [ ] **Declutter the threshold zone** (3 ft either side of the entry door):
      the doorway crossing is where tracking survives or dies.
- [ ] **Laser anchors** (Bosch GLM, ~3 minutes): ceiling height in two rooms,
      one long wall span, one doorway width. Ceiling = the scale anchor
      (proven +0.12%); the others are the witnesses.
- [ ] **Reference objects**: note any known-size object on site (a couch the
      owner can laser, standard counters). Registry `reference: true` —
      they certify scale later (the sectional method).
- [ ] Camera: Full-Sphere 8K, HorizonSteady ON (cinematic master); the .OSV
      re-exports later WITHOUT stabilization for VSLAM (one capture, two
      exports — DJI Studio "Panoramic Video").

## Phase 1 — Fly-by (exterior, GPS valid)

- [ ] Wait for **GPS lock before anything** (Avata logs 0,0 until lock; on
      The George it took ~146 s — do not start the pass early).
- [ ] One slow perimeter pass at ~20–40 ft: the establishing fly-by AND the
      georeferencing segment (GPS+compass valid out here — this segment
      gives the whole interior map its Earth frame, north tie, and an
      independent scale check via GPS-baseline Umeyama).
- [ ] One high 360 still framing the whole property (aerial base / footprint,
      the exterior-wall GLA witness).
- [ ] Descend to the approach line: a straight, slow, waist-height approach
      to the entry door — 10+ seconds of steady forward flight. This is the
      feature bridge between worlds.

## Phase 2 — The threshold (the moat — fly it like it's expensive)

- [ ] Cross the doorway at **< 1 ft/s**, centered, no yaw.
- [ ] **Hover 2–3 s just inside** the door with both worlds visible in the
      360 sphere (the equirect sees behind — outdoor features stay in frame
      while indoor features arrive; this is why a 360 can do what a flat
      camera can't).
- [ ] No exposure-triggering pirouettes at the threshold; let auto-exposure
      settle during the hover.
- One continuous recording across the boundary — never stop/restart here.
  The unbroken VSLAM track through this doorway is what carries GPS
  georeferencing into the GPS-denied interior (§4.4 core).

## Phase 3 — Fly-in (interior)

- [ ] **Cinematic route**: every room, slow arcs, ceiling-third height;
      enter each enclosed room fully (frames shot from inside a room measure
      it at ±3%; frames peering through doorways over-span +16–47%).
- [ ] **Nadir pass**: one slow down-facing sweep just under the ceiling —
      the floorplan backbone (constant-height loop bounds drift).
- [ ] **One 360 still per room, standing in the room** (two in large rooms),
      **pinned on the plan at capture** (still_pins.json). The still IS the
      room's pano, its measurement instrument, and its tour dot.
- [ ] **Close the loop**: end the flight back at the entry threshold and hover
      where Phase 2 hovered. Loop closure is a validation gate, not a nicety.

## Validation gates (the shoot fails these, refly before leaving)

1. GPS locked ≥ 30 s of exterior segment before the threshold.
2. Tracking continuity through the door (post-flight: keyframe density at
   the threshold — no gap > 1 s).
3. Loop closed: start/end pose agreement.
4. Every room entered (checklist against the room list).
5. Every enclosed space filmed (open the closets — again).
6. Stills: one per room, pinned, none skipped.
7. Laser anchors recorded in the shoot notes.

## The manifest (what must land in the project upload)

| item | registry kind | role |
|---|---|---|
| master .OSV / stabilized MP4 | capture:video | cinematic tour master |
| non-stabilized equirect re-export | capture:video | VSLAM input |
| SRT telemetry | capture:telemetry | GPS/baro/gimbal weld |
| 360 stills (8K, one/room) | capture:pano | rooms, measurement, tour dots |
| still_pins.json | human input | localization priors |
| exterior high still | capture:pano | aerial base, footprint |
| laser anchor notes | measurements | scale truth |

## Why one take (the fusion argument, for the IP file)

Outdoors the drone knows WHERE it is (GPS) but the map is coarse; indoors
the map is millimeter-fine (VSLAM) but unanchored. A single unbroken track
through the threshold welds them: the exterior segment georeferences,
orients, and scales the interior map; the ceiling laser verifies it; known
objects certify it. Fly-by, fly-in — one gesture, and the whole property
exists in one measured frame, inside and out.
