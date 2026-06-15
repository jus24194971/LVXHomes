# Interior maps from 360 video — the VSLAM pipeline (scope)

GPS dies indoors, so we recover the camera's path **and** the room geometry from
the 360 footage itself with monocular **equirectangular SLAM**, then drop the
result into the Floorplan Studio exactly like a grounds sheet: a top-down base
image + the flight route, ready to trace zones over.

```
 360 video ──► SLAM ──► trajectory + point cloud ──► slam-to-plan.mjs ──► Plan
 (non-stab)   (Docker)   (TUM .txt)   (PLY)          (proven, this repo)   (Studio)
```

**Status:** the post-processor (`slam-to-plan.mjs`) is **built and proven** on a
synthetic tilted-room fixture (`--selftest` → gravity-align ✓, top-down ✓, route
✓). The remaining work is environment + the SLAM run on real footage.

---

## Which SLAM build

| | Use | Output | Compute |
|---|---|---|---|
| **stella_vslam_dense** (RoblabWh) ⭐ | our backbone — built for *360 action cams on small UAVs* | **dense PLY** point cloud + trajectory | **NVIDIA GPU** (your RTX 2080S + ≥16 GB RAM fits; 32 GB for 5.7K) |
| **stella_vslam** (stella-cv) | toolchain validation / CPU fallback | sparse landmarks + TUM trajectory | CPU only |

Dense gives solid walls (PatchMatch-Stereo) → a recognizable interior base.
Sparse is faster to stand up and perfect for proving the camera config + tracking
before committing to the dense build.

---

## Your part (the environment)

1. **Re-export a NON-stabilized equirect** from the `.OSV` in DJI Studio:
   Panoramic Video → H.264, **HorizonSteady / RockSteady / horizon-leveling OFF.**
   SLAM needs the true camera rotation; stabilization removes exactly that. (The
   SRT shows `eis: close`, so the capture is clean — just don't re-add it on export.)
   Note the output **resolution + fps** and set them in `vslam/equirectangular.yaml`.

2. **Mask the drone.** Open one frame; see where the aircraft/props sit at the
   nadir; widen the nadir `mask_rectangles` in the config until they're covered.
   This is the single biggest cause of failed 360-on-drone tracking.

3. **Build the Docker image** (`Dockerfile.viser` in stella_vslam_dense), and grab
   the ORB vocabulary `orb_vocab.fbow`:
   `https://github.com/stella-cv/FBoW_orb_vocab/raw/main/orb_vocab.fbow`

4. **Validate the toolchain first** on the project's AIST equirect sample (a known-
   good clip) so you know a green run looks green before pointing it at our footage.

---

## Run

**Sparse (CPU) — also writes the TUM trajectory directly:**
```bash
./run_video_slam --temporal-mapping \
  -v orb_vocab.fbow -c vslam/equirectangular.yaml -m flight_equirect.mp4 \
  --frame-skip 3 --no-sleep \
  --map-db-out map.msg --eval-log-dir ./out
# → ./out/keyframe_trajectory.txt  (TUM: timestamp tx ty tz qx qy qz qw)  + map.msg
```

**Dense (GPU) — the recognizable cloud:**
```bash
./run_video_slam.py \
  -v orb_vocab.fbow -c example/dense/dense_hd.yaml -m flight_equirect.mp4 \
  --frame-step 3 -o flight.db -p flight.ply
# → flight.ply (dense point cloud) + flight.db (poses)
```
Get a TUM trajectory for the route from `--eval-log-dir` (sparse) or export poses
from the `.db`/`.msg`. The dense PLY is the cloud; the TUM file is the route.

---

## Post-process → Plan  (this repo, already working)

```bash
node slam-to-plan.mjs --traj ./out/keyframe_trajectory.txt --ply flight.ply \
  --slug apartment-1112 --label "Apartment 1112" --out apartment-1112.plan.json \
  --scale <metres-per-unit> [--cut 1.5] [--pxm 50] [--yaw <deg>] [--flip]
# → apartment-1112.plan.json (route + interior base) + -base.jpg
```

What it does (all proven via `--selftest`):
- **Gravity-align** — a drone flight is ~planar, so the trajectory's thin axis ≈ up;
  rotates the world flat (override with `--up x,y,z`).
- **Colour cut-plane top-down** — *this is the "compose a top-down shot" output.*
  Looks straight down with the ceiling/upper-walls **sliced off at `--cut` m above
  the floor** (architectural cut), keeping the highest point below the cut per cell:
  you get the **floor texture + furniture + wall cross-sections** as a photographic
  top-down, stabilized because it's one consistent SLAM solve. `--pxm` = px/metre
  (zoom/detail). A colourless/sparse cloud falls back to a wall-density raster.
- **Route** — trajectory → `paths.flight` keys `{t,x,y,h}`, heading from travel
  tangent, same schema the player's traveling dot already consumes.

### The three indoor unknowns (no GPS) and how we resolve them
- **Scale** (monocular is up-to-scale): easiest is the **takeoff climb** — the drone
  rises from the floor to hover height; the SRT barometer gives that in metres, the
  SLAM gives it in units → `--scale`. Fallback: one **known length** (a measured
  wall) → scale = metres / units.
- **Orientation**: `--yaw` from the SRT `gb_yaw` at a reference frame, or just rotate
  in the Studio. (Indoors there's no north to chase — heading-up is fine.)
- **Position**: the room is self-contained, so the sheet just frames the cloud; no
  anchor needed. (The tap-a-start anchor is the *outdoor* GPS-gap tool.)

---

## Into the Studio (same as grounds)

1. Host the base: `wrangler r2 object put lvx-media/plan-base/<slug>.jpg --file=<slug>-base.jpg --content-type image/jpeg --remote`
2. `node push-d1.mjs <slug>.plan.json <slug> --satUrl "https://media.lvxhomes.com/plan-base/<slug>.jpg"` → `wrangler d1 execute lvx-content --remote --file=_push.sql`
3. `/studio/plan` → **Load from site** → zoom in, trace the 2D plan over the top-down floor → **Save**.

---

## Perfecting the interior flight (capture for a clean top-down floor)

The cut-plane floor is only as good as the cloud, and the cloud is only as good as
the flight. To get a crisp, gap-free top-down:

- **Cover the whole floor like a lawnmower** — fly a slow serpentine over every
  area so the dense reconstruction sees all of it; gaps in coverage = holes in the
  top-down.
- **Hold a steady height around 1.5–2.5 m**, above the `--cut` plane so walls and
  furniture reconstruct, low enough for floor detail. (This shoot started at 0.6 m —
  climb a bit for room coverage.) Keep the **gimbal level** so "down" stays down.
- **Translate, don't hover/spin** — depth comes from parallax; pure rotation gives none.
- **Slow + steady**, generous overlap; **return to your start** so the loop closes and drift cancels.
- **Texture is your friend** — rugs/decor/grain track well; blank glossy floors and
  bare white walls are SLAM-hard. **Light it evenly**; avoid big mirrors/glass.
- Keep props out of frame where you can; mask the nadir in the config for the rest.
- A deliberate **vertical bob at takeoff** gives a clean barometric scale reference (`--scale`).
- One contiguous flight per floor; the cut-plane stitches rooms as long as the SLAM track stays unbroken.

## Milestones (so you know it's working)
1. Toolchain green on the AIST sample.  2. Tracking holds across our clip (no "lost").
3. Cloud looks like the room.  4. `slam-to-plan` base is recognizable.  5. Zones traced.

## References
- stella_vslam example config + run: https://stella-cv.readthedocs.io/en/latest/example.html · https://github.com/stella-cv/stella_vslam
- dense 360/UAV fork: https://github.com/RoblabWh/stella_vslam_dense
- ORB vocab: https://github.com/stella-cv/FBoW_orb_vocab
