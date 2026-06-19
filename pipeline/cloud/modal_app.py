# =============================================================================
# LVX cloud VSLAM processor (Modal)
#
# End goal:  upload a 360 video -> process in the cloud -> floor plan + base
#            image land in R2 -> a callback flips the listing to "ready".
#
# This is the GPU engine room. Cloudflare stays your front door (upload, R2,
# D1, serving); Modal is just the bolted-on GPU step that your Worker triggers
# over HTTPS. Nothing here runs on your 2080S ever again.
#
# Pipeline (one job):
#   run_vslam (GPU)  R2 raw video -> ffmpeg normalize -> stella_vslam_dense
#                    -> {slug}.ply / .db / trajectory  -> back to R2
#   make_floor (CPU) {slug}.ply   -> slam-to-plan.mjs  -> plan.json + base.jpg
#                    -> back to R2
#   process          orchestrates the two, then POSTs a callback to your Worker
#
# Run it:
#   pip install modal && modal token new
#   # create the two Modal secrets (lvx-r2, lvx-callback) — see README.
#   modal run  pipeline/cloud/modal_app.py --r2-key uploads/1112.mp4 --slug apartment-1112
#   modal deploy pipeline/cloud/modal_app.py     # first deploy BUILDS stella from
#   #   public source in Modal's cloud (~20-40 min, cached after); -> HTTPS endpoint.
# =============================================================================

import json
import os
import pathlib
import subprocess
import urllib.request

import modal

# ---------------------------------------------------------------------------
# Config — sensible defaults. Nothing here is secret, nothing ties to your PC.
# ---------------------------------------------------------------------------
# stella_vslam_dense is BUILT IN MODAL'S CLOUD from public source (see the image
# below) — no local Docker, no image to push, no machine dependency. These pin
# the same CUDA / Ubuntu the upstream Dockerfile.viser uses.
CUDA = "12.9.1"
UBUNTU = "24.04"

R2_BUCKET = "lvx-media"          # your existing R2 bucket
SLAM_W, SLAM_H = 1920, 960       # equirect size fed to SLAM (matches lvx-dense.yaml)
GPU_TYPE = "A10G"                # 24 GB — plenty for an apartment. "A100" for big captures.
FRAME_STEP = 3                   # lower = denser cloud (the 24 GB card can take it)

# Run stella's bindings with the SYSTEM python they're compiled against. Modal's
# own interpreter is separate and only orchestrates (download / ffmpeg / upload).
STELLA_PY = os.environ.get("STELLA_PY", "/usr/bin/python3")

# plan-extract scripts (slam-to-plan.mjs etc.) baked into the node image at build.
LOCAL_PLAN_EXTRACT = (pathlib.Path(__file__).parent.parent / "plan-extract").as_posix()

app = modal.App("lvx-vslam")

# Shared scratch between the GPU and CPU stages of a job.
vol = modal.Volume.from_name("lvx-vslam-scratch", create_if_missing=True)

# Secrets you create once (see README):
#   lvx-r2:       R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
#   lvx-callback: LVX_CALLBACK_URL, LVX_CALLBACK_TOKEN
r2_secret = modal.Secret.from_name("lvx-r2")
cb_secret = modal.Secret.from_name("lvx-callback")

# --- images -----------------------------------------------------------------
# GPU: stella_vslam_dense built FROM PUBLIC SOURCE in Modal's cloud — no local
# Docker, no image push. Mirrors upstream Dockerfile.viser, but clones the repo
# instead of COPYing a local checkout, so it's reproducible from GitHub alone.
# First `modal deploy` runs this build (~20-40 min); cached forever after.
_APT = [
    "git", "curl", "cmake", "ninja-build", "clang", "pkg-config",
    "libatlas-base-dev", "libsuitesparse-dev", "binutils-dev",
    "libomp-dev", "libopencv-dev", "libeigen3-dev", "libyaml-cpp-dev", "libsqlite3-dev",
    "python3", "python3-pip", "python3-opencv", "python3-msgpack", "python3-numpy",
    "python3-scipy", "python3-dev", "pybind11-dev",
    "ffmpeg",  # our transcode step
]
vslam_image = (
    modal.Image.from_registry(f"nvidia/cuda:{CUDA}-devel-ubuntu{UBUNTU}", add_python="3.12")
    .apt_install(*_APT)
    .env({"CXX": "clang++"})  # upstream builds C++ with clang
    .run_commands(
        # system-python build deps (PEP 668 → break-system-packages), per upstream
        "pip install --no-cache-dir --break-system-packages "
        "pybind11-stubgen numba viser==1.0.24",
        # ORB vocabulary, baked in
        "curl -fsSL https://github.com/stella-cv/FBoW_orb_vocab/raw/main/orb_vocab.fbow "
        "-o /opt/orb_vocab.fbow",
        # g2o
        "git clone https://github.com/RainerKuemmerle/g2o.git --branch 20241228_git --depth 1 "
        "/tmp/g2o && cd /tmp/g2o && cmake -B build -G Ninja -DCMAKE_BUILD_TYPE=Release "
        "-DBUILD_SHARED_LIBS=ON -DBUILD_UNITTESTS=OFF -DG2O_USE_CHOLMOD=OFF -DG2O_USE_CSPARSE=ON "
        "-DG2O_USE_OPENGL=OFF -DG2O_USE_OPENMP=OFF -DG2O_BUILD_APPS=OFF -DG2O_BUILD_EXAMPLES=OFF "
        "-DG2O_BUILD_LINKED_APPS=OFF && cmake --build build --parallel && cmake --install build "
        "&& rm -rf /tmp/g2o",
        # backward-cpp
        "git clone https://github.com/bombela/backward-cpp.git /tmp/backward-cpp && "
        "cd /tmp/backward-cpp && git checkout 5ffb2c879ebdbea3bdb8477c671e32b1c984beaa && "
        "cmake -B build -G Ninja -DCMAKE_BUILD_TYPE=Release && cmake --build build --parallel "
        "&& cmake --install build && rm -rf /tmp/backward-cpp",
        # stella_vslam_dense — clone WITH submodules (FBoW + PatchMatch; exactly what
        # broke the local build until `submodule update`), pin the bindings to the
        # system python. The final ninja step generates pybind .pyi stubs under
        # Modal's interpreter, which can't import the just-built module — cosmetic,
        # so tolerate it; we hard-require the binding .so, then make libs discoverable.
        "set -e; "
        "git clone --recursive https://github.com/RoblabWh/stella_vslam_dense.git /stella; "
        "cd /stella; git submodule update --init --recursive; "
        "cmake -B build -G Ninja -DCMAKE_BUILD_TYPE=Release -DPython3_EXECUTABLE=/usr/bin/python3; "
        "cmake --build build --parallel || echo 'non-fatal build tail (stub gen)'; "
        "test -f /stella/build/lib/stellapy.cpython-312-x86_64-linux-gnu.so; "
        "cmake --install build || echo 'non-fatal install tail'; "
        "cp -a /stella/build/lib/*.so* /usr/local/lib/ 2>/dev/null || true; "
        "ldconfig",
    )
    # run_video_slam.py + color_scheme.py import these from the SYSTEM python (where
    # the stella bindings live). Modal's add_python made the build-stage `pip` target
    # a DIFFERENT interpreter, so (re)install them against /usr/bin/python3 here —
    # after the cached stella build, so that heavy layer isn't invalidated.
    .run_commands(
        "/usr/bin/python3 -m pip install --no-cache-dir --break-system-packages "
        "tqdm viser==1.0.24 numba"
    )
    .env({"PYTHONPATH": "/stella/build/lib"})  # fallback so the bindings import
    .pip_install("boto3", "pillow")            # Modal-python orchestration deps
)

# CPU: node 20 + sharp + your plan-extract scripts.
node_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("curl", "ca-certificates", "gnupg")
    .run_commands(
        "curl -fsSL https://deb.nodesource.com/setup_20.x | bash -",
        "apt-get install -y nodejs",
    )
    .pip_install("boto3")
    .add_local_dir(LOCAL_PLAN_EXTRACT, remote_path="/opt/plan-extract", copy=True)
    .run_commands("cd /opt/plan-extract && npm init -y >/dev/null 2>&1 && npm install sharp")
)

# Tiny image for the HTTPS trigger endpoint — Modal needs FastAPI in the image
# that backs a web endpoint.
web_image = modal.Image.debian_slim().pip_install("fastapi[standard]")

# Tiny image for the secrets self-test (boto3 only).
test_image = modal.Image.debian_slim().pip_install("boto3")

# Image for the interior orthophoto stage (OpenCV + numpy + boto3 — no stella).
ortho_image = modal.Image.debian_slim(python_version="3.11").pip_install(
    "opencv-python-headless", "numpy", "boto3"
)


# --- helpers ----------------------------------------------------------------
def _r2():
    import boto3

    return boto3.client(
        "s3",
        endpoint_url=f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
        region_name="auto",
    )


def _dense_yaml(w: int, h: int) -> str:
    # The fork's dense config, sized to the normalized clip. Keeps Camera and
    # PatchMatch in lock-step so we never re-hit the 4x-memory mismatch bug.
    return f"""Camera:
  name: "LVX 360"
  setup: "monocular"
  model: "equirectangular"
  fps: 30.0
  cols: {w}
  rows: {h}
  color_order: "BGR"
Preprocessing:
  min_size: 800
  mask_rectangles:
    - [0.0, 1.0, 0.0, 0.1]
    - [0.0, 1.0, 0.84, 1.0]
    - [0.0, 0.2, 0.7, 1.0]
    - [0.8, 1.0, 0.7, 1.0]
Feature:
  name: "default ORB feature extraction setting"
  scale_factor: 1.2
  num_levels: 8
  ini_fast_threshold: 20
  min_fast_threshold: 7
Mapping:
  baseline_dist_thr_ratio: 0.02
  redundant_obs_ratio_thr: 0.95
LoopDetector:
  enabled: true
  reject_by_graph_distance: true
  min_distance_on_graph: 50
SocketPublisher:
  image_quality: 80
PatchMatch:
  enabled: true
  cols: {w}
  rows: {h}
  min_patch_std_dev: 0
  patch_size: 7
  patchmatch_iterations: 4
  min_score: 0.1
  min_consistent_views: 3
  depthmap_queue_size: 5
  depthmap_same_depth_threshold: 0.08
  min_views: 1
  pointcloud_queue_size: 4
  pointcloud_same_depth_threshold: 0.08
  min_stereo_score: 0
"""


def _write_mask(path: pathlib.Path, w: int, h: int, nadir=0.14, zenith=0.03):
    # white = use, black = ignore: hide the drone body (nadir) + stitch smear (zenith).
    from PIL import Image, ImageDraw

    img = Image.new("L", (w, h), 255)
    d = ImageDraw.Draw(img)
    d.rectangle([0, h - int(h * nadir), w, h], fill=0)
    d.rectangle([0, 0, w, int(h * zenith)], fill=0)
    img.save(path)


# --- GPU stage --------------------------------------------------------------
@app.function(image=vslam_image, gpu=GPU_TYPE, volumes={"/scratch": vol},
              secrets=[r2_secret], timeout=3600)
def run_vslam(r2_key: str, slug: str) -> dict:
    work = pathlib.Path(f"/scratch/{slug}")
    work.mkdir(parents=True, exist_ok=True)
    raw, norm = work / "raw.mp4", work / "slam.mp4"

    s3 = _r2()
    s3.download_file(R2_BUCKET, r2_key, str(raw))

    # normalize: whatever the agent uploaded -> equirect SLAM size, H.264, no audio.
    subprocess.run(
        ["ffmpeg", "-y", "-i", str(raw), "-vf", f"scale={SLAM_W}:{SLAM_H}",
         "-c:v", "libx264", "-preset", "fast", "-an", str(norm)],
        check=True,
    )

    (work / "lvx-dense.yaml").write_text(_dense_yaml(SLAM_W, SLAM_H))
    _write_mask(work / "mask.png", SLAM_W, SLAM_H)

    # locate the fork's runner (path varies by image WORKDIR) and run from there.
    run_py = subprocess.run(
        ["bash", "-lc",
         "find / -maxdepth 7 -name run_video_slam.py -not -path '*/proc/*' 2>/dev/null | head -1"],
        capture_output=True, text=True,
    ).stdout.strip()
    if not run_py:
        raise RuntimeError("run_video_slam.py not found in image — check STELLA_IMAGE")
    workdir = os.path.dirname(run_py)

    ply, db = work / f"{slug}.ply", work / f"{slug}.db"
    subprocess.run(
        [STELLA_PY, "run_video_slam.py",
         "-v", "/opt/orb_vocab.fbow",
         "-c", str(work / "lvx-dense.yaml"),
         "-m", str(norm), "--mask", str(work / "mask.png"),
         "-o", str(db), "-p", str(ply),
         "--eval-log-dir", str(work),
         "--frame-step", str(FRAME_STEP), "--disable-viewer", "--auto-term"],
        check=True, cwd=workdir,
    )
    if not ply.exists():
        raise RuntimeError("VSLAM finished but wrote no .ply (tracking lost or OOM)")

    out = {}
    for f in (ply, db, work / "keyframe_trajectory.txt"):
        if f.exists():
            key = f"vslam/{slug}/{f.name}"
            s3.upload_file(str(f), R2_BUCKET, key)
            out[f.suffix.lstrip(".") or "traj"] = key
    vol.commit()
    print(f"[vslam] {slug}: {ply.stat().st_size/1e6:.1f} MB cloud -> R2 {out}")
    return out


# --- CPU stage --------------------------------------------------------------
@app.function(image=node_image, volumes={"/scratch": vol},
              secrets=[r2_secret], timeout=900)
def make_floor(slug: str, scale: float = 1.0, cut: float = 1.5, pxm: int = 50) -> dict:
    work = pathlib.Path(f"/scratch/{slug}")
    work.mkdir(parents=True, exist_ok=True)
    ply = work / f"{slug}.ply"

    s3 = _r2()
    if not ply.exists():
        s3.download_file(R2_BUCKET, f"vslam/{slug}/{slug}.ply", str(ply))

    out_plan = work / f"{slug}.plan.json"
    cmd = ["node", "slam-to-plan.mjs",
           "--ply", str(ply), "--slug", slug, "--label", slug,
           "--out", str(out_plan),
           "--scale", str(scale), "--cut", str(cut), "--pxm", str(pxm)]
    traj = work / "keyframe_trajectory.txt"
    if not traj.exists():
        try:
            s3.download_file(R2_BUCKET, f"vslam/{slug}/keyframe_trajectory.txt", str(traj))
        except Exception:
            pass
    if traj.exists():
        cmd += ["--traj", str(traj)]
    subprocess.run(cmd, check=True, cwd="/opt/plan-extract")

    s3.upload_file(str(out_plan), R2_BUCKET, f"plans/{slug}.plan.json")
    result = {"plan": f"plans/{slug}.plan.json"}

    # slam-to-plan writes the interior base alongside --out; find it and host it.
    base = next((p for p in work.glob("*base*.jpg")), None) or \
        next((p for p in work.glob("*base*.png")), None)
    if base:
        key = f"plan-base/{slug}{base.suffix}"
        s3.upload_file(str(base), R2_BUCKET, key)
        result["base"] = key
    vol.commit()
    print(f"[floor] {slug} -> R2 {result}")
    return result


# --- orchestration + trigger ------------------------------------------------
_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"


def _notify(payload: dict):
    url = os.environ.get("LVX_CALLBACK_URL")
    if not url:
        print("[callback] no LVX_CALLBACK_URL set, skipping:", payload)
        return
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode(),
        headers={"content-type": "application/json", "user-agent": _UA,
                 "x-lvx-token": os.environ.get("LVX_CALLBACK_TOKEN", "").strip(),
                 "authorization": f"Bearer {os.environ.get('LVX_CALLBACK_TOKEN', '').strip()}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            print("[callback]", r.status, payload.get("slug"))
    except Exception as e:
        print("[callback] failed:", e)


@app.function(secrets=[cb_secret], timeout=4200)
def process(job: dict) -> dict:
    """One full job, fanned out by what was uploaded:
         video  -> run_vslam (cloud + trajectory -> /scratch) -> make_ortho
                   (top-down photo + flight path + feet-scaled plan.json)
         stills -> stitch_stills (dedicated-still orthomosaic)
       Sequential where there's a dependency (the ortho reads the VSLAM volume)."""
    slug = job["slug"]
    video_key = job.get("video_key") or job.get("r2_key")
    still_keys = job.get("still_keys") or []
    ceiling_ft = float(job.get("ceiling_ft", 9.0))
    # New capture workflow — dedicated stills + a flythrough → the localized, georeferenced
    # floorplan chain (still_layout → VSLAM → localize → fuse → deliver). It delivers itself.
    if still_keys:
        try:
            return process_floorplan.remote(slug, ceiling_ft=ceiling_ft)
        except Exception as e:
            payload = {"slug": slug, "status": "failed", "error": str(e)}
            _notify(payload)
            return payload
    # Legacy single-video capture (no dedicated stills, e.g. the 1112 demo).
    try:
        payload = {"slug": slug, "status": "ready"}
        if video_key:
            run_vslam.remote(video_key, slug)                       # GPU -> commits /scratch
            payload.update(make_ortho.remote(slug, video_key, ceiling_ft=ceiling_ft))
    except Exception as e:
        payload = {"slug": slug, "status": "failed", "error": str(e)}
    _notify(payload)
    return payload


@app.function(secrets=[cb_secret], image=web_image)
@modal.fastapi_endpoint(method="POST")          # older Modal: @modal.web_endpoint
def submit(job: dict):
    """HTTPS entry the Cloudflare Worker calls on upload. Returns immediately;
    the heavy job runs async and calls back when done."""
    from fastapi.responses import JSONResponse

    if os.environ.get("LVX_CALLBACK_TOKEN") and \
       job.get("token") != os.environ["LVX_CALLBACK_TOKEN"]:
        return JSONResponse({"error": "unauthorized"}, status_code=401)
    if not job.get("slug"):
        return JSONResponse({"error": "need slug"}, status_code=400)
    if not (job.get("r2_key") or job.get("video_key") or job.get("still_keys")):
        return JSONResponse({"error": "need a video or stills to process"}, status_code=400)
    process.spawn(job)
    return {"accepted": True, "slug": job["slug"]}


@app.function(image=test_image, secrets=[r2_secret, cb_secret])
def selftest() -> dict:
    """Verify the imported secrets actually work: R2 read with lvx-r2 + callback token set."""
    import os

    out: dict = {}
    try:
        s3 = _r2()
        r = s3.list_objects_v2(Bucket=R2_BUCKET, MaxKeys=5)
        out["r2"] = {
            "ok": True,
            "bucket": R2_BUCKET,
            "sample": [o["Key"] for o in r.get("Contents", [])],
        }
    except Exception as e:
        out["r2"] = {"ok": False, "error": str(e)[:300]}
    tok = os.environ.get("LVX_CALLBACK_TOKEN", "")
    out["callback"] = {
        "token_real": bool(tok) and tok != "PLACEHOLDER",
        "url": os.environ.get("LVX_CALLBACK_URL", ""),
    }
    print(out)
    return out


# ---------------------------------------------------------------------------
# Interior orthophoto — the "sat image, but of the inside"
# ---------------------------------------------------------------------------
def _read_ply_xyz(path):
    """Read x,y,z from a binary_little_endian (or ascii) PLY → (N,3) float32."""
    import numpy as np

    with open(path, "rb") as f:
        if f.readline().strip() != b"ply":
            raise ValueError("not a PLY")
        fmt, n, props, hlen = b"", 0, [], 1
        while True:
            ln = f.readline(); hlen += 1
            if not ln or ln.strip() == b"end_header":
                break
            t = ln.split()
            if t[0] == b"format":
                fmt = t[1]
            elif t[0] == b"element" and t[1] == b"vertex":
                n = int(t[2])
            elif t[0] == b"property" and len(t) >= 3:
                props.append((t[2].decode(), t[1].decode()))
        tymap = {"float": "<f4", "float32": "<f4", "double": "<f8", "uchar": "u1",
                 "uint8": "u1", "int": "<i4", "uint": "<u4", "short": "<i2", "ushort": "<u2"}
        if fmt == b"ascii":
            arr = np.loadtxt(path, skiprows=hlen)
            names = [p[0] for p in props]
            return arr[:, [names.index("x"), names.index("y"), names.index("z")]].astype("f4")
        dt = np.dtype([(nm, tymap.get(ty, "<f4")) for nm, ty in props])
        buf = f.read(n * dt.itemsize)
        d = np.frombuffer(buf, dtype=dt, count=n)
        return np.stack([d["x"], d["y"], d["z"]], 1).astype("f4")


def _quat2rot(q):
    """[qx,qy,qz,qw] → 3x3 rotation (world-from-camera)."""
    import numpy as np

    x, y, z, w = q
    n = x * x + y * y + z * z + w * w
    if n < 1e-12:
        return np.eye(3)
    s = 2.0 / n
    return np.array([
        [1 - s * (y * y + z * z), s * (x * y - z * w), s * (x * z + y * w)],
        [s * (x * y + z * w), 1 - s * (x * x + z * z), s * (y * z - x * w)],
        [s * (x * z - y * w), s * (y * z + x * w), 1 - s * (x * x + y * y)],
    ])


@app.function(image=ortho_image, secrets=[r2_secret], volumes={"/scratch": vol}, timeout=2400)
def make_ortho(slug: str, video_key: str, pxm: float = 60.0, kf_step: int = 1,
               yflip: int = 1, lonsign: int = 1, cone_deg: float = 55.0,
               blend: int = 0, path: int = 0, ceiling_ft: float = 0.0) -> dict:
    """Project each keyframe's downward (nadir) view onto the SLAM floor plane and
    mosaic → a top-down photographic interior 'sat image'. Conventions are flags
    (yflip / lonsign) so we can correct the render without re-running VSLAM."""
    import numpy as np
    import cv2

    import os

    s3 = _r2()
    sd = f"/scratch/{slug}"   # VSLAM scratch volume (run_vslam commits it)
    ply_p = f"{sd}/{slug}.ply"
    if not os.path.exists(ply_p):
        ply_p = "/tmp/cloud.ply"
        s3.download_file(R2_BUCKET, f"vslam/{slug}/{slug}.ply", ply_p)
    # prefer the DENSE per-frame poses from the volume; else sparse keyframes
    traj_p = f"{sd}/frame_trajectory.txt"
    if not os.path.exists(traj_p):
        traj_p = f"{sd}/keyframe_trajectory.txt"
    if not os.path.exists(traj_p):
        traj_p = "/tmp/kf.txt"
        s3.download_file(R2_BUCKET, f"vslam/{slug}/keyframe_trajectory.txt", traj_p)
    # prefer the exact clip stella processed (timestamps match the trajectory)
    vid_p = f"{sd}/slam.mp4"
    if not os.path.exists(vid_p):
        vid_p = "/tmp/flight.mp4"
        s3.download_file(R2_BUCKET, video_key, vid_p)
    print(f"[ortho] traj={traj_p.split('/')[-1]} video={vid_p.split('/')[-1]}")

    pts = _read_ply_xyz(ply_p)
    c = pts.mean(0)
    Xc = pts - c
    # gravity 'up' ≈ thinnest axis of a ~planar flight space
    _, _, Vt = np.linalg.svd(Xc[::41], full_matrices=False)
    up = Vt[2].astype("f4")
    T = np.loadtxt(traj_p)
    if T.ndim == 1:
        T = T[None, :]
    cams = T[:, 1:4]
    if np.dot(cams.mean(0) - c, up) < 0:
        up = -up
    a = np.array([1.0, 0, 0]) if abs(up[0]) < 0.9 else np.array([0, 1.0, 0])
    e1 = np.cross(up, a); e1 /= np.linalg.norm(e1)
    e2 = np.cross(up, e1)

    P2 = np.stack([Xc @ e1, Xc @ e2], 1)
    lo = np.percentile(P2, 1, axis=0); hi = np.percentile(P2, 99, axis=0)
    floor_h = float(np.percentile(Xc @ up, 4))
    W = min(1600, int((hi[0] - lo[0]) * pxm) + 1)
    H = min(1600, int((hi[1] - lo[1]) * pxm) + 1)
    gx, gy = np.meshgrid(np.linspace(lo[0], hi[0], W), np.linspace(lo[1], hi[1], H))
    floorP = (c + gx[..., None] * e1 + gy[..., None] * e2 + floor_h * up).astype("f4")

    cap = cv2.VideoCapture(vid_p)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    nfr = cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0
    Hv = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    Wv = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    ts = T[:, 0].copy()
    # timestamp units: seconds vs frame-index heuristic
    if nfr and ts.max() > (nfr / fps) * 2:
        ts = ts / fps  # looked like frame indices
    # use ~350 evenly-spaced poses (dense trajectory has ~1300; keyframes ~108)
    step = kf_step if kf_step > 1 else max(1, len(T) // 350)

    acc = np.zeros((H, W, 3), np.float32)   # blend=1: weighted average
    wsum = np.zeros((H, W), np.float32)
    best = np.zeros((H, W, 3), np.uint8)    # blend=0: best straight-down view (default)
    bestw = np.zeros((H, W), np.float32)
    cos_cone = np.cos(np.radians(cone_deg))
    used = 0
    for i in range(0, len(T), step):
        C = T[i, 1:4]; R = _quat2rot(T[i, 4:8])
        cap.set(cv2.CAP_PROP_POS_MSEC, float(ts[i]) * 1000.0)
        ok, fr = cap.read()
        if not ok:
            continue
        used += 1
        fr = cv2.cvtColor(fr, cv2.COLOR_BGR2RGB)
        ray = floorP - C
        rn = ray / (np.linalg.norm(ray, axis=2, keepdims=True) + 1e-9)
        vert = -(rn @ up)                       # 1.0 = straight down
        rc = ray @ R                            # world→camera
        rcn = rc / (np.linalg.norm(rc, axis=2, keepdims=True) + 1e-9)
        x, y, z = rcn[..., 0], rcn[..., 1], rcn[..., 2]
        lon = lonsign * np.arctan2(x, z)
        lat = np.arcsin(np.clip(yflip * (-y), -1, 1))
        u = (((lon / (2 * np.pi)) + 0.5) * Wv).astype(np.int32) % Wv
        v = np.clip((0.5 - lat / np.pi) * Hv, 0, Hv - 1).astype(np.int32)
        w = np.where(vert > cos_cone, vert, 0.0).astype(np.float32)
        w[v > int(Hv * 0.93)] = 0.0             # drop the drone-occluded nadir band
        col = fr[v, u]
        if blend:
            acc += col * w[..., None]; wsum += w
        else:
            better = w > bestw                  # keep only the most straight-down look
            best[better] = col[better]; bestw[better] = w[better]
    cap.release()

    if blend:
        img = np.zeros((H, W, 3), np.uint8); hit = wsum > 1e-6
        img[hit] = (acc[hit] / wsum[hit][..., None]).astype(np.uint8)
    else:
        img = best; hit = bestw > 1e-6
    import json
    import time
    out = "/tmp/ortho.jpg"
    bgr = cv2.cvtColor(img, cv2.COLOR_RGB2BGR)
    if path:                                   # optionally bake the path into the image too
        Pc = cams - c
        a1 = (Pc @ e1 - lo[0]) / (hi[0] - lo[0]) * (W - 1)
        a2 = (Pc @ e2 - lo[1]) / (hi[1] - lo[1]) * (H - 1)
        bx = np.clip(a1, 0, W - 1).astype(int); by = np.clip(a2, 0, H - 1).astype(int)
        for i in range(1, len(bx)):
            tt = i / len(bx)
            cv2.line(bgr, (bx[i - 1], by[i - 1]), (bx[i], by[i]),
                     (45, int(225 * (1 - tt) + 20), int(225 * tt + 20)), 3, cv2.LINE_AA)
        cv2.circle(bgr, (int(bx[0]), int(by[0])), 11, (90, 210, 90), -1)
        cv2.circle(bgr, (int(bx[-1]), int(by[-1])), 11, (60, 60, 240), -1)
    cv2.imwrite(out, bgr, [cv2.IMWRITE_JPEG_QUALITY, 90])
    key = f"ortho/{slug}.jpg"
    s3.upload_file(out, R2_BUCKET, key)

    # scale + flight path as VECTOR feet-coords (a real toggle-able layer, not baked)
    hcol = Xc @ up
    fpu = ceiling_ft / (np.percentile(hcol, 99) - np.percentile(hcol, 1.5)) if ceiling_ft > 0 else 0.0
    ftw = round(float((hi[0] - lo[0]) * fpu), 1); fth = round(float((hi[1] - lo[1]) * fpu), 1)
    Pcam = cams - c
    fxs = (Pcam @ e1 - lo[0]) * fpu; fys = (Pcam @ e2 - lo[1]) * fpu
    stepf = max(1, len(fxs) // 140)
    flight = [{"t": int(i), "x": round(float(fxs[i]), 2), "y": round(float(fys[i]), 2)}
              for i in range(0, len(fxs), stepf)]
    if fpu > 0:                                # compose a ready-to-load plan (feet + path)
        plan = {"tourSlug": slug, "sheets": [{
            "id": "floor-1", "label": slug, "kind": "floor",
            "width": ftw, "height": fth, "zones": [],
            "satUrl": f"https://media.lvxhomes.com/{key}?v={int(time.time())}",
            "paths": {"flight": flight},
        }]}
        s3.put_object(Bucket=R2_BUCKET, Key=f"plans/{slug}.plan.json",
                      Body=json.dumps(plan).encode(), ContentType="application/json")
    print(f"[ortho] {slug}: {W}x{H}px from {used} keyframes ({int(hit.mean()*100)}% filled), "
          f"{ftw}x{fth}ft, {len(flight)} path pts -> R2 {key} + plans/{slug}.plan.json")
    return {"ortho": key, "px": [W, H], "keyframes_used": used, "filled_pct": int(hit.mean() * 100),
            "ft": [ftw, fth], "flight_pts": len(flight)}


@app.function(image=ortho_image, secrets=[r2_secret], volumes={"/scratch": vol}, timeout=1200)
def make_dims(slug: str, flight_ft: float = 4.4167, ceiling_ft: float = 0.0,
              pxm: float = 40.0, wall_frac: float = 0.45) -> dict:
    """Dimensional half: anchor scale to the measured flight height, segment the
    walls (tall vertical structure) into a top-down outline, report room footprint
    in FEET. Object heights intentionally ignored — only room dimensions."""
    import os
    import numpy as np
    import cv2

    s3 = _r2()
    sd = f"/scratch/{slug}"
    ply = f"{sd}/{slug}.ply"
    if not os.path.exists(ply):
        ply = "/tmp/c.ply"; s3.download_file(R2_BUCKET, f"vslam/{slug}/{slug}.ply", ply)
    traj = f"{sd}/frame_trajectory.txt"
    if not os.path.exists(traj):
        traj = f"{sd}/keyframe_trajectory.txt"
    if not os.path.exists(traj):
        traj = "/tmp/t.txt"; s3.download_file(R2_BUCKET, f"vslam/{slug}/keyframe_trajectory.txt", traj)

    pts = _read_ply_xyz(ply)
    c = pts.mean(0); X = pts - c
    _, _, Vt = np.linalg.svd(X[::41], full_matrices=False)
    up = Vt[2].astype("f4")
    T = np.loadtxt(traj)
    if T.ndim == 1:
        T = T[None, :]
    cams = T[:, 1:4]
    if np.dot(cams.mean(0) - c, up) < 0:
        up = -up

    h = X @ up
    floor = float(np.percentile(h, 1.5))
    ceil = float(np.percentile(h, 99.0))
    cam_above = float(np.median((cams - c) @ up) - floor)   # camera height in SLAM units
    if ceiling_ft > 0:                                       # tape-measured ceiling = ruler
        fpu = ceiling_ft / max(ceil - floor, 1e-6)
        anchor = f"ceiling {ceiling_ft}ft"
    else:
        fpu = flight_ft / max(cam_above, 1e-6)
        anchor = f"flight {flight_ft}ft"

    a = np.array([1.0, 0, 0]) if abs(up[0]) < 0.9 else np.array([0, 1.0, 0])
    e1 = np.cross(up, a); e1 /= np.linalg.norm(e1)
    e2 = np.cross(up, e1)
    px = X @ e1; py = X @ e2
    lo1, hi1 = np.percentile(px, [1, 99]); lo2, hi2 = np.percentile(py, [1, 99])
    room_w = (hi1 - lo1) * fpu; room_l = (hi2 - lo2) * fpu
    ceil_ft = (ceil - floor) * fpu

    gw = min(1400, int((hi1 - lo1) * pxm) + 1)
    gh = min(1400, int((hi2 - lo2) * pxm) + 1)
    ix = np.clip(((px - lo1) / (hi1 - lo1) * (gw - 1)), 0, gw - 1).astype(np.int64)
    iy = np.clip(((py - lo2) / (hi2 - lo2) * (gh - 1)), 0, gh - 1).astype(np.int64)
    idx = iy * gw + ix
    mn = np.full(gw * gh, 1e9, np.float32); mx = np.full(gw * gh, -1e9, np.float32)
    np.minimum.at(mn, idx, h.astype("f4")); np.maximum.at(mx, idx, h.astype("f4"))
    span = (mx - mn).reshape(gh, gw); span[mx.reshape(gh, gw) < -1e8] = 0
    wall = ((span > wall_frac * (ceil - floor)) * 255).astype(np.uint8)
    cv2.imwrite("/tmp/walls.png", wall)
    s3.upload_file("/tmp/walls.png", R2_BUCKET, f"plan-walls/{slug}.png")

    # Compose the Studio plan: ortho = traceable base, room dims = the coordinate
    # space (plan units ARE feet), zones empty for the operator to trace + name →
    # every traced room reads out in real feet.
    import json

    ortho_url = f"https://media.lvxhomes.com/ortho/{slug}.jpg"
    plan = {
        "tourSlug": slug,
        "sheets": [{
            "id": "floor-1",
            "label": slug.replace("-", " ").title(),
            "kind": "floor",
            "width": round(float(room_w), 1),
            "height": round(float(room_l), 1),
            "zones": [],
            "satUrl": ortho_url,
        }],
    }
    with open("/tmp/plan.json", "w") as f:
        json.dump(plan, f)
    s3.upload_file("/tmp/plan.json", R2_BUCKET, f"plans/{slug}.plan.json")

    out = {
        "anchor": anchor,
        "feet_per_unit": round(float(fpu), 4),
        "room_w_ft": round(float(room_w), 1),
        "room_l_ft": round(float(room_l), 1),
        "ceiling_ft": round(float((ceil - floor) * fpu), 1),
        "flight_ft_crosscheck": round(float(cam_above * fpu), 2),
        "walls": f"plan-walls/{slug}.png",
        "plan": f"plans/{slug}.plan.json",
        "ortho_url": ortho_url,
    }
    print("[dims]", out)
    return out


def _read_ply_xyzrgb(path):
    """Read x,y,z (+ red,green,blue if present) from a PLY → (xyz f32, rgb u8|None)."""
    import numpy as np

    with open(path, "rb") as f:
        if f.readline().strip() != b"ply":
            raise ValueError("not a PLY")
        fmt, n, props, hlen = b"", 0, [], 1
        while True:
            ln = f.readline(); hlen += 1
            if not ln or ln.strip() == b"end_header":
                break
            t = ln.split()
            if t[0] == b"format":
                fmt = t[1]
            elif t[0] == b"element" and t[1] == b"vertex":
                n = int(t[2])
            elif t[0] == b"property" and len(t) >= 3:
                props.append((t[2].decode(), t[1].decode()))
        tymap = {"float": "<f4", "float32": "<f4", "double": "<f8", "uchar": "u1",
                 "uint8": "u1", "int": "<i4", "uint": "<u4", "short": "<i2", "ushort": "<u2"}
        names = [p[0] for p in props]

        def find_rgb(getter):
            for trip in (("red", "green", "blue"), ("r", "g", "b"), ("diffuse_red", "diffuse_green", "diffuse_blue")):
                if all(k in names for k in trip):
                    return np.stack([getter(k) for k in trip], 1).astype("u1")
            return None

        if fmt == b"ascii":
            arr = np.loadtxt(path, skiprows=hlen)
            xyz = arr[:, [names.index("x"), names.index("y"), names.index("z")]].astype("f4")
            rgb = find_rgb(lambda k: arr[:, names.index(k)])
            return xyz, rgb
        dt = np.dtype([(nm, tymap.get(ty, "<f4")) for nm, ty in props])
        d = np.frombuffer(f.read(n * dt.itemsize), dtype=dt, count=n)
        xyz = np.stack([d["x"], d["y"], d["z"]], 1).astype("f4")
        rgb = find_rgb(lambda k: d[k])
        return xyz, rgb


@app.function(image=ortho_image, secrets=[r2_secret], volumes={"/scratch": vol}, timeout=1800)
def make_topdown(slug: str, ceiling_ft: float = 9.0, pxm: float = 70.0,
                 ceil_cut: float = 0.86, splat: int = 2) -> dict:
    """The RIGHT top-down: orthographic z-buffer render of the dense COLORED cloud
    from straight above, ceiling sliced off. Every surface sits at its true (x,y),
    so no parallax ghosting; the cloud covers the whole room, so no coverage lobes.
    A still 'from the floor above'. Overwrites ortho/{slug}.jpg (the plan's base)."""
    import os
    import numpy as np
    import cv2

    s3 = _r2()
    sd = f"/scratch/{slug}"
    ply = f"{sd}/{slug}.ply"
    if not os.path.exists(ply):
        ply = "/tmp/c.ply"; s3.download_file(R2_BUCKET, f"vslam/{slug}/{slug}.ply", ply)
    xyz, rgb = _read_ply_xyzrgb(ply)
    if rgb is None:
        raise RuntimeError("dense cloud has no per-point color")

    c = xyz.mean(0); X = xyz - c
    _, _, Vt = np.linalg.svd(X[::41], full_matrices=False)
    up = Vt[2].astype("f4")
    traj = f"{sd}/frame_trajectory.txt"
    if not os.path.exists(traj):
        traj = f"{sd}/keyframe_trajectory.txt"
    if os.path.exists(traj):
        T = np.loadtxt(traj); cams = T[:, 1:4] if T.ndim > 1 else T[None, 1:4]
        if np.dot(cams.mean(0) - c, up) < 0:
            up = -up

    h = X @ up
    floor = float(np.percentile(h, 1.5)); ceil = float(np.percentile(h, 99))
    cut = floor + ceil_cut * (ceil - floor)   # slice off the ceiling
    a = np.array([1.0, 0, 0]) if abs(up[0]) < 0.9 else np.array([0, 1.0, 0])
    e1 = np.cross(up, a); e1 /= np.linalg.norm(e1)
    e2 = np.cross(up, e1)
    px = X @ e1; py = X @ e2
    lo1, hi1 = np.percentile(px, [0.5, 99.5]); lo2, hi2 = np.percentile(py, [0.5, 99.5])
    W = min(1600, int((hi1 - lo1) * pxm) + 1)
    H = min(1600, int((hi2 - lo2) * pxm) + 1)

    keep = (h < cut) & (px >= lo1) & (px <= hi1) & (py >= lo2) & (py <= hi2)
    pxk, pyk, hk, col = px[keep], py[keep], h[keep], rgb[keep]
    ix = np.clip(((pxk - lo1) / (hi1 - lo1) * (W - 1)), 0, W - 1).astype(np.int64)
    iy = np.clip(((pyk - lo2) / (hi2 - lo2) * (H - 1)), 0, H - 1).astype(np.int64)
    cell = iy * W + ix
    # z-buffer: per cell keep the color of the HIGHEST point (top surface seen from above)
    order = np.lexsort((hk, cell))
    cs = cell[order]; cols = col[order]
    last = np.ones(len(cs), bool)
    if len(cs) > 1:
        last[:-1] = cs[1:] != cs[:-1]
    cells_f = cs[last]; cols_f = cols[last]

    flat = np.zeros((H * W, 3), np.uint8)
    hit = np.zeros(H * W, bool)
    flat[cells_f] = cols_f; hit[cells_f] = True
    img = flat.reshape(H, W, 3); hitm = hit.reshape(H, W)
    # --- clean: trim stray specks, fill interior holes, denoise ---
    fm = hit.reshape(H, W).astype(np.uint8)
    n_lab, lab = cv2.connectedComponents(fm, connectivity=8)
    if n_lab > 2:
        sizes = np.bincount(lab.ravel()); sizes[0] = 0
        big = int(sizes.argmax())
        stray = (lab != big) & (lab != 0)
        img[stray] = 0; fm[stray] = 0
    # building OUTLINE: solid-fill the captured region, inpaint EVERY interior gap (under-
    # furniture, briefly-seen) from real neighbours → a complete orthophoto. Periphery stays black.
    cm = cv2.morphologyEx(fm * 255, cv2.MORPH_CLOSE, np.ones((31, 31), np.uint8))
    cnts, _ = cv2.findContours(cm, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    outline = np.zeros((H, W), np.uint8)
    if cnts:
        cv2.drawContours(outline, [max(cnts, key=cv2.contourArea)], -1, 255, -1)
    valid = outline
    holes = ((valid > 0) & (fm == 0)).astype(np.uint8)
    img = cv2.inpaint(img, holes, 6, cv2.INPAINT_NS)
    img[valid == 0] = 0
    img = cv2.medianBlur(img, 3)
    img = cv2.addWeighted(img, 1.35, cv2.GaussianBlur(img, (0, 0), 1.2), -0.35, 0)  # gentle sharpen
    img[valid == 0] = 0
    hitm = valid > 0

    out = "/tmp/topdown.jpg"
    cv2.imwrite(out, cv2.cvtColor(img, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, 92])
    s3.upload_file(out, R2_BUCKET, f"ortho/{slug}.jpg")
    print(f"[topdown] {slug}: {W}x{H} ({int(hitm.mean() * 100)}% filled, {int(keep.sum())} pts below cut) -> R2 ortho/{slug}.jpg")
    return {"px": [W, H], "filled": int(hitm.mean() * 100), "ortho": f"ortho/{slug}.jpg"}


@app.function(image=ortho_image, secrets=[r2_secret], volumes={"/scratch": vol}, timeout=1800)
def make_walls(slug: str, ceiling_ft: float = 9.0, pxm: float = 60.0) -> dict:
    """Detect WALLS from the cloud → clean line floorplan. A cell is a wall where the
    cloud has points in BOTH a low band and a high band (i.e. a surface that runs
    floor→ceiling). Exterior outline from occupancy; interior walls via Hough. Feet via
    ceiling calibration. Renders a preview to review BEFORE wiring strokes into the editor."""
    import os
    import numpy as np
    import cv2

    s3 = _r2(); sd = f"/scratch/{slug}"
    ply = f"{sd}/{slug}.ply"
    if not os.path.exists(ply):
        ply = "/tmp/c.ply"; s3.download_file(R2_BUCKET, f"vslam/{slug}/{slug}.ply", ply)
    xyz, _ = _read_ply_xyzrgb(ply)

    c = xyz.mean(0); X = xyz - c
    _, _, Vt = np.linalg.svd(X[::41], full_matrices=False); up = Vt[2].astype("f4")
    traj = f"{sd}/frame_trajectory.txt"
    if not os.path.exists(traj):
        traj = f"{sd}/keyframe_trajectory.txt"
    if os.path.exists(traj):
        T = np.loadtxt(traj); cams = T[:, 1:4] if T.ndim > 1 else T[None, 1:4]
        if np.dot(cams.mean(0) - c, up) < 0:
            up = -up

    h = X @ up
    floor = float(np.percentile(h, 1.5)); ceil = float(np.percentile(h, 99))
    room = ceil - floor
    fpu = ceiling_ft / room if ceiling_ft > 0 and room > 0 else 1.0
    a = np.array([1.0, 0, 0]) if abs(up[0]) < 0.9 else np.array([0, 1.0, 0])
    e1 = np.cross(up, a); e1 /= np.linalg.norm(e1); e2 = np.cross(up, e1)
    px = X @ e1; py = X @ e2
    lo1, hi1 = np.percentile(px, [0.5, 99.5]); lo2, hi2 = np.percentile(py, [0.5, 99.5])
    W = min(1400, int((hi1 - lo1) * pxm) + 1); H = min(1400, int((hi2 - lo2) * pxm) + 1)
    hn = (h - floor) / room
    inb = (px >= lo1) & (px <= hi1) & (py >= lo2) & (py <= hi2)
    ix = np.clip(((px - lo1) / (hi1 - lo1) * (W - 1)), 0, W - 1).astype(np.int64)
    iy = np.clip(((py - lo2) / (hi2 - lo2) * (H - 1)), 0, H - 1).astype(np.int64)
    cell = iy * W + ix

    def bandmask(a0, a1):
        m = inb & (hn >= a0) & (hn < a1)
        g = np.zeros(H * W, bool); g[cell[m]] = True
        return g.reshape(H, W)

    lo_m = bandmask(0.12, 0.42); hi_m = bandmask(0.60, 0.92)
    occ = np.zeros(H * W, bool); occ[cell[inb]] = True; occ = occ.reshape(H, W)
    wall = (lo_m & hi_m).astype(np.uint8) * 255            # full-height cells = walls
    wall = cv2.morphologyEx(wall, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    wall = cv2.morphologyEx(wall, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    n, lab, stats, _ = cv2.connectedComponentsWithStats((wall > 0).astype(np.uint8), 8)
    for i in range(1, n):
        if stats[i, cv2.CC_STAT_AREA] < (0.4 * pxm) ** 2:  # drop blobs < ~0.4ft
            wall[lab == i] = 0

    occu = cv2.morphologyEx(occ.astype(np.uint8) * 255, cv2.MORPH_CLOSE, np.ones((19, 19), np.uint8))
    cnts, _ = cv2.findContours(occu, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    prev = np.full((H, W, 3), 248, np.uint8)
    poly = None
    if cnts:
        big = max(cnts, key=cv2.contourArea)
        poly = cv2.approxPolyDP(big, 0.008 * cv2.arcLength(big, True), True)
        cv2.polylines(prev, [poly], True, (40, 40, 45), 4)
    inner = cv2.erode(occu, np.ones((int(0.5 * pxm), int(0.5 * pxm)), np.uint8))
    interior = cv2.bitwise_and(wall, inner)
    lines = cv2.HoughLinesP(interior, 1, np.pi / 180, threshold=int(0.6 * pxm),
                            minLineLength=int(1.5 * pxm), maxLineGap=int(0.6 * pxm))
    nseg = 0
    if lines is not None:
        nseg = len(lines)
        for l in lines[:, 0, :]:
            cv2.line(prev, (l[0], l[1]), (l[2], l[3]), (70, 100, 175), 3)

    cv2.imwrite("/tmp/walls.jpg", prev, [cv2.IMWRITE_JPEG_QUALITY, 94])
    s3.upload_file("/tmp/walls.jpg", R2_BUCKET, f"plan-walls/{slug}.preview.jpg")
    ftw = round(float((hi1 - lo1) * fpu), 1); fth = round(float((hi2 - lo2) * fpu), 1)
    print(f"[walls] {slug}: {W}x{H}, outline={'Y' if poly is not None else 'N'}"
          f"({0 if poly is None else len(poly)}pts), {nseg} interior segs, {ftw}x{fth}ft")
    return {"px": [W, H], "outline_pts": 0 if poly is None else int(len(poly)),
            "interior_segs": int(nseg), "ft": [ftw, fth],
            "preview": f"plan-walls/{slug}.preview.jpg"}


@app.function(image=ortho_image, secrets=[r2_secret], volumes={"/scratch": vol}, timeout=900)
def make_path(slug: str, ceiling_ft: float = 9.0, pxm: float = 60.0, rooms: str = "") -> dict:
    """Trace the drone PATH (VSLAM trajectory) top-down over the footprint outline:
    green->red by time, start/end marked, dwell stops detected and labeled in the given
    room sequence. `rooms` = comma-separated room names, in flight order."""
    import os
    import numpy as np
    import cv2

    s3 = _r2(); sd = f"/scratch/{slug}"
    ply = f"{sd}/{slug}.ply"
    if not os.path.exists(ply):
        ply = "/tmp/c.ply"; s3.download_file(R2_BUCKET, f"vslam/{slug}/{slug}.ply", ply)
    xyz, _ = _read_ply_xyzrgb(ply)
    traj = f"{sd}/frame_trajectory.txt"
    if not os.path.exists(traj):
        traj = f"{sd}/keyframe_trajectory.txt"
    T = np.loadtxt(traj)
    cams = T[:, 1:4] if T.ndim > 1 else T[None, 1:4]    # tx ty tz, time order

    c = xyz.mean(0); X = xyz - c
    _, _, Vt = np.linalg.svd(X[::41], full_matrices=False); up = Vt[2].astype("f4")
    if np.dot(cams.mean(0) - c, up) < 0:
        up = -up
    a = np.array([1.0, 0, 0]) if abs(up[0]) < 0.9 else np.array([0, 1.0, 0])
    e1 = np.cross(up, a); e1 /= np.linalg.norm(e1); e2 = np.cross(up, e1)
    px = X @ e1; py = X @ e2
    lo1, hi1 = np.percentile(px, [0.5, 99.5]); lo2, hi2 = np.percentile(py, [0.5, 99.5])
    W = min(1400, int((hi1 - lo1) * pxm) + 1); H = min(1400, int((hi2 - lo2) * pxm) + 1)

    inb = (px >= lo1) & (px <= hi1) & (py >= lo2) & (py <= hi2)
    ix = np.clip(((px - lo1) / (hi1 - lo1) * (W - 1)), 0, W - 1).astype(int)[inb]
    iy = np.clip(((py - lo2) / (hi2 - lo2) * (H - 1)), 0, H - 1).astype(int)[inb]
    occ = np.zeros((H, W), np.uint8); occ[iy, ix] = 255
    occ = cv2.morphologyEx(occ, cv2.MORPH_CLOSE, np.ones((19, 19), np.uint8))
    cnts, _ = cv2.findContours(occ, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    prev = np.full((H, W, 3), 250, np.uint8)
    if cnts:
        big = max(cnts, key=cv2.contourArea)
        poly = cv2.approxPolyDP(big, 0.008 * cv2.arcLength(big, True), True)
        cv2.polylines(prev, [poly], True, (205, 205, 210), 3)

    Pc = cams - c
    a1 = (Pc @ e1 - lo1) / (hi1 - lo1) * (W - 1)
    a2 = (Pc @ e2 - lo2) / (hi2 - lo2) * (H - 1)
    pxs = np.clip(a1, 0, W - 1).astype(int); pys = np.clip(a2, 0, H - 1).astype(int)
    n = len(pxs)
    for i in range(1, n):
        t = i / n
        col = (40, int(210 * (1 - t) + 20), int(210 * t + 20))   # BGR: green -> red
        cv2.line(prev, (pxs[i - 1], pys[i - 1]), (pxs[i], pys[i]), col, 3, cv2.LINE_AA)
    cv2.circle(prev, (int(pxs[0]), int(pys[0])), 11, (70, 190, 70), -1)
    cv2.circle(prev, (int(pxs[-1]), int(pys[-1])), 11, (60, 60, 230), -1)

    d = np.r_[0.0, np.hypot(np.diff(pxs.astype(float)), np.diff(pys.astype(float)))]
    spd = np.convolve(d, np.ones(15) / 15, mode="same")
    slow = spd < (np.median(spd) * 0.5 + 1e-6)
    stops = []
    i = 0
    while i < n:
        if slow[i]:
            j = i
            while j < n and slow[j]:
                j += 1
            if j - i > 18:
                stops.append((int(np.mean(pxs[i:j])), int(np.mean(pys[i:j]))))
            i = j
        else:
            i += 1
    labels = [r.strip() for r in rooms.split(",") if r.strip()]
    for k, (cx, cy) in enumerate(stops):
        cv2.circle(prev, (cx, cy), 6, (30, 30, 30), -1)
        if k < len(labels):                       # only label when names are given
            cv2.putText(prev, labels[k], (cx + 10, cy + 5), cv2.FONT_HERSHEY_SIMPLEX, 0.62,
                        (255, 255, 255), 4, cv2.LINE_AA)
            cv2.putText(prev, labels[k], (cx + 10, cy + 5), cv2.FONT_HERSHEY_SIMPLEX, 0.62,
                        (25, 25, 30), 2, cv2.LINE_AA)

    cv2.imwrite("/tmp/path.jpg", prev, [cv2.IMWRITE_JPEG_QUALITY, 94])
    s3.upload_file("/tmp/path.jpg", R2_BUCKET, f"plan-walls/{slug}.path.jpg")
    print(f"[path] {slug}: {n} poses, {len(stops)} dwell stops, {len(labels)} labels")
    return {"poses": int(n), "stops": len(stops), "labels": len(labels),
            "preview": f"plan-walls/{slug}.path.jpg"}


@app.function(image=ortho_image, secrets=[r2_secret], volumes={"/scratch": vol}, timeout=1800)
def make_overlay(slug: str, ceiling_ft: float = 9.0, pxm: float = 60.0,
                 ceil_cut: float = 0.86, dim: float = 0.82) -> dict:
    """The flat top-down PHOTO (colored cloud z-buffer) with the drone PATH drawn on top —
    same basis/extent so they register exactly. The visual + the journey in one image to
    break rooms up from. -> plan-walls/{slug}.overlay.jpg"""
    import os
    import numpy as np
    import cv2

    s3 = _r2(); sd = f"/scratch/{slug}"
    ply = f"{sd}/{slug}.ply"
    if not os.path.exists(ply):
        ply = "/tmp/c.ply"; s3.download_file(R2_BUCKET, f"vslam/{slug}/{slug}.ply", ply)
    xyz, rgb = _read_ply_xyzrgb(ply)
    if rgb is None:
        raise RuntimeError("dense cloud has no per-point color")
    traj = f"{sd}/frame_trajectory.txt"
    if not os.path.exists(traj):
        traj = f"{sd}/keyframe_trajectory.txt"
    T = np.loadtxt(traj); cams = T[:, 1:4] if T.ndim > 1 else T[None, 1:4]

    c = xyz.mean(0); X = xyz - c
    _, _, Vt = np.linalg.svd(X[::41], full_matrices=False); up = Vt[2].astype("f4")
    if np.dot(cams.mean(0) - c, up) < 0:
        up = -up
    hgt = X @ up
    floor = float(np.percentile(hgt, 1.5)); ceil = float(np.percentile(hgt, 99))
    cut = floor + ceil_cut * (ceil - floor)
    a = np.array([1.0, 0, 0]) if abs(up[0]) < 0.9 else np.array([0, 1.0, 0])
    e1 = np.cross(up, a); e1 /= np.linalg.norm(e1); e2 = np.cross(up, e1)
    px = X @ e1; py = X @ e2
    lo1, hi1 = np.percentile(px, [0.5, 99.5]); lo2, hi2 = np.percentile(py, [0.5, 99.5])
    W = min(1600, int((hi1 - lo1) * pxm) + 1); H = min(1600, int((hi2 - lo2) * pxm) + 1)

    # --- top-down z-buffer photo (max-height color per cell, ceiling sliced) ---
    keep = (hgt < cut) & (px >= lo1) & (px <= hi1) & (py >= lo2) & (py <= hi2)
    pxk, pyk, hk, col = px[keep], py[keep], hgt[keep], rgb[keep]
    ix = np.clip(((pxk - lo1) / (hi1 - lo1) * (W - 1)), 0, W - 1).astype(np.int64)
    iy = np.clip(((pyk - lo2) / (hi2 - lo2) * (H - 1)), 0, H - 1).astype(np.int64)
    cell = iy * W + ix
    order = np.lexsort((hk, cell))
    cs = cell[order]; cols = col[order]
    last = np.ones(len(cs), bool)
    if len(cs) > 1:
        last[:-1] = cs[1:] != cs[:-1]
    flat = np.zeros((H * W, 3), np.uint8); hit = np.zeros(H * W, bool)
    flat[cs[last]] = cols[last]; hit[cs[last]] = True
    img = flat.reshape(H, W, 3); fm = hit.reshape(H, W).astype(np.uint8)
    n_lab, lab = cv2.connectedComponents(fm, 8)
    if n_lab > 2:
        sizes = np.bincount(lab.ravel()); sizes[0] = 0
        big = int(sizes.argmax()); stray = (lab != big) & (lab != 0)
        img[stray] = 0; fm[stray] = 0
    valid = cv2.morphologyEx(fm * 255, cv2.MORPH_CLOSE, np.ones((25, 25), np.uint8))
    holes = ((valid > 0) & (fm == 0)).astype(np.uint8)
    img = cv2.inpaint(img, holes, 4, cv2.INPAINT_TELEA)
    img[valid == 0] = 0
    img = cv2.medianBlur(img, 3)
    img = cv2.cvtColor(img, cv2.COLOR_RGB2BGR)
    img = (img * dim).astype(np.uint8)                    # dim so the path pops

    # --- drone path on top ---
    Pc = cams - c
    a1 = (Pc @ e1 - lo1) / (hi1 - lo1) * (W - 1)
    a2 = (Pc @ e2 - lo2) / (hi2 - lo2) * (H - 1)
    pxs = np.clip(a1, 0, W - 1).astype(int); pys = np.clip(a2, 0, H - 1).astype(int)
    n = len(pxs)
    for i in range(1, n):
        t = i / n
        colr = (45, int(225 * (1 - t) + 20), int(225 * t + 20))    # BGR green->red
        cv2.line(img, (pxs[i - 1], pys[i - 1]), (pxs[i], pys[i]), colr, 3, cv2.LINE_AA)
    cv2.circle(img, (int(pxs[0]), int(pys[0])), 11, (90, 210, 90), -1)
    cv2.circle(img, (int(pxs[-1]), int(pys[-1])), 11, (60, 60, 240), -1)

    cv2.imwrite("/tmp/overlay.jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 92])
    s3.upload_file("/tmp/overlay.jpg", R2_BUCKET, f"plan-walls/{slug}.overlay.jpg")
    print(f"[overlay] {slug}: {W}x{H}, photo+path, {n} poses, "
          f"{int((valid > 0).mean() * 100)}% photo -> R2 plan-walls/{slug}.overlay.jpg")
    return {"px": [W, H], "poses": int(n), "preview": f"plan-walls/{slug}.overlay.jpg"}


@app.function(image=ortho_image, secrets=[r2_secret], timeout=2400)
def stitch_stills(slug: str, keys_csv: str, ceiling_ft: float = 9.0) -> dict:
    """Orthomosaic from dedicated nadir STILLS — the real top-down path. Feature-match
    + blend overlapping perspective stills via OpenCV's scan-mode stitcher (affine,
    flat-scene) → one clean top-down image. `keys_csv` = comma-separated R2 keys of the
    uploaded stills. Scale/registration to the VSLAM frame is the follow-up; this proves
    the mosaic. Sharpens automatically as the stills get better (overlap/altitude)."""
    import os
    import cv2

    s3 = _r2()
    keys = [k.strip() for k in keys_csv.split(",") if k.strip()]
    imgs = []
    for k in keys:
        p = f"/tmp/{os.path.basename(k)}"
        try:
            s3.download_file(R2_BUCKET, k, p)
            im = cv2.imread(p)
            if im is not None:
                imgs.append(im)
        except Exception as e:
            print(f"[stitch] skip {k}: {e}")
    if len(imgs) < 2:
        return {"error": f"need >=2 stills, got {len(imgs)}"}
    st = cv2.Stitcher_create(cv2.Stitcher_SCANS)   # affine / flat-scene mode for nadir
    status, pano = st.stitch(imgs)
    if status != cv2.Stitcher_OK:
        return {"error": f"stitch failed (status {status}) — needs more overlap", "n": len(imgs)}
    out = "/tmp/stitch.jpg"
    cv2.imwrite(out, pano, [cv2.IMWRITE_JPEG_QUALITY, 92])
    key = f"ortho/{slug}.stitch.jpg"
    s3.upload_file(out, R2_BUCKET, key)
    print(f"[stitch] {slug}: {len(imgs)} stills -> {pano.shape[1]}x{pano.shape[0]} -> R2 {key}")
    return {"ortho": key, "px": [int(pano.shape[1]), int(pano.shape[0])], "stills": len(imgs)}


@app.function(image=ortho_image, secrets=[r2_secret], volumes={"/scratch": vol}, timeout=900)
def add_walls(slug: str, ceiling_ft: float = 9.0, pxm: float = 60.0) -> dict:
    """Detect walls from the cloud and MERGE them into {slug}'s plan as editable
    stroke lines — the structure the nadir photo can't show (exterior/back walls +
    interior dividers). Uses the SAME [1,99] frame + ceiling scale as make_ortho, so
    the lines register exactly on the photo. Cloud-only (no video) → fast."""
    import os
    import json
    import numpy as np
    import cv2

    s3 = _r2(); sd = f"/scratch/{slug}"
    ply = f"{sd}/{slug}.ply"
    if not os.path.exists(ply):
        ply = "/tmp/c.ply"; s3.download_file(R2_BUCKET, f"vslam/{slug}/{slug}.ply", ply)
    xyz, _ = _read_ply_xyzrgb(ply)

    c = xyz.mean(0); X = xyz - c
    _, _, Vt = np.linalg.svd(X[::41], full_matrices=False); up = Vt[2].astype("f4")
    traj = f"{sd}/frame_trajectory.txt"
    if not os.path.exists(traj):
        traj = f"{sd}/keyframe_trajectory.txt"
    if os.path.exists(traj):
        T = np.loadtxt(traj); cams = T[:, 1:4] if T.ndim > 1 else T[None, 1:4]
        if np.dot(cams.mean(0) - c, up) < 0:
            up = -up
    a = np.array([1.0, 0, 0]) if abs(up[0]) < 0.9 else np.array([0, 1.0, 0])
    e1 = np.cross(up, a); e1 /= np.linalg.norm(e1); e2 = np.cross(up, e1)
    px = X @ e1; py = X @ e2; h = X @ up
    lo1, hi1 = np.percentile(px, [1, 99]); lo2, hi2 = np.percentile(py, [1, 99])   # MATCH make_ortho
    floor = float(np.percentile(h, 1.5)); ceil = float(np.percentile(h, 99)); room = ceil - floor
    fpu = ceiling_ft / room if room > 0 else 1.0
    ftw = (hi1 - lo1) * fpu; fth = (hi2 - lo2) * fpu
    W = min(1400, int((hi1 - lo1) * pxm) + 1); H = min(1400, int((hi2 - lo2) * pxm) + 1)
    hn = (h - floor) / room
    inb = (px >= lo1) & (px <= hi1) & (py >= lo2) & (py <= hi2)
    ix = np.clip(((px - lo1) / (hi1 - lo1) * (W - 1)), 0, W - 1).astype(np.int64)
    iy = np.clip(((py - lo2) / (hi2 - lo2) * (H - 1)), 0, H - 1).astype(np.int64)
    cell = iy * W + ix

    def bandmask(a0, a1):
        m = inb & (hn >= a0) & (hn < a1)
        g = np.zeros(H * W, bool); g[cell[m]] = True
        return g.reshape(H, W)

    wall = ((bandmask(0.12, 0.42) & bandmask(0.60, 0.92)).astype(np.uint8) * 255)  # full-height = wall
    wall = cv2.morphologyEx(wall, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    wall = cv2.morphologyEx(wall, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    nlab, lab, stats, _ = cv2.connectedComponentsWithStats((wall > 0).astype(np.uint8), 8)
    for i in range(1, nlab):
        if stats[i, cv2.CC_STAT_AREA] < (0.4 * pxm) ** 2:
            wall[lab == i] = 0
    occ = np.zeros(H * W, bool); occ[cell[inb]] = True
    occu = cv2.morphologyEx(occ.reshape(H, W).astype(np.uint8) * 255, cv2.MORPH_CLOSE, np.ones((19, 19), np.uint8))
    occu = cv2.morphologyEx(occu, cv2.MORPH_OPEN, np.ones((9, 9), np.uint8))   # drop thin spikes/noise

    def to_ft(xp, yp):
        return [round(float(xp / (W - 1) * ftw), 2), round(float(yp / (H - 1) * fth), 2)]

    strokes = []
    cnts, _ = cv2.findContours(occu, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if cnts:
        big = max(cnts, key=cv2.contourArea)
        poly = cv2.approxPolyDP(big, 0.012 * cv2.arcLength(big, True), True).reshape(-1, 2)  # cleaner outline
        outline = [to_ft(p[0], p[1]) for p in poly]
        outline.append(outline[0])
        strokes.append(outline)                       # exterior / back walls
    inner = cv2.erode(occu, np.ones((int(0.5 * pxm), int(0.5 * pxm)), np.uint8))
    lines = cv2.HoughLinesP(cv2.bitwise_and(wall, inner), 1, np.pi / 180,
                            threshold=int(0.7 * pxm), minLineLength=int(2.0 * pxm), maxLineGap=int(0.5 * pxm))
    if lines is not None:
        segs = lines[:, 0, :].astype(np.float64)
        angs = np.degrees(np.arctan2(segs[:, 3] - segs[:, 1], segs[:, 2] - segs[:, 0])) % 180.0
        hist, edges = np.histogram(angs, bins=18, range=(0, 180))
        theta = float(edges[int(np.argmax(hist))]) + 5.0          # dominant wall axis (deg)
        kept = []
        for (x1, y1, x2, y2), a in zip(segs, angs):
            length = float(np.hypot(x2 - x1, y2 - y1))
            d0 = min((a - theta) % 180, (theta - a) % 180)
            d1 = min((a - theta - 90) % 180, (theta + 90 - a) % 180)
            if min(d0, d1) < 18.0:                                 # snap near-axis walls clean
                rad = np.radians(theta if d0 < d1 else theta + 90.0)
                mx, my = (x1 + x2) / 2, (y1 + y2) / 2
                dx, dy = np.cos(rad) * length / 2, np.sin(rad) * length / 2
                p1, p2 = (mx - dx, my - dy), (mx + dx, my + dy)
            else:
                p1, p2 = (x1, y1), (x2, y2)
            kept.append((length, [to_ft(p1[0], p1[1]), to_ft(p2[0], p2[1])]))
        kept.sort(key=lambda t: -t[0])
        for _, seg in kept[:22]:                                  # significant dividers, snapped
            strokes.append(seg)

    pk = f"plans/{slug}.plan.json"
    plan = json.loads(s3.get_object(Bucket=R2_BUCKET, Key=pk)["Body"].read())
    plan["sheets"][0]["strokes"] = strokes
    s3.put_object(Bucket=R2_BUCKET, Key=pk, Body=json.dumps(plan).encode(), ContentType="application/json")
    print(f"[walls] {slug}: outline {len(strokes[0]) if strokes else 0}pts + {max(0, len(strokes) - 1)} interior segs -> merged into {pk}")
    return {"strokes": len(strokes), "ft": [round(ftw, 1), round(fth, 1)]}


@app.function(image=ortho_image, secrets=[r2_secret], volumes={"/scratch": vol}, timeout=3600)
def make_render(slug: str, video_key: str, ceiling_ft: float = 9.0, pxm: float = 48.0,
                ceil_cut: float = 0.9, yflip: int = 1, lonsign: int = 1, kf_step: int = 1) -> dict:
    """DEPTH-AWARE top-down — the realistic flat photo. Build the 3D surface (z-buffer of
    the cloud), then color each cell by sampling the frame that saw THAT 3D point most
    head-on (normal-weighted best view). Uses the full hemisphere of every frame and
    projects to true depth, so no flat-plane smear and no coverage gaps. Cloud geometry
    + real frame imaging, fused. Production replacement for make_ortho's flat projection."""
    import os
    import json
    import time
    import numpy as np
    import cv2

    s3 = _r2(); sd = f"/scratch/{slug}"
    ply = f"{sd}/{slug}.ply"
    if not os.path.exists(ply):
        ply = "/tmp/c.ply"; s3.download_file(R2_BUCKET, f"vslam/{slug}/{slug}.ply", ply)
    xyz, _ = _read_ply_xyzrgb(ply)
    traj = f"{sd}/frame_trajectory.txt"
    if not os.path.exists(traj):
        traj = f"{sd}/keyframe_trajectory.txt"
    T = np.loadtxt(traj)
    if T.ndim == 1:
        T = T[None, :]
    vid = f"{sd}/slam.mp4"
    if not os.path.exists(vid):
        vid = "/tmp/v.mp4"; s3.download_file(R2_BUCKET, video_key, vid)

    c = xyz.mean(0); X = xyz - c
    _, _, Vt = np.linalg.svd(X[::41], full_matrices=False); up = Vt[2].astype("f4")
    cams = T[:, 1:4]
    if np.dot(cams.mean(0) - c, up) < 0:
        up = -up
    a = np.array([1.0, 0, 0]) if abs(up[0]) < 0.9 else np.array([0, 1.0, 0])
    e1 = np.cross(up, a); e1 /= np.linalg.norm(e1); e2 = np.cross(up, e1)
    px = X @ e1; py = X @ e2; h = X @ up
    lo1, hi1 = np.percentile(px, [1, 99]); lo2, hi2 = np.percentile(py, [1, 99])
    floor = float(np.percentile(h, 1.5)); ceil = float(np.percentile(h, 99)); room = ceil - floor
    cut = floor + ceil_cut * room
    fpu = ceiling_ft / room if room > 0 else 1.0
    W = min(1400, int((hi1 - lo1) * pxm) + 1); H = min(1400, int((hi2 - lo2) * pxm) + 1)

    # 1. surface geometry — z-buffer the cloud to a top height per cell, then DENSIFY
    #    (interpolate the height map) so EVERY footprint cell has a true 3D surface
    #    point to sample a frame at — turns sparse-cloud speckle into full coverage.
    keep = (h < cut) & (px >= lo1) & (px <= hi1) & (py >= lo2) & (py <= hi2)
    ixk = np.clip(((px[keep] - lo1) / (hi1 - lo1) * (W - 1)), 0, W - 1).astype(np.int64)
    iyk = np.clip(((py[keep] - lo2) / (hi2 - lo2) * (H - 1)), 0, H - 1).astype(np.int64)
    hk = h[keep]; cellk = iyk * W + ixk
    order = np.lexsort((hk, cellk)); cs = cellk[order]; hs = hk[order]
    last = np.ones(len(cs), bool)
    if len(cs) > 1:
        last[:-1] = cs[1:] != cs[:-1]
    surf2d = np.full(H * W, np.nan, np.float32); surf2d[cs[last]] = hs[last]
    surf2d = surf2d.reshape(H, W)
    occ = np.zeros(H * W, bool); occ[cellk] = True
    fp = cv2.morphologyEx(occ.reshape(H, W).astype(np.uint8) * 255, cv2.MORPH_CLOSE, np.ones((11, 11), np.uint8)) > 0
    hmin = float(np.nanmin(surf2d)); hspan = float(np.nanmax(surf2d)) - hmin + 1e-6
    h8 = np.where(np.isnan(surf2d), 0, (surf2d - hmin) / hspan * 255).astype(np.uint8)
    h8 = cv2.inpaint(h8, (np.isnan(surf2d) & fp).astype(np.uint8), 7, cv2.INPAINT_TELEA)
    dense = cv2.GaussianBlur(cv2.medianBlur(h8, 5), (9, 9), 0).astype(np.float32) / 255.0 * hspan + hmin  # dense, smoothed height/cell
    iy_g, ix_g = np.mgrid[0:H, 0:W]
    plx = lo1 + ix_g / (W - 1) * (hi1 - lo1)
    ply = lo2 + iy_g / (H - 1) * (hi2 - lo2)
    P3 = (plx[..., None] * e1 + ply[..., None] * e2 + dense[..., None] * up).astype(np.float32).reshape(H * W, 3)
    gy, gx = np.gradient(cv2.GaussianBlur(dense, (5, 5), 0))   # dense slope → per-cell normal
    cellu = (hi1 - lo1) / (W - 1)
    nx, ny, nz = -gx.ravel(), -gy.ravel(), np.full(H * W, cellu * 2.0, np.float32)
    nl = np.sqrt(nx * nx + ny * ny + nz * nz) + 1e-9
    normal3 = ((nx / nl)[:, None] * e1 + (ny / nl)[:, None] * e2 + (nz / nl)[:, None] * up).astype(np.float32)
    cell_idx = np.where(fp.ravel())[0]
    Pv = P3[cell_idx]; Nv = normal3[cell_idx]                  # dense surface points + normals

    # 2. for each frame, project the surface points, keep the most head-on sample
    cap = cv2.VideoCapture(vid)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    nfr = cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0
    Hv = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)); Wv = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    ts = T[:, 0].copy()
    if nfr and ts.max() > (nfr / fps) * 2:
        ts = ts / fps
    step = kf_step if kf_step > 1 else max(1, len(T) // 320)
    bestw = np.zeros(len(Pv), np.float32); bestc = np.zeros((len(Pv), 3), np.uint8); used = 0
    for i in range(0, len(T), step):
        C = T[i, 1:4] - c; R = _quat2rot(T[i, 4:8])
        ray = Pv - C
        dist = np.linalg.norm(ray, axis=1) + 1e-9
        head = -(np.sum(Nv * (ray / dist[:, None]), axis=1))   # camera-facing surface
        w = np.where(head > 0.02, head, 0.0).astype(np.float32)
        if not np.any(w > bestw):
            continue
        cap.set(cv2.CAP_PROP_POS_MSEC, float(ts[i]) * 1000.0)
        ok, fr = cap.read()
        if not ok:
            continue
        used += 1
        fr = cv2.cvtColor(fr, cv2.COLOR_BGR2RGB)
        rc = ray @ R
        rcn = rc / (np.linalg.norm(rc, axis=1, keepdims=True) + 1e-9)
        lon = lonsign * np.arctan2(rcn[:, 0], rcn[:, 2])
        lat = np.arcsin(np.clip(yflip * (-rcn[:, 1]), -1, 1))
        u = (((lon / (2 * np.pi)) + 0.5) * Wv).astype(np.int32) % Wv
        v = np.clip((0.5 - lat / np.pi) * Hv, 0, Hv - 1).astype(np.int32)
        col = fr[v, u]
        better = w > bestw
        bestc[better] = col[better]; bestw[better] = w[better]
    cap.release()

    img = np.zeros((H * W, 3), np.uint8); img[cell_idx] = bestc
    hit = np.zeros(H * W, bool); hit[cell_idx[bestw > 0]] = True
    img = cv2.cvtColor(img.reshape(H, W, 3), cv2.COLOR_RGB2BGR)
    fm = hit.reshape(H, W).astype(np.uint8)
    # building OUTLINE: solid-fill the colored region so EVERY interior gap (swiss-cheese,
    # under-furniture, briefly-seen) gets color-inpainted from real neighbours → a complete
    # orthophoto, not a sparse one. Only the genuine periphery (outside the outline) stays black.
    cm = cv2.morphologyEx((fm > 0).astype(np.uint8) * 255, cv2.MORPH_CLOSE, np.ones((31, 31), np.uint8))
    cnts, _ = cv2.findContours(cm, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    outline = np.zeros((H, W), np.uint8)
    if cnts:
        cv2.drawContours(outline, [max(cnts, key=cv2.contourArea)], -1, 255, -1)
    outm = outline > 0
    holes = (outm & (fm == 0)).astype(np.uint8)
    img = cv2.inpaint(img, holes, 9, cv2.INPAINT_NS)   # interpolate all interior gaps
    img[~outm] = 0
    # polish for a crisp photo look: edge-preserving denoise + unsharp mask
    img = cv2.bilateralFilter(img, 5, 45, 45)
    img = cv2.addWeighted(img, 1.55, cv2.GaussianBlur(img, (0, 0), 1.4), -0.55, 0)
    img[~outm] = 0
    hit = outm.ravel().copy()
    out = "/tmp/render.jpg"; cv2.imwrite(out, img, [cv2.IMWRITE_JPEG_QUALITY, 92])
    key = f"ortho/{slug}.jpg"; s3.upload_file(out, R2_BUCKET, key)

    # feet + flight path vector + plan (preserve any wall strokes already merged)
    ftw = round(float((hi1 - lo1) * fpu), 1); fth = round(float((hi2 - lo2) * fpu), 1)
    Pcam = cams - c
    fxs = (Pcam @ e1 - lo1) * fpu; fys = (Pcam @ e2 - lo2) * fpu
    stp = max(1, len(fxs) // 140)
    flight = [{"t": int(i), "x": round(float(fxs[i]), 2), "y": round(float(fys[i]), 2)} for i in range(0, len(fxs), stp)]
    pk = f"plans/{slug}.plan.json"
    try:
        plan = json.loads(s3.get_object(Bucket=R2_BUCKET, Key=pk)["Body"].read())
        sh = plan["sheets"][0]
    except Exception:
        plan = {"tourSlug": slug, "sheets": [{"id": "floor-1", "label": slug, "kind": "floor", "zones": []}]}
        sh = plan["sheets"][0]
    sh.update({"width": ftw, "height": fth,
               "satUrl": f"https://media.lvxhomes.com/{key}?v={int(time.time())}",
               "paths": {"flight": flight}})
    s3.put_object(Bucket=R2_BUCKET, Key=pk, Body=json.dumps(plan).encode(), ContentType="application/json")
    print(f"[render] {slug}: {W}x{H}, {used} frames, {int(hit.mean() * 100)}% colored, {ftw}x{fth}ft -> {key} + {pk}")
    return {"ortho": key, "px": [int(W), int(H)], "frames": int(used), "filled_pct": int(hit.mean() * 100),
            "ft": [ftw, fth], "flight_pts": int(len(flight))}


@app.function(image=ortho_image, secrets=[r2_secret], volumes={"/scratch": vol}, timeout=3600)
def make_fused(slug: str, video_key: str, ceiling_ft: float = 9.0, pxm: float = 48.0,
               ceil_cut: float = 0.9, yflip: int = 1, lonsign: int = 1, cone_deg: float = 60.0) -> dict:
    """FUSE nadir + depth from all the data. Per frame, sample each cell two ways:
       (a) NADIR — project the cell's floor-plane point, weight by how straight-down the
           view is (clean on the dominant flat floor);
       (b) DEPTH — project the cell's true 3D surface point, weight by how head-on
           (recovers furniture/edges without flat-plane smear).
    Best-view across ALL frames for each, then composite: nadir where it has a confident
    sample, depth fills the gaps. Cloud geometry + every 360 frame + the VSLAM pose, fused."""
    import os
    import json
    import time
    import numpy as np
    import cv2

    s3 = _r2(); sd = f"/scratch/{slug}"
    ply = f"{sd}/{slug}.ply"
    if not os.path.exists(ply):
        ply = "/tmp/c.ply"; s3.download_file(R2_BUCKET, f"vslam/{slug}/{slug}.ply", ply)
    xyz, _ = _read_ply_xyzrgb(ply)
    traj = f"{sd}/frame_trajectory.txt"
    if not os.path.exists(traj):
        traj = f"{sd}/keyframe_trajectory.txt"
    T = np.loadtxt(traj)
    if T.ndim == 1:
        T = T[None, :]
    vid = f"{sd}/slam.mp4"   # SLAM clip (working). 4K hi-res = re-encode to H.264 first (next session, #67).
    if not os.path.exists(vid):
        vid = "/tmp/v.mp4"; s3.download_file(R2_BUCKET, video_key, vid)

    c = xyz.mean(0); X = xyz - c
    _, _, Vt = np.linalg.svd(X[::41], full_matrices=False); up = Vt[2].astype("f4")
    cams = T[:, 1:4]
    if np.dot(cams.mean(0) - c, up) < 0:
        up = -up
    a = np.array([1.0, 0, 0]) if abs(up[0]) < 0.9 else np.array([0, 1.0, 0])
    e1 = np.cross(up, a); e1 /= np.linalg.norm(e1); e2 = np.cross(up, e1)
    pxa = X @ e1; pya = X @ e2; hgt = X @ up
    lo1, hi1 = np.percentile(pxa, [1, 99]); lo2, hi2 = np.percentile(pya, [1, 99])
    floor = float(np.percentile(hgt, 1.5)); ceil = float(np.percentile(hgt, 99)); room = ceil - floor
    cut = floor + ceil_cut * room
    fpu = ceiling_ft / room if room > 0 else 1.0
    W = min(1800, int((hi1 - lo1) * pxm) + 1); H = min(1800, int((hi2 - lo2) * pxm) + 1)

    # densified surface (dense top height per cell) + footprint
    keep = (hgt < cut) & (pxa >= lo1) & (pxa <= hi1) & (pya >= lo2) & (pya <= hi2)
    ixk = np.clip(((pxa[keep] - lo1) / (hi1 - lo1) * (W - 1)), 0, W - 1).astype(np.int64)
    iyk = np.clip(((pya[keep] - lo2) / (hi2 - lo2) * (H - 1)), 0, H - 1).astype(np.int64)
    hk = hgt[keep]; cellk = iyk * W + ixk
    order = np.lexsort((hk, cellk)); cssort = cellk[order]; hssort = hk[order]
    lastm = np.ones(len(cssort), bool)
    if len(cssort) > 1:
        lastm[:-1] = cssort[1:] != cssort[:-1]
    s2 = np.full(H * W, np.nan, np.float32); s2[cssort[lastm]] = hssort[lastm]; s2 = s2.reshape(H, W)
    occ = np.zeros(H * W, bool); occ[cellk] = True
    fp = cv2.morphologyEx(occ.reshape(H, W).astype(np.uint8) * 255, cv2.MORPH_CLOSE, np.ones((11, 11), np.uint8)) > 0
    hmin = float(np.nanmin(s2)); hspan = float(np.nanmax(s2)) - hmin + 1e-6
    h8 = np.where(np.isnan(s2), 0, (s2 - hmin) / hspan * 255).astype(np.uint8)
    h8 = cv2.inpaint(h8, (np.isnan(s2) & fp).astype(np.uint8), 7, cv2.INPAINT_TELEA)
    dense = cv2.GaussianBlur(cv2.medianBlur(h8, 5), (9, 9), 0).astype(np.float32) / 255.0 * hspan + hmin
    iy_g, ix_g = np.mgrid[0:H, 0:W]
    plx = lo1 + ix_g / (W - 1) * (hi1 - lo1); ply = lo2 + iy_g / (H - 1) * (hi2 - lo2)
    surfP = (plx[..., None] * e1 + ply[..., None] * e2 + dense[..., None] * up).astype(np.float32).reshape(H * W, 3)
    floorP = (plx[..., None] * e1 + ply[..., None] * e2 + floor * up).astype(np.float32).reshape(H * W, 3)
    gy, gx = np.gradient(cv2.GaussianBlur(dense, (5, 5), 0))
    cellu = (hi1 - lo1) / (W - 1)
    nx, ny, nz = -gx.ravel(), -gy.ravel(), np.full(H * W, cellu * 2.0, np.float32)
    nl = np.sqrt(nx * nx + ny * ny + nz * nz) + 1e-9
    Nrm = ((nx / nl)[:, None] * e1 + (ny / nl)[:, None] * e2 + (nz / nl)[:, None] * up).astype(np.float32)
    idx = np.where(fp.ravel())[0]
    Pd = surfP[idx]; Pn = floorP[idx]; Nv = Nrm[idx]

    cap = cv2.VideoCapture(vid)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0; nfr = cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0
    Hv = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)); Wv = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    ts = T[:, 0].copy()
    if nfr and ts.max() > (nfr / fps) * 2:
        ts = ts / fps
    step = max(1, len(T) // 360)
    cos_cone = np.cos(np.radians(cone_deg))
    dW = np.zeros(len(idx), np.float32); dC = np.zeros((len(idx), 3), np.uint8)
    nW = np.zeros(len(idx), np.float32); nC = np.zeros((len(idx), 3), np.uint8)
    used = 0

    def sample(P, C, R, fr):
        ray = P - C
        rc = ray @ R
        rcn = rc / (np.linalg.norm(rc, axis=1, keepdims=True) + 1e-9)
        lon = lonsign * np.arctan2(rcn[:, 0], rcn[:, 2])
        lat = np.arcsin(np.clip(yflip * (-rcn[:, 1]), -1, 1))
        u = (((lon / (2 * np.pi)) + 0.5) * Wv).astype(np.int32) % Wv
        v = np.clip((0.5 - lat / np.pi) * Hv, 0, Hv - 1).astype(np.int32)
        return fr[v, u], ray

    for i in range(0, len(T), step):
        C = T[i, 1:4] - c; R = _quat2rot(T[i, 4:8])
        rayd = Pd - C; dist = np.linalg.norm(rayd, axis=1) + 1e-9
        wd = np.maximum(0.0, -(np.sum(Nv * (rayd / dist[:, None]), axis=1))).astype(np.float32)
        rayn = Pn - C; dn = np.linalg.norm(rayn, axis=1) + 1e-9
        vert = -(rayn @ up) / dn
        wn = np.where(vert > cos_cone, vert, 0.0).astype(np.float32)
        if not (np.any(wd > dW) or np.any(wn > nW)):
            continue
        cap.set(cv2.CAP_PROP_POS_MSEC, float(ts[i]) * 1000.0)
        ok, fr = cap.read()
        if not ok:
            continue
        used += 1
        fr = cv2.cvtColor(fr, cv2.COLOR_BGR2RGB)
        cold, _ = sample(Pd, C, R, fr)
        coln, _ = sample(Pn, C, R, fr)
        bd = wd > dW; dC[bd] = cold[bd]; dW[bd] = wd[bd]
        bn = wn > nW; nC[bn] = coln[bn]; nW[bn] = wn[bn]
    cap.release()

    # composite: nadir base where it has a confident sample, depth fills the gaps
    out = np.zeros((len(idx), 3), np.uint8)
    hasn = nW > 0.05; hasd = dW > 0.05
    out[hasd] = dC[hasd]; out[hasn] = nC[hasn]            # nadir overwrites depth (base)
    img = np.zeros((H * W, 3), np.uint8); img[idx] = out
    hit = np.zeros(H * W, bool); hit[idx[hasn | hasd]] = True
    img = cv2.cvtColor(img.reshape(H, W, 3), cv2.COLOR_RGB2BGR)
    fm2 = cv2.morphologyEx(hit.reshape(H, W).astype(np.uint8), cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))
    # building OUTLINE: solid-fill the captured region, inpaint EVERY interior gap → complete photo
    cm = cv2.morphologyEx(fm2 * 255, cv2.MORPH_CLOSE, np.ones((31, 31), np.uint8))
    cnts, _ = cv2.findContours(cm, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    outline = np.zeros((H, W), np.uint8)
    if cnts:
        cv2.drawContours(outline, [max(cnts, key=cv2.contourArea)], -1, 255, -1)
    outm = outline > 0
    holes = (outm & (fm2 == 0)).astype(np.uint8)
    img = cv2.inpaint(img, holes, 6, cv2.INPAINT_NS)
    img[~outm] = 0
    img = cv2.medianBlur(img, 3)                     # light denoise (high-res source needs less)
    img = cv2.addWeighted(img, 1.35, cv2.GaussianBlur(img, (0, 0), 1.2), -0.35, 0)  # gentle sharpen
    img[~outm] = 0
    # WALL LINES from geometry (Justin's crop-to-walls): near-ceiling cloud points — walls reach
    # the ceiling, furniture doesn't — project to the room perimeter + interior walls; draw them
    # over the texture, which covers the messy wall-base speckle for a clean floorplan look.
    # (geometry wall-lines are off by default now — the cloud is too noisy for crisp walls; the
    # clean source is the HorizonNet room polygons laid over the texture. See #67. Texture only here.)
    o = "/tmp/fused.jpg"; cv2.imwrite(o, img, [cv2.IMWRITE_JPEG_QUALITY, 92])
    key = f"ortho/{slug}.jpg"; s3.upload_file(o, R2_BUCKET, key)

    ftw = round(float((hi1 - lo1) * fpu), 1); fth = round(float((hi2 - lo2) * fpu), 1)
    Pcam = cams - c; fxs = (Pcam @ e1 - lo1) * fpu; fys = (Pcam @ e2 - lo2) * fpu
    stp = max(1, len(fxs) // 140)
    flight = [{"t": int(i), "x": round(float(fxs[i]), 2), "y": round(float(fys[i]), 2)} for i in range(0, len(fxs), stp)]
    pk = f"plans/{slug}.plan.json"
    try:
        plan = json.loads(s3.get_object(Bucket=R2_BUCKET, Key=pk)["Body"].read()); sh = plan["sheets"][0]
    except Exception:
        plan = {"tourSlug": slug, "sheets": [{"id": "floor-1", "label": slug, "kind": "floor", "zones": []}]}; sh = plan["sheets"][0]
    sh.update({"width": ftw, "height": fth, "satUrl": f"https://media.lvxhomes.com/{key}?v={int(time.time())}", "paths": {"flight": flight}})
    s3.put_object(Bucket=R2_BUCKET, Key=pk, Body=json.dumps(plan).encode(), ContentType="application/json")
    nadir_pct = int(hasn.mean() * 100); fill_pct = int((hasd & ~hasn).mean() * 100)
    print(f"[fused] {slug}: {W}x{H}, {used} frames, nadir {nadir_pct}% + depth-fill {fill_pct}%, {ftw}x{fth}ft -> {key}")
    return {"ortho": key, "px": [int(W), int(H)], "frames": int(used),
            "nadir_pct": nadir_pct, "depth_fill_pct": fill_pct, "ft": [ftw, fth]}


# --- AI wall layout from 360 panos (Phase 1 of the fused-floorplan stack) ----------
# HorizonNet predicts a room's wall layout from a single equirect pano — from learned
# structure, NOT texture — so blank white dividers the MVS cloud can't reconstruct still
# get walls. We feed it panos sampled across the flight; later phases fuse per-pano
# layouts via the VSLAM poses (360-DFPE style) into one multi-room plan.
horizon_image = (
    modal.Image.from_registry("pytorch/pytorch:2.1.0-cuda12.1-cudnn8-runtime")
    .env({"DEBIAN_FRONTEND": "noninteractive", "TZ": "Etc/UTC"})   # tzdata must not prompt
    .apt_install("git", "libgl1", "libglib2.0-0", "build-essential", "wget", "tzdata")
    .pip_install("numpy", "scipy", "scikit-learn", "Pillow", "tqdm", "tensorboardX",
                 "opencv-python-headless", "shapely", "open3d", "pylsd-nova", "huggingface_hub")
    .pip_install("boto3", "numpy<2")   # boto3 for R2; pin numpy<2 (torch 2.1 ABI needs numpy 1.x)
    .run_commands(
        "git clone https://github.com/sunset1995/HorizonNet /horizon",
        # HorizonNet hardcodes ResNet50_Weights for all backbones -> breaks resnet34 on new
        # torchvision. We load the full checkpoint anyway, so drop the ImageNet pretrain.
        "sed -i 's/weights=ResNet50_Weights.IMAGENET1K_V1/weights=None/g' /horizon/model.py",
        "python -c \"from huggingface_hub import hf_hub_download as d; d('sunset1995/HorizonNet','resnet50_rnn__zind.pth',local_dir='/horizon/ckpt')\"",
    )
)


@app.function(image=horizon_image, gpu="T4", secrets=[r2_secret], volumes={"/scratch": vol}, timeout=2400)
def make_layout(slug: str, video_key: str, n: int = 6) -> dict:
    """Predict per-pano wall layouts across the flight (HorizonNet). Proves the model
    draws walls — white ones included — on YOUR panos before we build the fusion."""
    import os
    import glob
    import subprocess
    import cv2

    s3 = _r2(); sd = f"/scratch/{slug}"
    vid = f"{sd}/slam.mp4"
    if not os.path.exists(vid):
        vid = "/tmp/v.mp4"; s3.download_file(R2_BUCKET, video_key, vid)
    for d in ("/tmp/fr", "/tmp/al", "/tmp/out"):
        os.makedirs(d, exist_ok=True)
    cap = cv2.VideoCapture(vid); nfr = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 1
    saved = []
    for k in range(n):
        cap.set(cv2.CAP_PROP_POS_FRAMES, int(nfr * (k + 0.5) / n))
        ok, fr = cap.read()
        if ok:
            cv2.imwrite(f"/tmp/fr/f{k:02d}.png", cv2.resize(fr, (1024, 512)))   # equirect 2:1
            saved.append(f"f{k:02d}")
    cap.release()

    done = []
    for base in saved:
        subprocess.run(["python", "preprocess.py", "--img_glob", f"/tmp/fr/{base}.png", "--output_dir", "/tmp/al/"],
                       cwd="/horizon", capture_output=True, text=True)
        al = glob.glob(f"/tmp/al/{base}_aligned_rgb.png")
        if not al:
            print(f"[layout] {base}: preprocess produced no aligned pano"); continue
        r = subprocess.run(["python", "inference.py", "--pth", "/horizon/ckpt/resnet50_rnn__zind.pth",
                            "--img_glob", al[0], "--output_dir", "/tmp/out/", "--visualize"],
                           cwd="/horizon", capture_output=True, text=True)
        if r.returncode != 0:
            print(f"[layout] {base}: inference failed -> {r.stderr[-400:]}"); continue
        done.append(base)

    up = 0
    for o in glob.glob("/tmp/out/*") + glob.glob("/tmp/al/*_aligned_rgb.png"):
        s3.upload_file(o, R2_BUCKET, f"layout/{slug}/{os.path.basename(o)}"); up += 1
    print(f"[layout] {slug}: {len(saved)} panos, {len(done)} predicted, {up} files -> R2 layout/{slug}/")
    return {"panos": len(saved), "predicted": len(done), "files": up}


def _read_dji_meta(path: str) -> dict:
    """GPS (decimal, signed) + AGL + yaw from a DJI still's EXIF GPS IFD and DJI XMP
    block. Pure-stdlib port of pipeline/plan-extract/exif-gps.mjs — no Pillow/exifread."""
    import struct
    import re

    try:
        buf = open(path, "rb").read()
    except Exception:
        return {"lat": None, "lon": None, "relAlt": None, "flightYaw": None, "gimbalYaw": None}
    lat = lon = relAlt = flightYaw = gimbalYaw = None
    if len(buf) > 4 and buf[0] == 0xFF and buf[1] == 0xD8:
        off, tiff, xmp, n = 2, -1, "", len(buf)
        while off < n - 4:
            if buf[off] != 0xFF:
                off += 1
                continue
            mk = buf[off + 1]
            if mk in (0xDA, 0xD9):
                break
            size = struct.unpack(">H", buf[off + 2:off + 4])[0]
            seg = off + 4
            if mk == 0xE1:
                if buf[seg:seg + 6] == b"Exif\x00\x00" and tiff < 0:
                    tiff = seg + 6
                elif buf[seg:seg + 23] == b"http://ns.adobe.com/xap":
                    xmp += buf[seg:off + 2 + size].decode("utf-8", "ignore")
            off += 2 + size
        if tiff >= 0:
            le = buf[tiff:tiff + 2] == b"II"
            ef = "<" if le else ">"
            u16 = lambda o: struct.unpack(ef + "H", buf[o:o + 2])[0]
            u32 = lambda o: struct.unpack(ef + "I", buf[o:o + 4])[0]
            Tr = lambda o: tiff + o
            try:
                ifd0 = u32(Tr(4))
                gpsRel = None
                for i in range(u16(Tr(ifd0))):
                    e = Tr(ifd0 + 2 + i * 12)
                    if u16(e) == 0x8825:
                        gpsRel = u32(e + 8)
                if gpsRel is not None:
                    def dms(rel):
                        v = 0.0
                        for k in range(3):
                            num = u32(Tr(rel + k * 8))
                            den = u32(Tr(rel + k * 8 + 4))
                            v += (num / den if den else 0) / (60 ** k)
                        return v
                    latRef, lonRef = "N", "E"
                    for i in range(u16(Tr(gpsRel))):
                        e = Tr(gpsRel + 2 + i * 12)
                        tag = u16(e)
                        if tag == 1:
                            latRef = chr(buf[e + 8])
                        elif tag == 3:
                            lonRef = chr(buf[e + 8])
                        elif tag == 2:
                            lat = dms(u32(e + 8))
                        elif tag == 4:
                            lon = dms(u32(e + 8))
                    if lat is not None and latRef == "S":
                        lat = -lat
                    if lon is not None and lonRef == "W":
                        lon = -lon
            except Exception as ex:
                print(f"[exif] {os.path.basename(path)}: GPS IFD parse warn -> {ex}")

        def grab(k):
            mm = re.search(k + r'[>="\s]+([+\-\d.]+)', xmp)
            return float(mm.group(1)) if mm else None

        relAlt, flightYaw, gimbalYaw = grab("RelativeAltitude"), grab("FlightYawDegree"), grab("GimbalYawDegree")
    return {"lat": lat, "lon": lon, "relAlt": relAlt, "flightYaw": flightYaw, "gimbalYaw": gimbalYaw}


@app.function(image=horizon_image, gpu="T4", secrets=[r2_secret], volumes={"/scratch": vol}, timeout=3600)
def still_layout(slug: str) -> dict:
    """HorizonNet on the dedicated full-res 360 STILLS, read from the Studio upload prefix
    projects/{slug}/still/ (falls back to the legacy stills/{slug}/). For each still it predicts
    the room layout, recovers the preprocess align-yaw (horizon-band cross-correlation), and reads
    the still's OWN GPS + gimbal yaw from EXIF/XMP — returning all of it per still so the GPS
    fusion can drop each room (and each separate structure: house, casita) at its true position.
    Mirrors layout viz to stilllayout/{slug}/ for inspection."""
    import os
    import glob
    import json
    import subprocess
    import numpy as np
    import cv2

    s3 = _r2()
    for d in ("/tmp/fr", "/tmp/al", "/tmp/out"):
        os.makedirs(d, exist_ok=True)

    keys = []
    for prefix in (f"projects/{slug}/still/", f"stills/{slug}/"):
        resp = s3.list_objects_v2(Bucket=R2_BUCKET, Prefix=prefix)
        keys = sorted(o["Key"] for o in resp.get("Contents", [])
                      if o["Key"].lower().endswith((".jpg", ".jpeg")))
        if keys:
            print(f"[still_layout] {slug}: {len(keys)} stills under {prefix}")
            break

    meta, saved = {}, []
    for key in keys:
        name = os.path.splitext(os.path.basename(key))[0]
        dl = f"/tmp/dl_{name}.jpg"
        s3.download_file(R2_BUCKET, key, dl)
        meta[name] = _read_dji_meta(dl)        # read EXIF from the ORIGINAL full-res jpg
        im = cv2.imread(dl)
        if im is None:
            print(f"[still_layout] {name}: cv2 could not read"); continue
        cv2.imwrite(f"/tmp/fr/{name}.png", cv2.resize(im, (1024, 512)))
        saved.append(name)

    stills = []
    for base in saved:
        subprocess.run(["python", "preprocess.py", "--img_glob", f"/tmp/fr/{base}.png", "--output_dir", "/tmp/al/"],
                       cwd="/horizon", capture_output=True, text=True)
        al = glob.glob(f"/tmp/al/{base}_aligned_rgb.png")
        if not al:
            print(f"[still_layout] {base}: no aligned pano"); continue
        r = subprocess.run(["python", "inference.py", "--pth", "/horizon/ckpt/resnet50_rnn__zind.pth",
                            "--img_glob", al[0], "--output_dir", "/tmp/out/", "--visualize"],
                           cwd="/horizon", capture_output=True, text=True)
        jp = f"/tmp/out/{base}_aligned_rgb.json"
        if r.returncode != 0 or not os.path.exists(jp):
            print(f"[still_layout] {base}: inference failed -> {r.stderr[-300:]}"); continue
        lay = json.loads(open(jp).read())
        # recover the preprocess align-yaw: circular cross-corr of the horizon band -> frac of width -> deg
        og = cv2.cvtColor(cv2.imread(f"/tmp/fr/{base}.png"), cv2.COLOR_BGR2GRAY)[200:312].mean(0)
        ag = cv2.cvtColor(cv2.imread(al[0]), cv2.COLOR_BGR2GRAY)[200:312].mean(0)
        cc = np.fft.irfft(np.fft.rfft(og - og.mean()) * np.conj(np.fft.rfft(ag - ag.mean())), n=len(og))
        shift = float(np.argmax(cc)) / len(og)
        m = meta.get(base, {})
        stills.append({
            "name": base,
            "lat": m.get("lat"), "lon": m.get("lon"),
            "relAlt": m.get("relAlt"), "gimbalYaw": m.get("gimbalYaw"), "flightYaw": m.get("flightYaw"),
            "preprocessYaw": round(shift * 360.0, 2),
            "uv": lay.get("uv"), "z0": lay.get("z0"), "z1": lay.get("z1"),
        })

    up = 0
    for o in glob.glob("/tmp/out/*") + glob.glob("/tmp/al/*_aligned_rgb.png"):
        s3.upload_file(o, R2_BUCKET, f"stilllayout/{slug}/{os.path.basename(o)}"); up += 1
    geo = [s for s in stills if s["lat"] is not None]
    print(f"[still_layout] {slug}: {len(saved)} stills, {len(stills)} predicted, {len(geo)} geotagged, {up} viz -> stilllayout/{slug}/")
    return {"slug": slug, "count": len(stills), "geotagged": len(geo), "stills": stills}


@app.function(image=horizon_image, gpu="T4", secrets=[r2_secret], volumes={"/scratch": vol}, timeout=3600)
def make_walls_ai(slug: str, video_key: str, ceiling_ft: float = 9.0, spacing_ft: float = 4.0,
                  pxm: float = 18.0, yflip: int = 1, lonsign: int = 1,
                  maxd: float = 16.0, maxroom: float = 32.0) -> dict:
    """Phase 2 — fuse 360 room-layout (HorizonNet) into a wall composite. Sample panos by
    TRAJECTORY DISTANCE (every spacing_ft), predict each room's layout, recover its align
    rotation, project the floor-wall corners to the global floor through that frame's VSLAM
    pose, and overlay all of them + the flight path in the make_fused feet frame."""
    import os
    import glob
    import json
    import subprocess
    import numpy as np
    import cv2

    s3 = _r2(); sd = f"/scratch/{slug}"
    ply = f"{sd}/{slug}.ply"
    if not os.path.exists(ply):
        ply = "/tmp/c.ply"; s3.download_file(R2_BUCKET, f"vslam/{slug}/{slug}.ply", ply)
    xyz, _ = _read_ply_xyzrgb(ply)
    traj = f"{sd}/frame_trajectory.txt"
    if not os.path.exists(traj):
        traj = f"{sd}/keyframe_trajectory.txt"
    T = np.loadtxt(traj)
    vid = f"{sd}/slam.mp4"
    if not os.path.exists(vid):
        vid = "/tmp/v.mp4"; s3.download_file(R2_BUCKET, video_key, vid)

    # basis / extent / scale — SAME frame as make_fused so walls register on the photo
    c = xyz.mean(0); X = xyz - c
    _, _, Vt = np.linalg.svd(X[::41], full_matrices=False); up = Vt[2].astype("f4")
    cams = T[:, 1:4]
    if np.dot(cams.mean(0) - c, up) < 0:
        up = -up
    a = np.array([1.0, 0, 0]) if abs(up[0]) < 0.9 else np.array([0, 1.0, 0])
    e1 = np.cross(up, a); e1 /= np.linalg.norm(e1); e2 = np.cross(up, e1)
    h = X @ up
    lo1, hi1 = np.percentile(X @ e1, [1, 99]); lo2, hi2 = np.percentile(X @ e2, [1, 99])
    floor = float(np.percentile(h, 1.5)); ceil = float(np.percentile(h, 99))
    fpu = ceiling_ft / (ceil - floor)
    ftw = (hi1 - lo1) * fpu; fth = (hi2 - lo2) * fpu
    W = int(ftw * pxm) + 1; H = int(fth * pxm) + 1

    # sample frame indices by cumulative trajectory distance (in feet)
    Pc = cams - c
    fxs = (Pc @ e1 - lo1) * fpu; fys = (Pc @ e2 - lo2) * fpu
    seg = np.r_[0.0, np.hypot(np.diff(fxs), np.diff(fys))]
    cum = np.cumsum(seg)
    picks = []
    nextd = 0.0
    for i in range(len(cum)):
        if cum[i] >= nextd:
            picks.append(i); nextd = cum[i] + spacing_ft
    cap = cv2.VideoCapture(vid)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0; nfr = cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0
    ts = T[:, 0].copy()
    if nfr and ts.max() > (nfr / fps) * 2:
        ts = ts / fps

    def floor_uv_to_feet(u, v, C, R, shift):
        u0 = (u - shift) % 1.0                                  # un-roll the align yaw
        lon = lonsign * (u0 - 0.5) * 2 * np.pi
        lat = (0.5 - v) * np.pi
        rc = np.array([np.cos(lat) * np.sin(lon), -yflip * np.sin(lat), np.cos(lat) * np.cos(lon)])
        rw = R.T @ rc                                           # camera -> world
        denom = rw @ up
        if abs(denom) < 1e-4:
            return None
        t = (floor - (C @ up)) / denom
        if t <= 0:
            return None
        p = C + t * rw
        return [(p @ e1 - lo1) * fpu, (p @ e2 - lo2) * fpu]

    rooms = []
    used = 0
    for i in picks:
        cap.set(cv2.CAP_PROP_POS_MSEC, float(ts[i]) * 1000.0)
        ok, fr = cap.read()
        if not ok:
            continue
        pano = cv2.resize(fr, (1024, 512))
        cv2.imwrite("/tmp/p.png", pano)
        subprocess.run(["python", "preprocess.py", "--img_glob", "/tmp/p.png", "--output_dir", "/tmp/al/"],
                       cwd="/horizon", capture_output=True, text=True)
        al = glob.glob("/tmp/al/p_aligned_rgb.png")
        if not al:
            continue
        r = subprocess.run(["python", "inference.py", "--pth", "/horizon/ckpt/resnet50_rnn__zind.pth",
                            "--img_glob", al[0], "--output_dir", "/tmp/out/"], cwd="/horizon", capture_output=True, text=True)
        jp = "/tmp/out/p_aligned_rgb.json"
        if r.returncode != 0 or not os.path.exists(jp):
            continue
        aligned = cv2.imread(al[0])
        # recover align yaw: circular cross-correlation of the horizon band
        oa = cv2.cvtColor(pano, cv2.COLOR_BGR2GRAY)[200:312].mean(0)
        ob = cv2.cvtColor(aligned, cv2.COLOR_BGR2GRAY)[200:312].mean(0)
        cc = np.fft.irfft(np.fft.rfft(oa - oa.mean()) * np.conj(np.fft.rfft(ob - ob.mean())), n=len(oa))
        shift = float(np.argmax(cc)) / len(oa)
        lay = json.loads(open(jp).read())
        uv = lay["uv"]
        floor_corners = uv[1::2]                                # odd indices = floor corners
        C = T[i, 1:4] - c; R = _quat2rot(T[i, 4:8])
        cam_ft = [(Pc[i] @ e1 - lo1) * fpu, (Pc[i] @ e2 - lo2) * fpu]
        poly = []
        for (u, v) in floor_corners:
            p = floor_uv_to_feet(u, v, C, R, shift)
            if p is None:
                continue
            dd = float(np.hypot(p[0] - cam_ft[0], p[1] - cam_ft[1]))
            if maxd > 0 and dd > maxd:                      # low camera height blows far corners out; pull them in
                p = [cam_ft[0] + (p[0] - cam_ft[0]) * maxd / dd, cam_ft[1] + (p[1] - cam_ft[1]) * maxd / dd]
            poly.append(p)
        if len(poly) >= 3:
            xs = [q[0] for q in poly]; ys = [q[1] for q in poly]
            if (max(xs) - min(xs)) <= maxroom and (max(ys) - min(ys)) <= maxroom:  # drop outdoor/garbage frames
                rooms.append({"poly": poly, "cam": cam_ft})
        used += 1
    cap.release()

    # cache the raw room polys + cams + flight (feet) so the reconciliation can iterate locally
    flight_ft = [[round(float(fxs[i]), 2), round(float(fys[i]), 2)]
                 for i in range(0, len(fxs), max(1, len(fxs) // 140))]
    s3.put_object(Bucket=R2_BUCKET, Key=f"layout/{slug}/rooms.json",
                  Body=json.dumps({
                      "ftw": round(float(ftw), 2), "fth": round(float(fth), 2),
                      "rooms": [{"poly": [[round(float(p[0]), 2), round(float(p[1]), 2)] for p in rm["poly"]],
                                 "cam": [round(float(rm["cam"][0]), 2), round(float(rm["cam"][1]), 2)]} for rm in rooms],
                      "flight": flight_ft}).encode(),
                  ContentType="application/json")

    def px(p):
        return (int(np.clip(p[0] / ftw * (W - 1), 0, W - 1)), int(np.clip(p[1] / fth * (H - 1), 0, H - 1)))

    # --- reconcile: vote wall edges (near edges weigh more), extract consensus walls ---
    acc = np.zeros((H, W), np.float32)
    for rm in rooms:
        cam = rm["cam"]; pts = rm["poly"]
        for a in range(len(pts)):
            p1, p2 = pts[a], pts[(a + 1) % len(pts)]
            mid = ((p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2)
            wgt = 1.0 / (1.0 + np.hypot(mid[0] - cam[0], mid[1] - cam[1]) / 6.0)   # feet
            tmp = np.zeros((H, W), np.float32)
            cv2.line(tmp, px(p1), px(p2), 1.0, max(2, int(pxm * 0.3)))
            acc += tmp * wgt
    acc = cv2.GaussianBlur(acc, (0, 0), pxm * 0.25)
    mask = (acc > acc.max() * 0.18).astype(np.uint8) * 255
    lines = cv2.HoughLinesP(mask, 1, np.pi / 180, threshold=int(pxm * 1.0),
                            minLineLength=int(pxm * 2.0), maxLineGap=int(pxm * 1.4))
    strokes = []; vsegs = []
    if lines is not None:
        segs = lines[:, 0, :].astype(np.float64)
        angs = np.degrees(np.arctan2(segs[:, 3] - segs[:, 1], segs[:, 2] - segs[:, 0])) % 180.0
        hist, edg = np.histogram(angs, bins=18, range=(0, 180))
        theta = float(edg[int(np.argmax(hist))]) + 5.0
        kept = []
        for (x1, y1, x2, y2), an in zip(segs, angs):
            length = float(np.hypot(x2 - x1, y2 - y1))
            d0 = min((an - theta) % 180, (theta - an) % 180)
            d1 = min((an - theta - 90) % 180, (theta + 90 - an) % 180)
            if min(d0, d1) < 16:
                rad = np.radians(theta if d0 < d1 else theta + 90.0)
                mx, my = (x1 + x2) / 2, (y1 + y2) / 2
                dx, dy = np.cos(rad) * length / 2, np.sin(rad) * length / 2
                q = [(mx - dx, my - dy), (mx + dx, my + dy)]
            else:
                q = [(x1, y1), (x2, y2)]
            kept.append((length, q))
        kept.sort(key=lambda t: -t[0])
        for _, q in kept[:60]:
            vsegs.append(q)
            strokes.append([[round(float(q[0][0] / (W - 1) * ftw), 2), round(float(q[0][1] / (H - 1) * fth), 2)],
                            [round(float(q[1][0] / (W - 1) * ftw), 2), round(float(q[1][1] / (H - 1) * fth), 2)]])

    pk = f"plans/{slug}.plan.json"
    try:
        plan = json.loads(s3.get_object(Bucket=R2_BUCKET, Key=pk)["Body"].read())
        plan["sheets"][0]["strokes"] = strokes
        s3.put_object(Bucket=R2_BUCKET, Key=pk, Body=json.dumps(plan).encode(), ContentType="application/json")
    except Exception as e:
        print("[walls_ai] plan merge skip:", e)

    base = np.full((H, W, 3), 250, np.uint8)
    try:
        s3.download_file(R2_BUCKET, f"ortho/{slug}.jpg", "/tmp/o.jpg")
        ph = cv2.imread("/tmp/o.jpg")
        if ph is not None:
            base = cv2.resize(ph, (W, H))
    except Exception:
        pass
    comp = base.copy()
    for k, rm in enumerate(rooms):
        col = ((37 * k) % 255, (91 * k + 60) % 255, (150 * k + 90) % 255)
        cv2.polylines(comp, [np.array([px(p) for p in rm["poly"]], np.int32)], True, col, 1, cv2.LINE_AA)
    cv2.imwrite("/tmp/comp.jpg", comp, [cv2.IMWRITE_JPEG_QUALITY, 90])
    s3.upload_file("/tmp/comp.jpg", R2_BUCKET, f"layout/{slug}/composite.jpg")
    clean = base.copy()
    for q in vsegs:
        a2, b2 = (int(q[0][0]), int(q[0][1])), (int(q[1][0]), int(q[1][1]))
        cv2.line(clean, a2, b2, (255, 255, 255), 4, cv2.LINE_AA)
        cv2.line(clean, a2, b2, (30, 25, 20), 2, cv2.LINE_AA)
    cv2.imwrite("/tmp/clean.jpg", clean, [cv2.IMWRITE_JPEG_QUALITY, 90])
    s3.upload_file("/tmp/clean.jpg", R2_BUCKET, f"layout/{slug}/walls.jpg")
    print(f"[walls_ai] {slug}: {len(picks)} panos, {len(rooms)} polys, {len(strokes)} consensus walls, "
          f"{round(ftw,1)}x{round(fth,1)}ft -> composite.jpg + walls.jpg + plan")
    return {"panos": int(len(picks)), "rooms": int(len(rooms)), "walls": int(len(strokes)),
            "ft": [round(float(ftw), 1), round(float(fth), 1)]}


@app.function(image=horizon_image, gpu="T4", secrets=[r2_secret], volumes={"/scratch": vol}, timeout=3600)
def localize_stills(slug: str, video_key: str, ceiling_ft: float = 9.0, n_frames: int = 160,
                    stills_prefix: str = "", srt_key: str = "") -> dict:
    """Localize each dedicated 360 STILL into the VSLAM frame: ORB-match it to the video
    frame it overlaps (the 'common frames'), inherit that frame's pose -> the still's true
    feet position in the make_fused plan frame. -> layout/{slug}/localize.json."""
    import os
    import json
    import numpy as np
    import cv2

    s3 = _r2(); sd = f"/scratch/{slug}"
    ply = f"{sd}/{slug}.ply"
    if not os.path.exists(ply):
        ply = "/tmp/c.ply"; s3.download_file(R2_BUCKET, f"vslam/{slug}/{slug}.ply", ply)
    xyz, _ = _read_ply_xyzrgb(ply)
    traj = f"{sd}/frame_trajectory.txt"
    if not os.path.exists(traj):
        traj = f"{sd}/keyframe_trajectory.txt"
    T = np.loadtxt(traj)
    vid = f"{sd}/slam.mp4"
    if not os.path.exists(vid):
        vid = "/tmp/v.mp4"; s3.download_file(R2_BUCKET, video_key, vid)

    # basis / scale — identical to make_fused so positions land in the plan's feet frame
    c = xyz.mean(0); X = xyz - c
    _, _, Vt = np.linalg.svd(X[::41], full_matrices=False); up = Vt[2].astype("f4")
    cams = T[:, 1:4]
    if np.dot(cams.mean(0) - c, up) < 0:
        up = -up
    a = np.array([1.0, 0, 0]) if abs(up[0]) < 0.9 else np.array([0, 1.0, 0])
    e1 = np.cross(up, a); e1 /= np.linalg.norm(e1); e2 = np.cross(up, e1)
    h = X @ up
    lo1, hi1 = np.percentile(X @ e1, [1, 99]); lo2, hi2 = np.percentile(X @ e2, [1, 99])
    floor = float(np.percentile(h, 1.5)); ceil = float(np.percentile(h, 99))
    fpu = ceiling_ft / (ceil - floor)
    ftw = float((hi1 - lo1) * fpu); fth = float((hi2 - lo2) * fpu)

    cap = cv2.VideoCapture(vid)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0; nfr = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 1
    ts = T[:, 0].copy()
    if nfr and ts.max() > (nfr / fps) * 2:
        ts = ts / fps

    orb = cv2.ORB_create(1000)
    frames = []
    for k in range(n_frames):
        fi = int(nfr * (k + 0.5) / n_frames)
        cap.set(cv2.CAP_PROP_POS_FRAMES, fi)
        ok, fr = cap.read()
        if not ok:
            continue
        g = cv2.cvtColor(cv2.resize(fr, (1024, 512)), cv2.COLOR_BGR2GRAY)
        _, des = orb.detectAndCompute(g, None)
        if des is None:
            continue
        idx = int(np.argmin(np.abs(ts - fi / fps)))
        cam = cams[idx] - c
        # camera-forward heading in the floor (e1,e2) frame — feeds the cross-stream
        # compass calibration: this is the SAME camera direction gimbalYaw reports, but
        # measured from the VSLAM pose, so head vs gimbalYaw exposes the compass offset.
        fhead = None
        if T.shape[1] >= 8:
            q = T[idx, 4:8]  # TUM quaternion qx qy qz qw -> world third column = R@[0,0,1] (cam forward)
            fwd = np.array([2 * (q[0] * q[2] + q[3] * q[1]),
                            2 * (q[1] * q[2] - q[3] * q[0]),
                            1 - 2 * (q[0] ** 2 + q[1] ** 2)])
            fhead = float(np.degrees(np.arctan2(float(fwd @ e2), float(fwd @ e1))))
        frames.append((fi, des, [float((cam @ e1 - lo1) * fpu), float((cam @ e2 - lo2) * fpu)], fhead))
    cap.release()

    bf = cv2.BFMatcher(cv2.NORM_HAMMING)
    keys = []
    for prefix in ([stills_prefix] if stills_prefix else [f"projects/{slug}/still/", f"stills/{slug}/"]):
        resp = s3.list_objects_v2(Bucket=R2_BUCKET, Prefix=prefix)
        keys = sorted(o["Key"] for o in resp.get("Contents", []) if o["Key"].lower().endswith((".jpg", ".jpeg")))
        if keys:
            print(f"[localize] {len(keys)} stills under {prefix}")
            break
    out = {}
    for key in keys:
        name = os.path.splitext(os.path.basename(key))[0]
        dl = f"/tmp/s_{name}.jpg"; s3.download_file(R2_BUCKET, key, dl)
        im = cv2.imread(dl)
        if im is None:
            continue
        g = cv2.cvtColor(cv2.resize(im, (1024, 512)), cv2.COLOR_BGR2GRAY)
        _, sdes = orb.detectAndCompute(g, None)
        best_feet, best_fi, best_cnt, best_head = None, -1, -1, None
        for fi, fdes, feet, fhead in frames:
            matches = bf.knnMatch(sdes, fdes, k=2)
            good = sum(1 for mm in matches if len(mm) == 2 and mm[0].distance < 0.75 * mm[1].distance)
            if good > best_cnt:
                best_cnt, best_feet, best_fi, best_head = good, feet, fi, fhead
        out[name] = {"frame": int(best_fi), "feet": [round(best_feet[0], 2), round(best_feet[1], 2)], "matches": int(best_cnt)}
        if best_head is not None:
            out[name]["head"] = round(best_head, 1)
        print(f"[localize] {name}: frame {best_fi} ({best_cnt} matches) -> ({out[name]['feet'][0]}, {out[name]['feet'][1]}) ft")

    # ---- cross-stream heading calibration (Justin's GPS/compass idea): the flythrough's
    # own VSLAM head vs its SRT compass (gb_yaw) over the sampled frames -> one constant
    # mapping compass -> floor-frame (phi, slope). Same camera + capture, so it's internally
    # consistent; the spread flags magnetic interference. The stills' gimbalYaw maps through it.
    heading_cal = None
    if srt_key:
        try:
            import re as _re, math as _m
            sp = "/tmp/fly.srt"; s3.download_file(R2_BUCKET, srt_key, sp)
            yaws = []
            for b in _re.split(r"\n\s*\n", open(sp, encoding="utf-8", errors="ignore").read()):
                my = _re.search(r"gb_yaw\s*:\s*([-\d.]+)", b)
                yaws.append(float(my.group(1)) if my else None)
            pairs = []
            for fi, _d, _feet, fhead in frames:
                if fhead is None:
                    continue
                bi = min(len(yaws) - 1, max(0, int(round(fi / max(1, nfr) * len(yaws)))))
                if yaws[bi] is not None:
                    pairs.append((fhead, yaws[bi]))

            def _fit(slope):
                ds = [fh - slope * gy for (fh, gy) in pairs]
                cx = sum(_m.cos(_m.radians(d)) for d in ds); cy = sum(_m.sin(_m.radians(d)) for d in ds)
                ph = _m.degrees(_m.atan2(cy, cx))
                spread = _m.sqrt(sum(((((d - ph + 540) % 360) - 180) ** 2) for d in ds) / len(ds))
                return slope, round(ph, 1), round(spread, 1)

            if len(pairs) >= 5:
                slope, phi, spread = min((_fit(s) for s in (1.0, -1.0)), key=lambda t: t[2])
                nb = len([y for y in yaws if y is not None])
                heading_cal = {"phi": phi, "slope": slope, "spreadDeg": spread, "n": len(pairs), "srtBlocks": nb}
                print(f"[localize] heading-cal: phi {phi}° slope {slope:+.0f} spread {spread}° over {len(pairs)} frames ({nb} srt blocks)")
        except Exception as _e:
            print(f"[localize] heading-cal failed: {_e}")

    out["_meta"] = {"ftw": round(ftw, 2), "fth": round(fth, 2), "frames": len(frames)}
    if heading_cal:
        out["_meta"]["heading"] = heading_cal
    s3.put_object(Bucket=R2_BUCKET, Key=f"layout/{slug}/localize.json", Body=json.dumps(out).encode(), ContentType="application/json")
    n = len([k for k in out if k != "_meta"])
    print(f"[localize] {slug}: {n} stills localized -> R2 layout/{slug}/localize.json")
    return {"localized": int(n), "frames": int(len(frames))}


@app.local_entrypoint()
def main(r2_key: str, slug: str, scale: float = 1.0):
    """CLI smoke test:  modal run modal_app.py --r2-key uploads/1112.mp4 --slug apartment-1112"""
    print(process.remote({"r2_key": r2_key, "slug": slug, "scale": scale}))


@app.local_entrypoint()
def stills(slug: str, out: str = "_stills_layout.json"):
    """Run HorizonNet + EXIF-GPS over a project's uploaded stills and write the per-still
    layout+GPS bundle locally (no deploy needed; uses this file's code):

        modal run modal_app.py::stills --slug old-town-scottsdale-home
    """
    import json
    res = still_layout.remote(slug)
    open(out, "w", encoding="utf-8").write(json.dumps(res, indent=2))
    print(f"{res['count']} stills, {res['geotagged']} geotagged -> {out}")


@app.function(image=test_image, secrets=[r2_secret])
def list_r2(prefix: str) -> list:
    """List R2 objects under a prefix (key + size in MB), paginated."""
    s3 = _r2()
    out, token = [], None
    while True:
        kw = {"Bucket": R2_BUCKET, "Prefix": prefix}
        if token:
            kw["ContinuationToken"] = token
        resp = s3.list_objects_v2(**kw)
        for o in resp.get("Contents", []):
            out.append({"key": o["Key"], "mb": round(o["Size"] / 1e6, 1)})
        if resp.get("IsTruncated"):
            token = resp.get("NextContinuationToken")
        else:
            break
    return out


@app.local_entrypoint()
def lsr2(prefix: str):
    """modal run modal_app.py::lsr2 --prefix projects/old-town-scottsdale-home/"""
    objs = list_r2.remote(prefix)
    total = 0.0
    for o in sorted(objs, key=lambda x: x["key"]):
        total += o["mb"]
        print(f"{o['mb']:>9.1f} MB  {o['key']}")
    print(f"--- {len(objs)} objects, {total:.1f} MB total under {prefix}")


@app.function(image=test_image, secrets=[r2_secret], volumes={"/scratch": vol}, timeout=3600)
def stage_video(vol_path: str, r2_key: str) -> dict:
    """Copy a big capture staged on the volume (via `modal volume put`, which is chunked
    and uncapped) into R2 — boto3 does a multipart upload automatically for large files.
    This is how >5 GiB videos get into R2 without the browser's single-PUT limit."""
    import os
    vol.reload()
    src = f"/scratch/{vol_path}"
    if not os.path.exists(src):
        raise RuntimeError(f"not staged on volume: {src}")
    size = os.path.getsize(src)
    _r2().upload_file(src, R2_BUCKET, r2_key)
    print(f"[stage] {src} ({size/1e6:.0f} MB) -> R2 {r2_key}")
    return {"key": r2_key, "mb": round(size / 1e6, 1)}


@app.local_entrypoint()
def stage(vol_path: str, key: str):
    """modal run modal_app.py::stage --vol-path staging/x.mp4 --key projects/slug/nadir/x.mp4"""
    print(stage_video.remote(vol_path, key))


@app.local_entrypoint()
def vslam(key: str, slug: str):
    """Run just the VSLAM stage on an R2 video (no callback) — for validating tracking:
        modal run modal_app.py::vslam --key projects/slug/nadir/x.mp4 --slug scottsdale-nadir
    """
    print(run_vslam.remote(key, slug))


@app.function(image=test_image, secrets=[r2_secret])
def read_r2(key: str) -> bytes:
    """Return an R2 object's bytes — for pulling cloud artifacts (walls.jpg etc.) down to view."""
    return _r2().get_object(Bucket=R2_BUCKET, Key=key)["Body"].read()


@app.local_entrypoint()
def getr2(key: str, out: str):
    """modal run modal_app.py::getr2 --key layout/scottsdale-fly/walls.jpg --out walls.jpg"""
    data = read_r2.remote(key)
    open(out, "wb").write(data)
    print(f"{len(data)} bytes -> {out}")


@app.local_entrypoint()
def walls(slug: str, video_key: str, ceiling_ft: float = 9.0, spacing_ft: float = 4.0):
    """Horizon-line wall reconstruction: sample the flythrough along its VSLAM trajectory,
    HorizonNet each frame, back-project the floor horizon, vote consensus walls.
        modal run modal_app.py::walls --slug scottsdale-fly --video-key projects/.../standard.mp4 --ceiling-ft 8.5
    """
    print(make_walls_ai.remote(slug, video_key, ceiling_ft=ceiling_ft, spacing_ft=spacing_ft))


@app.local_entrypoint()
def localize(slug: str, video_key: str, ceiling_ft: float = 9.0, stills_prefix: str = "", srt_key: str = ""):
    """ORB-localize the dedicated stills onto the flythrough's VSLAM path (same feet frame):
        modal run modal_app.py::localize --slug scottsdale-fly --video-key projects/.../standard.mp4 \
            --ceiling-ft 8.5 --stills-prefix projects/old-town-scottsdale-home/still/ \
            --srt-key projects/old-town-scottsdale-home/telemetry/<flythrough>.srt
    """
    print(localize_stills.remote(slug, video_key, ceiling_ft=ceiling_ft, stills_prefix=stills_prefix, srt_key=srt_key))


@app.function(image=test_image, secrets=[r2_secret])
def put_r2(key: str, data_b64: str, content_type: str = "image/jpeg") -> dict:
    """Upload bytes to an R2 key — for hand-built plan layers (satellite, ortho) that are
    too big to embed as data-URLs in the D1 plan blob."""
    import base64
    _r2().put_object(Bucket=R2_BUCKET, Key=key, Body=base64.b64decode(data_b64), ContentType=content_type)
    return {"key": key}


@app.local_entrypoint()
def putr2(key: str, path: str):
    """modal run modal_app.py::putr2 --key plans/old-town-scottsdale-home-sat.jpg --path _sat_final.jpg"""
    import base64
    print(put_r2.remote(key, base64.b64encode(open(path, "rb").read()).decode()))


@app.function(image=test_image, secrets=[r2_secret, cb_secret])
def deliver_plan(slug: str, plan_json: str, base_b64: str = "") -> dict:
    """Land a finished plan on a project through the production path: upload plan (+ base)
    to R2, then fire the same callback the cloud pipeline uses (writes the plan to D1 by
    slug, points satUrl at the R2 base). Lets a locally-built plan ship like a cloud one."""
    import json
    import base64
    s3 = _r2()
    plan = json.loads(plan_json)
    plan["tourSlug"] = slug                           # the Floorplan editor keys/loads plans by tourSlug
    for sh in plan.get("sheets", []):
        sh.pop("satUrl", None)                       # drop any data-URL; callback sets the R2 URL
    plan_key = f"plans/{slug}.plan.json"
    s3.put_object(Bucket=R2_BUCKET, Key=plan_key, Body=json.dumps(plan).encode(), ContentType="application/json")
    base_key = None
    if base_b64:
        base_key = f"plans/{slug}-base.jpg"
        s3.put_object(Bucket=R2_BUCKET, Key=base_key, Body=base64.b64decode(base_b64), ContentType="image/jpeg")
    _notify({"slug": slug, "status": "ready", "plan": plan_key, "base": base_key})
    print(f"[deliver] {slug}: plan -> {plan_key}, base -> {base_key}")
    return {"plan": plan_key, "base": base_key}


@app.local_entrypoint()
def deliver(slug: str, plan_path: str, base_path: str = ""):
    """modal run modal_app.py::deliver --slug <slug> --plan-path x.plan.json --base-path x-base.jpg"""
    import base64
    plan_json = open(plan_path, "r", encoding="utf-8").read()
    base_b64 = base64.b64encode(open(base_path, "rb").read()).decode() if base_path else ""
    print(deliver_plan.remote(slug, plan_json, base_b64))


@app.function(image=horizon_image, gpu="T4", secrets=[r2_secret], volumes={"/scratch": vol}, timeout=3600)
def make_floormap(slug: str, video_key: str, ceiling_ft: float = 9.0, step_ft: float = 2.0,
                  pxm: float = 20.0, maxd_ft: float = 16.0, yflip: int = 1, lonsign: int = 1) -> dict:
    """Dense floor-occupancy footprint (the 'visual rerun'). Samples the flythrough every
    step_ft along the VSLAM path, runs HorizonNet, clamps each floor polygon to its reliable
    near range (far corners blow up under the lens), and FILLS that floor patch into a
    top-down occupancy grid through the frame's pose. The equirect->ray projection removes
    lens distortion exactly; overlapping patches from the moving camera average out per-frame
    noise; threshold + contour -> the footprint outline. Repeatable across properties."""
    import os
    import glob
    import json
    import subprocess
    import numpy as np
    import cv2

    s3 = _r2(); sd = f"/scratch/{slug}"
    ply = f"{sd}/{slug}.ply"
    if not os.path.exists(ply):
        ply = "/tmp/c.ply"; s3.download_file(R2_BUCKET, f"vslam/{slug}/{slug}.ply", ply)
    xyz, _ = _read_ply_xyzrgb(ply)
    traj = f"{sd}/frame_trajectory.txt"
    if not os.path.exists(traj):
        traj = f"{sd}/keyframe_trajectory.txt"
    T = np.loadtxt(traj)
    vid = f"{sd}/slam.mp4"
    if not os.path.exists(vid):
        vid = "/tmp/v.mp4"; s3.download_file(R2_BUCKET, video_key, vid)

    # basis / extent / scale — same feet frame as make_walls_ai
    c = xyz.mean(0); X = xyz - c
    _, _, Vt = np.linalg.svd(X[::41], full_matrices=False); up = Vt[2].astype("f4")
    cams = T[:, 1:4]
    if np.dot(cams.mean(0) - c, up) < 0:
        up = -up
    a = np.array([1.0, 0, 0]) if abs(up[0]) < 0.9 else np.array([0, 1.0, 0])
    e1 = np.cross(up, a); e1 /= np.linalg.norm(e1); e2 = np.cross(up, e1)
    h = X @ up
    lo1, hi1 = np.percentile(X @ e1, [1, 99]); lo2, hi2 = np.percentile(X @ e2, [1, 99])
    floor = float(np.percentile(h, 1.5)); ceil = float(np.percentile(h, 99))
    fpu = ceiling_ft / (ceil - floor)
    ftw = float((hi1 - lo1) * fpu); fth = float((hi2 - lo2) * fpu)
    W = int(ftw * pxm) + 1; H = int(fth * pxm) + 1

    Pc = cams - c
    fxs = (Pc @ e1 - lo1) * fpu; fys = (Pc @ e2 - lo2) * fpu
    seg = np.r_[0.0, np.hypot(np.diff(fxs), np.diff(fys))]; cum = np.cumsum(seg)
    picks, nextd = [], 0.0
    for i in range(len(cum)):
        if cum[i] >= nextd:
            picks.append(i); nextd = cum[i] + step_ft
    cap = cv2.VideoCapture(vid)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0; nfr = cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0
    ts = T[:, 0].copy()
    if nfr and ts.max() > (nfr / fps) * 2:
        ts = ts / fps

    def floor_uv_to_feet(u, v, C, R, shift):
        u0 = (u - shift) % 1.0
        lon = lonsign * (u0 - 0.5) * 2 * np.pi
        lat = (0.5 - v) * np.pi
        rc = np.array([np.cos(lat) * np.sin(lon), -yflip * np.sin(lat), np.cos(lat) * np.cos(lon)])
        rw = R.T @ rc; denom = rw @ up
        if abs(denom) < 1e-4:
            return None
        t = (floor - (C @ up)) / denom
        if t <= 0:
            return None
        p = C + t * rw
        return [(p @ e1 - lo1) * fpu, (p @ e2 - lo2) * fpu]

    def px(p):
        return (int(np.clip(p[0] / ftw * (W - 1), 0, W - 1)), int(np.clip(p[1] / fth * (H - 1), 0, H - 1)))

    occ = np.zeros((H, W), np.float32); used = 0
    for i in picks:
        cap.set(cv2.CAP_PROP_POS_MSEC, float(ts[i]) * 1000.0)
        ok, fr = cap.read()
        if not ok:
            continue
        pano = cv2.resize(fr, (1024, 512)); cv2.imwrite("/tmp/p.png", pano)
        subprocess.run(["python", "preprocess.py", "--img_glob", "/tmp/p.png", "--output_dir", "/tmp/al/"],
                       cwd="/horizon", capture_output=True, text=True)
        al = glob.glob("/tmp/al/p_aligned_rgb.png")
        if not al:
            continue
        r = subprocess.run(["python", "inference.py", "--pth", "/horizon/ckpt/resnet50_rnn__zind.pth",
                            "--img_glob", al[0], "--output_dir", "/tmp/out/"], cwd="/horizon", capture_output=True, text=True)
        jp = "/tmp/out/p_aligned_rgb.json"
        if r.returncode != 0 or not os.path.exists(jp):
            continue
        aligned = cv2.imread(al[0])
        oa = cv2.cvtColor(pano, cv2.COLOR_BGR2GRAY)[200:312].mean(0)
        ob = cv2.cvtColor(aligned, cv2.COLOR_BGR2GRAY)[200:312].mean(0)
        cc = np.fft.irfft(np.fft.rfft(oa - oa.mean()) * np.conj(np.fft.rfft(ob - ob.mean())), n=len(oa))
        shift = float(np.argmax(cc)) / len(oa)
        lay = json.loads(open(jp).read())
        C = T[i, 1:4] - c; R = _quat2rot(T[i, 4:8])
        cam_ft = [float((Pc[i] @ e1 - lo1) * fpu), float((Pc[i] @ e2 - lo2) * fpu)]
        poly = []
        for (u, v) in lay["uv"][1::2]:
            p = floor_uv_to_feet(u, v, C, R, shift)
            if p is None:
                continue
            dd = float(np.hypot(p[0] - cam_ft[0], p[1] - cam_ft[1]))
            if maxd_ft > 0 and dd > maxd_ft:                       # lens blows far corners out; clamp to reliable range
                p = [cam_ft[0] + (p[0] - cam_ft[0]) * maxd_ft / dd, cam_ft[1] + (p[1] - cam_ft[1]) * maxd_ft / dd]
            poly.append(px(p))
        if len(poly) >= 3:
            cv2.fillPoly(occ, [np.array(poly, np.int32)], 1.0)     # accumulate this frame's reliable floor patch
            used += 1
    cap.release()

    occ = cv2.GaussianBlur(occ, (0, 0), pxm * 0.2)
    mask = (occ >= max(1.0, occ.max() * 0.12)).astype(np.uint8) * 255
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (int(pxm * 0.8) | 1, int(pxm * 0.8) | 1))
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, k)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, k)
    cnts, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    foot = []
    if cnts:
        big = max(cnts, key=cv2.contourArea)
        ap = cv2.approxPolyDP(big, 0.01 * cv2.arcLength(big, True), True)
        foot = [[round(float(p[0][0] / (W - 1) * ftw), 2), round(float(p[0][1] / (H - 1) * fth), 2)] for p in ap]

    base = np.full((H, W, 3), 250, np.uint8)
    try:
        s3.download_file(R2_BUCKET, f"ortho/{slug}.jpg", "/tmp/o.jpg")
        ph = cv2.imread("/tmp/o.jpg")
        if ph is not None:
            base = cv2.resize(ph, (W, H))
    except Exception:
        pass
    heat = cv2.applyColorMap((np.clip(occ / max(occ.max(), 1e-6), 0, 1) * 255).astype(np.uint8), cv2.COLORMAP_JET)
    viz = cv2.addWeighted(base, 0.6, heat, 0.4, 0)
    if foot:
        pts = np.array([px([f[0], f[1]]) for f in foot], np.int32)
        cv2.polylines(viz, [pts], True, (255, 255, 255), 4, cv2.LINE_AA)
        cv2.polylines(viz, [pts], True, (20, 20, 20), 2, cv2.LINE_AA)
    cv2.imwrite("/tmp/fm.jpg", viz, [cv2.IMWRITE_JPEG_QUALITY, 90])
    s3.upload_file("/tmp/fm.jpg", R2_BUCKET, f"layout/{slug}/floormap.jpg")
    s3.put_object(Bucket=R2_BUCKET, Key=f"layout/{slug}/floor.json",
                  Body=json.dumps({"footprint": foot, "ftw": round(ftw, 2), "fth": round(fth, 2), "frames": int(used)}).encode(),
                  ContentType="application/json")
    print(f"[floormap] {slug}: {used} frames -> footprint {len(foot)} pts, {round(ftw,1)}x{round(fth,1)}ft -> floormap.jpg")
    return {"frames": int(used), "footprint_pts": int(len(foot)), "ft": [round(ftw, 1), round(fth, 1)]}


@app.local_entrypoint()
def floormap(slug: str, video_key: str, ceiling_ft: float = 9.0, step_ft: float = 2.0):
    """modal run modal_app.py::floormap --slug scottsdale-fly --video-key projects/.../standard.mp4 --ceiling-ft 8.5"""
    print(make_floormap.remote(slug, video_key, ceiling_ft=ceiling_ft, step_ft=step_ft))


@app.local_entrypoint()
def topdown(slug: str, ceiling_ft: float = 9.0):
    """Interior stripped top-down from the dense colored cloud (ceiling sliced):
        modal run modal_app.py::topdown --slug scottsdale-fly --ceiling-ft 8.5"""
    print(make_topdown.remote(slug, ceiling_ft=ceiling_ft))


@app.local_entrypoint()
def render(slug: str, video_key: str, ceiling_ft: float = 9.0):
    """Photo-like top-down: color each floor cell from the real frame that saw it most directly:
        modal run modal_app.py::render --slug scottsdale-fly --video-key projects/old-town-scottsdale-home/video/standard.mp4 --ceiling-ft 8.5"""
    print(make_render.remote(slug, video_key, ceiling_ft=ceiling_ft))


@app.local_entrypoint()
def fused(slug: str, video_key: str, ceiling_ft: float = 9.0, pxm: float = 64.0):
    """Nadir-weighted FLAT-floor fusion — pulls each cell's colour from the most straight-down
    clean frame that saw it (clean floor, minimal wall-smear; Justin's visual-ref approach):
        modal run modal_app.py::fused --slug scottsdale-fly --video-key projects/old-town-scottsdale-home/video/standard.mp4 --ceiling-ft 8.5"""
    print(make_fused.remote(slug, video_key, ceiling_ft=ceiling_ft, pxm=pxm))


@app.function(secrets=[cb_secret])
def cbtest() -> dict:
    """Diagnose the callback path: show the URL + the raw response so we can tell an Access
    page / WAF block / app response apart."""
    import urllib.request
    import urllib.error
    import hashlib
    url = os.environ.get("LVX_CALLBACK_URL", "")
    tok = os.environ.get("LVX_CALLBACK_TOKEN", "").strip()
    out = {"url": url, "token_set": bool(tok), "token_len": len(tok),
           "token_fp": hashlib.sha256(tok.encode()).hexdigest()[:12]}
    req = urllib.request.Request(
        url,
        headers={"user-agent": _UA, "x-lvx-token": tok, "authorization": f"Bearer {tok}"},
        method="GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            out["status"] = r.status
            out["body"] = r.read(600).decode("utf-8", "ignore")
    except urllib.error.HTTPError as e:
        out["status"] = e.code
        out["server"] = e.headers.get("server", "")
        out["cf_mitigated"] = e.headers.get("cf-mitigated", "")
        out["body"] = e.read(900).decode("utf-8", "ignore")
    except Exception as e:
        out["status"] = "err"
        out["body"] = str(e)
    return out


@app.local_entrypoint()
def cbtest_run():
    import json as _j
    print(_j.dumps(cbtest.remote(), indent=2)[:1600])


@app.function(image=node_image, secrets=[r2_secret], timeout=1800)
def fuse_localized(slug: str, stills_json: str, vslam_slug: str, overview_key: str,
                   ceiling_ft: float = 9.0, maxd: float = 14.0) -> dict:
    """CPU node stage of the one-click chain: the localized fusion + de-overlap + aerial base,
    server-side. Reads still_layout's output (stills_json) + localize.json (R2) + the overview
    still (R2), runs the plan-extract scripts, returns the finished plan + base for delivery."""
    import os
    import json
    import base64
    import subprocess
    s3 = _r2()
    pe = "/opt/plan-extract"
    wd = f"/tmp/{slug}"; os.makedirs(wd, exist_ok=True)
    open(f"{wd}/_stills_layout.json", "w").write(stills_json)
    s3.download_file(R2_BUCKET, f"layout/{vslam_slug}/localize.json", f"{wd}/localize.json")
    ov = f"{wd}/overview.jpg"; s3.download_file(R2_BUCKET, overview_key, ov)

    def run(*a):
        r = subprocess.run(["node", *a], cwd=pe, capture_output=True, text=True)
        if r.returncode != 0:
            raise RuntimeError(f"node {os.path.basename(a[0])} failed: {r.stderr[-400:]}")
        print(f"[fuse] {os.path.basename(a[0])}: {r.stdout.strip()[-200:]}")

    run(f"{pe}/stills-localized-plan.mjs", f"{wd}/_stills_layout.json", f"{wd}/localize.json",
        f"{wd}/plan.json", "--ceil", str(ceiling_ft), "--maxD", str(maxd))
    run(f"{pe}/shape-snap.mjs", f"{wd}/plan.json", f"{wd}/snap.json", "--kgps", "0.08")
    run(f"{pe}/aerial-to-base.mjs", ov, f"{wd}/snap.json", "--out", f"{wd}/based.json")
    plan = open(f"{wd}/based.json").read()
    base_b64 = base64.b64encode(open(f"{wd}/based-base.jpg", "rb").read()).decode()
    return {"plan_json": plan, "base_b64": base_b64}


@app.function(image=test_image, secrets=[r2_secret, cb_secret], timeout=7200)
def process_floorplan(slug: str, ceiling_ft: float = 9.0) -> dict:
    """ONE-CLICK: a project's stills + flythrough -> localized, georeferenced floorplan -> delivered
    onto the project (callback writes it to D1). Discovers inputs from R2 projects/{slug}/."""
    s3 = _r2()
    resp = s3.list_objects_v2(Bucket=R2_BUCKET, Prefix=f"projects/{slug}/")
    keys = [o["Key"] for o in resp.get("Contents", [])]
    stills = [k for k in keys if "/still/" in k and k.lower().endswith((".jpg", ".jpeg"))]
    videos = [k for k in keys if "/video/" in k and k.lower().endswith((".mp4", ".mov", ".m4v"))]
    if not stills or not videos:
        _notify({"slug": slug, "status": "failed", "error": "need stills + a flythrough video in the project"})
        return {"error": "missing inputs", "stills": len(stills), "videos": len(videos)}
    flythrough = sorted(videos)[0]
    vslam_slug = f"{slug}-fly"
    print(f"[process_floorplan] {slug}: {len(stills)} stills, flythrough {flythrough}")

    sl = still_layout.remote(slug)                                  # HorizonNet + GPS per still
    rooms = sl.get("stills", [])
    if not rooms:
        _notify({"slug": slug, "status": "failed", "error": "still_layout produced nothing"})
        return {"error": "no still layouts"}
    ov = max(rooms, key=lambda s: s.get("relAlt") or 0)            # overview = highest AGL still
    ov_key = next((k for k in stills if ov["name"] in k), sorted(stills)[0])
    import json
    stills_json = json.dumps(rooms)

    run_vslam.remote(flythrough, vslam_slug)                        # VSLAM the flythrough
    localize_stills.remote(vslam_slug, flythrough, stills_prefix=f"projects/{slug}/still/")
    fz = fuse_localized.remote(slug, stills_json, vslam_slug, ov_key, ceiling_ft=ceiling_ft)
    d = deliver_plan.remote(slug, fz["plan_json"], fz["base_b64"])  # upload + callback -> D1
    print(f"[process_floorplan] {slug}: delivered {d}")
    return {"slug": slug, "delivered": d}


@app.local_entrypoint()
def floorplan(slug: str, ceiling_ft: float = 9.0):
    """modal run modal_app.py::floorplan --slug old-town-scottsdale-home --ceiling-ft 8.5"""
    print(process_floorplan.remote(slug, ceiling_ft=ceiling_ft))
