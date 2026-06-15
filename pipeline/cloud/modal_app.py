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
def _notify(payload: dict):
    url = os.environ.get("LVX_CALLBACK_URL")
    if not url:
        print("[callback] no LVX_CALLBACK_URL set, skipping:", payload)
        return
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode(),
        headers={"content-type": "application/json",
                 "authorization": f"Bearer {os.environ.get('LVX_CALLBACK_TOKEN', '')}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            print("[callback]", r.status, payload.get("slug"))
    except Exception as e:
        print("[callback] failed:", e)


@app.function(secrets=[cb_secret], timeout=4200)
def process(job: dict) -> dict:
    """One full job: VSLAM -> floor -> callback. Sequential (floor needs the .ply)."""
    slug, r2_key = job["slug"], job["r2_key"]
    try:
        v = run_vslam.remote(r2_key, slug)
        f = make_floor.remote(slug, scale=float(job.get("scale", 1.0)),
                              cut=float(job.get("cut", 1.5)), pxm=int(job.get("pxm", 50)))
        payload = {"slug": slug, "status": "ready", **v, **f}
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
    if not job.get("slug") or not job.get("r2_key"):
        return JSONResponse({"error": "need slug + r2_key"}, status_code=400)
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
               blend: int = 0) -> dict:
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
    out = "/tmp/ortho.jpg"
    cv2.imwrite(out, cv2.cvtColor(img, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, 90])
    key = f"ortho/{slug}.jpg"
    s3.upload_file(out, R2_BUCKET, key)
    print(f"[ortho] {slug}: {W}x{H}px from {used} keyframes ({int(hit.mean()*100)}% filled) -> R2 {key}")
    return {"ortho": key, "px": [W, H], "keyframes_used": used, "filled_pct": int(hit.mean() * 100)}


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


@app.local_entrypoint()
def main(r2_key: str, slug: str, scale: float = 1.0):
    """CLI smoke test:  modal run modal_app.py --r2-key uploads/1112.mp4 --slug apartment-1112"""
    print(process.remote({"r2_key": r2_key, "slug": slug, "scale": scale}))
