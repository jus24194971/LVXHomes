# Dense VSLAM on Windows — step by step (RTX 2080S)

Goal: a re-exported interior 360 clip → dense point cloud + trajectory → the
**colour cut-plane top-down floor** (`slam-to-plan.mjs`) you trace the plan from.

Everything heavy runs in the `stella_vslam_dense` container; the only Cloudflare
parts are at the very end (host the base, push the plan).

---

## 0 · GPU + Docker prerequisites (one time)

1. **NVIDIA driver** — a current Game Ready/Studio driver (these include WSL2 CUDA).
2. **WSL2** — `wsl --install` (reboot if it's the first time).
3. **Docker Desktop** — install, Settings → General → *Use the WSL 2 based engine* (on).
4. **Smoke-test the GPU passthrough** (PowerShell):
   ```powershell
   docker run --rm --gpus all nvidia/cuda:12.2.0-base-ubuntu22.04 nvidia-smi
   ```
   You should see your **2080S** in the table. If not, fix this before going further —
   nothing else will work without it.

---

## 1 · Build the image (one time, slow)

```powershell
git clone https://github.com/RoblabWh/stella_vslam_dense.git
cd stella_vslam_dense
docker build -t stella_vslam_dense -f Dockerfile.viser .
```
This compiles stella + PatchMatch + CUDA — **expect 30–60+ min** and a few GB. If a
step fails, it's almost always a CUDA/dependency version in `Dockerfile.viser`; check
the repo issues for the pinned base image.

---

## 2 · Stage a data folder (mounted to `/data`)

Make one folder that holds inputs + outputs, e.g. `C:\Users\jus24\vslam\1112`:

```powershell
mkdir C:\Users\jus24\vslam\1112
cd C:\Users\jus24\vslam\1112
# ORB vocabulary
curl.exe -L "https://github.com/stella-cv/FBoW_orb_vocab/raw/main/orb_vocab.fbow" -o orb_vocab.fbow
```

**The config** (`lvx-dense.yaml`): copy the fork's working dense config out of the
container and set the camera to *our* 360:
```powershell
docker run --rm -v "${PWD}:/data" stella_vslam_dense cp /stella/example/dense/dense_hd.yaml /data/lvx-dense.yaml
```
Open `lvx-dense.yaml` and make the `Camera` block match your re-export — keep the dense
keys as-is, just set:
```yaml
Camera:
  name: "DJI 360"
  setup: "monocular"
  model: "equirectangular"   # must be equirectangular
  fps: 30.0                  # your re-export fps
  cols: 3840                 # your re-export width
  rows: 1920                 # your re-export height
  color_order: "RGB"
```
(Reference: `../plan-extract/vslam/equirectangular.yaml`.)

**The mask** (hide the drone body at the nadir) — generate one sized to your video,
from the lvx-homes repo so it can use `sharp`:
```powershell
node C:\Users\jus24\dev\lvx-homes\pipeline\vslam\make-mask.mjs 3840 1920 C:\Users\jus24\vslam\1112\mask.png 0.14
```
Check it against a frame; bump the `0.14` until the aircraft is fully covered.

**The clip**: drop your **non-stabilized equirect re-export** in as `1112.mp4`
(DJI Studio → Panoramic Video, HorizonSteady/RockSteady **OFF** — the SRT shows
`eis: close`, so don't re-add it).

---

## 3 · Validate the toolchain first

Run the fork's own sample clip once so you know a green run looks green before
trusting it on our footage (see the repo README for the sample). Then →

## 4 · Run dense VSLAM on the clip

```powershell
C:\Users\jus24\dev\lvx-homes\pipeline\vslam\run-vslam.ps1 -Clip 1112.mp4 -Data C:\Users\jus24\vslam\1112
```
→ `1112.ply` (dense cloud) + `1112.db` + (ideally) `keyframe_trajectory.txt` (TUM route).
Watch for **"tracking lost"** — if it happens, the flight was too fast / too dark /
too rotation-heavy there (see capture tips in `../plan-extract/VSLAM.md`).

> If `--eval-log-dir` didn't write `keyframe_trajectory.txt` on this build, the `.ply`
> is still good — send me the `.db` and I'll add a tiny sqlite→TUM extractor. The
> **floor image comes from the cloud**, so a missing route doesn't block it.

---

## 5 · Post-process → floor plan  (lvx-homes repo)

```powershell
cd C:\Users\jus24\dev\lvx-homes\pipeline\plan-extract
node slam-to-plan.mjs --ply C:\Users\jus24\vslam\1112\1112.ply `
  --traj C:\Users\jus24\vslam\1112\keyframe_trajectory.txt `
  --slug apartment-1112 --label "Apartment 1112" --out 1112.plan.json `
  --scale <metres-per-unit> --cut 1.5 --pxm 50
node preview-plan.mjs 1112.plan.json 1112.preview.png   # eyeball it
```
**`--scale`** (monocular is up-to-scale): take the **takeoff climb** — the SRT
`rel_alt` rises from the floor to hover height in metres; divide by the same rise in
SLAM units. Or one **known length** (a measured wall) = metres ÷ units. `--cut` = slice
height above the floor; `--pxm` = px/metre (detail).

---

## 6 · Into the Studio (same as the grounds)

```powershell
# host the floor image on R2
npx wrangler r2 object put lvx-media/plan-base/apartment-1112.jpg --file=1112-base.jpg --content-type image/jpeg --remote
# push the plan (R2 url keeps it lean)
node push-d1.mjs 1112.plan.json apartment-1112 --satUrl "https://media.lvxhomes.com/plan-base/apartment-1112.jpg"
npx wrangler d1 execute lvx-content --remote --file=_push.sql
```
Then `/studio/plan` → **Load from site** → zoom in → trace the 2D plan over the floor → **Save**.

---

## Milestones / where it breaks
1. `nvidia-smi` works in Docker → 2. image builds → 3. green on the sample clip →
4. tracking holds on `1112.mp4` (no "lost") → 5. cloud looks like the apartment →
6. `slam-to-plan` floor is recognizable → 7. plan traced + saved.

Two known-uncertain bits I'll close once you have real outputs: the **TUM trajectory
export** (extractor from the `.db` if `--eval-log-dir` is a no-op) and the exact
**`--scale`** (we'll read it off the takeoff `rel_alt`).
