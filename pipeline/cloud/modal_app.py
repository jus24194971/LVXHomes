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

# Image for the LaMa AI inpaint stage — resolution-robust large-mask fill of the nadir gaps (#71).
lama_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("libgl1", "libglib2.0-0")
    .pip_install("torch", "torchvision", "numpy", "pillow",
                 "opencv-python-headless", "boto3", "simple-lama-inpainting")
    # bake the big-lama weights into the image (downloads on CPU at build; runs on GPU at call)
    .run_commands("python -c 'from simple_lama_inpainting import SimpleLama; SimpleLama()' || echo 'lama preload skipped (will download at runtime)'")
)

# Image for the 3D Gaussian Splatting stage — learned geometry for the photoreal dollhouse.
# torch + gsplat (nerfstudio-project) on CUDA; prebuilt wheel matched to torch2.4/cu124 when
# available, else a source build (the -devel base has nvcc; arch list covers A10G/A100/L4).
gsplat_image = (
    modal.Image.from_registry("pytorch/pytorch:2.4.0-cuda12.4-cudnn9-devel")
    .env({"DEBIAN_FRONTEND": "noninteractive", "TZ": "Etc/UTC",
          "TORCH_CUDA_ARCH_LIST": "8.0;8.6;8.9"})   # set BEFORE any gsplat JIT compile
    .apt_install("git", "libgl1", "libglib2.0-0", "build-essential", "ninja-build")
    .pip_install("numpy<2", "scipy", "opencv-python-headless", "boto3", "pillow",
                 "jaxtyping", "rich", "typing_extensions", "ninja")
    .run_commands(
        "pip install gsplat==1.4.0 --index-url https://docs.gsplat.studio/whl/pt24cu124 --no-deps"
        " || pip install gsplat==1.4.0 --no-build-isolation",
        # AOT-compile the CUDA backend at BUILD time (nvcc only, no GPU needed; arch list
        # above) — otherwise every fresh container pays a ~8 min JIT on first import.
        "python -c \"from gsplat.cuda._backend import _C; print('gsplat CUDA backend compiled:', _C is not None)\"",
    )
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
            return process_floorplan.remote(slug, ceiling_ft=ceiling_ft,
                                            video_key=video_key or "",
                                            srt_key=job.get("srt_key") or "")
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
    vid = f"{sd}/hires.mp4"      # 4K texture proxy first (slam.mp4 = 1920x960 was a softness leak)
    if not os.path.exists(vid):
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
               ceil_cut: float = 0.9, yflip: int = 1, lonsign: int = 1, cone_deg: float = 60.0,
               depth: int = 1, fill: int = 1) -> dict:
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
    vid = f"{sd}/hires.mp4"      # full-res seek-friendly TEXTURE proxy (make_proxy) — #67
    if not os.path.exists(vid):
        vid = f"{sd}/slam.mp4"   # fallback: the 1920x960 tracking clip (soft texture)
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
    W = min(4096, int((hi1 - lo1) * pxm) + 1); H = min(4096, int((hi2 - lo2) * pxm) + 1)

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
        # bilinear (int-cast nearest-neighbor was a verified softness leak); u wraps, v clamps
        uf = (((lon / (2 * np.pi)) + 0.5) * Wv) % Wv
        vf = np.clip((0.5 - lat / np.pi) * Hv, 0, Hv - 1.001)
        x0 = np.floor(uf).astype(np.int32); x1 = (x0 + 1) % Wv
        y0 = np.floor(vf).astype(np.int32); y1 = np.minimum(y0 + 1, Hv - 1)
        fx = (uf - x0).astype(np.float32)[:, None]; fy = (vf - y0).astype(np.float32)[:, None]
        col = (fr[y0, x0] * (1 - fx) * (1 - fy) + fr[y0, x1] * fx * (1 - fy)
               + fr[y1, x0] * (1 - fx) * fy + fr[y1, x1] * fx * fy)
        return np.clip(col, 0, 255).astype(np.uint8), ray

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

    # composite: nadir base; depth fills gaps UNLESS disabled (nadir-only clean mode for the AI fill)
    out = np.zeros((len(idx), 3), np.uint8)
    hasn = nW > 0.05; hasd = (dW > 0.05) if depth else np.zeros(len(idx), bool)
    if depth:
        out[hasd] = dC[hasd]                             # depth-fill (smears 3D content -> the "tears")
    out[hasn] = nC[hasn]                                 # nadir overwrites depth (clean straight-down base)
    img = np.zeros((H * W, 3), np.uint8); img[idx] = out
    hit = np.zeros(H * W, bool); hit[idx[hasn | hasd]] = True
    img = cv2.cvtColor(img.reshape(H, W, 3), cv2.COLOR_RGB2BGR)
    fm2 = cv2.morphologyEx(hit.reshape(H, W).astype(np.uint8), cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))
    cm = cv2.morphologyEx(fm2 * 255, cv2.MORPH_CLOSE, np.ones((31, 31), np.uint8))
    cnts, _ = cv2.findContours(cm, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    outline = np.zeros((H, W), np.uint8)
    if cnts:
        cv2.drawContours(outline, [max(cnts, key=cv2.contourArea)], -1, 255, -1)
    outm = outline > 0
    if not fill:
        # NADIR-ONLY CLEAN: no depth smear, no cv2 gap-inpaint. Leave gaps BLACK and emit a gap mask
        # (black cells inside the footprint) so LaMa can fill them with plausible floor. #71.
        img[~outm] = 0
        gap = (outm & (img.sum(2) == 0)).astype(np.uint8) * 255
        gap = cv2.morphologyEx(gap, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))   # drop pinpricks
        gap = cv2.dilate(gap, np.ones((5, 5), np.uint8))                          # let LaMa breathe past edges
        ck = f"ortho/{slug}_nadir_clean.png"; cv2.imwrite("/tmp/c.png", img); s3.upload_file("/tmp/c.png", R2_BUCKET, ck)  # lossless into LaMa (was a double-JPEG)
        gk = f"ortho/{slug}_gap.png"; cv2.imwrite("/tmp/g.png", gap); s3.upload_file("/tmp/g.png", R2_BUCKET, gk)
        npct = int(hasn.mean() * 100); gpct = int((gap > 0).mean() * 100)
        print(f"[fused nadir-clean] {slug}: {W}x{H}, nadir {npct}%, gaps {gpct}% -> {ck} + {gk}")
        return {"clean": ck, "gap": gk, "px": [int(W), int(H)], "nadir_pct": npct, "gap_pct": gpct}
    holes = (outm & (fm2 == 0)).astype(np.uint8)
    img = cv2.inpaint(img, holes, 6, cv2.INPAINT_NS)
    img[~outm] = 0
    # (medianBlur removed — it erased grout/wood-grain; bilinear sampling denoises enough)
    img = cv2.addWeighted(img, 1.25, cv2.GaussianBlur(img, (0, 0), 1.2), -0.25, 0)  # gentle sharpen
    img[~outm] = 0
    o = "/tmp/fused.jpg"; cv2.imwrite(o, img, [cv2.IMWRITE_JPEG_QUALITY, 95])
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
                    stills_prefix: str = "", srt_key: str = "", pin_radius_ft: float = 9.0) -> dict:
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

    # SINGLE-POINT capture pins (Justin's field-tagging workflow): one tap per still on
    # the CubiCasa plan at capture time -> projects/{project}/still_pins.json
    # {"space": "plan_norm", "pins": {uuid: [nx, ny]}} (normalized to the plan image).
    # With the plan alignment (layout/{slug}/plan_align.json, from _fitalign.py or hand
    # calibration) each pin becomes a floor-frame position prior, and the match search
    # shrinks from the WHOLE flight to frames within pin_radius_ft — no global visual
    # ambiguity. Yaw and all presentation (tour pin fade in/out) are derived downstream;
    # the tap is the only user input. No pins / no alignment -> global match as before.
    pin_ft = {}
    try:
        pkey = prefix.rsplit("still/", 1)[0] + "still_pins.json"
        pj = json.loads(s3.get_object(Bucket=R2_BUCKET, Key=pkey)["Body"].read())
        al = json.loads(s3.get_object(Bucket=R2_BUCKET,
                                      Key=f"layout/{slug}/plan_align.json")["Body"].read())
        FXa, FYa, FWa, FHa = al["FX"], al["FY"], al["FW"], al["FH"]
        ROTa, FLIPa = al["ROT"], al.get("FLIPH", True)
        CXa, CYa, CWa, CHa = al.get("CX", 0.0), al.get("CY", 0.0), al["CW"], al["CH"]
        cxa = FXa + FWa / 2.0; cya = FYa + FHa / 2.0
        tha = np.radians(ROTa); ca, sa = np.cos(-tha), np.sin(-tha)
        for nm, xy in (pj.get("pins") or {}).items():
            sx = float(xy[0]) * CWa + CXa                     # plan_norm -> plan canvas ft
            sy = float(xy[1]) * CHa + CYa
            dx = sx - cxa; dy = sy - cya                      # same forward map as the plansheet
            p1x = cxa + ca * dx - sa * dy
            p1y = cya + sa * dx + ca * dy
            if FLIPa:
                p1x = 2 * cxa - p1x
            pin_ft[nm] = [(p1x - FXa) / FWa * ftw, (p1y - FYa) / FHa * fth]
        print(f"[localize] {len(pin_ft)} capture pins loaded (radius {pin_radius_ft} ft)")
    except Exception as e:
        print(f"[localize] no capture pins in play ({type(e).__name__}) — global matching")
    out = {}
    for key in keys:
        name = os.path.splitext(os.path.basename(key))[0]
        dl = f"/tmp/s_{name}.jpg"; s3.download_file(R2_BUCKET, key, dl)
        im = cv2.imread(dl)
        if im is None:
            continue
        g = cv2.cvtColor(cv2.resize(im, (1024, 512)), cv2.COLOR_BGR2GRAY)
        _, sdes = orb.detectAndCompute(g, None)
        pf = pin_ft.get(name)
        cand = frames
        if pf is not None:                                    # pin -> local search only
            near = [f for f in frames
                    if (f[2][0] - pf[0]) ** 2 + (f[2][1] - pf[1]) ** 2 < pin_radius_ft ** 2]
            if len(near) >= 3:
                cand = near
        best_feet, best_fi, best_cnt, best_head = None, -1, -1, None
        for fi, fdes, feet, fhead in cand:
            matches = bf.knnMatch(sdes, fdes, k=2)
            good = sum(1 for mm in matches if len(mm) == 2 and mm[0].distance < 0.75 * mm[1].distance)
            if good > best_cnt:
                best_cnt, best_feet, best_fi, best_head = good, feet, fi, fhead
        out[name] = {"frame": int(best_fi), "feet": [round(best_feet[0], 2), round(best_feet[1], 2)], "matches": int(best_cnt)}
        if best_head is not None:
            out[name]["head"] = round(best_head, 1)
        if pf is not None:
            out[name]["pin_ft"] = [round(pf[0], 2), round(pf[1], 2)]
            out[name]["pinned"] = bool(cand is not frames)
        print(f"[localize] {name}: frame {best_fi} ({best_cnt} matches"
              f"{', pinned ' + str(len(cand)) + ' cand' if pf is not None and cand is not frames else ''})"
              f" -> ({out[name]['feet'][0]}, {out[name]['feet'][1]}) ft")

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


@app.function(image=vslam_image, gpu="T4", volumes={"/scratch": vol}, secrets=[r2_secret], timeout=3600)
def make_proxy(slug: str, video_key: str = "", maxw: int = 4096, gop: int = 15, crf: int = 20,
               src_name: str = "raw.mp4", out_name: str = "hires.mp4", use_gpu: bool = True) -> dict:
    """Render a full-res, seek-friendly proxy of a capture on the volume (#67).
    slam.mp4 is downscaled to 1920x960 for tracking — too soft for a crisp floor texture.
    The raw 4K/5.7K HEVC is sharp but seeks glacially in OpenCV (decode-from-keyframe on a
    long GOP) -> the texture pass times out the Modal worker. Fix: re-encode the source ONCE to
    H.264 at native-or-4K with a TIGHT, uniform GOP (cheap MSEC seeks), cache on the volume.
    Default raw.mp4 -> hires.mp4 (equirect texture). Also used for the 4K nadir reframe
    (src_name=nadir4k.mp4 -> out_name=nadir_hires.mp4), which OpenCV would otherwise seek too slowly."""
    import os
    import json as _json
    import subprocess

    vol.reload()
    sd = f"/scratch/{slug}"; os.makedirs(sd, exist_ok=True)
    src = f"{sd}/{src_name}"
    if not os.path.exists(src):
        if not video_key:
            raise RuntimeError(f"no {src_name} on volume for {slug}; pass --video-key to pull from R2")
        src = "/tmp/src.mp4"; _r2().download_file(R2_BUCKET, video_key, src)

    out = f"{sd}/{out_name}"
    # cap width at maxw, NEVER upscale, PRESERVE aspect (-2 = auto even height) — works for both the
    # 2:1 equirect and the 16:9 nadir reframe; uniform tight GOP for cheap MSEC seeks.
    sc = f"scale='min({maxw},iw)':-2"
    cpu_cmd = ["ffmpeg", "-y", "-i", src, "-vf", sc,
               "-c:v", "libx264", "-preset", "veryfast", "-crf", str(crf),
               "-x264-params", f"keyint={gop}:min-keyint={gop}:scenecut=0",
               "-pix_fmt", "yuv420p", "-an", out]
    # GPU path: NVDEC decode + NVENC encode — the heavy cost is decoding 10-bit 4K/6K HEVC, which
    # -hwaccel cuda offloads to the GPU; h264_nvenc encodes on-chip (10-20x the CPU x264 throughput).
    # Uniform tight GOP, no B-frames -> cheap cv2 MSEC seeks. Falls back to CPU x264 if NVENC is absent.
    gpu_cmd = ["ffmpeg", "-y", "-hwaccel", "cuda", "-i", src,
               "-vf", f"{sc},format=yuv420p",
               "-c:v", "h264_nvenc", "-preset", "p4", "-cq", str(crf),
               "-g", str(gop), "-bf", "0", "-an", out]
    mode = "cpu(x264)"
    if use_gpu:
        enc = subprocess.run(["ffmpeg", "-hide_banner", "-encoders"], capture_output=True, text=True).stdout
        if "h264_nvenc" in enc:
            try:
                subprocess.run(gpu_cmd, check=True, capture_output=True, text=True)
                mode = "gpu(nvenc)"
            except subprocess.CalledProcessError as e:
                print(f"[proxy] nvenc failed -> CPU fallback: {(e.stderr or '')[-400:]}")
                subprocess.run(cpu_cmd, check=True)
        else:
            print("[proxy] h264_nvenc not in this ffmpeg build -> CPU x264")
            subprocess.run(cpu_cmd, check=True)
    else:
        subprocess.run(cpu_cmd, check=True)
    vol.commit()

    dims = {}
    try:
        pr = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "v:0",
             "-show_entries", "stream=width,height", "-of", "json", out],
            capture_output=True, text=True,
        )
        st = _json.loads(pr.stdout)["streams"][0]; dims = {"w": st.get("width"), "h": st.get("height")}
    except Exception:
        pass
    mb = round(os.path.getsize(out) / 1e6, 1)
    print(f"[proxy] {slug}: {dims} {mb} MB seek-friendly H.264 via {mode} -> {out}")
    return {"hires": out, "mb": mb, "mode": mode, **dims}


@app.local_entrypoint()
def proxy(slug: str, video_key: str = "", src_name: str = "raw.mp4", out_name: str = "hires.mp4",
          use_gpu: bool = True):
    """Render a seek-friendly proxy once, cached on the volume (NVENC on GPU, CPU x264 fallback):
        modal run modal_app.py::proxy --slug scottsdale-fly                                  # raw.mp4 -> hires.mp4
        modal run modal_app.py::proxy --slug scottsdale-fly --src-name nadir4k.mp4 --out-name nadir_hires.mp4"""
    print(make_proxy.remote(slug, video_key, src_name=src_name, out_name=out_name, use_gpu=use_gpu))


@app.function(image=ortho_image, secrets=[r2_secret], volumes={"/scratch": vol}, timeout=3600,
              memory=10240)
def make_nadir_mosaic(slug: str, nadir_name: str = "nadir_hires.mp4", ceiling_ft: float = 9.0,
                      pxm: float = 80.0, fov_deg: float = 79.5, fov_axis: str = "h", yaw_off: float = 0.0,
                      t_off: float = 0.0, sx: int = 1, sy: int = 1, swap: int = 0,
                      frame_step: int = 2, feather: float = 4.0, gain: int = 1, sharp_gate: int = 1,
                      mode: str = "select") -> dict:
    """Drape a true-NADIR 4K reframe onto the VSLAM poses we already solved for THIS flight (#67).
    v2 (orthomosaic-grade): SEQUENTIALLY decodes ALL frames (no seek subsampling), gates out
    motion-blurred frames (rolling-median Laplacian variance), FEATHER-BLENDS every observation
    (w^feather center-weighted accumulation — kills the winner-take-all seams/serration), applies
    incremental GAIN COMPENSATION per frame against the mosaic built so far (kills auto-exposure
    patchwork), samples bilinearly, and writes a LOSSLESS PNG + gap mask for LaMa.
    Projection stays the validated yaw-only model: the DJI reframe is synthetically locked to true
    nadir, so residual tilt is already removed in the video itself. SAME feet frame as make_fused."""
    import os
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
    vid = f"{sd}/{nadir_name}"
    if not os.path.exists(vid):
        raise RuntimeError(f"nadir proxy not staged: {vid} (run proxy --src-name nadir4k.mp4 --out-name {nadir_name})")

    # floor frame — IDENTICAL derivation to make_fused so the mosaic registers with everything
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
    fpu = ceiling_ft / room if room > 0 else 1.0
    W = min(6000, int((hi1 - lo1) * pxm) + 1); H = min(6000, int((hi2 - lo2) * pxm) + 1)
    span1 = hi1 - lo1; span2 = hi2 - lo2

    cap = cv2.VideoCapture(vid)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    nfr = cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0
    Hv = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)); Wv = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    if not Wv or not Hv:
        raise RuntimeError(f"could not open nadir video: {vid}")
    half = np.radians(fov_deg) / 2.0                      # f_px is what matters; pixels are square (SAR 1:1)
    if fov_axis == "v":
        f_px = (Hv / 2.0) / np.tan(half)
    elif fov_axis == "d":
        f_px = (np.hypot(Wv, Hv) / 2.0) / np.tan(half)
    else:                                                 # "h" — horizontal FOV (typical reframe spec)
        f_px = (Wv / 2.0) / np.tan(half)
    ts = T[:, 0].copy()
    if nfr and ts.max() > (nfr / fps) * 2:
        ts = ts / fps

    # precompute poses once — v2 decodes the whole video sequentially and looks up the
    # nearest pose per FRAME (the tight-GOP proxy makes sequential decode cheap; seeks were
    # what forced the old ~700-frame subsample)
    Rm = np.array([_quat2rot(q) for q in T[:, 4:8]])
    Cm = T[:, 1:4] - c
    pose_ok = np.isfinite(Cm).all(1) & np.isfinite(Rm.reshape(len(T), -1)).all(1)
    # Track smoothing OFF by default (ksm=0): tested on the serpentine Scottsdale flight, a boxcar
    # lags the true track into the inside of every turn and WORSENS tile registration. Keep the
    # hook for straight-line survey flights only.
    ksm = 0
    if ksm and len(Cm) > 2 * ksm:
        Cs = Cm.copy()
        good = pose_ok.astype(np.float64)
        for ax in range(3):
            v = np.where(pose_ok, Cm[:, ax], 0.0)
            num = np.convolve(v, np.ones(ksm), mode="same")
            den = np.convolve(good, np.ones(ksm), mode="same")
            Cs[:, ax] = np.where(den > 0, num / np.maximum(den, 1e-9), Cm[:, ax])
        Cm = np.where(pose_ok[:, None], Cs, Cm)

    # INSTANTANEOUS heading: the reframe is drone-yaw-locked (verified on this capture — total
    # yaw excursion ~3 deg), so the raw per-pose heading is the correct rotation. Smoothing it was
    # tested and REGRESSES: it adds ~1-2 deg of tile-to-tile rotational mismatch (radial fans).
    fwd_all = Rm @ np.array([0.0, 0.0, 1.0])
    fh = fwd_all - np.outer(fwd_all @ up, up)
    psi_raw = np.arctan2(fh @ e2, fh @ e1)
    psi_s = np.unwrap(np.where(np.isfinite(psi_raw), psi_raw, 0.0))

    p = float(feather)
    select = (mode == "select")
    # select: per-cell ARGMAX (v1's proven-sharp semantics — blending exposes residual pose error
    # as smear, selection hides it) with v2's gates/gain on top. blend: w^p feathered accumulation.
    acc = np.zeros((H * W, 3), np.float32)   # blend: weighted color sum | select: winning color
    accw = np.zeros(H * W, np.float32)       # blend: weight sum         | select: best weight
    used = 0; skip_blur = 0; reg_hits = 0
    drift1 = 0.0; drift2 = 0.0               # running frame->mosaic registration correction (plan units)
    sharps = []
    fi = -1; last_pi = -1
    while True:
        ok, fr = cap.read()
        if not ok:
            break
        fi += 1
        if fi % max(1, frame_step):
            continue
        t = fi / fps + t_off
        pi = int(np.searchsorted(ts, t))
        if pi >= len(ts):
            pi = len(ts) - 1
        if pi > 0 and abs(float(ts[pi - 1]) - t) < abs(float(ts[pi]) - t):
            pi -= 1
        if abs(float(ts[pi]) - t) > 1.5 / fps or not pose_ok[pi]:
            continue                                       # tracking lost around this frame
        if pi == last_pi:
            continue                                       # same pose as previous frame — painting it
        last_pi = pi                                       # twice just adds misregistered content
        C = Cm[pi]; R = Rm[pi]
        h = float(C @ up - floor)
        # takeoff/landing gate must be SCALE-RELATIVE: monocular VSLAM units are arbitrary
        # (review-confirmed: absolute 0.3 could silently blank a small-scale reconstruction)
        if not np.isfinite(h) or h < (1.5 / ceiling_ft) * room:   # ~1.5 ft above floor
            continue
        psi = float(psi_s[pi]) + np.radians(yaw_off)       # SMOOTHED heading (matches the reframe)
        cps, sps = np.cos(psi), np.sin(psi)
        Ce1 = float(C @ e1) + drift1; Ce2 = float(C @ e2) + drift2   # registration-corrected placement
        if sharp_gate:
            # rolling-median Laplacian variance: motion-blurred frames poison a blend, skip them
            g = cv2.cvtColor(cv2.resize(fr, (480, 270)), cv2.COLOR_BGR2GRAY)
            s = float(cv2.Laplacian(g, cv2.CV_64F).var())
            sharps.append(s)
            if len(sharps) > 30 and s < 0.55 * float(np.median(sharps[-121:])):
                skip_blur += 1
                continue

        def project(ce1, ce2):
            """Project this frame onto the canvas at camera-centre (ce1, ce2); bilinear gather."""
            fwid = h * (np.hypot(Wv, Hv) / 2.0) / f_px * 1.2
            a0 = int(np.clip((ce1 - fwid - lo1) / span1 * (W - 1), 0, W - 1))
            a1 = int(np.clip((ce1 + fwid - lo1) / span1 * (W - 1) + 1, 0, W))
            b0 = int(np.clip((ce2 - fwid - lo2) / span2 * (H - 1), 0, H - 1))
            b1 = int(np.clip((ce2 + fwid - lo2) / span2 * (H - 1) + 1, 0, H))
            if a1 <= a0 or b1 <= b0:
                return None
            sj, si = np.mgrid[b0:b1, a0:a1]
            gidx = (sj * W + si).ravel()
            sP1 = lo1 + si.ravel() / (W - 1) * span1
            sP2 = lo2 + sj.ravel() / (H - 1) * span2
            dxx = sP1 - ce1; dyy = sP2 - ce2
            u_cam = dxx * cps + dyy * sps
            v_cam = -dxx * sps + dyy * cps
            if swap:
                u_cam, v_cam = v_cam, u_cam
            u_img = Wv / 2.0 + sx * (f_px / h) * u_cam
            v_img = Hv / 2.0 + sy * (f_px / h) * v_cam
            inb = (u_img >= 0) & (u_img < Wv - 1) & (v_img >= 0) & (v_img < Hv - 1)
            if not inb.any():
                return None
            rr = np.sqrt((u_img - Wv / 2.0) ** 2 + (v_img - Hv / 2.0) ** 2) / (Hv / 2.0)
            w = np.clip(1.0 - 0.85 * rr, 0.0, 1.0).astype(np.float32) ** p
            w[~inb] = 0.0
            sel = w > 1e-6
            if not sel.any():
                return None
            uf = u_img[sel]; vf = v_img[sel]
            x0 = np.floor(uf).astype(np.int32); y0 = np.floor(vf).astype(np.int32)
            fx = (uf - x0).astype(np.float32)[:, None]; fy = (vf - y0).astype(np.float32)[:, None]
            c00 = fr[y0, x0].astype(np.float32); c10 = fr[y0, x0 + 1].astype(np.float32)
            c01 = fr[y0 + 1, x0].astype(np.float32); c11 = fr[y0 + 1, x0 + 1].astype(np.float32)
            col = c00 * (1 - fx) * (1 - fy) + c10 * fx * (1 - fy) + c01 * (1 - fx) * fy + c11 * fx * fy
            return gidx, sel, w, col, (b1 - b0, a1 - a0)

        res = project(Ce1, Ce2)
        if res is None:
            continue
        gidx, sel, w, col, (bh, bw) = res
        # REGISTER frame -> mosaic (blend mode only): residual pose drift leaves each tile a few
        # px off; phase-correlate this frame's projection against the mosaic already built in its
        # bbox and correct placement BEFORE accumulating (this is what lets blending stay sharp).
        seenb = accw[gidx] > 0.5
        if (not select) and int(seenb.sum()) > 3000:
            fp = np.zeros(bh * bw, np.float32)
            fp[sel] = col.mean(1)
            mp = np.zeros(bh * bw, np.float32)
            mp[seenb] = acc[gidx[seenb]].sum(1) / (3.0 * accw[gidx[seenb]])
            both = (fp > 0) & (mp > 0)
            if int(both.sum()) > 3000:
                fp[~both] = 0.0; mp[~both] = 0.0
                win = cv2.createHanningWindow((bw, bh), cv2.CV_32F)
                (shx, shy), resp = cv2.phaseCorrelate(mp.reshape(bh, bw), fp.reshape(bh, bw), win)
                if resp > 0.04 and abs(shx) < 18 and abs(shy) < 18 and (abs(shx) > 0.5 or abs(shy) > 0.5):
                    d1 = shx * span1 / (W - 1); d2 = shy * span2 / (H - 1)
                    drift1 -= 0.45 * d1; drift2 -= 0.45 * d2      # EMA drift carried to next frames
                    res2 = project(Ce1 - d1, Ce2 - d2)            # re-place THIS frame corrected
                    if res2 is not None:
                        gidx, sel, w, col, (bh, bw) = res2
                        reg_hits += 1
        used += 1
        gi = gidx[sel]; ws = w[sel]
        if gain:
            # incremental gain compensation: match this frame to the mosaic already built where
            # they overlap — auto-exposure flicker is the patchwork's root cause
            seen = accw[gi] > (0.15 if select else 0.5)
            if int(seen.sum()) > 400:
                if select:
                    mos = acc[gi[seen]].mean(1)
                else:
                    mos = acc[gi[seen]].sum(1) / (3.0 * accw[gi[seen]])
                cur = col[seen].mean(1) + 1e-3
                gval = float(np.clip(np.median(mos / cur), 0.75, 1.35))
                col *= gval
        if select:
            cand = ws > accw[gi]                    # v1's proven argmax: best view wins the cell
            if cand.any():
                gc = gi[cand]
                acc[gc] = col[cand]
                accw[gc] = ws[cand]
        else:
            acc[gi] += col * ws[:, None]
            accw[gi] += ws
    cap.release()

    covm = accw > 1e-6
    img = np.zeros((H * W, 3), np.float32)
    if select:
        img[covm] = acc[covm]
    else:
        img[covm] = acc[covm] / accw[covm, None]
    img = np.clip(img, 0, 255).astype(np.uint8).reshape(H, W, 3)   # frames stayed BGR throughout
    hit = covm.reshape(H, W).astype(np.uint8)
    fm = cv2.morphologyEx(hit, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))
    gapm = ((fm > 0) & (hit == 0)).astype(np.uint8) * 255          # for LaMa — no NS smear here
    img[fm == 0] = 0
    o = "/tmp/nadir.png"; cv2.imwrite(o, img)                      # LOSSLESS master
    key = f"ortho/{slug}_nadir.png"; s3.upload_file(o, R2_BUCKET, key)
    oj = "/tmp/nadir.jpg"; cv2.imwrite(oj, img, [cv2.IMWRITE_JPEG_QUALITY, 95])
    s3.upload_file(oj, R2_BUCKET, f"ortho/{slug}_nadir.jpg")       # quick-view copy
    gk = f"ortho/{slug}_nadir_gap.png"; cv2.imwrite("/tmp/ng.png", gapm); s3.upload_file("/tmp/ng.png", R2_BUCKET, gk)

    cov = int(covm.mean() * 100)
    ftw = round(float(span1 * fpu), 1); fth = round(float(span2 * fpu), 1)
    print(f"[nadir v2] {slug}: {W}x{H}, {used} frames blended ({skip_blur} blur-skipped, "
          f"{reg_hits} registration-corrected), {cov}% covered, feather^{p} gain{gain} step{frame_step}, "
          f"{ftw}x{fth}ft -> {key}")
    return {"ortho": key, "gap": gk, "px": [int(W), int(H)], "frames": int(used),
            "blur_skipped": int(skip_blur), "cov_pct": cov, "ft": [ftw, fth], "fov": fov_deg}


@app.local_entrypoint()
def nadir(slug: str, ceiling_ft: float = 9.0, pxm: float = 80.0, fov_deg: float = 79.5,
          fov_axis: str = "h", yaw_off: float = 0.0, t_off: float = 0.0, sx: int = 1, sy: int = 1,
          swap: int = 0, nadir_name: str = "nadir_hires.mp4", frame_step: int = 2,
          feather: float = 4.0, gain: int = 1, sharp_gate: int = 1, mode: str = "select"):
    """v2 orthomosaic of the true-nadir 4K reframe (all frames, blur-gated, argmax-SELECT by
    default — sharp by construction — with gain compensation; --mode blend for feathered):
        modal run modal_app.py::nadir --slug scottsdale-nadir --ceiling-ft 8.5 --pxm 100"""
    print(make_nadir_mosaic.remote(slug, nadir_name=nadir_name, ceiling_ft=ceiling_ft, pxm=pxm,
                                   fov_deg=fov_deg, fov_axis=fov_axis, yaw_off=yaw_off, t_off=t_off,
                                   sx=sx, sy=sy, swap=swap, frame_step=frame_step, feather=feather,
                                   gain=gain, sharp_gate=sharp_gate, mode=mode))


@app.function(image=ortho_image, secrets=[r2_secret], volumes={"/scratch": vol}, timeout=3600,
              memory=10240)
def make_furnish(slug: str, nadir_name: str = "nadir_hires.mp4", base_key: str = "",
                 ceiling_ft: float = 9.0, pxm: float = 100.0, fov_deg: float = 79.5,
                 yaw_off: float = 0.0, max_blobs: int = 60, ribbons: int = 0) -> dict:
    """FURNITURE-COHERENT composite (Justin's 'sample image' idea, #70):
    stack = complete LaMa floor (base) -> sharp nadir ribbons -> per-furniture SINGLE-VIEW patches.
    Furniture squishes in any mosaic because everything projects through the FLOOR plane; a couch
    seat 0.5 m up stretches differently in every tile. Here each furniture blob (from the dense
    cloud's height map) is re-projected from ONE most-overhead sharp frame at ITS OWN height plane
    (scale f/(h-z), not f/h) — one coherent, correctly-scaled photo per piece."""
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
    vid = f"{sd}/{nadir_name}"
    if not os.path.exists(vid):
        raise RuntimeError(f"nadir proxy not staged: {vid}")

    # identical floor frame to make_fused / make_nadir_mosaic (deterministic from the ply)
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
    fpu = ceiling_ft / room if room > 0 else 1.0
    W = min(6000, int((hi1 - lo1) * pxm) + 1); H = min(6000, int((hi2 - lo2) * pxm) + 1)
    span1 = hi1 - lo1; span2 = hi2 - lo2

    # DSM: top height per cell below a near-ceiling cut (walls kept, ceiling dropped)
    cut = floor + 0.9 * room
    keep = (hgt < cut) & (pxa >= lo1) & (pxa <= hi1) & (pya >= lo2) & (pya <= hi2)
    ix = np.clip(((pxa[keep] - lo1) / span1 * (W - 1)), 0, W - 1).astype(np.int64)
    iy = np.clip(((pya[keep] - lo2) / span2 * (H - 1)), 0, H - 1).astype(np.int64)
    hk = hgt[keep]; cell = iy * W + ix
    order = np.lexsort((hk, cell)); cs = cell[order]; hs = hk[order]
    last = np.ones(len(cs), bool)
    if len(cs) > 1:
        last[:-1] = cs[1:] != cs[:-1]
    dsm = np.full(H * W, np.nan, np.float32); dsm[cs[last]] = hs[last]
    occ = np.zeros(H * W, bool); occ[cell] = True
    fp = cv2.morphologyEx(occ.reshape(H, W).astype(np.uint8) * 255, cv2.MORPH_CLOSE,
                          np.ones((15, 15), np.uint8)) > 0
    d8 = np.where(np.isnan(dsm), 0, np.clip((dsm - floor) / max(room, 1e-6), 0, 1) * 255).astype(np.uint8)
    d8 = d8.reshape(H, W)
    d8 = cv2.inpaint(d8, (np.isnan(dsm).reshape(H, W) & fp).astype(np.uint8), 5, cv2.INPAINT_TELEA)
    d8 = cv2.medianBlur(d8, 5)
    hrel = d8.astype(np.float32) / 255.0                      # 0..1 of room height, per cell

    # furniture band: above trip-hazard, below counter-top+ (walls ~1.0 excluded)
    fmask = ((hrel > 0.05) & (hrel < 0.68) & fp).astype(np.uint8) * 255
    fmask = cv2.morphologyEx(fmask, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
    fmask = cv2.morphologyEx(fmask, cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8))
    px_per_ft = pxm / fpu
    min_area = int((1.0 * px_per_ft) ** 2)                    # ignore blobs smaller than ~1x1 ft
    nb, lab, st, cent = cv2.connectedComponentsWithStats(fmask)

    # base stack: LaMa-complete floor, upscaled to this grid; sharp ribbons on top
    bk = base_key or f"ortho/{slug}_lama2.jpg"
    s3.download_file(R2_BUCKET, bk, "/tmp/base.jpg")
    base = cv2.resize(cv2.imread("/tmp/base.jpg"), (W, H), interpolation=cv2.INTER_CUBIC)
    if ribbons:  # OFF by default: the ribbon arcs cut up the smooth base more than they sharpen it
        try:
            s3.download_file(R2_BUCKET, f"ortho/{slug}_nadir.png", "/tmp/rib.png")
            rib = cv2.imread("/tmp/rib.png")
            if rib is not None and rib.shape[:2] != (H, W):
                rib = cv2.resize(rib, (W, H), interpolation=cv2.INTER_NEAREST)
            rm = (rib.sum(2) > 30).astype(np.uint8)
            rm = cv2.erode(rm, np.ones((5, 5), np.uint8))      # avoid dark edge fringe
            base[rm > 0] = rib[rm > 0]
        except Exception as e:
            print("[furnish] no ribbon layer:", e)

    cap = cv2.VideoCapture(vid)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    Wv = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)); Hv = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    f_px = (Wv / 2.0) / np.tan(np.radians(fov_deg) / 2.0)
    ts = T[:, 0].copy(); nfr = cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0
    if nfr and ts.max() > (nfr / fps) * 2:
        ts = ts / fps
    Rm = np.array([_quat2rot(q) for q in T[:, 4:8]])
    Cm = T[:, 1:4] - c
    ok = np.isfinite(Cm).all(1) & np.isfinite(Rm.reshape(len(T), -1)).all(1)
    ch = (Cm @ up) - floor                                    # cam height above floor (units)
    fwd_all = Rm @ np.array([0.0, 0.0, 1.0])
    fh2 = fwd_all - np.outer(fwd_all @ up, up)
    psi_all = np.arctan2(fh2 @ e2, fh2 @ e1)
    cx1 = Cm @ e1; cx2 = Cm @ e2

    blobs = sorted(range(1, nb), key=lambda i: -st[i, cv2.CC_STAT_AREA])
    pasted = 0
    for bi in blobs:
        if st[bi, cv2.CC_STAT_AREA] < min_area:
            break
        if pasted >= max_blobs:
            break
        bm = (lab == bi).astype(np.uint8)
        z = float(np.median(hrel[bm > 0])) * room             # blob height above floor (units)
        bx0 = st[bi, cv2.CC_STAT_LEFT]; by0 = st[bi, cv2.CC_STAT_TOP]
        bw = st[bi, cv2.CC_STAT_WIDTH]; bh = st[bi, cv2.CC_STAT_HEIGHT]
        cxp, cyp = cent[bi]                                   # centroid in canvas px
        c1 = lo1 + cxp / (W - 1) * span1; c2 = lo2 + cyp / (H - 1) * span2
        # most-overhead usable pose: max verticality to the blob top-plane
        dxy = np.hypot(cx1 - c1, cx2 - c2)
        hz = ch - z
        vert = np.where(ok & (hz > 0.15 * room), hz / np.hypot(dxy, hz), -1)
        pi = int(np.argmax(vert))
        if vert[pi] <= 0.55:                                  # nothing saw it near-overhead
            continue
        cap.set(cv2.CAP_PROP_POS_MSEC, float(ts[pi]) * 1000.0)
        rd, fr = cap.read()
        if not rd:
            continue
        # project the blob region (with margin) at the blob's OWN height plane
        pad = int(0.5 * px_per_ft)
        a0 = max(0, bx0 - pad); a1 = min(W, bx0 + bw + pad)
        b0 = max(0, by0 - pad); b1 = min(H, by0 + bh + pad)
        sj, si = np.mgrid[b0:b1, a0:a1]
        pl1 = lo1 + si / (W - 1) * span1; pl2 = lo2 + sj / (H - 1) * span2
        dx = pl1 - cx1[pi]; dy = pl2 - cx2[pi]
        cps, sps = np.cos(psi_all[pi] + np.radians(yaw_off)), np.sin(psi_all[pi] + np.radians(yaw_off))
        u_cam = dx * cps + dy * sps; v_cam = -dx * sps + dy * cps
        # TRUE-ORTHO per cell: each cell projects at ITS OWN surface height from the DSM —
        # a couch is not a plateau; one flat plane per blob is what smushed the sloping sides
        zc = hrel[b0:b1, a0:a1] * room
        he = np.maximum(ch[pi] - zc, 0.12 * room)
        valid = (ch[pi] - zc) > 0.12 * room
        u_img = Wv / 2.0 + (f_px / he) * u_cam; v_img = Hv / 2.0 + (f_px / he) * v_cam
        inb = (u_img >= 0) & (u_img < Wv - 1) & (v_img >= 0) & (v_img < Hv - 1) & valid
        if not inb.any():
            continue
        x0 = np.floor(np.where(inb, u_img, 0)).astype(np.int32)
        y0 = np.floor(np.where(inb, v_img, 0)).astype(np.int32)
        fx = (u_img - x0).astype(np.float32)[..., None]; fy = (v_img - y0).astype(np.float32)[..., None]
        p00 = fr[y0, x0].astype(np.float32); p10 = fr[y0, x0 + 1].astype(np.float32)
        p01 = fr[y0 + 1, x0].astype(np.float32); p11 = fr[y0 + 1, x0 + 1].astype(np.float32)
        patch = p00 * (1 - fx) * (1 - fy) + p10 * fx * (1 - fy) + p01 * (1 - fx) * fy + p11 * fx * fy
        patch[~inb] = 0
        # gain-match the patch to the base around the blob (kills the visible patch-border seams)
        roi0 = base[b0:b1, a0:a1].astype(np.float32)
        ringm = (bm[b0:b1, a0:a1] == 0) & inb & (patch.sum(2) > 30) & (roi0.sum(2) > 30)
        if int(ringm.sum()) > 300:
            gv = float(np.clip(np.median(roi0[ringm].mean(1) / (patch[ringm].mean(1) + 1e-3)), 0.8, 1.25))
            patch = np.clip(patch * gv, 0, 255)
        # feathered alpha from the blob mask
        sub = bm[b0:b1, a0:a1] * 255
        alpha = cv2.distanceTransform(cv2.dilate(sub, np.ones((5, 5), np.uint8)), cv2.DIST_L2, 3)
        alpha = np.clip(alpha / max(3.0, 0.25 * px_per_ft), 0, 1).astype(np.float32)
        alpha = alpha * inb.astype(np.float32)
        roi = base[b0:b1, a0:a1].astype(np.float32)
        base[b0:b1, a0:a1] = (roi * (1 - alpha[..., None]) + patch * alpha[..., None]).astype(np.uint8)
        pasted += 1
    cap.release()

    o = "/tmp/furnish.png"; cv2.imwrite(o, base)
    key = f"ortho/{slug}_composed.png"; s3.upload_file(o, R2_BUCKET, key)
    oj = "/tmp/furnish.jpg"; cv2.imwrite(oj, base, [cv2.IMWRITE_JPEG_QUALITY, 95])
    s3.upload_file(oj, R2_BUCKET, f"ortho/{slug}_composed.jpg")
    print(f"[furnish] {slug}: {pasted} furniture pieces re-pasted from single overhead views -> {key}")
    return {"composed": key, "px": [int(W), int(H)], "furniture": int(pasted)}


@app.function(image=ortho_image, secrets=[r2_secret], volumes={"/scratch": vol}, timeout=3600,
              memory=10240)
def make_trueortho(slug: str, ceiling_ft: float = 9.0, pxm: float = 100.0,
                   max_off_deg: float = 32.0, n_frames: int = 900, fov_pow: float = 12.0) -> dict:
    """TRUE-ORTHO base from the 360's BOTTOM HEMISPHERE (Justin's dewarp insight, done per-ray):
    every cell samples only NEAR-VERTICAL rays (<=max_off_deg off straight-down) from the 4K
    equirect, projected at the cell's OWN surface height from the dense cloud's DSM — no flat-floor
    layover (phantom cabinets), no oblique bathroom jumble. Gaps (never seen near-vertically) stay
    black + gap mask for LaMa."""
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
    vid = f"{sd}/hires.mp4"
    if not os.path.exists(vid):
        raise RuntimeError("4K equirect proxy (hires.mp4) not staged")

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
    fpu = ceiling_ft / room if room > 0 else 1.0
    W = min(6000, int((hi1 - lo1) * pxm) + 1); H = min(6000, int((hi2 - lo2) * pxm) + 1)
    span1 = hi1 - lo1; span2 = hi2 - lo2

    # float-ish DSM (top surface below a near-ceiling cut)
    cut = floor + 0.9 * room
    keep = (hgt < cut) & (pxa >= lo1) & (pxa <= hi1) & (pya >= lo2) & (pya <= hi2)
    ix = np.clip(((pxa[keep] - lo1) / span1 * (W - 1)), 0, W - 1).astype(np.int64)
    iy = np.clip(((pya[keep] - lo2) / span2 * (H - 1)), 0, H - 1).astype(np.int64)
    hk = hgt[keep]; cell = iy * W + ix
    order = np.lexsort((hk, cell)); cs = cell[order]; hs = hk[order]
    last = np.ones(len(cs), bool)
    if len(cs) > 1:
        last[:-1] = cs[1:] != cs[:-1]
    dsm = np.full(H * W, np.nan, np.float32); dsm[cs[last]] = hs[last]
    occ = np.zeros(H * W, bool); occ[cell] = True
    fpm = cv2.morphologyEx(occ.reshape(H, W).astype(np.uint8) * 255, cv2.MORPH_CLOSE,
                           np.ones((15, 15), np.uint8)) > 0
    d8 = np.where(np.isnan(dsm), 0, np.clip((dsm - floor) / max(room, 1e-6), 0, 1) * 255).astype(np.uint8).reshape(H, W)
    d8 = cv2.inpaint(d8, (np.isnan(dsm).reshape(H, W) & fpm).astype(np.uint8), 5, cv2.INPAINT_TELEA)
    d8 = cv2.medianBlur(d8, 5)
    zsurf = (d8.astype(np.float32) / 255.0 * room).reshape(H * W)   # height above floor per cell

    cap = cv2.VideoCapture(vid)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    Wv = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)); Hv = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    nfr = cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0
    ts = T[:, 0].copy()
    if nfr and ts.max() > (nfr / fps) * 2:
        ts = ts / fps
    Rm = np.array([_quat2rot(q) for q in T[:, 4:8]])
    Cm = T[:, 1:4] - c
    okp = np.isfinite(Cm).all(1) & np.isfinite(Rm.reshape(len(T), -1)).all(1)
    cosmax = np.cos(np.radians(max_off_deg))
    yflip = 1; lonsign = 1

    best = np.zeros(H * W, np.float32)
    out = np.zeros((H * W, 3), np.float32)
    step = max(1, len(T) // n_frames)
    used = 0
    for i in range(0, len(T), step):
        if not okp[i]:
            continue
        C = Cm[i]; R = Rm[i]
        hcam = float(C @ up - floor)
        if hcam < (1.5 / ceiling_ft) * room:
            continue
        Ce1 = float(C @ e1); Ce2 = float(C @ e2)
        fw = hcam * np.tan(np.radians(max_off_deg)) * 1.15
        a0 = int(np.clip((Ce1 - fw - lo1) / span1 * (W - 1), 0, W - 1))
        a1 = int(np.clip((Ce1 + fw - lo1) / span1 * (W - 1) + 1, 0, W))
        b0 = int(np.clip((Ce2 - fw - lo2) / span2 * (H - 1), 0, H - 1))
        b1 = int(np.clip((Ce2 + fw - lo2) / span2 * (H - 1) + 1, 0, H))
        if a1 <= a0 or b1 <= b0:
            continue
        sj, si = np.mgrid[b0:b1, a0:a1]
        gidx = (sj * W + si).ravel()
        pl1 = lo1 + si.ravel() / (W - 1) * span1
        pl2 = lo2 + sj.ravel() / (H - 1) * span2
        zc = zsurf[gidx]
        # world ray camera -> cell's SURFACE point
        rays = (pl1 - Ce1)[:, None] * e1 + (pl2 - Ce2)[:, None] * e2 + (zc - hcam)[:, None] * up
        dist = np.linalg.norm(rays, axis=1) + 1e-9
        vert = -(rays @ up) / dist                          # 1 = straight down
        sel = (vert > cosmax) & ((hcam - zc) > 0.1 * room)
        if not sel.any():
            continue
        w = (vert ** fov_pow).astype(np.float32)
        cand = sel & (w > best[gidx])
        if not cand.any():
            continue
        cap.set(cv2.CAP_PROP_POS_MSEC, float(ts[i]) * 1000.0)
        ok2, fr = cap.read()
        if not ok2:
            continue
        used += 1
        rc = rays[cand] @ R
        rcn = rc / (np.linalg.norm(rc, axis=1, keepdims=True) + 1e-9)
        lon = lonsign * np.arctan2(rcn[:, 0], rcn[:, 2])
        lat = np.arcsin(np.clip(yflip * (-rcn[:, 1]), -1, 1))
        uf = (((lon / (2 * np.pi)) + 0.5) * Wv) % Wv
        vf = np.clip((0.5 - lat / np.pi) * Hv, 0, Hv - 1.001)
        x0 = np.floor(uf).astype(np.int32); x1 = (x0 + 1) % Wv
        y0 = np.floor(vf).astype(np.int32); y1 = np.minimum(y0 + 1, Hv - 1)
        fx = (uf - x0).astype(np.float32)[:, None]; fy = (vf - y0).astype(np.float32)[:, None]
        col = (fr[y0, x0] * (1 - fx) * (1 - fy) + fr[y0, x1] * fx * (1 - fy)
               + fr[y1, x0] * (1 - fx) * fy + fr[y1, x1] * fx * fy).astype(np.float32)
        gi = gidx[cand]
        seen = best[gi] > 0.2
        if int(seen.sum()) > 400:                            # per-frame gain match to the mosaic
            gv = float(np.clip(np.median(out[gi[seen]].mean(1) / (col[seen].mean(1) + 1e-3)), 0.8, 1.25))
            col *= gv
        out[gi] = col
        best[gi] = w[cand]
    cap.release()

    covm = best > 0
    img = np.clip(out, 0, 255).astype(np.uint8).reshape(H, W, 3)
    hit = covm.reshape(H, W).astype(np.uint8)
    fm = (cv2.morphologyEx((fpm.astype(np.uint8)) * 255, cv2.MORPH_CLOSE, np.ones((31, 31), np.uint8)) > 0)
    gap = ((fm) & (hit == 0)).astype(np.uint8) * 255
    img[~fm] = 0
    cv2.imwrite("/tmp/to.png", img)
    key = f"ortho/{slug}_trueortho.png"; s3.upload_file("/tmp/to.png", R2_BUCKET, key)
    gk = f"ortho/{slug}_trueortho_gap.png"; cv2.imwrite("/tmp/tog.png", gap); s3.upload_file("/tmp/tog.png", R2_BUCKET, gk)
    cov = int(covm.mean() * 100)
    print(f"[trueortho] {slug}: {W}x{H}, {used} frames, {cov}% covered within {max_off_deg} deg -> {key}")
    return {"ortho": key, "gap": gk, "px": [int(W), int(H)], "frames": int(used), "cov_pct": cov}


@app.local_entrypoint()
def trueortho(slug: str, ceiling_ft: float = 8.5, pxm: float = 100.0, max_off_deg: float = 32.0):
    """True-ortho base from the 360 bottom hemisphere (per-ray dewarp at DSM height):
        modal run modal_app.py::trueortho --slug scottsdale-nadir --ceiling-ft 8.5"""
    print(make_trueortho.remote(slug, ceiling_ft=ceiling_ft, pxm=pxm, max_off_deg=max_off_deg))


@app.local_entrypoint()
def furnish(slug: str, ceiling_ft: float = 8.5, pxm: float = 100.0, base_key: str = ""):
    """Furniture-coherent composite (base floor + ribbons + single-view furniture):
        modal run modal_app.py::furnish --slug scottsdale-nadir --ceiling-ft 8.5"""
    print(make_furnish.remote(slug, ceiling_ft=ceiling_ft, pxm=pxm, base_key=base_key))


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
def walls(slug: str, video_key: str, ceiling_ft: float = 9.0, spacing_ft: float = 4.0,
          pxm: float = 18.0, maxd: float = 16.0, maxroom: float = 32.0):
    """Horizon-line wall reconstruction: sample the flythrough along its VSLAM trajectory,
    HorizonNet each frame, back-project the floor horizon, vote consensus walls. pxm is px/FOOT
    (set ~27 to match a make_fused texture for a 1:1 overlay); ceiling_ft MUST match the texture run.
        modal run modal_app.py::walls --slug scottsdale-fly --video-key projects/.../standard.mp4 --ceiling-ft 8.5 --pxm 27
    """
    print(make_walls_ai.remote(slug, video_key, ceiling_ft=ceiling_ft, spacing_ft=spacing_ft,
                               pxm=pxm, maxd=maxd, maxroom=maxroom))


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


@app.function(image=gsplat_image, secrets=[r2_secret], volumes={"/scratch": vol},
              memory=16384, timeout=3600)
def make_tour_data(vslam_slug: str, tour_slug: str,
                   stills_prefix: str,
                   min_lon: float, max_lon: float, min_lat: float, max_lat: float,
                   sheet_w: float, sheet_h: float,
                   pano_px: int = 4096, path_hz: float = 1.0,
                   zones_key: str = "", nadir_slug: str = "scottsdale-nadir",
                   overrides_key: str = "", prox_ft: float = 9.0) -> dict:
    """Single-anchor tour data, Justin's spec: the math places and fades the pins.
    Fits the flythrough's VSLAM floor frame into the plan sheet (GPS-feet grid) using
    stills that have BOTH a localize position (feet) and EXIF GPS (sheet coords), then
    emits: the camera path {t,x,y} for anchored-ring pose interpolation, one anchored
    hotspot per localized still (its standpoint), and tour-sized panos on R2.
    -> layout/{vslam_slug}/tour_data.json"""
    import io
    import json
    import numpy as np
    import cv2

    s3 = _r2(); sd = f"/scratch/{vslam_slug}"

    # --- fly floor frame (identical derivation to every other engine) ---
    ply = f"{sd}/{vslam_slug}.ply"
    if not os.path.exists(ply):
        ply = "/tmp/c.ply"; s3.download_file(R2_BUCKET, f"vslam/{vslam_slug}/{vslam_slug}.ply", ply)
    xyz, _ = _read_ply_xyzrgb(ply)
    traj = f"{sd}/frame_trajectory.txt"
    if not os.path.exists(traj):
        traj = "/tmp/kf.txt"
        s3.download_file(R2_BUCKET, f"vslam/{vslam_slug}/keyframe_trajectory.txt", traj)
    T = np.loadtxt(traj)
    if T.ndim == 1:
        T = T[None, :]
    c = xyz.mean(0); X = xyz - c
    _, _, Vt = np.linalg.svd(X[::41], full_matrices=False); up = Vt[2].astype("f4")
    cams = T[:, 1:4]
    if np.dot(cams.mean(0) - c, up) < 0:
        up = -up
    a = np.array([1.0, 0, 0]) if abs(up[0]) < 0.9 else np.array([0, 1.0, 0])
    e1 = np.cross(up, a); e1 /= np.linalg.norm(e1); e2 = np.cross(up, e1)
    hgt = X @ up
    lo1, hi1 = np.percentile(X @ e1, [1, 99]); lo2, hi2 = np.percentile(X @ e2, [1, 99])
    floor = float(np.percentile(hgt, 1.5)); ceil_ = float(np.percentile(hgt, 99))
    fpu = 8.5 / (ceil_ - floor)                              # this property: 8.5 ft ceilings
    Cm = T[:, 1:4] - c
    okp = np.isfinite(Cm).all(1)
    feet = np.stack([(Cm @ e1 - lo1) * fpu, (Cm @ e2 - lo2) * fpu], 1)

    # --- correspondences: localize feet <-> still EXIF GPS (sheet coords) ---
    loc = json.loads(s3.get_object(Bucket=R2_BUCKET,
                                   Key=f"layout/{vslam_slug}/localize.json")["Body"].read())
    resp = s3.list_objects_v2(Bucket=R2_BUCKET, Prefix=stills_prefix)
    skeys = {os.path.splitext(os.path.basename(o["Key"]))[0]: o["Key"]
             for o in resp.get("Contents", []) if o["Key"].lower().endswith((".jpg", ".jpeg"))}

    def sheet_xy(lat, lon):
        x = (lon - min_lon) / (max_lon - min_lon) * sheet_w
        y = (max_lat - lat) / (max_lat - min_lat) * sheet_h
        return x, y

    def poly_centroid(pts):
        pts = np.asarray(pts, np.float64)
        x, y = pts[:, 0], pts[:, 1]
        x2, y2 = np.roll(x, -1), np.roll(y, -1)
        cr = x * y2 - x2 * y
        A = cr.sum() / 2.0
        if abs(A) < 1e-6:
            return float(x.mean()), float(y.mean())
        return float(((x + x2) * cr).sum() / (6 * A)), float(((y + y2) * cr).sum() / (6 * A))

    # STILL positions on the sheet via the VALIDATED nadir chain: referee-checked
    # still poses (nadir frame) -> fitted plansheet transform -> CubiCasa canvas,
    # which sits on the sheet at origin/scale 1. Inch-class anchors, no GPS involved.
    nspd = f"/scratch/{nadir_slug}/splat"
    nmeta = json.load(open(f"{nspd}/cameras.json"))
    nposes = _load_still_poses(s3, nadir_slug, nmeta, nspd)
    ne1 = np.array(nmeta["e1"]); ne2 = np.array(nmeta["e2"])
    nlo1, nlo2 = nmeta["lo1"], nmeta["lo2"]
    nfpu = nmeta["fpu"]
    nftw = (nmeta["hi1"] - nlo1) * nfpu; nfth = (nmeta["hi2"] - nlo2) * nfpu
    al = json.loads(s3.get_object(Bucket=R2_BUCKET,
                                  Key=f"layout/{nadir_slug}/plan_align.json")["Body"].read())
    FX, FY, FW, FH, ROT = al["FX"], al["FY"], al["FW"], al["FH"], al["ROT"]
    cxa = FX + FW / 2.0; cya = FY + FH / 2.0
    tha = np.radians(ROT); ca, sa = np.cos(-tha), np.sin(-tha)

    def nadir_feet_to_sheet(fx_ft, fy_ft):
        # inverse of the plansheet forward map (photo -> plan canvas = sheet units)
        p1x = fx_ft / nftw * FW + FX
        p1y = fy_ft / nfth * FH + FY
        if al.get("FLIPH", True):
            p1x = 2 * cxa - p1x
        dx = p1x - cxa; dy = p1y - cya
        sx = cxa + ca * dx + sa * dy
        sy = cya - sa * dx + ca * dy
        return float(sx), float(sy)

    sheet_still = {}
    for name, c2w in nposes.items():
        C = c2w[:3, 3]
        fx_ft = (float(C @ ne1) - nlo1) * nfpu
        fy_ft = (float(C @ ne2) - nlo2) * nfpu
        sheet_still[name] = nadir_feet_to_sheet(fx_ft, fy_ft)
    print(f"[tourdata] {len(sheet_still)} stills placed on sheet via nadir chain")

    # zones: label each still by the room polygon that contains (or is nearest to) it
    zone_by_still = {}
    if zones_key:
        zones = json.loads(s3.get_object(Bucket=R2_BUCKET, Key=zones_key)["Body"].read())

        def inside(pt, pts):
            x, y = pt; n = len(pts); j = n - 1; c = False
            for i in range(n):
                xi, yi = pts[i]; xj, yj = pts[j]
                if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi + 1e-12) + xi:
                    c = not c
                j = i
            return c

        for name, pt in sheet_still.items():
            best_lab, best_d = None, 1e9
            for z in zones:
                if not z.get("points"):
                    continue
                if inside(pt, z["points"]):
                    best_lab, best_d = z.get("label"), 0.0
                    break
                cx, cy = poly_centroid(z["points"])
                d = (cx - pt[0]) ** 2 + (cy - pt[1]) ** 2
                if d < best_d:
                    best_lab, best_d = z.get("label"), d
            # nearest-zone is only trustworthy CLOSE to a room — an outdoor still
            # (backyard pano) otherwise inherits a wrong interior label (audit
            # finding: putting-green still labeled "Dining"). Flag, don't guess.
            if best_lab and best_d > 8.0 ** 2:
                print(f"[tourdata] {name[:8]}: outside all zones "
                      f"({best_d ** 0.5:.0f} ft from '{best_lab}') — labeling for review")
                best_lab = f"Review: near {best_lab}"
            if best_lab:
                zone_by_still[name] = {"label": best_lab}

    # FLY-frame fit (drives only the camera path; a couple of feet is fine there):
    # fly localize feet <-> the same stills' sheet positions from the nadir chain.
    src, dst, names = [], [], []
    for name, info in loc.items():
        if name == "_meta" or not isinstance(info, dict) or name not in sheet_still:
            continue
        if info.get("matches", 0) < 30:
            continue
        src.append(info["feet"])
        dst.append(sheet_still[name])
        names.append(name)
    src = np.array(src); dst = np.array(dst)
    if len(src) < 3:
        raise RuntimeError(f"only {len(src)} correspondences — cannot fit feet->sheet")

    # --- 2D similarity via RANSAC: the fly localize contains wrong-room matches
    #     (gross outliers) — hypothesize from point PAIRS, keep the biggest
    #     consensus under 4 ft, refit Umeyama on the inliers only ---
    def cplx_fit(sp, dp):
        """Closed-form 2D similarity, reflection decided by residual: z' = a z + b
        vs z' = a conj(z) + b. Returns (predict_fn, scale, reflected, residuals)."""
        zs = sp[:, 0] + 1j * sp[:, 1]
        zd = dp[:, 0] + 1j * dp[:, 1]
        mzs, mzd = zs.mean(), zd.mean()
        cs, cd = zs - mzs, zd - mzd
        out = []
        for refl in (False, True):
            base = np.conj(cs) if refl else cs
            a = (cd * np.conj(base)).sum() / ((np.abs(base) ** 2).sum() + 1e-12)
            b = mzd - a * (np.conj(mzs) if refl else mzs)

            def pred(p, a=a, b=b, refl=refl):
                z = np.asarray(p)[..., 0] + 1j * np.asarray(p)[..., 1]
                w = a * (np.conj(z) if refl else z) + b
                return np.stack([w.real, w.imag], -1)

            r = np.linalg.norm(pred(sp) - dp, axis=1)
            out.append((r.mean(), pred, abs(a), refl, r, a))
        out.sort(key=lambda t: t[0])
        _, pred, sc, refl, r, a = out[0]
        return pred, float(sc), refl, r, a

    best_inl, best_model = [], None
    for i in range(len(src)):
        for j in range(i + 1, len(src)):
            v_s = src[j] - src[i]; v_d = dst[j] - dst[i]
            ns_ = np.linalg.norm(v_s); nd_ = np.linalg.norm(v_d)
            if ns_ < 3.0 or nd_ < 3.0:
                continue
            for refl in (1.0, -1.0):
                vs = v_s.copy()
                if refl < 0:
                    vs = np.array([vs[0], -vs[1]])
                sc = nd_ / ns_
                ang = np.arctan2(v_d[1], v_d[0]) - np.arctan2(vs[1], vs[0])
                Rr = np.array([[np.cos(ang), -np.sin(ang)], [np.sin(ang), np.cos(ang)]])
                M = Rr @ np.diag([1.0, refl])
                tt = dst[i] - sc * M @ src[i]
                pred = (sc * (M @ src.T)).T + tt
                err = np.linalg.norm(pred - dst, axis=1)
                inl = list(np.where(err < 4.0)[0])
                if len(inl) > len(best_inl):
                    best_inl, best_model = inl, (sc, M, tt, refl)
    if len(best_inl) < 4:
        raise RuntimeError(f"RANSAC found only {len(best_inl)} inliers — fly localize too poor")
    predict, scale, refl, resid, acomp = cplx_fit(src[best_inl], dst[best_inl])

    def fit(p):
        return predict(np.asarray(p, np.float64))

    def fit_dir(vx, vy):
        # direction vectors transform without translation (conjugate first if reflected)
        z = complex(vx, vy)
        w = acomp * (z.conjugate() if refl else z)
        return w.real, w.imag

    out_n = len(src) - len(best_inl)
    print(f"[tourdata] RANSAC fit: {len(best_inl)}/{len(src)} inliers ({out_n} wrong-room "
          f"rejected), scale {scale:.3f}, inlier residual mean {resid.mean():.2f} ft / "
          f"max {resid.max():.2f} ft (reflection {'yes' if refl else 'no'})")
    if resid.mean() > 5.0:
        raise RuntimeError(f"inlier residual still high ({resid.mean():.1f} ft mean)")

    # --- camera path in sheet coords with REAL headings + altitude: the viewer's
    #     tangent-heading fallback swims whenever the drone yaws without moving,
    #     which is what made the rings float. h = VSLAM forward through the fit;
    #     z = camera feet above floor (keeps anchor pitch in one unit system). ---
    ts = T[:, 0].copy()
    if ts.max() > 3600:                                       # frame-index timestamps guard
        ts = ts / 30.0
    Rm = np.array([_quat2rot(q) for q in T[:, 4:8]])
    fwd_all = Rm @ np.array([0.0, 0.0, 1.0])
    camh_ft = (Cm @ up - floor) * fpu
    order = np.argsort(ts)
    path = []
    last_t = -1e9
    for i in order:
        if not okp[i] or not np.isfinite(ts[i]):
            continue
        if ts[i] - last_t < 1.0 / path_hz:
            continue
        last_t = float(ts[i])
        p = fit(feet[i])
        fh = fwd_all[i] - np.dot(fwd_all[i], up) * up
        vx, vy = fit_dir(float(fh @ e1), float(fh @ e2))
        heading = float(np.degrees(np.arctan2(vx, -vy)))      # viewer bearing convention
        # no z on purpose: camH then falls back to the viewer's CAMERA_HEIGHT_M and,
        # with anchor.h set to the same constant, pitch == 0 — every ring rides the
        # horizon line (Justin's spec: same height, no vertical float, easy to click)
        path.append({"t": round(float(ts[i]), 2), "x": round(float(p[0]), 2),
                     "y": round(float(p[1]), 2), "h": round(heading, 1)})

    # --- LINE-OF-SIGHT visibility windows per pin: march camera->anchor across the
    #     nadir splat height field (same occlusion test as the floor unwrap). When a
    #     wall blocks the room, the ring's window closes — "out of view, dot goes away".
    hbuf = s3.get_object(Bucket=R2_BUCKET,
                         Key=f"ortho/{nadir_slug}_splat_height.png")["Body"].read()
    h16 = cv2.imdecode(np.frombuffer(hbuf, np.uint8), cv2.IMREAD_UNCHANGED)
    hft_g = h16.astype(np.float32) / 1000.0 - 5.0
    hft_g[hft_g > 12.0] = 0.0
    Hg, Wg = hft_g.shape
    tha_f = np.radians(ROT); caf, saf = np.cos(-tha_f), np.sin(-tha_f)

    def sheet_to_nadir_feet(sx, sy):
        # inverse of nadir_feet_to_sheet: unrotate about the window centre, unflip
        dx = sx - cxa; dy = sy - cya
        p1x = cxa + caf * dx - saf * dy
        p1y = cya + saf * dx + caf * dy
        if al.get("FLIPH", True):
            p1x = 2 * cxa - p1x
        return (p1x - FX) / FW * nftw, (p1y - FY) / FH * nfth

    def grid_h(fx_ft, fy_ft):
        gx_ = int(np.clip(fx_ft / nftw * (Wg - 1), 0, Wg - 1))
        gy_ = int(np.clip(fy_ft / nfth * (Hg - 1), 0, Hg - 1))
        return float(hft_g[gy_, gx_])

    def los_clear(cam_xy, cam_h, anc_xy, anc_h):
        ax_, ay_ = sheet_to_nadir_feet(*cam_xy)
        bx_, by_ = sheet_to_nadir_feet(*anc_xy)
        for s in np.linspace(0.08, 0.92, 14):
            hx = ax_ + s * (bx_ - ax_); hy = ay_ + s * (by_ - ay_)
            ray_h = cam_h + s * (anc_h - cam_h)
            if grid_h(hx, hy) > ray_h + 0.4:
                return False
        return True

    # --- one anchored hotspot per still, at its NADIR-CHAIN standpoint (inch-class),
    #     labeled by its room, GATED to line-of-sight windows (hysteresis-merged);
    #     one hotspot COPY per window so the stock viewer needs no changes ---
    ANCHOR_H = 1.35   # == viewer CAMERA_HEIGHT_M -> pitch 0: rings horizon-locked
    LOS_H = 4.0       # geometric sight-line target height in FEET (eye-ish, above sofas)

    # sticky label overrides (R2 json {short8: label}) — survive reruns, so a
    # hand-corrected name (audit fixes) never regresses
    overrides = {}
    if overrides_key:
        try:
            overrides = json.loads(s3.get_object(Bucket=R2_BUCKET,
                                                 Key=overrides_key)["Body"].read())
            print(f"[tourdata] {len(overrides)} label overrides loaded")
        except Exception:
            pass

    def merge_windows(flags):
        """(t, bool) series -> [start,end] windows: bridge <1.5s gaps, drop <1.5s
        runs, pad 0.6s."""
        ws = []
        run_start = None
        last_seen = None
        for tt, v in flags:
            if v and run_start is None:
                run_start = tt
            if v:
                last_seen = tt
            elif run_start is not None and last_seen is not None and tt - last_seen > 1.5:
                ws.append([run_start, last_seen])
                run_start = None
        if run_start is not None and last_seen is not None:
            ws.append([run_start, last_seen])
        return [[max(0.0, w0 - 0.6), w1 + 0.6] for w0, w1 in ws if w1 - w0 >= 1.5][:8]

    hotspots, panos = [], []
    for name in sorted(sheet_still):
        if name not in skeys:
            continue
        short = name[:8]
        ax, ay = sheet_still[name]
        label = overrides.get(short) or zone_by_still.get(name, {}).get("label", short)
        # line-of-sight windows along the path
        windows = merge_windows(
            [(pp["t"], los_clear((pp["x"], pp["y"]), max(pp.get("z", 4.5), 1.0),
                                 (ax, ay), LOS_H)) for pp in path])
        mode = "LOS"
        if not windows:
            # walls block every sight-line (interior bathrooms): fall back to
            # PROXIMITY — the dot shows on each pass within prox_ft (doorway moments)
            windows = merge_windows(
                [(pp["t"], (pp["x"] - ax) ** 2 + (pp["y"] - ay) ** 2 < prox_ft ** 2)
                 for pp in path])
            mode = "proximity"
        if not windows:
            print(f"[tourdata] {short} ({label}): no LOS and never within "
                  f"{prox_ft} ft — pin dropped")
            continue
        s3.download_file(R2_BUCKET, skeys[name], "/tmp/sp.jpg")
        im = cv2.imread("/tmp/sp.jpg")
        if im is None:
            continue
        pano = cv2.resize(im, (pano_px, pano_px // 2), interpolation=cv2.INTER_AREA)
        ok2, enc = cv2.imencode(".jpg", pano, [cv2.IMWRITE_JPEG_QUALITY, 84])
        pkey = f"tours/{tour_slug}/pano-{short}.jpg"
        s3.put_object(Bucket=R2_BUCKET, Key=pkey, Body=enc.tobytes(),
                      ContentType="image/jpeg",
                      CacheControl="public, max-age=31536000, immutable")
        for k, (w0, w1) in enumerate(windows):
            hotspots.append({"id": f"hs-{short}-{k}", "label": label, "panoId": short,
                             "anchor": {"x": round(float(ax), 2), "y": round(float(ay), 2),
                                        "h": ANCHOR_H},
                             "fadeNear": 4.0, "fadeFar": 14.0,
                             "start": round(w0, 2), "end": round(w1, 2)})
        panos.append({"id": short, "label": label,
                      "src": f"https://media.lvxhomes.com/{pkey}?v=1"})
        print(f"[tourdata] {short} ({label}): {len(windows)} {mode} windows")
    out = {"path": path, "hotspots": hotspots, "panos": panos,
           "fit": {"n": len(src), "inliers": len(best_inl), "scale": round(float(scale), 4),
                   "residual_mean_ft": round(float(resid.mean()), 2),
                   "residual_max_ft": round(float(resid.max()), 2),
                   "reflection": bool(refl)}}
    s3.put_object(Bucket=R2_BUCKET, Key=f"layout/{vslam_slug}/tour_data.json",
                  Body=json.dumps(out).encode(), ContentType="application/json")
    print(f"[tourdata] {len(path)} path samples, {len(hotspots)} anchored pins, "
          f"{len(panos)} panos -> layout/{vslam_slug}/tour_data.json")
    return {"path": len(path), "pins": len(hotspots), "panos": len(panos), "fit": out["fit"]}


@app.local_entrypoint()
def tourdata(vslam_slug: str, tour_slug: str, stills_prefix: str,
             min_lon: float, max_lon: float, min_lat: float, max_lat: float,
             sheet_w: float, sheet_h: float, zones_key: str = "", path_hz: float = 3.0,
             overrides_key: str = ""):
    """modal run modal_app.py::tourdata --vslam-slug scottsdale-fly --tour-slug old-town-scottsdale-home ..."""
    print(make_tour_data.remote(vslam_slug, tour_slug, stills_prefix,
                                min_lon, max_lon, min_lat, max_lat, sheet_w, sheet_h,
                                zones_key=zones_key, path_hz=path_hz,
                                overrides_key=overrides_key))


@app.function(image=vslam_image, secrets=[r2_secret], cpu=16.0, memory=16384, timeout=7200)
def make_mezzanine(src_key: str, out_key: str, maxw: int = 3840, crf: int = 19) -> dict:
    """Stream-ingestable mezzanine from a raw export: Cloudflare Stream rejects >4K
    input (the 6K HEVC 360 masters), so transcode to H.264 <=maxw wide, faststart,
    and put it back on R2 next to the original."""
    import subprocess

    s3 = _r2()
    src = "/tmp/mezz_src.mp4"
    out = "/tmp/mezz_out.mp4"
    print(f"[mezz] downloading {src_key}")
    s3.download_file(R2_BUCKET, src_key, src)
    subprocess.run(
        ["ffmpeg", "-y", "-i", src,
         "-vf", f"scale='min({maxw},iw)':-2",
         "-c:v", "libx264", "-preset", "fast", "-crf", str(crf),
         "-pix_fmt", "yuv420p", "-movflags", "+faststart",
         "-c:a", "aac", "-b:a", "192k",
         out],
        check=True,
    )
    s3.upload_file(out, R2_BUCKET, out_key,
                   ExtraArgs={"ContentType": "video/mp4"})
    bytes_out = os.path.getsize(out)
    print(f"[mezz] {src_key} -> {out_key} ({bytes_out/1e9:.2f} GB)")
    return {"out": out_key, "bytes": int(bytes_out)}


@app.local_entrypoint()
def mezzanine(src_key: str, out_key: str, maxw: int = 3840):
    """modal run modal_app.py::mezzanine --src-key projects/x/video/a.mp4 --out-key projects/x/video/a_4k.mp4"""
    print(make_mezzanine.remote(src_key, out_key, maxw=maxw))


@app.function(image=test_image, secrets=[r2_secret])
def presign_r2(keys_csv: str, expires: int = 604800) -> dict:
    """Presigned GET links (default 7 days) so renders can be viewed from any browser
    without Studio wiring — for remote review."""
    s3 = _r2()
    return {k.strip(): s3.generate_presigned_url(
        "get_object", Params={"Bucket": R2_BUCKET, "Key": k.strip()}, ExpiresIn=expires)
        for k in keys_csv.split(",") if k.strip()}


@app.local_entrypoint()
def presign(keys: str, expires: int = 604800):
    """modal run modal_app.py::presign --keys ortho/x.png,ortho/y.jpg"""
    for k, u in presign_r2.remote(keys, expires).items():
        print(f"{k}\n  {u}\n")


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
def fused(slug: str, video_key: str, ceiling_ft: float = 9.0, pxm: float = 64.0, depth: int = 1, fill: int = 1):
    """Nadir-weighted FLAT-floor fusion — pulls each cell's colour from the most straight-down
    clean frame that saw it. --depth 0 --fill 0 = NADIR-ONLY CLEAN (no tears, black gaps + gap mask for LaMa):
        modal run modal_app.py::fused --slug scottsdale-nadir --video-key x --ceiling-ft 8.5 --pxm 90 --depth 0 --fill 0"""
    print(make_fused.remote(slug, video_key, ceiling_ft=ceiling_ft, pxm=pxm, depth=depth, fill=fill))


@app.function(image=lama_image, gpu="T4", secrets=[r2_secret], timeout=1800)
def lama_fill(clean_key: str, gap_key: str, out_key: str) -> dict:
    """Fill the nadir-only gaps with LaMa (resolution-robust large-mask inpainting): plausible clean
    floor where furniture occluded the straight-down view — no tears, no cv2 smear. #71."""
    import io
    from PIL import Image
    from simple_lama_inpainting import SimpleLama
    s3 = _r2()
    img = Image.open(io.BytesIO(s3.get_object(Bucket=R2_BUCKET, Key=clean_key)["Body"].read())).convert("RGB")
    mask = Image.open(io.BytesIO(s3.get_object(Bucket=R2_BUCKET, Key=gap_key)["Body"].read())).convert("L")
    if mask.size != img.size:
        mask = mask.resize(img.size, Image.NEAREST)
    assert out_key != clean_key, "lama_fill: out_key == clean_key would overwrite the master"
    # big-lama at full 4-6K blows past a T4's VRAM (review-confirmed OOM). LaMa is resolution-
    # robust by design: inpaint at a bounded size, then paste ONLY the masked fill back into the
    # full-res master so every captured pixel stays native.
    import numpy as _np
    MAXS = 2048
    w0, h0 = img.size
    if max(w0, h0) > MAXS:
        sc = MAXS / max(w0, h0)
        sw = max(8, int(round(w0 * sc)) // 8 * 8); sh = max(8, int(round(h0 * sc)) // 8 * 8)
        small = img.resize((sw, sh), Image.LANCZOS)
        smask = mask.resize((sw, sh), Image.NEAREST)
        res_s = SimpleLama()(small, smask).resize((w0, h0), Image.LANCZOS)
        m = _np.array(mask) > 0
        outa = _np.array(img); outa[m] = _np.array(res_s)[m]
        res = Image.fromarray(outa)
    else:
        res = SimpleLama()(img, mask)
    buf = io.BytesIO()
    if out_key.lower().endswith(".png"):
        res.save(buf, format="PNG"); ctype = "image/png"           # lossless when asked
    else:
        res.save(buf, format="JPEG", quality=95); ctype = "image/jpeg"
    s3.put_object(Bucket=R2_BUCKET, Key=out_key, Body=buf.getvalue(), ContentType=ctype)
    print(f"[lama] {clean_key} + {gap_key} -> {out_key} ({res.size})")
    return {"out": out_key, "size": list(res.size)}


@app.local_entrypoint()
def lama(clean_key: str, gap_key: str, out_key: str = ""):
    """Fill nadir-clean gaps with LaMa:
        modal run modal_app.py::lama --clean-key ortho/scottsdale-nadir_nadir_clean.png --gap-key ortho/scottsdale-nadir_gap.png"""
    out_key = out_key or clean_key.replace("_nadir_clean", "_lama")
    if out_key == clean_key:                       # replace didn't match — NEVER overwrite the master
        dot = clean_key.rfind(".")
        out_key = clean_key[:dot] + "_lama" + clean_key[dot:]
    print(lama_fill.remote(clean_key, gap_key, out_key))


# ---------------------------------------------------------------------------
# 3D Gaussian Splatting — learned geometry for the photoreal dollhouse
# Every projection engine above is capped by the dense cloud's accuracy on
# furniture (distorted couch / dining table / fixtures). A splat TRAINED on the
# posed video learns the geometry instead, then renders a clean true-ortho
# top-down + tilted dollhouse views. 3 stages: data -> train -> render.
# ---------------------------------------------------------------------------
@app.function(image=ortho_image, secrets=[r2_secret], volumes={"/scratch": vol}, timeout=3600,
              memory=10240)
def make_splat_data(slug: str, n_frames: int = 400, face_px: int = 800, fov_deg: float = 95.0,
                    ceiling_ft: float = 8.5, stills: int = 1,
                    stills_prefix: str = "projects/old-town-scottsdale-home/still/") -> dict:
    """Stage 1: posed PINHOLE views for splat training. Picks ~n_frames SHARP frames from the
    4K equirect proxy (rolling-median Laplacian gate, as make_nadir_mosaic), cuts 5 pinhole
    faces per frame (4 sides + straight DOWN; the zenith face is stitch smear — skipped) via
    the standard equirect ray remap, and writes images + cameras.json to /scratch/{slug}/splat/.
    The floor frame (IDENTICAL derivation to make_fused) is computed ONCE here and stored in
    cameras.json so train/render can never drift from the other engines' frame."""
    import os
    import json
    import shutil
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
    vid = f"{sd}/hires.mp4"
    if not os.path.exists(vid):
        raise RuntimeError("4K equirect proxy (hires.mp4) not staged")

    # floor frame — IDENTICAL derivation to make_fused / make_trueortho (do not "improve")
    c = xyz.mean(0); X = xyz - c
    _, _, Vt = np.linalg.svd(X[::41], full_matrices=False); up = Vt[2].astype("f4")
    cams = T[:, 1:4]
    if np.dot(cams.mean(0) - c, up) < 0:
        up = -up
    a = np.array([1.0, 0, 0]) if abs(up[0]) < 0.9 else np.array([0, 1.0, 0])
    e1 = np.cross(up, a); e1 /= np.linalg.norm(e1); e2 = np.cross(up, e1)
    pxa = X @ e1; pya = X @ e2; hgt = X @ up
    lo1, hi1 = np.percentile(pxa, [1, 99]); lo2, hi2 = np.percentile(pya, [1, 99])
    floor = float(np.percentile(hgt, 1.5)); ceilh = float(np.percentile(hgt, 99)); room = ceilh - floor
    fpu = ceiling_ft / room if room > 0 else 1.0

    out_dir = f"{sd}/splat"
    shutil.rmtree(out_dir, ignore_errors=True)
    os.makedirs(f"{out_dir}/images", exist_ok=True)

    cap = cv2.VideoCapture(vid)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    nfr = cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0
    Wv = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)); Hv = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    ts = T[:, 0].copy()
    if nfr and ts.max() > (nfr / fps) * 2:
        ts = ts / fps
    Rm = np.array([_quat2rot(q) for q in T[:, 4:8]])
    Cm = T[:, 1:4] - c
    okp = np.isfinite(Cm).all(1) & np.isfinite(Rm.reshape(len(T), -1)).all(1) & np.isfinite(ts)

    # 5 virtual faces in the CAMERA frame (x right, y down, z nose — OpenCV convention,
    # exactly the frame the equirect lives in: lon = atan2(x, z), lat = asin(-y)).
    def _ry(t):
        ct, st = np.cos(t), np.sin(t)
        return np.array([[ct, 0.0, st], [0.0, 1.0, 0.0], [-st, 0.0, ct]])
    faces = [("f", np.eye(3)), ("r", _ry(np.pi / 2)), ("b", _ry(np.pi)), ("l", _ry(-np.pi / 2)),
             ("d", np.array([[1.0, 0, 0], [0, 0, 1.0], [0, -1.0, 0]]))]   # nose -> straight down

    # equirect->pinhole remap is pose-independent (the pano IS the camera frame): precompute
    # one map per face; u spans [0, Wv] against a 1-col wrap-padded frame (no seam at lon 180).
    f_px = (face_px / 2.0) / np.tan(np.radians(fov_deg) / 2.0)
    cxy = (face_px - 1) / 2.0
    jj, ii = np.mgrid[0:face_px, 0:face_px].astype(np.float32)
    d_f = np.stack([(ii - cxy) / f_px, (jj - cxy) / f_px, np.ones_like(ii)], -1)
    d_f /= np.linalg.norm(d_f, axis=-1, keepdims=True)
    maps = {}
    for nm, Rf in faces:
        d_c = d_f @ Rf.T
        lon = np.arctan2(d_c[..., 0], d_c[..., 2])
        lat = np.arcsin(np.clip(-d_c[..., 1], -1, 1))
        maps[nm] = ((((lon / (2 * np.pi)) + 0.5) * Wv).astype(np.float32),
                    np.clip((0.5 - lat / np.pi) * Hv, 0, Hv - 1.001).astype(np.float32))

    okidx = np.where(okp)[0]
    # sample the WHOLE flight: no early stop — capping at n_frames while stepping in time
    # order starved the flight's tail (the casita visit) down to 3 training frames.
    step = max(1, len(okidx) // max(1, n_frames))
    frames_meta = []
    nkept = 0; skip_blur = 0; sharps = []
    for i in okidx[::step]:
        cap.set(cv2.CAP_PROP_POS_MSEC, float(ts[i]) * 1000.0)
        ok2, fr = cap.read()
        if not ok2:
            continue
        g = cv2.cvtColor(cv2.resize(fr, (480, 240)), cv2.COLOR_BGR2GRAY)
        s = float(cv2.Laplacian(g, cv2.CV_64F).var())
        sharps.append(s)
        if len(sharps) > 30 and s < 0.55 * float(np.median(sharps[-121:])):
            skip_blur += 1
            continue
        frp = np.concatenate([fr, fr[:, :1]], axis=1)              # wrap pad for lon-180 seam
        for nm, Rf in faces:
            im = cv2.remap(frp, maps[nm][0], maps[nm][1], cv2.INTER_LINEAR)
            fn = f"images/p{i:05d}_{nm}.jpg"
            cv2.imwrite(f"{out_dir}/{fn}", im, [cv2.IMWRITE_JPEG_QUALITY, 95])
            c2w = np.eye(4)
            c2w[:3, :3] = Rm[i] @ Rf                               # world<-face (OpenCV convention)
            c2w[:3, 3] = Cm[i]                                     # centered world (xyz - c)
            frames_meta.append({"img": fn, "c2w": c2w.tolist()})
        nkept += 1
    cap.release()

    # DEDICATED 360 STILLS as extra training views — shot standing IN the rooms, they
    # observe exactly the near-wall zones the flythrough missed. Pose init: position
    # inherited from the localize.json matched frame; the still's OWN yaw re-derived
    # from the ORB equirect x-shift vs that frame (lon = psi - azimuth, so the shift
    # IS the yaw delta); level attitude. train_splat refines each still's pose (SE3).
    nstill = 0
    if stills:
        try:
            loc = json.loads(s3.get_object(Bucket=R2_BUCKET,
                                           Key=f"layout/{slug}/localize.json")["Body"].read())
        except Exception as e:
            loc = None
            print(f"[splatdata] no localize.json for {slug} ({e}) — skipping stills")
        svid = f"{sd}/slam.mp4"
        if loc and os.path.exists(svid):
            scap = cv2.VideoCapture(svid)
            sfps = scap.get(cv2.CAP_PROP_FPS) or 30.0
            orb = cv2.ORB_create(1500)
            bfm = cv2.BFMatcher(cv2.NORM_HAMMING)
            resp = s3.list_objects_v2(Bucket=R2_BUCKET, Prefix=stills_prefix)
            skeys = {os.path.splitext(os.path.basename(o["Key"]))[0]: o["Key"]
                     for o in resp.get("Contents", []) if o["Key"].lower().endswith((".jpg", ".jpeg"))}
            for name, info in loc.items():
                if name == "_meta" or not isinstance(info, dict):
                    continue
                if info.get("matches", 0) < 30 or name not in skeys:
                    continue
                pi = int(np.argmin(np.abs(ts - info["frame"] / sfps)))
                if not okp[pi]:
                    continue
                scap.set(cv2.CAP_PROP_POS_FRAMES, int(info["frame"]))
                okf, fr = scap.read()
                if not okf:
                    continue
                s3.download_file(R2_BUCKET, skeys[name], "/tmp/still.jpg")
                sim = cv2.imread("/tmp/still.jpg")
                if sim is None:
                    continue
                gf = cv2.cvtColor(cv2.resize(fr, (1024, 512)), cv2.COLOR_BGR2GRAY)
                gs2 = cv2.cvtColor(cv2.resize(sim, (1024, 512)), cv2.COLOR_BGR2GRAY)
                kps, dss = orb.detectAndCompute(gs2, None)
                kpf, dsf = orb.detectAndCompute(gf, None)
                if dss is None or dsf is None:
                    continue
                good = [p[0] for p in bfm.knnMatch(dss, dsf, k=2)
                        if len(p) == 2 and p[0].distance < 0.75 * p[1].distance]
                if len(good) < 25:
                    continue
                dxs = np.array([(kps[m.queryIdx].pt[0] - kpf[m.trainIdx].pt[0] + 512.0) % 1024.0 - 512.0
                                for m in good])
                dyaw = float(np.median(dxs)) / 1024.0 * 360.0
                q = T[pi, 4:8]     # matched frame's floor-frame heading (as localize_stills)
                fwdf = np.array([2 * (q[0] * q[2] + q[3] * q[1]),
                                 2 * (q[1] * q[2] - q[3] * q[0]),
                                 1 - 2 * (q[0] ** 2 + q[1] ** 2)])
                fhead = np.degrees(np.arctan2(float(fwdf @ e2), float(fwdf @ e1)))
                psi = np.radians(fhead + dyaw)
                fwd = np.cos(psi) * e1 + np.sin(psi) * e2
                Rst = np.stack([np.cross(fwd, up), -up, fwd], 1)  # cols: x, y(down), z(fwd) — level
                simp = cv2.resize(sim, (Wv, Hv), interpolation=cv2.INTER_AREA)
                simp = np.concatenate([simp, simp[:, :1]], axis=1)
                for nm, Rf in faces:
                    imf = cv2.remap(simp, maps[nm][0], maps[nm][1], cv2.INTER_LINEAR)
                    fn = f"images/s_{name[:8]}_{nm}.jpg"
                    cv2.imwrite(f"{out_dir}/{fn}", imf, [cv2.IMWRITE_JPEG_QUALITY, 95])
                    c2w = np.eye(4)
                    c2w[:3, :3] = Rst @ Rf
                    c2w[:3, 3] = Cm[pi]
                    frames_meta.append({"img": fn, "c2w": c2w.tolist(), "group": name})
                nstill += 1
                print(f"[splatdata] still {name[:8]}: frame {info['frame']}, yaw {fhead + dyaw:+.1f}deg, "
                      f"{len(good)} matches")
            scap.release()
            print(f"[splatdata] stills: {nstill} localized into the training set")

    meta = {"slug": slug, "face_px": face_px, "fov_deg": fov_deg, "f_px": float(f_px),
            "cx": cxy, "cy": cxy,
            "world": "vslam minus cloud centroid c; cams OpenCV x-right y-down z-forward",
            "c": [float(v) for v in c], "up": [float(v) for v in up],
            "e1": [float(v) for v in e1], "e2": [float(v) for v in e2],
            "floor": floor, "room": room, "fpu": float(fpu), "ceiling_ft": ceiling_ft,
            "lo1": float(lo1), "hi1": float(hi1), "lo2": float(lo2), "hi2": float(hi2),
            "frames": frames_meta}
    with open(f"{out_dir}/cameras.json", "w") as f:
        json.dump(meta, f)
    vol.commit()
    ftw = round(float((hi1 - lo1) * fpu), 1); fth = round(float((hi2 - lo2) * fpu), 1)
    print(f"[splatdata] {slug}: {nkept} frames x {len(faces)} faces = {len(frames_meta)} views "
          f"({skip_blur} blur-skipped), {face_px}px @ {fov_deg}deg, {ftw}x{fth}ft -> {out_dir}")
    return {"views": len(frames_meta), "frames": nkept, "stills": nstill,
            "blur_skipped": skip_blur, "ft": [ftw, fth]}


@app.function(image=gsplat_image, gpu="A10G", secrets=[r2_secret], volumes={"/scratch": vol},
              timeout=10800, memory=32768)
def train_splat(slug: str, iters: int = 20000, init_pts: int = 500000, sh_degree: int = 2,
                max_gauss: int = 3000000, pose_opt: int = 1, still_start: int = 0) -> dict:
    """Stage 2: gsplat training (simple_trainer pattern). Gaussians init from the dense
    COLORED cloud (subsampled), DefaultStrategy densification, 0.8*L1 + 0.2*(1-SSIM).
    Checkpoint -> /scratch/{slug}/splat/ckpt.pt; a couple of train-view vs GT strips -> R2."""
    import os
    import json
    import numpy as np
    import cv2
    import torch
    import torch.nn.functional as F
    from gsplat import rasterization
    from gsplat.strategy import DefaultStrategy

    sd = f"/scratch/{slug}"; spd = f"{sd}/splat"
    meta = json.load(open(f"{spd}/cameras.json"))
    frames = meta["frames"]
    if not frames:
        raise RuntimeError("no training views — run make_splat_data first")
    Wf = Hf = int(meta["face_px"])

    # all views into RAM as uint8 (≈5 GB at 400x5x800²) — one .cuda() per iter
    imgs = np.empty((len(frames), Hf, Wf, 3), np.uint8)
    c2ws = np.empty((len(frames), 4, 4), np.float64)
    for k, frm in enumerate(frames):
        imgs[k] = cv2.cvtColor(cv2.imread(f"{spd}/{frm['img']}"), cv2.COLOR_BGR2RGB)
        c2ws[k] = np.array(frm["c2w"])
    w2cs = np.linalg.inv(c2ws)
    viewmats = torch.tensor(w2cs, dtype=torch.float32, device="cuda")
    K = torch.tensor([[meta["f_px"], 0, meta["cx"]], [0, meta["f_px"], meta["cy"]], [0, 0, 1]],
                     dtype=torch.float32, device="cuda")
    # dedicated-still views: coarse localize poses, refined per-STILL during training
    # (all faces of one still share the still's body SE3)
    gnames = sorted({f["group"] for f in frames if "group" in f})
    gidx = np.array([gnames.index(f["group"]) if "group" in f else -1 for f in frames])
    c2wt = torch.tensor(c2ws, dtype=torch.float32, device="cuda")

    # init from the dense colored cloud, clipped to the scene box (+ margin) and subsampled
    xyz, rgb = _read_ply_xyzrgb(f"{sd}/{slug}.ply")
    if rgb is None:
        raise RuntimeError("PLY has no RGB — splat init needs the colored dense cloud")
    c = np.array(meta["c"], np.float64)
    up = np.array(meta["up"]); e1 = np.array(meta["e1"]); e2 = np.array(meta["e2"])
    floor, room = meta["floor"], meta["room"]
    lo1, hi1, lo2, hi2 = meta["lo1"], meta["hi1"], meta["lo2"], meta["hi2"]
    X = xyz - c
    p1 = X @ e1; p2 = X @ e2; h = X @ up
    m1 = 0.25 * (hi1 - lo1); m2 = 0.25 * (hi2 - lo2)
    keep = ((p1 > lo1 - m1) & (p1 < hi1 + m1) & (p2 > lo2 - m2) & (p2 < hi2 + m2)
            & (h > floor - 0.3 * room) & (h < floor + 1.3 * room))
    X = X[keep]; col = rgb[keep].astype(np.float32) / 255.0
    if len(X) > init_pts:
        sel = np.random.default_rng(0).choice(len(X), init_pts, replace=False)
        X = X[sel]; col = col[sel]
    from scipy.spatial import cKDTree
    d3, _ = cKDTree(X).query(X, k=4)
    scale0 = np.log(np.clip(d3[:, 1:].mean(1), 1e-5, None))
    N = len(X)
    KSH = (sh_degree + 1) ** 2
    params = torch.nn.ParameterDict({
        "means": torch.nn.Parameter(torch.tensor(X, dtype=torch.float32)),
        "scales": torch.nn.Parameter(torch.tensor(np.repeat(scale0[:, None], 3, 1), dtype=torch.float32)),
        "quats": torch.nn.Parameter(torch.rand(N, 4) * 2 - 1),
        "opacities": torch.nn.Parameter(torch.logit(torch.full((N,), 0.1))),
        "sh0": torch.nn.Parameter(torch.tensor((col - 0.5) / 0.28209479177387814,
                                               dtype=torch.float32)[:, None, :]),
        "shN": torch.nn.Parameter(torch.zeros(N, KSH - 1, 3)),
    }).cuda()
    cpos = c2ws[:, :3, 3]
    scene_scale = 1.1 * float(np.linalg.norm(cpos - cpos.mean(0), axis=1).max())
    lrs = {"means": 1.6e-4 * scene_scale, "scales": 5e-3, "quats": 1e-3,
           "opacities": 5e-2, "sh0": 2.5e-3, "shN": 2.5e-3 / 20}
    opts = {k: torch.optim.Adam([params[k]], lr=lrs[k], eps=1e-15) for k in lrs}
    sched = torch.optim.lr_scheduler.ExponentialLR(opts["means"], gamma=0.01 ** (1.0 / iters))
    if still_start <= 0:
        still_start = iters // 2 + 1000                       # after densification stops
    strategy = DefaultStrategy(refine_start_iter=500, refine_stop_iter=iters // 2,
                               reset_every=3000, refine_every=100)
    strategy.check_sanity(params, opts)
    sstate = strategy.initialize_state(scene_scale=scene_scale)

    use_pose = bool(pose_opt and len(gnames))
    if use_pose:
        rvec = torch.nn.Parameter(torch.zeros(len(gnames), 3, device="cuda"))
        tvec = torch.nn.Parameter(torch.zeros(len(gnames), 3, device="cuda"))
        evec = torch.nn.Parameter(torch.zeros(len(gnames), 3, device="cuda"))   # per-still exposure
        pose_optim = torch.optim.Adam([{"params": [rvec], "lr": 1e-3},
                                       {"params": [tvec], "lr": 1.6e-3 * scene_scale},
                                       {"params": [evec], "lr": 5e-3}])

    def _viewmat(k):
        g = int(gidx[k])
        if g < 0 or not use_pose:
            return viewmats[k][None]
        rv = rvec[g]
        th = rv.norm() + 1e-8                                 # Rodrigues (safe near zero)
        ax = rv / th
        Kx = torch.zeros(3, 3, device="cuda")
        Kx[0, 1] = -ax[2]; Kx[0, 2] = ax[1]; Kx[1, 0] = ax[2]
        Kx[1, 2] = -ax[0]; Kx[2, 0] = -ax[1]; Kx[2, 1] = ax[0]
        Rd = torch.eye(3, device="cuda") + torch.sin(th) * Kx + (1 - torch.cos(th)) * (Kx @ Kx)
        Rn = Rd @ c2wt[k, :3, :3]
        tn = c2wt[k, :3, 3] + tvec[g]
        w2c = torch.eye(4, device="cuda")
        w2c[:3, :3] = Rn.T
        w2c[:3, 3] = -Rn.T @ tn
        return w2c[None]

    gk = torch.exp(-((torch.arange(11, device="cuda") - 5.0) ** 2) / (2 * 1.5 ** 2))
    gk = gk / gk.sum()
    sswin = (gk[:, None] @ gk[None, :]).expand(3, 1, 11, 11)

    def _ssim(x, y):
        C1, C2 = 0.01 ** 2, 0.03 ** 2
        mu1 = F.conv2d(x, sswin, padding=5, groups=3); mu2 = F.conv2d(y, sswin, padding=5, groups=3)
        s1 = F.conv2d(x * x, sswin, padding=5, groups=3) - mu1 ** 2
        s2 = F.conv2d(y * y, sswin, padding=5, groups=3) - mu2 ** 2
        s12 = F.conv2d(x * y, sswin, padding=5, groups=3) - mu1 * mu2
        return (((2 * mu1 * mu2 + C1) * (2 * s12 + C2))
                / ((mu1 ** 2 + mu2 ** 2 + C1) * (s1 + s2 + C2))).mean()

    def _render(k, shd):
        return rasterization(
            means=params["means"], quats=params["quats"], scales=torch.exp(params["scales"]),
            opacities=torch.sigmoid(params["opacities"]),
            colors=torch.cat([params["sh0"], params["shN"]], 1),
            viewmats=_viewmat(k), Ks=K[None], width=Wf, height=Hf,
            sh_degree=shd, packed=False)

    rng = np.random.default_rng(1)
    vididx = np.where(gidx < 0)[0]
    stillidx = np.where(gidx >= 0)[0]
    print(f"[train] {slug}: {len(vididx)} video + {len(stillidx)} still views "
          f"({len(gnames)} stills, pose_opt={use_pose} from iter {still_start}), "
          f"{N} init gaussians, scene_scale {scene_scale:.2f}, {iters} iters on "
          f"{torch.cuda.get_device_name(0)}")
    psnr = 0.0
    for it in range(iters):
        # stills join once the map is solid; oversample them (they're few but gold)
        if len(stillidx) and it >= still_start and rng.random() < 0.15:
            k = int(rng.choice(stillidx))
        else:
            k = int(rng.choice(vididx))
        shd = min(it // 1000, sh_degree)
        g = int(gidx[k])
        renders, _, info = _render(k, shd)
        gt = torch.from_numpy(imgs[k]).cuda().float().div_(255.0)
        pred = renders[0]
        if use_pose and g >= 0:
            pred = pred * (2.0 * torch.sigmoid(evec[g]))[None, None, :]   # still exposure gain
        l1 = (pred - gt).abs().mean()
        pc = pred.permute(2, 0, 1)[None].clamp(0, 1); gc = gt.permute(2, 0, 1)[None]
        loss = 0.8 * l1 + 0.2 * (1.0 - _ssim(pc, gc))
        if g < 0:
            # video view: normal training step (densification only ever sees these —
            # a misaligned still must never SPAWN gaussians, it sprays needles)
            strategy.step_pre_backward(params, opts, sstate, it, info)
            loss.backward()
            strategy.step_post_backward(params, opts, sstate, it, info, packed=False)
            for o in opts.values():
                o.step(); o.zero_grad(set_to_none=True)
        else:
            # still view: pose+exposure always learn; the map only after the warmup
            loss.backward()
            if it >= still_start + 2000:
                for o in opts.values():
                    o.step(); o.zero_grad(set_to_none=True)
            else:
                for o in opts.values():
                    o.zero_grad(set_to_none=True)
            pose_optim.step(); pose_optim.zero_grad(set_to_none=True)
        sched.step()
        if len(params["means"]) > max_gauss:                       # pragmatic VRAM guard
            strategy.grow_grad2d *= 1.5
        if it % 1000 == 0 or it == iters - 1:
            with torch.no_grad():
                mse = ((pred.clamp(0, 1) - gt) ** 2).mean()
                psnr = float(10 * torch.log10(1.0 / (mse + 1e-12)))
            print(f"[train] it {it}: loss {float(loss):.4f} psnr {psnr:.2f} "
                  f"gaussians {len(params['means'])}")

    extra = {"sh_degree": sh_degree}
    if use_pose:
        extra["still_pose"] = {"names": gnames, "rvec": rvec.detach().cpu(),
                               "tvec": tvec.detach().cpu(), "evec": evec.detach().cpu()}
        dr = np.degrees(rvec.detach().cpu().norm(dim=1).numpy())
        dt = (tvec.detach().cpu().norm(dim=1).numpy() * meta["fpu"])
        print(f"[train] still pose refinement: rot median {np.median(dr):.2f}deg max {dr.max():.2f}deg, "
              f"trans median {np.median(dt):.2f}ft max {dt.max():.2f}ft")
    torch.save({k: v.detach().cpu() for k, v in params.items()} | extra, f"{spd}/ckpt.pt")
    vol.commit()

    s3 = _r2(); dbg = []
    with torch.no_grad():
        for j, k in enumerate(rng.choice(len(frames), 3, replace=False)):
            renders, _, _ = _render(int(k), sh_degree)
            pr = (renders[0].clamp(0, 1) * 255).byte().cpu().numpy()
            strip = np.concatenate([cv2.cvtColor(pr, cv2.COLOR_RGB2BGR),
                                    cv2.cvtColor(imgs[int(k)], cv2.COLOR_RGB2BGR)], axis=1)
            cv2.imwrite("/tmp/dbg.jpg", strip, [cv2.IMWRITE_JPEG_QUALITY, 90])
            dk = f"ortho/{slug}_splat_train{j}.jpg"
            s3.upload_file("/tmp/dbg.jpg", R2_BUCKET, dk); dbg.append(dk)
    ng = int(len(params["means"]))
    print(f"[train] {slug}: done — {ng} gaussians, last psnr {psnr:.2f} -> {spd}/ckpt.pt, dbg {dbg}")
    return {"gaussians": ng, "psnr": round(psnr, 2), "ckpt": f"{spd}/ckpt.pt", "debug": dbg}


@app.function(image=gsplat_image, gpu="A10G", secrets=[r2_secret], volumes={"/scratch": vol},
              timeout=1800, memory=16384)
def render_splat(slug: str, out_w: int = 2266, ceil_cut: float = 0.8, floor_cut: float = -0.5,
                 dollhouse: int = 3, doll_elev_deg: float = 40.0,
                 opa_min: float = 0.35, big_cut: float = 0.2, xy_margin: float = 0.12,
                 walls_mode: int = 0, strip_walls: int = 1, wall_lo: float = 0.55,
                 wall_hi: float = 0.75, tex_cut: float = 0.8) -> dict:
    """Stage 3: TRUE ORTHOGRAPHIC top-down from the trained splat (gaussians above
    floor + ceil_cut*room dropped = ceiling removed), pixel-registered to the same
    lo/hi-percentile frame as every other engine -> ortho/{slug}_splat.png. Bonus:
    tilted dollhouse renders (horizontally flipped for delivery — the reconstruction
    is mirrored vs reality; the ortho PNG stays RAW frame like _composed_v2, the
    editor layer applies flipH)."""
    import json
    import numpy as np
    import cv2
    import torch
    from gsplat import rasterization, spherical_harmonics

    sd = f"/scratch/{slug}"; spd = f"{sd}/splat"
    meta = json.load(open(f"{spd}/cameras.json"))
    ck = torch.load(f"{spd}/ckpt.pt", map_location="cuda", weights_only=False)
    up = np.array(meta["up"]); e1 = np.array(meta["e1"]); e2 = np.array(meta["e2"])
    floor, room = meta["floor"], meta["room"]
    lo1, hi1, lo2, hi2 = meta["lo1"], meta["hi1"], meta["lo2"], meta["hi2"]
    span1 = hi1 - lo1; span2 = hi2 - lo2
    mid1 = 0.5 * (lo1 + hi1); mid2 = 0.5 * (lo2 + hi2)
    shdeg = int(ck["sh_degree"])

    upT = torch.tensor(up, dtype=torch.float32, device="cuda")
    e1T = torch.tensor(e1, dtype=torch.float32, device="cuda")
    e2T = torch.tensor(e2, dtype=torch.float32, device="cuda")
    mall = ck["means"].cuda()
    h = mall @ upT
    sall = torch.exp(ck["scales"].cuda())
    qall = ck["quats"].cuda()
    opaall = torch.sigmoid(ck["opacities"].cuda())
    shall = torch.cat([ck["sh0"].cuda(), ck["shN"].cuda()], 1)
    p1g = mall @ e1T; p2g = mall @ e2T
    mx = xy_margin * max(span1, span2)
    # de-fuzz + scene box: semi-transparent floaters, oversized soft blobs, and
    # through-window sky/street gaussians all read as gray haze from above
    boxm = (p1g > lo1 - mx) & (p1g < hi1 + mx) & (p2g > lo2 - mx) & (p2g < hi2 + mx)
    # needles (ONE long axis — misaligned-view artifacts) render as streak spikes;
    # pancakes (walls/surfaces, TWO long axes) pass because max ~ median there
    needle = ((sall.max(1).values > 4.0 * sall.median(1).values)
              & (sall.max(1).values > 0.05 * room))
    solid = (opaall > opa_min) & (sall.max(1).values < big_cut * room) & boxm & ~needle
    band = solid & (h < floor + ceil_cut * room) & (h > floor + floor_cut * room)
    print(f"[render] {slug}: {int(band.sum())}/{len(band)} gaussians in view band "
          f"(ceil_cut {ceil_cut}, opa>{opa_min}, scale<{big_cut}*room, box+{xy_margin})")

    def _shade(idx, campos=None):
        # bake SH -> per-gaussian RGB for THIS view (dirs = -up for ortho top-down),
        # so the ortho camera model never has to reason about SH view directions
        m = mall[idx]
        if campos is None:
            dirs = (-upT)[None, :].expand(len(m), 3)
        else:
            dirs = m - torch.tensor(campos, dtype=torch.float32, device="cuda")
            dirs = dirs / dirs.norm(dim=1, keepdim=True).clamp(min=1e-9)
        return torch.clamp(spherical_harmonics(shdeg, dirs, shall[idx]) + 0.5, 0.0, 1.0)

    def _raster(idx, viewmat, Km, w, hh, campos=None, model="pinhole"):
        renders, alphas, _ = rasterization(
            means=mall[idx], quats=qall[idx], scales=sall[idx], opacities=opaall[idx],
            colors=_shade(idx, campos),
            viewmats=torch.tensor(viewmat, dtype=torch.float32, device="cuda")[None],
            Ks=torch.tensor(Km, dtype=torch.float32, device="cuda")[None],
            width=w, height=hh, packed=False, camera_model=model)
        return ((renders[0].clamp(0, 1) * 255).byte().cpu().numpy(),
                alphas[0, :, :, 0].cpu().numpy())

    # -- true ortho top-down: rows [e1, -e2, -up] (right-handed), flipud after -> raw frame
    Ht = int(round((out_w - 1) * span2 / span1)) + 1
    Rw2c = np.stack([e1, -e2, -up])
    campos = mid1 * e1 + mid2 * e2 + (floor + 4.0 * room) * up
    vm = np.eye(4); vm[:3, :3] = Rw2c; vm[:3, 3] = -Rw2c @ campos
    fx = (out_w - 1) / span1; fy = (Ht - 1) / span2
    Ko = [[fx, 0, (out_w - 1) / 2.0], [0, fy, (Ht - 1) / 2.0], [0, 0, 1]]

    keep_tex = band
    nwall = 0
    if walls_mode or strip_walls:
        # WALLS AS SOLID PAINT-COLORED STROKES (Justin's spec): the door-header band
        # (wall_lo..wall_hi of room height, ~4.7-6.4 ft) is solid over walls, OPEN over
        # doorways (openings stop at ~6'8"), and above nearly all furniture — so its
        # ortho occupancy IS the wall map with door breaks built in, and its rendered
        # color IS the paint.
        # walls only: a wall gaussian is a PANCAKE standing upright (smallest axis =
        # surface normal = horizontal). Furniture tops / floaters in the band are
        # horizontal pancakes or blobs — drop them before rasterizing the mask.
        qn = qall / qall.norm(dim=1, keepdim=True).clamp(min=1e-9)
        w_, x_, y_, z_ = qn[:, 0], qn[:, 1], qn[:, 2], qn[:, 3]
        Rg = torch.stack([
            torch.stack([1 - 2 * (y_ * y_ + z_ * z_), 2 * (x_ * y_ - w_ * z_), 2 * (x_ * z_ + w_ * y_)], -1),
            torch.stack([2 * (x_ * y_ + w_ * z_), 1 - 2 * (x_ * x_ + z_ * z_), 2 * (y_ * z_ - w_ * x_)], -1),
            torch.stack([2 * (x_ * z_ - w_ * y_), 2 * (y_ * z_ + w_ * x_), 1 - 2 * (x_ * x_ + y_ * y_)], -1),
        ], 1)
        jmin = sall.argmin(1)
        nrm = Rg[torch.arange(len(jmin), device="cuda"), :, jmin]
        vertical = (nrm @ upT).abs() < 0.6
        flatg = sall.min(1).values < 0.7 * sall.median(1).values
        wb = (boxm & (opaall > min(0.25, opa_min)) & (sall.max(1).values < big_cut * room)
              & vertical & flatg
              & (h > floor + wall_lo * room) & (h < floor + wall_hi * room))
        nwall = int(wb.sum())
        wrgb, wocc = _raster(wb, vm, Ko, out_w, Ht, model="ortho")
        ev = cv2.morphologyEx((wocc > 0.35).astype(np.uint8), cv2.MORPH_CLOSE,
                              np.ones((5, 5), np.uint8))
        px_ft = (out_w - 1) / (span1 * meta["fpu"])           # px per foot
        nc, lab, st, _ = cv2.connectedComponentsWithStats(ev)
        for i in range(1, nc):
            if st[i, cv2.CC_STAT_AREA] < 200:                 # specks aren't walls
                ev[lab == i] = 0
                continue
            dt = cv2.distanceTransform((lab == i).astype(np.uint8), cv2.DIST_L2, 3)
            if float(dt.max()) > 0.75 * px_ft:                # fatter than ~1.5 ft -> not a wall
                ev[lab == i] = 0
        ug = (fx * (p1g - mid1) + (out_w - 1) / 2.0).round().long().clamp(0, out_w - 1)
        vg = ((Ht - 1) / 2.0 - fy * (p2g - mid2)).round().long().clamp(0, Ht - 1)
        stroke = np.zeros((Ht, out_w), np.uint8)
    if walls_mode:
        # VECTORIZE by 1-D density: in the rotated Manhattan frame a wall is a sustained
        # line of band-gaussian mass at one offset; doorways are the gaps in its span.
        # (Robust to spotty evidence — no skeleton/Hough cascade to break.)
        wall_px = max(3, int(round(0.37 * px_ft)))
        segs = cv2.HoughLinesP(ev * 255, 1, np.pi / 180, threshold=int(1.5 * px_ft),
                               minLineLength=int(2.0 * px_ft), maxLineGap=int(0.5 * px_ft))
        theta = 0.0
        if segs is not None and len(segs):
            s0_ = segs[:, 0, :].astype(np.float64)
            ang = np.degrees(np.arctan2(s0_[:, 3] - s0_[:, 1], s0_[:, 2] - s0_[:, 0])) % 90.0
            ln = np.hypot(s0_[:, 2] - s0_[:, 0], s0_[:, 3] - s0_[:, 1])
            hist = np.zeros(90)
            np.add.at(hist, ang.astype(int) % 90, ln)
            hist = np.convolve(np.concatenate([hist[-2:], hist, hist[:2]]), np.ones(5), "valid")
            theta = float(np.argmax(hist))                    # dominant wall orientation
        cxi = (out_w - 1) / 2.0; cyi = (Ht - 1) / 2.0
        th = np.radians(theta); ct, sn = np.cos(th), np.sin(th)
        ir = lambda v: int(round(v))
        uw = ug[wb].cpu().numpy().astype(np.float64); vw = vg[wb].cpu().numpy().astype(np.float64)
        wts = opaall[wb].cpu().numpy()
        WX = cxi + ct * (uw - cxi) + sn * (vw - cyi)          # rotate by -theta
        WY = cyi - sn * (uw - cxi) + ct * (vw - cyi)
        OB, AB = 4.0, 16.0                                    # offset / along bin sizes (px)
        gaptol = int(round(2.0 * px_ft / AB)); minrun = 3.0 * px_ft / AB
        for axis in (0, 1):
            off = (WY if axis == 0 else WX) / OB
            alo = (WX if axis == 0 else WY) / AB
            o0 = int(np.floor(off.min())); a0 = int(np.floor(alo.min()))
            grid = np.zeros((int(off.max()) - o0 + 2, int(alo.max()) - a0 + 2), np.float32)
            np.add.at(grid, (off.astype(int) - o0, alo.astype(int) - a0), wts)
            rs = np.convolve(grid.sum(1), np.ones(3), "same")
            order = np.argsort(-rs)
            taken = np.zeros(len(rs), bool)
            rs_min = max(6.0, 0.18 * float(rs.max()))         # furniture rows don't qualify
            for r in order:
                if rs[r] < rs_min or taken[max(0, r - 8):r + 9].any():   # one stroke per wall
                    continue
                taken[r] = True
                prof = np.convolve(grid[max(0, r - 2):r + 3].sum(0), np.ones(3), "same")
                on = prof > 1.4
                runs = []
                for k in np.where(on)[0]:                     # merge sub-door gaps only
                    if runs and k - runs[-1][1] <= gaptol:
                        runs[-1][1] = k
                    else:
                        runs.append([k, k])
                for k0, k1 in runs:
                    if k1 - k0 < minrun:                      # stray dashes aren't walls
                        continue
                    aa0 = (k0 + a0) * AB; aa1 = (k1 + a0 + 1) * AB
                    oo = (r + o0 + 0.5) * OB
                    if axis == 0:
                        P0 = (aa0, oo); P1 = (aa1, oo)
                    else:
                        P0 = (oo, aa0); P1 = (oo, aa1)
                    q0 = (cxi + ct * (P0[0] - cxi) - sn * (P0[1] - cyi),
                          cyi + sn * (P0[0] - cxi) + ct * (P0[1] - cyi))
                    q1 = (cxi + ct * (P1[0] - cxi) - sn * (P1[1] - cyi),
                          cyi + sn * (P1[0] - cxi) + ct * (P1[1] - cyi))
                    cv2.line(stroke, (ir(q0[0]), ir(q0[1])), (ir(q1[0]), ir(q1[1])),
                             255, wall_px)
    if walls_mode or strip_walls:
        wmask = stroke > 0
        # strip ALL wall evidence (not just drawn strokes) from the texture pass — the
        # wall fuzz goes away, and with walls gone the ceiling cut can rise to tex_cut
        # so tall furniture keeps its top
        grow = cv2.dilate(((ev > 0) | wmask).astype(np.uint8), np.ones((13, 13), np.uint8)) > 0
        inwall = torch.from_numpy(grow).cuda()[vg, ug]
        # mid-air isotropic blobs (floaters the opacity gate misses) read as gray haze
        roundish = sall.min(1).values > 0.45 * sall.max(1).values
        airjunk = roundish & (h > floor + 0.45 * room) & (h < floor + tex_cut * room)
        keep_tex = (solid & (h < floor + tex_cut * room) & (h > floor + floor_cut * room)
                    & ~(inwall & (h > floor + 0.18 * room)) & ~airjunk)

    img, _ = _raster(keep_tex, vm, Ko, out_w, Ht, model="ortho")
    if walls_mode:
        # flat paint field: de-alpha the band render, spread + smooth at quarter res,
        # then fill the wall strokes solid with it
        pf = (wrgb.astype(np.float32) / np.maximum(wocc[..., None], 0.25)).clip(0, 255).astype(np.uint8)
        q = cv2.resize(pf, (max(2, out_w // 4), max(2, Ht // 4)), interpolation=cv2.INTER_AREA)
        qm = (cv2.resize((wocc > 0.3).astype(np.uint8) * 255, (q.shape[1], q.shape[0]),
                         interpolation=cv2.INTER_NEAREST) == 0).astype(np.uint8)
        q = cv2.inpaint(q, qm, 5, cv2.INPAINT_TELEA)
        q = cv2.GaussianBlur(q, (31, 31), 0)
        paint = cv2.resize(q, (out_w, Ht), interpolation=cv2.INTER_LINEAR)
        img[wmask] = paint[wmask]

    img = np.flipud(img)
    obgr = cv2.cvtColor(np.ascontiguousarray(img), cv2.COLOR_RGB2BGR)
    s3 = _r2()
    cv2.imwrite("/tmp/so.png", obgr)
    key = f"ortho/{slug}_splat.png"; s3.upload_file("/tmp/so.png", R2_BUCKET, key)
    cv2.imwrite("/tmp/so.jpg", obgr, [cv2.IMWRITE_JPEG_QUALITY, 95])
    s3.upload_file("/tmp/so.jpg", R2_BUCKET, f"ortho/{slug}_splat.jpg")

    # compositor inputs: per-pixel surface HEIGHT (expected-depth ortho -> feet above
    # floor; PNG16, value = (ft + 5) * 1000) + the raw wall-evidence mask (registration)
    dep, dal, _ = rasterization(
        means=mall[keep_tex], quats=qall[keep_tex], scales=sall[keep_tex],
        opacities=opaall[keep_tex], colors=torch.ones((int(keep_tex.sum()), 3), device="cuda"),
        viewmats=torch.tensor(vm, dtype=torch.float32, device="cuda")[None],
        Ks=torch.tensor(Ko, dtype=torch.float32, device="cuda")[None],
        width=out_w, height=Ht, packed=False, camera_model="ortho", render_mode="ED")
    hft = (4.0 * room - dep[0, :, :, 0].cpu().numpy()) * meta["fpu"]
    hft[dal[0, :, :, 0].cpu().numpy() < 0.5] = 30.0           # empty sky reads as "not floor"
    cv2.imwrite("/tmp/shh.png", np.flipud(np.clip((hft + 5.0) * 1000.0, 0, 65535).astype(np.uint16)))
    hkey = f"ortho/{slug}_splat_height.png"; s3.upload_file("/tmp/shh.png", R2_BUCKET, hkey)
    if walls_mode or strip_walls:
        cv2.imwrite("/tmp/sev.png", np.flipud(ev * 255))
        s3.upload_file("/tmp/sev.png", R2_BUCKET, f"ortho/{slug}_splat_wallev.png")

    # -- bonus dollhouse views: pinhole, 35-45 deg elevation, flipH for delivery
    dkeys = []
    el = np.radians(doll_elev_deg); fov = np.radians(55.0); dw, dh = 1600, 1200
    ctr = mid1 * e1 + mid2 * e2 + (floor + 0.35 * room) * up
    dist = 0.65 * float(np.hypot(span1, span2)) / np.tan(fov / 2)
    for k in range(max(0, dollhouse)):
        az = 2 * np.pi * k / max(1, dollhouse) + np.pi / 6
        back = np.cos(az) * e1 + np.sin(az) * e2
        cp = ctr + dist * (np.cos(el) * back + np.sin(el) * up)
        fwd = ctr - cp; fwd = fwd / np.linalg.norm(fwd)
        rgt = np.cross(fwd, up); rgt = rgt / np.linalg.norm(rgt)
        dwn = np.cross(fwd, rgt)                             # OpenCV y-down; [rgt,dwn,fwd] right-handed
        R = np.stack([rgt, dwn, fwd])
        vmk = np.eye(4); vmk[:3, :3] = R; vmk[:3, 3] = -R @ cp
        fpx = (dw / 2.0) / np.tan(fov / 2)
        Kd = [[fpx, 0, dw / 2.0], [0, fpx, dh / 2.0], [0, 0, 1]]
        dim, _ = _raster(band, vmk, Kd, dw, dh, campos=cp)
        dim = cv2.cvtColor(np.ascontiguousarray(dim[:, ::-1]), cv2.COLOR_RGB2BGR)  # mirror fix
        cv2.imwrite("/tmp/dh.jpg", dim, [cv2.IMWRITE_JPEG_QUALITY, 92])
        dk = f"ortho/{slug}_dollhouse{k}.jpg"
        s3.upload_file("/tmp/dh.jpg", R2_BUCKET, dk); dkeys.append(dk)

    fpu = meta["fpu"]
    print(f"[render] {slug}: ortho {out_w}x{Ht} ({round(span1*fpu,1)}x{round(span2*fpu,1)}ft), "
          f"walls_mode={walls_mode} ({nwall} band gaussians) -> {key}, dollhouse {dkeys}")
    return {"ortho": key, "jpg": f"ortho/{slug}_splat.jpg", "px": [out_w, Ht],
            "walls": bool(walls_mode), "dollhouse": dkeys}


def _load_still_poses(s3, slug, meta, spd):
    """Refined still BODY poses (c2w) for projection: prefer the COLMAP registration
    (layout/{slug}/colmap_stills.json — mm-class), else the photometric refinement
    saved in the training checkpoint."""
    import json
    import numpy as np
    try:
        cj = json.loads(s3.get_object(Bucket=R2_BUCKET,
                                      Key=f"layout/{slug}/colmap_stills.json")["Body"].read())
        poses = {k: np.array(v["c2w"]) for k, v in cj.items() if isinstance(v, dict)}
        if poses:
            print(f"[stillposes] COLMAP poses for {len(poses)} stills")
            return poses
    except Exception:
        pass
    import torch
    ck = torch.load(f"{spd}/ckpt.pt", map_location="cpu", weights_only=False)
    sp = ck.get("still_pose")
    if not sp:
        return {}
    base = {}
    for f in meta["frames"]:
        if f.get("group") and f["img"].endswith("_f.jpg"):
            base[f["group"]] = np.array(f["c2w"])
    rv = sp["rvec"].numpy(); tv = sp["tvec"].numpy()
    poses = {}
    for gi, name in enumerate(sp["names"]):
        if name not in base:
            continue
        c2w = base[name].copy()
        th = np.linalg.norm(rv[gi])
        if th > 1e-8:
            ax = rv[gi] / th
            Kx = np.array([[0, -ax[2], ax[1]], [ax[2], 0, -ax[0]], [-ax[1], ax[0], 0]])
            c2w[:3, :3] = (np.eye(3) + np.sin(th) * Kx + (1 - np.cos(th)) * (Kx @ Kx)) @ c2w[:3, :3]
        c2w[:3, 3] += tv[gi]
        poses[name] = c2w
    print(f"[stillposes] ckpt-refined poses for {len(poses)} stills")
    return poses


@app.function(image=gsplat_image, secrets=[r2_secret], volumes={"/scratch": vol},
              timeout=3600, memory=16384)
def make_still_ortho(slug: str, out_w: int = 2266, max_off_deg: float = 60.0,
                     max_off_flat: float = 76.0,
                     stills_prefix: str = "projects/old-town-scottsdale-home/still/") -> dict:
    """Project each 360 STILL's bottom hemisphere onto the splat's height surface
    (make_trueortho's per-ray trick, but from 14 standpoints INSIDE the rooms at 8K,
    through the REFINED poses from train_splat). Occlusion-checked against the height
    map, exposure-corrected by each still's learned gain, winner-take-all by ray
    verticality -> ortho/{slug}_still_tex.png + weight mask for the hybrid compositor."""
    import io
    import json
    import numpy as np
    import cv2
    import torch

    s3 = _r2(); sd = f"/scratch/{slug}"; spd = f"{sd}/splat"
    meta = json.load(open(f"{spd}/cameras.json"))
    ck = torch.load(f"{spd}/ckpt.pt", map_location="cpu", weights_only=False)
    poses = _load_still_poses(s3, slug, meta, spd)
    if not poses:
        raise RuntimeError("no refined still poses — run colmapreg or retrain with pose_opt=1")
    up = np.array(meta["up"]); e1 = np.array(meta["e1"]); e2 = np.array(meta["e2"])
    floor, room, fpu = meta["floor"], meta["room"], meta["fpu"]
    lo1, hi1, lo2, hi2 = meta["lo1"], meta["hi1"], meta["lo2"], meta["hi2"]
    span1 = hi1 - lo1; span2 = hi2 - lo2
    Ht = int(round((out_w - 1) * span2 / span1)) + 1

    # surface height per RAW-frame cell (ft above floor), from the splat render stage
    hbuf = s3.get_object(Bucket=R2_BUCKET, Key=f"ortho/{slug}_splat_height.png")["Body"].read()
    h16 = cv2.imdecode(np.frombuffer(hbuf, np.uint8), cv2.IMREAD_UNCHANGED)
    h16 = cv2.resize(h16, (out_w, Ht), interpolation=cv2.INTER_NEAREST)
    hft = h16.astype(np.float32) / 1000.0 - 5.0
    hft[hft > 12.0] = 0.0                                    # empty sky -> treat as floor
    hu = floor + hft / fpu                                   # surface height in units

    sp = ck.get("still_pose") or {}
    evec = sp.get("evec")                                     # may be absent on old ckpts
    egain = {}
    if evec is not None:
        for gi, nm in enumerate(sp["names"]):
            egain[nm] = 2.0 / (1.0 + np.exp(-evec[gi].numpy()))
    resp = s3.list_objects_v2(Bucket=R2_BUCKET, Prefix=stills_prefix)
    skeys = {os.path.splitext(os.path.basename(o["Key"]))[0]: o["Key"]
             for o in resp.get("Contents", []) if o["Key"].lower().endswith((".jpg", ".jpeg"))}

    # splat ortho = the color/exposure anchor each still patch gets matched to
    sbuf = s3.get_object(Bucket=R2_BUCKET, Key=f"ortho/{slug}_splat.png")["Body"].read()
    sref = cv2.imdecode(np.frombuffer(sbuf, np.uint8), cv2.IMREAD_COLOR)
    sref = cv2.resize(sref, (out_w, Ht), interpolation=cv2.INTER_AREA).astype(np.float32)

    gx, gy = np.meshgrid(np.arange(out_w), np.arange(Ht))     # RAW frame cell coords
    p1c = lo1 + gx / (out_w - 1.0) * span1
    p2c = lo2 + gy / (Ht - 1.0) * span2
    cosmax = np.cos(np.radians(max_off_deg))
    # flat surfaces (counters, tables, floors) tolerate OBLIQUE rays — layover needs a
    # height EDGE to show. Relax the cone there; stay strict near discontinuities.
    gyf, gxf = np.gradient(hft)
    flatm = np.hypot(gxf, gyf) < 0.12
    flatm = cv2.erode(flatm.astype(np.uint8), np.ones((7, 7), np.uint8)) > 0
    coscell = np.where(flatm, np.cos(np.radians(max_off_flat)), cosmax).astype(np.float32)
    out = np.zeros((Ht, out_w, 3), np.float32)
    best = np.zeros((Ht, out_w), np.float32)
    used = 0
    for name, c2w in poses.items():
        if name not in skeys:
            continue
        R = c2w[:3, :3]; C = c2w[:3, 3]
        p1s = float(C @ e1); p2s = float(C @ e2); hs = float(C @ up)
        s3.download_file(R2_BUCKET, skeys[name], "/tmp/sp.jpg")
        pano = cv2.imread("/tmp/sp.jpg")
        if pano is None:
            continue
        Hp, Wp = pano.shape[:2]
        pano = np.concatenate([pano, pano[:, :1]], axis=1)    # lon-180 wrap
        dx = p1c - p1s; dy = p2c - p2s
        drop = hs - hu
        dxy = np.hypot(dx, dy)
        dist = np.hypot(dxy, drop)
        vert = drop / np.maximum(dist, 1e-6)                  # 1 = straight down
        cand = (vert > coscell) & (drop > 0.4 / fpu)
        w = np.where(cand, vert ** 6, 0.0).astype(np.float32)
        w[w <= best] = 0.0
        if not (w > 0).any():
            continue
        # occlusion march: reject cells whose ray dips below the surface en route
        vis = np.ones((Ht, out_w), bool)
        for s in np.linspace(0.2, 0.9, 10):
            sx = ((p1s + s * dx - lo1) / span1 * (out_w - 1)).astype(np.int32).clip(0, out_w - 1)
            sy = ((p2s + s * dy - lo2) / span2 * (Ht - 1)).astype(np.int32).clip(0, Ht - 1)
            vis &= hu[sy, sx] < (hs + s * (hu - hs)) + 0.35 / fpu
        w[~vis] = 0.0
        sel = w > 0
        if not sel.any():
            continue
        vx = dx[sel]; vy = dy[sel]; vz = (hu - hs)[sel]
        vw = (vx[:, None] * e1 + vy[:, None] * e2 + vz[:, None] * up)
        vw /= np.linalg.norm(vw, axis=1, keepdims=True) + 1e-9
        rc = vw @ R                                           # world -> camera (R^T v)
        lon = np.arctan2(rc[:, 0], rc[:, 2])
        lat = np.arcsin(np.clip(-rc[:, 1], -1, 1))
        uf = ((lon / (2 * np.pi)) + 0.5) * Wp
        vf = np.clip((0.5 - lat / np.pi) * Hp, 0, Hp - 1.001)
        polar = vf > 0.86 * Hp                                # pano bottom pole = drone body
        x0 = np.floor(uf).astype(np.int32); y0 = np.floor(vf).astype(np.int32)
        fx = (uf - x0).astype(np.float32)[:, None]; fy = (vf - y0).astype(np.float32)[:, None]
        col = (pano[y0, x0] * (1 - fx) * (1 - fy) + pano[y0, x0 + 1] * fx * (1 - fy)
               + pano[y0 + 1, x0] * (1 - fx) * fy + pano[y0 + 1, x0 + 1] * fx * fy).astype(np.float32)
        if name in egain:                                     # learned gain maps splat->still (RGB);
            col /= np.maximum(egain[name][::-1], 0.3)         # divide -> splat exposure (BGR order)
        col = col[~polar]
        selyx = np.where(sel)
        keep2 = ~polar
        sel2 = np.zeros_like(sel); sel2[selyx[0][keep2], selyx[1][keep2]] = True
        # per-still exposure anchor: match this patch's stats to the splat at the SAME cells
        anch = sref[sel2]
        okc = anch.sum(1) > 25
        if int(okc.sum()) > 400:
            for cch in range(3):
                a = float(np.clip(anch[okc, cch].std() / max(col[okc, cch].std(), 1e-3), 0.6, 1.6))
                b = float(anch[okc, cch].mean() - a * col[okc, cch].mean())
                col[:, cch] = col[:, cch] * a + b
        out[sel2] = np.clip(col, 0, 255)
        best[sel2] = w[sel][keep2]
        used += 1
        print(f"[stilltex] {name[:8]}: {int(sel.sum())} px, standpoint ({(p1s-lo1)*fpu:.1f}, "
              f"{(p2s-lo2)*fpu:.1f}) ft, h {(hs-floor)*fpu:.1f} ft")

    img = np.clip(out, 0, 255).astype(np.uint8)
    w8 = np.clip(best / max(best.max(), 1e-6) * 255, 0, 255).astype(np.uint8)
    cv2.imwrite("/tmp/st.png", img)
    key = f"ortho/{slug}_still_tex.png"; s3.upload_file("/tmp/st.png", R2_BUCKET, key)
    cv2.imwrite("/tmp/stw.png", w8)
    wkey = f"ortho/{slug}_still_texw.png"; s3.upload_file("/tmp/stw.png", R2_BUCKET, wkey)
    cov = int((best > 0).mean() * 100)
    print(f"[stilltex] {slug}: {used} stills projected, {cov}% of frame covered -> {key}")
    return {"tex": key, "weight": wkey, "stills": used, "cov_pct": cov}


@app.local_entrypoint()
def stillortho(slug: str, max_off_deg: float = 60.0):
    """Project the 8K stills through their refined poses onto the splat height surface:
        modal run modal_app.py::stillortho --slug scottsdale-nadir"""
    print(make_still_ortho.remote(slug, max_off_deg=max_off_deg))


@app.function(image=gsplat_image, secrets=[r2_secret], volumes={"/scratch": vol},
              timeout=7200, memory=32768)
def make_floortex(slug: str, out_w: int = 2266, n_frames: int = 240, rmax_ft: float = 16.0,
                  stills_prefix: str = "projects/old-town-scottsdale-home/still/") -> dict:
    """Justin's horizon-bounded floor unwrap: every posed pano (stills first, then video
    frames) projects its FLOOR pixels outward to the per-azimuth LINE-OF-SIGHT horizon —
    an occlusion march on the splat height field stands in for the horizon line, so the
    projection stops at wall bases and furniture instead of a fixed cone. Floor is flat,
    so there is NO layover at any obliquity. Select-blend by ray verticality with rolling
    gain match -> ortho/{slug}_floortex.png (+ mask) for the hybrid compositor."""
    import json
    import numpy as np
    import cv2
    import torch

    s3 = _r2(); sd = f"/scratch/{slug}"; spd = f"{sd}/splat"
    meta = json.load(open(f"{spd}/cameras.json"))
    up = np.array(meta["up"]); e1 = np.array(meta["e1"]); e2 = np.array(meta["e2"])
    floor, room, fpu = meta["floor"], meta["room"], meta["fpu"]
    lo1, hi1, lo2, hi2 = meta["lo1"], meta["hi1"], meta["lo2"], meta["hi2"]
    span1 = hi1 - lo1; span2 = hi2 - lo2
    Ht = int(round((out_w - 1) * span2 / span1)) + 1
    c = np.array(meta["c"], np.float64)

    hbuf = s3.get_object(Bucket=R2_BUCKET, Key=f"ortho/{slug}_splat_height.png")["Body"].read()
    h16 = cv2.imdecode(np.frombuffer(hbuf, np.uint8), cv2.IMREAD_UNCHANGED)
    h16 = cv2.resize(h16, (out_w, Ht), interpolation=cv2.INTER_NEAREST)
    hft = h16.astype(np.float32) / 1000.0 - 5.0
    hft[hft > 12.0] = 0.0
    hu = (floor + hft / fpu).astype(np.float32)               # surface height (units)
    F = hft < 0.35                                            # floor + rugs = unwrap targets

    gx, gy = np.meshgrid(np.arange(out_w), np.arange(Ht))
    p1c = (lo1 + gx / (out_w - 1.0) * span1).astype(np.float32)
    p2c = (lo2 + gy / (Ht - 1.0) * span2).astype(np.float32)
    rmax_u = rmax_ft / fpu

    out = np.zeros((Ht, out_w, 3), np.float32)
    best = np.zeros((Ht, out_w), np.float32)

    def unwrap(pano, R, C, tag, wboost=1.0):
        nonlocal out, best
        p1s = float(C @ e1); p2s = float(C @ e2); hs = float(C @ up)
        if hs - floor < 0.25 * (1.0 / fpu):                   # too low to see floor (< ~3in? no: 0.25ft)
            return 0
        dx = p1c - p1s; dy = p2c - p2s
        dxy = np.hypot(dx, dy)
        drop = hs - hu
        vert = drop / np.maximum(np.hypot(dxy, drop), 1e-6)
        w = np.where(F & (dxy < rmax_u) & (drop > 0.15 / fpu), vert ** 4, 0.0).astype(np.float32) * wboost
        cand = w > best
        if not cand.any():
            return 0
        cy, cx2 = np.where(cand)
        dxc = dx[cy, cx2]; dyc = dy[cy, cx2]
        # LINE-OF-SIGHT march: the ray from the camera to the cell's floor point must
        # clear the height field en route — this IS the per-azimuth horizon line
        vis = np.ones(len(cy), bool)
        huc = hu[cy, cx2]
        for s in np.linspace(0.12, 0.93, 12):
            sx = ((p1s + s * dxc - lo1) / span1 * (out_w - 1)).astype(np.int32).clip(0, out_w - 1)
            sy = ((p2s + s * dyc - lo2) / span2 * (Ht - 1)).astype(np.int32).clip(0, Ht - 1)
            vis &= hu[sy, sx] < (hs + s * (huc - hs)) + 0.3 / fpu
        if not vis.any():
            return 0
        cy = cy[vis]; cx2 = cx2[vis]
        vw = (dx[cy, cx2][:, None] * e1 + dy[cy, cx2][:, None] * e2
              + (hu[cy, cx2] - hs)[:, None] * up)
        vw /= np.linalg.norm(vw, axis=1, keepdims=True) + 1e-9
        rc = vw @ R
        Hp, Wp = pano.shape[0], pano.shape[1] - 1
        lon = np.arctan2(rc[:, 0], rc[:, 2])
        lat = np.arcsin(np.clip(-rc[:, 1], -1, 1))
        uf = ((lon / (2 * np.pi)) + 0.5) * Wp
        vf = np.clip((0.5 - lat / np.pi) * Hp, 0, Hp - 1.001)
        keepp = vf < 0.88 * Hp                                # pano bottom pole = drone body
        cy = cy[keepp]; cx2 = cx2[keepp]; uf = uf[keepp]; vf = vf[keepp]
        if not len(cy):
            return 0
        x0 = np.floor(uf).astype(np.int32); y0 = np.floor(vf).astype(np.int32)
        fx = (uf - x0).astype(np.float32)[:, None]; fy = (vf - y0).astype(np.float32)[:, None]
        col = (pano[y0, x0] * (1 - fx) * (1 - fy) + pano[y0, x0 + 1] * fx * (1 - fy)
               + pano[y0 + 1, x0] * (1 - fx) * fy + pano[y0 + 1, x0 + 1] * fx * fy).astype(np.float32)
        seen = best[cy, cx2] > 0.05
        if int(seen.sum()) > 400:                             # rolling gain match to the mosaic
            gv = float(np.clip(np.median(out[cy[seen], cx2[seen]].mean(1)
                                         / (col[seen].mean(1) + 1e-3)), 0.75, 1.35))
            col *= gv
        out[cy, cx2] = col
        best[cy, cx2] = w[cy, cx2]
        return int(len(cy))

    # --- stills first (in-room standpoints set the exposure baseline) ---
    poses = _load_still_poses(s3, slug, meta, spd)
    nstill = 0
    if poses:
        resp = s3.list_objects_v2(Bucket=R2_BUCKET, Prefix=stills_prefix)
        skeys = {os.path.splitext(os.path.basename(o["Key"]))[0]: o["Key"]
                 for o in resp.get("Contents", []) if o["Key"].lower().endswith((".jpg", ".jpeg"))}
        for name, c2w in poses.items():
            if name not in skeys:
                continue
            s3.download_file(R2_BUCKET, skeys[name], "/tmp/fp.jpg")
            pano = cv2.imread("/tmp/fp.jpg")
            if pano is None:
                continue
            pano = np.concatenate([pano, pano[:, :1]], axis=1)
            n = unwrap(pano, c2w[:3, :3], c2w[:3, 3], name[:8], wboost=1.6)   # stills win ties
            nstill += 1 if n else 0
    print(f"[floortex] {nstill} stills unwrapped")

    # --- video frames: sequential decode of the 4K proxy, sharp-gated ---
    traj = f"{sd}/frame_trajectory.txt"
    T = np.loadtxt(traj)
    vid = f"{sd}/hires.mp4"
    cap = cv2.VideoCapture(vid)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    nfr = cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0
    ts = T[:, 0].copy()
    if nfr and ts.max() > (nfr / fps) * 2:
        ts = ts / fps
    Rm = np.array([_quat2rot(q) for q in T[:, 4:8]])
    Cm = T[:, 1:4] - c
    okp = np.isfinite(Cm).all(1) & np.isfinite(Rm.reshape(len(T), -1)).all(1) & np.isfinite(ts)
    okidx = np.where(okp)[0]
    step = max(1, len(okidx) // max(1, n_frames))
    nvid = 0; sharps = []
    for i in okidx[::step]:
        cap.set(cv2.CAP_PROP_POS_MSEC, float(ts[i]) * 1000.0)
        ok2, fr = cap.read()
        if not ok2:
            continue
        g = cv2.cvtColor(cv2.resize(fr, (480, 240)), cv2.COLOR_BGR2GRAY)
        s = float(cv2.Laplacian(g, cv2.CV_64F).var())
        sharps.append(s)
        if len(sharps) > 30 and s < 0.55 * float(np.median(sharps[-121:])):
            continue
        frp = np.concatenate([fr, fr[:, :1]], axis=1)
        if unwrap(frp, Rm[i], Cm[i], f"f{i}"):
            nvid += 1
    cap.release()

    img = np.clip(out, 0, 255).astype(np.uint8)
    cov = best > 0
    cv2.imwrite("/tmp/ft.png", img)
    key = f"ortho/{slug}_floortex.png"; s3.upload_file("/tmp/ft.png", R2_BUCKET, key)
    cv2.imwrite("/tmp/ftm.png", cov.astype(np.uint8) * 255)
    mkey = f"ortho/{slug}_floortex_mask.png"; s3.upload_file("/tmp/ftm.png", R2_BUCKET, mkey)
    covp = int(cov.mean() * 100)
    floorp = int((cov & F).sum() / max(F.sum(), 1) * 100)
    print(f"[floortex] {slug}: {nstill} stills + {nvid} video frames, floor {floorp}% textured "
          f"({covp}% of frame) -> {key}")
    return {"tex": key, "mask": mkey, "stills": nstill, "frames": nvid,
            "floor_cov_pct": floorp}


@app.local_entrypoint()
def floortex(slug: str, n_frames: int = 240, rmax_ft: float = 16.0):
    """Horizon-bounded floor unwrap from ALL posed panos:
        modal run modal_app.py::floortex --slug scottsdale-nadir"""
    print(make_floortex.remote(slug, n_frames=n_frames, rmax_ft=rmax_ft))


# COLMAP CLI layered on top of the gsplat image (appended layer — the cached torch/gsplat
# build is untouched). CPU SIFT; we drive the classic known-pose flow via subprocess.
colmap_image = gsplat_image.apt_install("colmap")

# Real-ESRGAN weights via spandrel (torch-only loader — no basicsr dependency tar pit).
esrgan_image = (
    gsplat_image
    .pip_install("spandrel")
    .run_commands(
        "python -c \"import urllib.request; urllib.request.urlretrieve("
        "'https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth',"
        "'/opt/realesrgan_x4plus.pth')\"")
)


@app.function(image=esrgan_image, gpu="A10G", secrets=[r2_secret], timeout=1800, memory=16384)
def enhance_image(key_in: str, key_out: str, sharpen: float = 0.35, tile: int = 512) -> dict:
    """AI de-blur for the composite (Justin-approved generative sharpening): Real-ESRGAN
    x4 over the image in padded tiles, downsampled back to NATIVE size — soft edges come
    back defined — plus a mild unsharp kiss. R2 key -> R2 key."""
    import numpy as np
    import cv2
    import torch
    from spandrel import ModelLoader

    s3 = _r2()
    buf = s3.get_object(Bucket=R2_BUCKET, Key=key_in)["Body"].read()
    img = cv2.imdecode(np.frombuffer(buf, np.uint8), cv2.IMREAD_COLOR)
    H, W = img.shape[:2]
    model = ModelLoader().load_from_file("/opt/realesrgan_x4plus.pth").cuda().eval()
    rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
    up = np.zeros((H * 4, W * 4, 3), np.float32)
    pad = 16
    with torch.no_grad():
        for y0 in range(0, H, tile):
            for x0 in range(0, W, tile):
                y1 = min(H, y0 + tile); x1 = min(W, x0 + tile)
                ya = max(0, y0 - pad); xa = max(0, x0 - pad)
                yb = min(H, y1 + pad); xb = min(W, x1 + pad)
                t = torch.from_numpy(rgb[ya:yb, xa:xb]).permute(2, 0, 1)[None].cuda()
                o = model(t)[0].permute(1, 2, 0).clamp(0, 1).cpu().numpy()
                up[y0 * 4:y1 * 4, x0 * 4:x1 * 4] = \
                    o[(y0 - ya) * 4:(y0 - ya) * 4 + (y1 - y0) * 4,
                      (x0 - xa) * 4:(x0 - xa) * 4 + (x1 - x0) * 4]
    out = cv2.resize(up, (W, H), interpolation=cv2.INTER_AREA)
    out = cv2.cvtColor((np.clip(out, 0, 1) * 255).astype(np.uint8), cv2.COLOR_RGB2BGR)
    if sharpen > 0:
        bl = cv2.GaussianBlur(out, (0, 0), 1.2)
        out = cv2.addWeighted(out, 1 + sharpen, bl, -sharpen, 0)
    png = key_out.lower().endswith(".png")
    enc = cv2.imencode(".png" if png else ".jpg", out,
                       [] if png else [cv2.IMWRITE_JPEG_QUALITY, 95])[1]
    s3.put_object(Bucket=R2_BUCKET, Key=key_out, Body=enc.tobytes(),
                  ContentType="image/png" if png else "image/jpeg")
    print(f"[enhance] {key_in} -> {key_out} ({W}x{H}, x4->native, sharpen {sharpen})")
    return {"out": key_out, "px": [W, H]}


@app.local_entrypoint()
def enhance(key_in: str, key_out: str, sharpen: float = 0.35):
    """modal run modal_app.py::enhance --key-in ortho/x.png --key-out ortho/x_enh.png"""
    print(enhance_image.remote(key_in, key_out, sharpen=sharpen))


@app.function(image=colmap_image, secrets=[r2_secret], volumes={"/scratch": vol},
              timeout=10800, cpu=16.0, memory=65536)
def colmap_register(slug: str, t_win: int = 4, spatial_ft: float = 5.0,
                    still_partners: int = 60) -> dict:
    """COLMAP-grade still registration: video faces enter a known-pose model FIXED at
    their VSLAM poses (frame + scale preserved by construction), the scene is
    triangulated from them, and the still faces are registered into that fixed model
    (PnP + BA with fix_existing_images). Per-still body pose = robust average over its
    registered faces; the face-to-face spread is the accuracy diagnostic.
    -> layout/{slug}/colmap_stills.json (consumed by make_still_ortho / make_floortex)."""
    import json
    import shutil
    import subprocess
    import numpy as np

    s3 = _r2(); sd = f"/scratch/{slug}"; spd = f"{sd}/splat"
    meta = json.load(open(f"{spd}/cameras.json"))
    frames = meta["frames"]
    face_px = int(meta["face_px"]); f_px = float(meta["f_px"])
    cx = float(meta["cx"]); cy = float(meta["cy"])
    fpu = float(meta["fpu"])
    wd = f"{sd}/colmap"
    shutil.rmtree(wd, ignore_errors=True)
    os.makedirs(f"{wd}/known", exist_ok=True)

    def _run(args):
        r = subprocess.run(["colmap"] + args, capture_output=True, text=True)
        if r.returncode != 0:
            raise RuntimeError(f"colmap {args[0]} failed:\n{r.stdout[-800:]}\n{r.stderr[-800:]}")
        return r

    # --- image inventory from cameras.json (faces already on the volume at 1024px) ---
    vids, stils = [], []
    for f in frames:
        (stils if "group" in f else vids).append(f)
    C_all = {f["img"]: np.array(f["c2w"])[:3, 3] for f in frames}
    D_all = {f["img"]: np.array(f["c2w"])[:3, :3][:, 2] for f in frames}   # view dir (z col)

    # --- curated match list: temporal same-face, same-frame adjacent faces, spatial
    #     same-face loop closures, stills vs nearby video faces (direction-gated) ---
    pairs = set()
    byface = {}
    for f in vids:
        nm = f["img"]                                        # images/p{idx:05d}_{s}.jpg
        idx = int(nm.split("p")[1][:5]); sfx = nm[-5]
        byface.setdefault(sfx, []).append((idx, nm))
    for sfx, lst in byface.items():
        lst.sort()
        for a in range(len(lst)):
            for b in range(a + 1, min(a + 1 + t_win, len(lst))):
                pairs.add((lst[a][1], lst[b][1]))
    adj = [("f", "r"), ("r", "b"), ("b", "l"), ("l", "f"),
           ("f", "d"), ("r", "d"), ("b", "d"), ("l", "d")]
    frameix = {}
    for f in vids:
        frameix.setdefault(int(f["img"].split("p")[1][:5]), {})[f["img"][-5]] = f["img"]
    for fmap in frameix.values():
        for a, b in adj:
            if a in fmap and b in fmap:
                pairs.add((fmap[a], fmap[b]))
    # spatial loop closures: same-suffix faces of non-adjacent frames that are close
    sp_u = spatial_ft / fpu
    ids = sorted(frameix)
    cents = np.array([C_all[frameix[i]["f"]] if "f" in frameix[i]
                      else C_all[list(frameix[i].values())[0]] for i in ids])
    for ai in range(0, len(ids), 2):
        d = np.linalg.norm(cents - cents[ai], axis=1)
        near = [bi for bi in np.argsort(d)[1:12]
                if d[bi] < sp_u and abs(ids[bi] - ids[ai]) > t_win * 8]
        for bi in near[:4]:
            for sfx in ("d", "f", "r", "b", "l"):
                if sfx in frameix[ids[ai]] and sfx in frameix[ids[bi]]:
                    pairs.add(tuple(sorted((frameix[ids[ai]][sfx], frameix[ids[bi]][sfx]))))
    # stills: every still face vs the closest video faces with compatible view direction
    vnames = [f["img"] for f in vids]
    vC = np.array([C_all[n] for n in vnames]); vD = np.array([D_all[n] for n in vnames])
    for f in stils:
        nm = f["img"]; Cs = C_all[nm]; Ds = D_all[nm]
        d = np.linalg.norm(vC - Cs, axis=1)
        cosang = vD @ Ds
        order = np.argsort(d)
        cnt = 0
        for oi in order:
            if d[oi] > 4.5 * sp_u:
                break
            if cosang[oi] > 0.34:                            # < ~70 deg apart
                pairs.add((nm, vnames[oi])); cnt += 1
            if cnt >= still_partners:
                break
        for f2 in stils:                                     # still <-> still
            if f2["img"] > nm and np.linalg.norm(C_all[f2["img"]] - Cs) < 4.5 * sp_u \
                    and float(D_all[f2["img"]] @ Ds) > 0.2:
                pairs.add((nm, f2["img"]))
    with open(f"{wd}/pairs.txt", "w") as fh:
        fh.write("\n".join(f"{a} {b}" for a, b in sorted(pairs)))
    print(f"[colmap] {len(vids)} video + {len(stils)} still faces, {len(pairs)} match pairs")

    # --- features + matches ---
    cam = f"{f_px},{f_px},{cx},{cy}"
    _run(["feature_extractor", "--database_path", f"{wd}/db.db", "--image_path", spd,
          "--ImageReader.camera_model", "PINHOLE", "--ImageReader.single_camera", "1",
          "--ImageReader.camera_params", cam,
          "--SiftExtraction.use_gpu", "0", "--SiftExtraction.max_num_features", "4096",
          "--SiftExtraction.num_threads", "16"])
    print("[colmap] features extracted")
    _run(["matches_importer", "--database_path", f"{wd}/db.db",
          "--match_list_path", f"{wd}/pairs.txt", "--match_type", "pairs",
          "--SiftMatching.use_gpu", "0", "--SiftMatching.num_threads", "16"])
    print("[colmap] matches verified")

    # --- known-pose model (video faces FIXED at VSLAM poses; COLMAP wants w2c) ---
    import sqlite3
    con = sqlite3.connect(f"{wd}/db.db")
    name2id = {n: i for i, n in con.execute("SELECT image_id, name FROM images")}
    con.close()

    def _q_from_R(R):
        t = np.trace(R)
        if t > 0:
            s = np.sqrt(t + 1.0) * 2
            return np.array([0.25 * s, (R[2, 1] - R[1, 2]) / s,
                             (R[0, 2] - R[2, 0]) / s, (R[1, 0] - R[0, 1]) / s])
        i = int(np.argmax(np.diag(R)))
        j, k = (i + 1) % 3, (i + 2) % 3
        s = np.sqrt(R[i, i] - R[j, j] - R[k, k] + 1.0) * 2
        q = np.zeros(4)
        q[0] = (R[k, j] - R[j, k]) / s
        q[1 + i] = 0.25 * s
        q[1 + j] = (R[j, i] + R[i, j]) / s
        q[1 + k] = (R[k, i] + R[i, k]) / s
        return q

    with open(f"{wd}/known/cameras.txt", "w") as fh:
        fh.write(f"1 PINHOLE {face_px} {face_px} {cam.replace(',', ' ')}\n")
    with open(f"{wd}/known/images.txt", "w") as fh:
        for f in vids:
            nm = f["img"]
            if nm not in name2id:
                continue
            c2w = np.array(f["c2w"])
            Rw2c = c2w[:3, :3].T
            tw2c = -Rw2c @ c2w[:3, 3]
            q = _q_from_R(Rw2c)
            fh.write(f"{name2id[nm]} {q[0]} {q[1]} {q[2]} {q[3]} "
                     f"{tw2c[0]} {tw2c[1]} {tw2c[2]} 1 {nm}\n\n")
    open(f"{wd}/known/points3D.txt", "w").close()

    os.makedirs(f"{wd}/tri", exist_ok=True)
    _run(["point_triangulator", "--database_path", f"{wd}/db.db", "--image_path", spd,
          "--input_path", f"{wd}/known", "--output_path", f"{wd}/tri",
          "--Mapper.ba_refine_focal_length", "0", "--Mapper.ba_refine_extra_params", "0",
          "--Mapper.ba_refine_principal_point", "0"])
    print("[colmap] triangulated")
    os.makedirs(f"{wd}/reg", exist_ok=True)
    _run(["mapper", "--database_path", f"{wd}/db.db", "--image_path", spd,
          "--input_path", f"{wd}/tri", "--output_path", f"{wd}/reg",
          "--Mapper.fix_existing_images", "1",
          "--Mapper.ba_refine_focal_length", "0", "--Mapper.ba_refine_extra_params", "0",
          "--Mapper.ba_refine_principal_point", "0"])
    print("[colmap] stills registered")
    _run(["model_converter", "--input_path", f"{wd}/reg", "--output_path", f"{wd}/reg",
          "--output_type", "TXT"])

    # --- read back still-face poses -> per-still BODY pose + spread diagnostics ---
    RF = {"f": np.eye(3),
          "r": np.array([[0, 0, 1.], [0, 1, 0], [-1., 0, 0]]),
          "b": np.array([[-1., 0, 0], [0, 1, 0], [0, 0, -1.]]),
          "l": np.array([[0, 0, -1.], [0, 1, 0], [1., 0, 0]]),
          "d": np.array([[1., 0, 0], [0, 0, 1.], [0, -1., 0]])}
    got = {}
    with open(f"{wd}/reg/images.txt") as fh:
        lines = [ln.strip() for ln in fh if ln.strip() and not ln.startswith("#")]
    for ln in lines[::2]:
        p = ln.split()
        nm = p[-1]
        if not nm.startswith("images/s_"):
            continue
        qw, qx, qy, qz = map(float, p[1:5])
        tx, ty, tz = map(float, p[5:8])
        Rw2c = np.array([
            [1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy - qz * qw), 2 * (qx * qz + qy * qw)],
            [2 * (qx * qy + qz * qw), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz - qx * qw)],
            [2 * (qx * qz - qy * qw), 2 * (qy * qz + qx * qw), 1 - 2 * (qx * qx + qy * qy)]])
        C = -Rw2c.T @ np.array([tx, ty, tz])
        sfx = nm[-5]
        Rbody = Rw2c.T @ RF[sfx].T
        short = nm.split("s_")[1].split("_")[0]
        got.setdefault(short, []).append((Rbody, C))
    outj = {}
    name_by_short = {g[:8]: g for g in {f["group"] for f in stils}}
    for short, obs in got.items():
        Cs = np.array([o[1] for o in obs])
        Cm_ = np.median(Cs, 0)
        qs = np.array([_q_from_R(o[0].T) for o in obs])       # w2c-quat basis for averaging
        qs[qs @ qs[0] < 0] *= -1
        qm = qs.mean(0); qm /= np.linalg.norm(qm)
        w, x, y, z = qm
        Rw2c_m = np.array([
            [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
            [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
            [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])
        Rb = Rw2c_m.T
        c2w = np.eye(4); c2w[:3, :3] = Rb; c2w[:3, 3] = Cm_
        spread_ft = float(np.linalg.norm(Cs - Cm_, axis=1).max() * fpu)
        angs = [float(np.degrees(np.arccos(np.clip((np.trace(o[0].T @ Rb) - 1) / 2, -1, 1))))
                for o in obs]
        full = name_by_short.get(short, short)
        outj[full] = {"c2w": c2w.tolist(), "faces": len(obs),
                      "spread_ft": round(spread_ft, 3), "spread_deg": round(max(angs), 2)}
        print(f"[colmap] {short}: {len(obs)}/5 faces, spread {spread_ft:.2f}ft / {max(angs):.1f}deg")
    s3.put_object(Bucket=R2_BUCKET, Key=f"layout/{slug}/colmap_stills.json",
                  Body=json.dumps(outj).encode(), ContentType="application/json")
    nreg = len(outj)
    print(f"[colmap] {slug}: {nreg}/{len(name_by_short)} stills registered -> "
          f"layout/{slug}/colmap_stills.json")
    return {"registered": nreg, "stills": len(name_by_short),
            "spread_ft": {k[:8]: v["spread_ft"] for k, v in outj.items()}}


@app.local_entrypoint()
def colmapreg(slug: str):
    """COLMAP-register the stills into the fixed VSLAM frame:
        modal run modal_app.py::colmapreg --slug scottsdale-nadir"""
    print(colmap_register.remote(slug))


@app.function(image=gsplat_image, gpu="A10G", secrets=[r2_secret], volumes={"/scratch": vol},
              timeout=900)
def probe_still_pose(slug: str, still: str = "ce3508df", face: str = "f") -> dict:
    """Referee a disputed still pose: render the splat (trusted video geometry) from the
    COLMAP pose and from the ckpt-refined pose for one face, side-by-side with the
    actual face image -> ortho/{slug}_posecheck.jpg. Whichever render matches the photo
    has the right pose."""
    import json
    import numpy as np
    import cv2
    import torch
    from gsplat import rasterization, spherical_harmonics

    s3 = _r2(); sd = f"/scratch/{slug}"; spd = f"{sd}/splat"
    meta = json.load(open(f"{spd}/cameras.json"))
    ck = torch.load(f"{spd}/ckpt.pt", map_location="cuda", weights_only=False)
    shdeg = int(ck["sh_degree"])
    Wf = Hf = int(meta["face_px"])
    K = np.array([[meta["f_px"], 0, meta["cx"]], [0, meta["f_px"], meta["cy"]], [0, 0, 1]])
    RF = {"f": np.eye(3),
          "r": np.array([[0, 0, 1.], [0, 1, 0], [-1., 0, 0]]),
          "b": np.array([[-1., 0, 0], [0, 1, 0], [0, 0, -1.]]),
          "l": np.array([[0, 0, -1.], [0, 1, 0], [1., 0, 0]]),
          "d": np.array([[1., 0, 0], [0, 0, 1.], [0, -1., 0]])}

    opa = torch.sigmoid(ck["opacities"].cuda())
    keep = opa > 0.3
    means = ck["means"].cuda()[keep]; quats = ck["quats"].cuda()[keep]
    scales = torch.exp(ck["scales"].cuda()[keep]); opa = opa[keep]
    shs = torch.cat([ck["sh0"].cuda(), ck["shN"].cuda()], 1)[keep]

    def render(c2w_body):
        c2w = c2w_body.copy()
        c2w[:3, :3] = c2w[:3, :3] @ RF[face]
        R = c2w[:3, :3]; C = c2w[:3, 3]
        w2c = np.eye(4); w2c[:3, :3] = R.T; w2c[:3, 3] = -R.T @ C
        dirs = means - torch.tensor(C, dtype=torch.float32, device="cuda")
        dirs = dirs / dirs.norm(dim=1, keepdim=True).clamp(min=1e-9)
        cols = torch.clamp(spherical_harmonics(shdeg, dirs, shs) + 0.5, 0, 1)
        img, _, _ = rasterization(
            means=means, quats=quats, scales=scales, opacities=opa, colors=cols,
            viewmats=torch.tensor(w2c, dtype=torch.float32, device="cuda")[None],
            Ks=torch.tensor(K, dtype=torch.float32, device="cuda")[None],
            width=Wf, height=Hf, packed=False)
        return cv2.cvtColor((img[0].clamp(0, 1) * 255).byte().cpu().numpy(), cv2.COLOR_RGB2BGR)

    # actual face image
    act = None
    full = None
    for f in meta["frames"]:
        if f.get("group", "").startswith(still) and f["img"].endswith(f"_{face}.jpg"):
            act = cv2.imread(f"{spd}/{f['img']}")
            full = f["group"]
            break
    cj = json.loads(s3.get_object(Bucket=R2_BUCKET,
                                  Key=f"layout/{slug}/colmap_stills.json")["Body"].read())
    r_col = render(np.array(cj[full]["c2w"]))
    # ckpt-refined pose via the shared loader's fallback path (force it by skipping colmap)
    sp = ck["still_pose"]
    base = {f["group"]: np.array(f["c2w"]) for f in meta["frames"]
            if f.get("group") and f["img"].endswith("_f.jpg")}
    gi = sp["names"].index(full)
    rv = sp["rvec"].cpu().numpy()[gi]; tv = sp["tvec"].cpu().numpy()[gi]
    c2w_ck = base[full].copy()
    th = np.linalg.norm(rv)
    if th > 1e-8:
        ax = rv / th
        Kx = np.array([[0, -ax[2], ax[1]], [ax[2], 0, -ax[0]], [-ax[1], ax[0], 0]])
        c2w_ck[:3, :3] = (np.eye(3) + np.sin(th) * Kx + (1 - np.cos(th)) * (Kx @ Kx)) @ c2w_ck[:3, :3]
    c2w_ck[:3, 3] += tv
    r_ckpt = render(c2w_ck)
    strip = np.concatenate([act, r_col, r_ckpt], axis=1)
    cv2.putText(strip, "ACTUAL", (20, 50), 0, 1.6, (0, 255, 0), 3)
    cv2.putText(strip, "COLMAP", (Wf + 20, 50), 0, 1.6, (0, 255, 0), 3)
    cv2.putText(strip, "CKPT", (2 * Wf + 20, 50), 0, 1.6, (0, 255, 0), 3)
    cv2.imwrite("/tmp/pc.jpg", strip, [cv2.IMWRITE_JPEG_QUALITY, 90])
    key = f"ortho/{slug}_posecheck.jpg"
    s3.upload_file("/tmp/pc.jpg", R2_BUCKET, key)
    print(f"[posecheck] {still}/{face} -> {key}")
    return {"key": key}


@app.local_entrypoint()
def posecheck(slug: str, still: str = "ce3508df", face: str = "f"):
    """modal run modal_app.py::posecheck --slug scottsdale-nadir --still ce3508df"""
    print(probe_still_pose.remote(slug, still=still, face=face))


@app.function(image=gsplat_image, gpu="A10G", timeout=900)
def splat_env() -> dict:
    """Smoke test: gsplat imports and a tiny CUDA rasterization runs (incl. ortho camera)."""
    import torch
    import gsplat
    from gsplat import rasterization
    N = 128
    means = torch.randn(N, 3, device="cuda") * 0.5
    quats = torch.randn(N, 4, device="cuda")
    scales = torch.rand(N, 3, device="cuda") * 0.1
    opac = torch.rand(N, device="cuda")
    cols = torch.rand(N, 3, device="cuda")
    vm = torch.eye(4, device="cuda")[None]; vm[0, 2, 3] = 3.0
    Km = torch.tensor([[100.0, 0, 64], [0, 100.0, 64], [0, 0, 1]], device="cuda")[None]
    img, _, _ = rasterization(means, quats, scales, opac, cols, vm, Km, 128, 128)
    ortho_ok = True
    try:
        rasterization(means, quats, scales, opac, cols, vm, Km, 128, 128, camera_model="ortho")
    except TypeError:
        ortho_ok = False
    out = {"torch": str(torch.__version__), "gsplat": str(gsplat.__version__),   # plain str — TorchVersion doesn't unpickle locally
           "gpu": torch.cuda.get_device_name(0), "render_mean": round(float(img.mean()), 4),
           "ortho_supported": ortho_ok}
    print(f"[splatenv] {out}")
    return out


@app.local_entrypoint()
def splatenv():
    """modal run modal_app.py::splatenv — verify the gsplat CUDA env before training."""
    print(splat_env.remote())


@app.local_entrypoint()
def splatdata(slug: str, n_frames: int = 400, face_px: int = 800, fov_deg: float = 95.0,
              ceiling_ft: float = 8.5, stills: int = 1,
              stills_prefix: str = "projects/old-town-scottsdale-home/still/"):
    """Stage 1 — posed pinhole views for splat training (video + localized 360 stills):
        modal run modal_app.py::splatdata --slug scottsdale-nadir"""
    print(make_splat_data.remote(slug, n_frames=n_frames, face_px=face_px, fov_deg=fov_deg,
                                 ceiling_ft=ceiling_ft, stills=stills,
                                 stills_prefix=stills_prefix))


@app.local_entrypoint()
def splattrain(slug: str, iters: int = 20000, init_pts: int = 500000, sh_degree: int = 2,
               pose_opt: int = 1, still_start: int = 8000):
    """Stage 2 — train the splat (A10G, ~30-60 min at 20k iters; stills join with
    per-still pose refinement at still_start):
        modal run modal_app.py::splattrain --slug scottsdale-nadir"""
    print(train_splat.remote(slug, iters=iters, init_pts=init_pts, sh_degree=sh_degree,
                             pose_opt=pose_opt, still_start=still_start))


@app.local_entrypoint()
def splatrender(slug: str, out_w: int = 2266, ceil_cut: float = 0.8, dollhouse: int = 3,
                doll_elev_deg: float = 40.0, opa_min: float = 0.35, big_cut: float = 0.2,
                walls_mode: int = 0, strip_walls: int = 1, wall_lo: float = 0.55,
                wall_hi: float = 0.75, tex_cut: float = 0.8):
    """Stage 3 — true-ortho top-down (wall gaussians stripped for de-blur; strokes only
    with --walls-mode 1) + height/wall-evidence maps + dollhouse renders:
        modal run modal_app.py::splatrender --slug scottsdale-nadir"""
    print(render_splat.remote(slug, out_w=out_w, ceil_cut=ceil_cut, dollhouse=dollhouse,
                              doll_elev_deg=doll_elev_deg, opa_min=opa_min, big_cut=big_cut,
                              walls_mode=walls_mode, strip_walls=strip_walls, wall_lo=wall_lo,
                              wall_hi=wall_hi, tex_cut=tex_cut))


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
def process_floorplan(slug: str, ceiling_ft: float = 9.0, video_key: str = "", srt_key: str = "") -> dict:
    """ONE-CLICK: a project's stills + flythrough -> localized, georeferenced floorplan -> delivered
    onto the project (callback writes it to D1). Prefers the explicit video_key/srt_key from the
    submit payload (the Studio picks nadir-role over cinematic); falls back to R2 discovery."""
    s3 = _r2()
    resp = s3.list_objects_v2(Bucket=R2_BUCKET, Prefix=f"projects/{slug}/")
    keys = [o["Key"] for o in resp.get("Contents", [])]
    stills = [k for k in keys if "/still/" in k and k.lower().endswith((".jpg", ".jpeg"))]
    videos = [k for k in keys if ("/video/" in k or "/nadir/" in k) and k.lower().endswith((".mp4", ".mov", ".m4v"))]
    if not stills or not (videos or video_key):
        _notify({"slug": slug, "status": "failed", "error": "need stills + a flythrough video in the project"})
        return {"error": "missing inputs", "stills": len(stills), "videos": len(videos)}
    flythrough = video_key or sorted(videos)[0]
    srts = [k for k in keys if "/telemetry/" in k and k.lower().endswith(".srt")]
    srt_key = srt_key or (sorted(srts)[0] if srts else "")
    vslam_slug = f"{slug}-fly"
    print(f"[process_floorplan] {slug}: {len(stills)} stills, flythrough {flythrough}, "
          f"srt {srt_key or 'NONE'}, ceiling {ceiling_ft} ft")

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
    localize_stills.remote(vslam_slug, flythrough, ceiling_ft=ceiling_ft,
                           stills_prefix=f"projects/{slug}/still/", srt_key=srt_key)
    fz = fuse_localized.remote(slug, stills_json, vslam_slug, ov_key, ceiling_ft=ceiling_ft)
    d = deliver_plan.remote(slug, fz["plan_json"], fz["base_b64"])  # upload + callback -> D1
    print(f"[process_floorplan] {slug}: delivered {d}")
    return {"slug": slug, "delivered": d}


@app.local_entrypoint()
def floorplan(slug: str, ceiling_ft: float = 9.0, video_key: str = "", srt_key: str = ""):
    """modal run modal_app.py::floorplan --slug old-town-scottsdale-home --ceiling-ft 8.5"""
    print(process_floorplan.remote(slug, ceiling_ft=ceiling_ft, video_key=video_key, srt_key=srt_key))


# ---------------------------------------------------------------------------
# Cross-boundary validation (§4.4): the six-gate report that scores a single
# continuous outdoor→indoor take. GPS georeferences the exterior segment; the
# unbroken VSLAM track carries that scale/heading/position through the door.
# ---------------------------------------------------------------------------

def _parse_srt_blocks(txt: str) -> list:
    """DJI SRT -> [{t, lat, lon, alt, sats, yaw}] (fields None when absent).
    Handles both `latitude: x longitude: y` and `GPS(lon,lat,alt)` block styles."""
    import re
    out = []
    for b in re.split(r"\n\s*\n", txt):
        tm = re.search(r"(\d+):(\d+):(\d+)[,.](\d+)\s*-->", b)
        if not tm:
            continue
        t = int(tm[1]) * 3600 + int(tm[2]) * 60 + int(tm[3]) + int(tm[4]) / 1000.0
        lat = re.search(r"latitude\s*[:=]\s*([-\d.]+)", b, re.I)
        lon = re.search(r"longitude\s*[:=]\s*([-\d.]+)", b, re.I)
        if lat and lon:
            la, lo = float(lat[1]), float(lon[1])
        else:
            g = re.search(r"GPS\s*\(\s*([-\d.]+)\s*,\s*([-\d.]+)", b, re.I)
            lo, la = (float(g[1]), float(g[2])) if g else (None, None)
        alt = re.search(r"(?:rel_alt|abs_alt|altitude)\s*[:=]\s*([-\d.]+)", b, re.I)
        sats = re.search(r"satellites?\s*[:=]\s*(\d+)", b, re.I)
        yaw = re.search(r"gb_yaw\s*[:=]\s*([-\d.]+)", b, re.I)
        iso = re.search(r"\[iso\s*[:=]\s*(\d+)", b, re.I)
        shut = re.search(r"shutter\s*[:=]\s*1/([\d.]+)", b, re.I)
        out.append({
            "t": t,
            "lat": la, "lon": lo,
            "alt": float(alt[1]) if alt else None,
            "sats": int(sats[1]) if sats else None,
            "yaw": float(yaw[1]) if yaw else None,
            "iso": int(iso[1]) if iso else None,
            "shutter_s": 1.0 / float(shut[1]) if shut and float(shut[1]) > 0 else None,
        })
    return out


def _exposure_windows(blocks, min_exterior_s):
    """Indoor/outdoor segmentation from the camera's own exposure telemetry.
    Signal = iso * shutter_s (scene darkness): desert exterior ~0.06, interior
    ~5+ — a two-decade step at the threshold. Returns (t_transition, windows)
    where windows = list of (t0, t1, 'exterior'|'interior'), or (None, [])
    when exposure fields are absent (fallback to GPS-run logic)."""
    import numpy as np
    ev = [(b["t"], b["iso"] * b["shutter_s"]) for b in blocks
          if b.get("iso") and b.get("shutter_s")]
    if len(ev) < 50:
        return None, []
    t = np.array([e[0] for e in ev])
    x = np.log10(np.array([e[1] for e in ev]))
    # rolling median (~1 s) to kill single-frame exposure hunts
    k = max(1, int(len(x) / max(1.0, t[-1]) ))  # ≈ blocks per second
    k = max(3, k | 1)
    pad = k // 2
    xs = np.convolve(np.pad(x, pad, mode="edge"), np.ones(k) / k, mode="valid")
    base = np.median(xs[t < min(min_exterior_s, t[-1] / 3)])      # bright exterior baseline
    dark = np.percentile(xs, 90)                                   # interior plateau
    if dark - base < 1.0:
        return None, []                                            # no real cliff (never went inside?)
    thr = (base + dark) / 2.0
    inside = xs > thr
    # sustained-state segmentation (>= 2 s to flip)
    windows, cur_state, t0 = [], bool(inside[0]), t[0]
    run_start = 0
    for i in range(1, len(inside)):
        if inside[i] != cur_state:
            j = i
            hold = 0.0
            while j < len(inside) and inside[j] != cur_state:
                hold = t[j] - t[i]
                if hold >= 2.0:
                    break
                j += 1
            if hold >= 2.0:
                windows.append((t0, t[i], "interior" if cur_state else "exterior"))
                cur_state, t0 = inside[i], t[i]
    windows.append((t0, t[-1], "interior" if cur_state else "exterior"))
    ext = [w for w in windows if w[2] == "exterior"]
    if not ext:
        return None, []
    t_transition = ext[0][1]
    return float(t_transition), windows


def _umeyama3(X, Y):
    """Similarity fit Y ≈ s·R·X + t (both (n,3)). Returns s, R, t."""
    import numpy as np
    mx, my = X.mean(0), Y.mean(0)
    Xc, Yc = X - mx, Y - my
    C = Yc.T @ Xc / len(X)
    U, D, Vt = np.linalg.svd(C)
    S = np.eye(3)
    if np.linalg.det(U) * np.linalg.det(Vt) < 0:
        S[2, 2] = -1
    R = U @ S @ Vt
    varX = (Xc ** 2).sum() / len(X)
    s = float((D * S.diagonal()).sum() / varX)
    return s, R, my - s * R @ mx


@app.function(image=ortho_image, secrets=[r2_secret], volumes={"/scratch": vol},
              timeout=1200, memory=8192)
def cross_boundary(slug: str, srt_key: str, ceiling_fpu: float = 0.0,
                   fps: float = 30.0, min_exterior_s: float = 15.0) -> dict:
    """Six-gate §4.4 report for one continuous outdoor→indoor take.
    Gates: (1) VSLAM continuity, (2) GPS anchor quality, (3) Umeyama georef of the
    exterior window + RMS, (4) GPS scale vs ceiling scale Δ%, (5) closure drift if
    GPS reacquired (out-and-back), (6) north tie (heading of the fitted rotation).
    -> layout/{slug}/crossboundary.json + labs/{slug}-crossboundary.png"""
    import json
    import os
    import numpy as np
    import cv2

    s3 = _r2()
    sd = f"/scratch/{slug}"
    traj_p = f"{sd}/frame_trajectory.txt"
    if not os.path.exists(traj_p):
        traj_p = f"{sd}/keyframe_trajectory.txt"
    if not os.path.exists(traj_p):
        traj_p = "/tmp/kf.txt"
        s3.download_file(R2_BUCKET, f"vslam/{slug}/keyframe_trajectory.txt", traj_p)
    T = np.loadtxt(traj_p)
    if T.ndim == 1:
        T = T[None, :]
    ts, P = T[:, 0].copy(), T[:, 1:4]

    sp = "/tmp/cb.srt"
    s3.download_file(R2_BUCKET, srt_key, sp)
    blocks = _parse_srt_blocks(open(sp, encoding="utf-8", errors="ignore").read())
    if not blocks:
        return {"error": "no SRT blocks parsed"}
    srt_dur = blocks[-1]["t"]
    # trajectory timestamps: frame-index vs seconds heuristic against the SRT clock
    if ts.max() > srt_dur * 2.5:
        ts = ts / fps

    # ---- valid fixes -> local ENU feet ----
    fixes = [b for b in blocks if b["lat"] and b["lon"] and abs(b["lat"]) > 0.5 and abs(b["lon"]) > 0.5]
    if len(fixes) < 10:
        return {"error": f"only {len(fixes)} GPS fixes in SRT — no exterior anchor"}
    la0 = float(np.median([b["lat"] for b in fixes]))
    lo0 = float(np.median([b["lon"] for b in fixes]))
    R_E = 6371000.0 * 3.28084
    def enu(b):
        north = np.radians(b["lat"] - la0) * R_E
        east = np.radians(b["lon"] - lo0) * R_E * np.cos(np.radians(la0))
        return [east, north, (b["alt"] or 0.0) * 3.28084]
    # multipath/outlier filter: implied speed < 45 ft/s between consecutive fixes
    clean = [fixes[0]]
    for b in fixes[1:]:
        dt = b["t"] - clean[-1]["t"]
        if dt <= 0:
            continue
        d = np.linalg.norm(np.array(enu(b)[:2]) - np.array(enu(clean[-1])[:2]))
        if d / dt < 45.0:
            clean.append(b)
    # ---- indoor/outdoor segmentation ----
    # Preferred: the exposure cliff (DJI keeps publishing stale/drifting GPS
    # indoors, so fix presence can't mark the wall — but iso*shutter can).
    t_exp, exp_windows = _exposure_windows(blocks, min_exterior_s)
    if t_exp is not None:
        ext = [b for b in clean if b["t"] <= t_exp - 1.0]
        if len(ext) < 10:
            ext = [b for b in clean if b["t"] <= t_exp]
        t_transition = t_exp
        # reacquisition = a later exterior window (out-and-back)
        later_ext = [w for w in exp_windows if w[2] == "exterior" and w[0] > t_exp + 3]
        reacq = None
        if later_ext:
            w0 = later_ext[0]
            reacq = [b for b in clean if w0[0] + 1.0 <= b["t"] <= w0[1]] or None
        seg_method = "exposure-cliff"
    else:
        # Fallback: contiguous valid-fix runs (older SRTs that zero out indoors)
        runs, cur = [], [clean[0]]
        for b in clean[1:]:
            if b["t"] - cur[-1]["t"] <= 2.0:
                cur.append(b)
            else:
                runs.append(cur); cur = [b]
        runs.append(cur)
        ext = next((r for r in runs if r[-1]["t"] - r[0]["t"] >= min_exterior_s), runs[0])
        t_transition = ext[-1]["t"]
        reacq = next((r for r in runs if r is not ext and r[0]["t"] > t_transition + 3
                      and r[-1]["t"] - r[0]["t"] >= 4.0), None)
        seg_method = "gps-fix-runs"

    # ---- gate 1: VSLAM continuity ----
    dts = np.diff(ts)
    win = (ts[:-1] > t_transition - 10) & (ts[:-1] < t_transition + 10)
    gate1 = {
        "traj_points": int(len(ts)),
        "traj_span_s": round(float(ts[-1] - ts[0]), 1),
        "srt_span_s": round(float(srt_dur), 1),
        "max_gap_s": round(float(dts.max()), 2) if len(dts) else None,
        "max_gap_at_threshold_s": round(float(dts[win].max()), 2) if win.any() else None,
        "pass": bool(len(dts) and (not win.any() or dts[win].max() <= 1.0)),
    }

    # ---- gate 2: anchor quality ----
    gate2 = {
        "exterior_fix_s": round(ext[-1]["t"] - ext[0]["t"], 1),
        "n_fixes": len(ext),
        "sats_min": min((b["sats"] for b in ext if b["sats"] is not None), default=None),
        "t_transition_s": round(t_transition, 1),
        "segmentation": seg_method,
        "pass": (ext[-1]["t"] - ext[0]["t"]) >= min_exterior_s,
    }

    # ---- gate 3: Umeyama georef on the exterior window ----
    X, Y = [], []
    for b in ext:
        i = int(np.searchsorted(ts, b["t"]))
        if i <= 0 or i >= len(ts):
            continue
        w = (b["t"] - ts[i - 1]) / max(1e-9, ts[i] - ts[i - 1])
        X.append(P[i - 1] * (1 - w) + P[i] * w)
        Y.append(enu(b))
    X, Y = np.array(X), np.array(Y)
    if len(X) < 8:
        return {"error": f"only {len(X)} GPS<->VSLAM pairs in the exterior window",
            "gate1": gate1, "gate2": gate2}
    s, Rm, tv = _umeyama3(X, Y)
    res = Y - (s * (Rm @ X.T).T + tv)
    rms = float(np.sqrt((res ** 2).sum(1).mean()))
    gate3 = {"n_pairs": int(len(X)), "scale_ft_per_unit": round(s, 4),
             "rms_ft": round(rms, 2), "pass": rms < 6.0}

    # ---- gate 4: dual-anchor scale ----
    gate4 = {"gps_fpu": round(s, 4), "ceiling_fpu": ceiling_fpu or None}
    if ceiling_fpu > 0:
        gate4["delta_pct"] = round(100.0 * (s - ceiling_fpu) / ceiling_fpu, 2)
        gate4["pass"] = abs(gate4["delta_pct"]) < 5.0
    else:
        gate4["note"] = "no ceiling scale supplied yet — rerun with --ceiling-fpu after the layout stage"

    # ---- gate 5: closure (out-and-back) ----
    if reacq:
        Xr, Yr = [], []
        for b in reacq:
            i = int(np.searchsorted(ts, b["t"]))
            if i <= 0 or i >= len(ts):
                continue
            w = (b["t"] - ts[i - 1]) / max(1e-9, ts[i] - ts[i - 1])
            Xr.append(P[i - 1] * (1 - w) + P[i] * w)
            Yr.append(enu(b))
        if Xr:
            pred = s * (Rm @ np.array(Xr).T).T + tv
            drift = float(np.linalg.norm((np.array(Yr) - pred)[:, :2], axis=1).mean())
            gate5 = {"reacq_fixes": len(Xr), "drift_ft": round(drift, 2), "pass": drift < 10.0}
        else:
            gate5 = {"note": "reacquisition run had no overlapping trajectory"}
    else:
        gate5 = {"note": "not flown (no GPS reacquisition — crash-ended or single crossing)"}

    # ---- gate 6: north tie ----
    e_east = Rm.T @ np.array([1.0, 0, 0])   # ENU east expressed in VSLAM frame
    heading = float(np.degrees(np.arctan2(e_east[1], e_east[0])))
    gate6 = {"vslam_to_east_deg": round(heading, 1),
             "note": "verify visually against the satellite footprint"}

    # ---- exhibit: GPS track vs transformed VSLAM track ----
    G = np.array([enu(b) for b in clean])[:, :2]
    V = (s * (Rm @ P.T).T + tv)[:, :2]
    allp = np.vstack([G, V])
    lo_, hi_ = allp.min(0), allp.max(0)
    span = max(float((hi_ - lo_).max()), 1.0)
    Wp = 1200
    def px(p):
        q = (p - lo_) / span
        return (int(60 + q[0] * (Wp - 120)), int(Wp - 60 - q[1] * (Wp - 120)))
    img = np.full((Wp, Wp, 3), 16, np.uint8)
    for arr, col in ((V, (255, 220, 80)), (G, (60, 200, 90))):
        for a, b2 in zip(arr[:-1], arr[1:]):
            cv2.line(img, px(a), px(b2), col, 2, cv2.LINE_AA)
    cv2.circle(img, px(np.array(enu(ext[-1]))[:2]), 9, (60, 60, 255), 2)
    cv2.putText(img, f"{slug}  GPS(green) vs VSLAM->ENU(gold)  rms {rms:.1f}ft  scale {s:.3f}ft/u",
                (20, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.62, (235, 230, 220), 1, cv2.LINE_AA)
    cv2.putText(img, f"transition at t={t_transition:.0f}s (red)", (20, 58),
                cv2.FONT_HERSHEY_SIMPLEX, 0.55, (140, 140, 220), 1, cv2.LINE_AA)
    ok1, buf = cv2.imencode(".png", img)
    if ok1:
        s3.put_object(Bucket=R2_BUCKET, Key=f"labs/{slug}-crossboundary.png",
                      Body=buf.tobytes(), ContentType="image/png")

    report = {"slug": slug, "srt_key": srt_key,
              "gate1_continuity": gate1, "gate2_anchor": gate2, "gate3_georef": gate3,
              "gate4_dual_scale": gate4, "gate5_closure": gate5, "gate6_north": gate6,
              "exhibit": f"labs/{slug}-crossboundary.png"}
    s3.put_object(Bucket=R2_BUCKET, Key=f"layout/{slug}/crossboundary.json",
                  Body=json.dumps(report, indent=1).encode(), ContentType="application/json")
    print(json.dumps(report, indent=1))
    return report


@app.local_entrypoint()
def crossboundary(slug: str, srt_key: str, ceiling_fpu: float = 0.0, fps: float = 30.0):
    """modal run modal_app.py::crossboundary --slug tucson-castilla --srt-key projects/tucson-castilla/telemetry/<id>.srt"""
    print(cross_boundary.remote(slug, srt_key, ceiling_fpu=ceiling_fpu, fps=fps))
