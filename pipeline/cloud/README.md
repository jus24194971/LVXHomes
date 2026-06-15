# LVX cloud VSLAM — upload → process → post

The GPU step moves **off your machine**. Cloudflare stays the front door
(upload, R2, D1, serving); **Modal** is the bolted-on GPU engine your Worker
triggers over HTTPS. A 24 GB cloud GPU makes the dense-finalization OOM that
ate the week simply disappear.

```
Studio upload ──presigned PUT──► R2 (raw video)
       │                          │
       └── Worker ──HTTPS POST──► Modal submit()
                                   │  run_vslam (GPU): ffmpeg → stella_vslam_dense → .ply
                                   │  make_floor (CPU): slam-to-plan.mjs → plan.json + base.jpg
                                   │  ──► R2 (plans/ + plan-base/)
                                   └── callback ──► Worker → upsert D1 → listing "ready"
```

---

## 0 · No local image, no Docker push — Modal builds from source

Modal builds `stella_vslam_dense` **from public source in its own cloud**:
`modal_app.py` clones the RoblabWh repo (with submodules) and compiles it,
mirroring the upstream `Dockerfile.viser`. So **nothing is tied to this PC** —
if it dies, `git clone` lvx-homes anywhere + `modal deploy` and the whole engine
rebuilds itself from GitHub. The first `modal deploy` runs that build once
(~20–40 min, unattended, cached forever after). You don't babysit it, and there
is **nothing to `docker push`.**

> The only thing that still wants the local image is the optional
> *rent-a-GPU-tonight* shortcut (§1). If you don't need a floor literally
> tonight, skip straight to **§2**.

---

## 1 · (Optional) Tonight — a floor on a rented 24 GB GPU

Independent of Modal — only if you want a result *tonight* while the Modal build
runs. Your local `stella_vslam_dense` image (8.6 GB) powers this.

**Option A — RunPod from a one-off push:**
```powershell
docker login
docker tag stella_vslam_dense YOURUSER/stella_vslam_dense:latest
docker push YOURUSER/stella_vslam_dense:latest
```
1. RunPod → **Deploy a Pod** → GPU **≥24 GB** (RTX A5000 / 4090 / A6000).
2. **Container Image** = `YOURUSER/stella_vslam_dense:latest`.
3. Open the pod's **web terminal**. Put your 4 files in `/data`
   (`orb_vocab.fbow`, `mask.png`, `lvx-dense.yaml` [now 1920×960], `1112_sm.mp4`).
4. Run **inside the pod** (no `docker run` wrapper — you're already in it):
   ```bash
   python3 ./run_video_slam.py -v /data/orb_vocab.fbow -c /data/lvx-dense.yaml \
     -m /data/1112_sm.mp4 --mask /data/mask.png -o /data/1112.db -p /data/1112.ply \
     --eval-log-dir /data --frame-step 3 --disable-viewer --auto-term
   ```
5. Download `1112.ply`.

**Option B — rebuild on a GPU VM (Lambda Labs / Vast.ai, Docker preinstalled):**
```bash
git clone --recursive https://github.com/RoblabWh/stella_vslam_dense.git
cd stella_vslam_dense && docker build -t stella_vslam_dense -f Dockerfile.viser .
# scp your ~260 MB data folder up, then run your exact `docker run …` command
```

**Then back on your PC — see the footprint:**
```powershell
cd C:\Users\jus24\dev\lvx-homes\pipeline\plan-extract
node slam-to-plan.mjs --ply C:\Users\jus24\vslam\1112\1112.ply --slug apartment-1112 `
  --label "Apartment 1112" --out 1112.plan.json --scale 1 --cut 1.5 --pxm 50
node preview-plan.mjs 1112.plan.json 1112.preview.png
```
`--scale 1` is just to **see the shape** tonight; calibrate metres later off the
takeoff `rel_alt` (one known wall length works too).

---

## 2 · Modal — the productized pipeline

```powershell
pip install modal
modal token new                       # opens browser; you authorize
```

**Two secrets** (your creds — you create them, I never see them):

```powershell
# R2 S3 token: Cloudflare dash → R2 → Manage R2 API Tokens → Create (Object R/W).
modal secret create lvx-r2 `
  R2_ACCOUNT_ID=xxxxxxxx `
  R2_ACCESS_KEY_ID=xxxxxxxx `
  R2_SECRET_ACCESS_KEY=xxxxxxxx

# Where Modal calls back when a job is done (the Worker route is the next build).
modal secret create lvx-callback `
  LVX_CALLBACK_URL=https://lvxhomes.com/api/vslam/callback `
  LVX_CALLBACK_TOKEN=<make-a-long-random-string>
```

**Smoke test** (put a clip in R2 first, e.g. `uploads/1112.mp4`):
```powershell
modal run pipeline/cloud/modal_app.py --r2-key uploads/1112.mp4 --slug apartment-1112
```
First run triggers the ~20–40 min source build (cached after), then processes.
Watch the logs: it should print the cloud size and the R2 keys. **This is the
moment the `.ply` actually saves** — on a 24 GB card it won't OOM.

**Deploy** (gives you the HTTPS endpoint the Worker will hit):
```powershell
modal deploy pipeline/cloud/modal_app.py
```

---

## 3 · The Cloudflare side (built)

The full loop is wired in the app:
- **`/studio/process`** — upload a 360 video (presigned PUT straight to R2, so the
  big file never touches the Worker) + trigger. Linked from the Studio dashboard.
- **`/studio/api/vslam/start`** — records the job, POSTs `{slug, r2_key, token}` to
  your Modal `submit` endpoint.
- **`/api/vslam/callback`** — token-gated, PUBLIC path so Modal can reach it; pulls
  the produced plan.json from R2, repoints its base at the public R2 URL, saves it
  as the live plan for `slug`. **Your Access app must NOT cover `/api/vslam/*`.**
- **`/studio/api/vslam/status`** — the page polls this (processing → ready → failed).

Wire the two halves (you — needs your creds):
```powershell
# 1. apply the job table
wrangler d1 migrations apply lvx-content --remote

# 2. share the secret BOTH ways — paste the SAME value you put in LVX_CALLBACK_TOKEN
wrangler secret put VSLAM_CALLBACK_TOKEN

# 3. set MODAL_SUBMIT_URL in wrangler.jsonc vars to the deployed `submit` URL
#    (printed by `modal deploy`), then deploy the usual way:  git push main → CF CI
```

---

## Knobs / gotchas
- **`STELLA_PY`** — if `modal run` can't bootstrap on the image's interpreter,
  set `STELLA_PY` to the image's python that has the stella bindings.
- **GPU** — `GPU_TYPE="A10G"` (24 GB) is plenty for an apartment; bump to `"A100"`
  for resort-scale captures.
- **`--scale`** is the one genuinely manual number (monocular is up-to-scale).
  Read it off the takeoff climb in the SRT `rel_alt`, or one measured wall.
- **Cost** — A10G is per-second, scale-to-zero; a ~3-min clip is roughly
  **$0.10–0.30**. R2 has no egress fees, so moving the video CF↔Modal is free.
- **License** — running stella as *your* service is operating, not distributing;
  the GPL lineage only bites if you ship the binary to licensees later.
