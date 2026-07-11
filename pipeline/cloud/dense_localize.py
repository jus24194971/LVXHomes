"""Dense still-to-video matching (smoke test) — Justin's "cut the 360 into
200+ images and match pixel-for-pixel" design.

Replaces the thin ORB weld (50-295 sparse matches per still) with dense
LoFTR correspondences between perspective tiles cut from BOTH the 360 still
and 360 video frames. First target: apt-1112 living room, where the Bosch
gives same-day truth (couch 127.47in, great-room diagonal 35'2.5").

Smoke scope: tile both sides, match, report the correspondence budget per
frame + a match visualization. Metric PnP/triangulation is the next stage.

  modal run pipeline/cloud/dense_localize.py --pano-key projects/apartment-1112/still/pano-living.jpg --video-key tours/apartment-1112/flight.mp4 --times "3.5,4.5,60,118,120" --outdir <dir>
"""

import io
import json
import os
from pathlib import Path

import modal

app = modal.App("lvx-dense-localize")

r2_secret = modal.Secret.from_name("lvx-r2")

def _download_loftr():
    import kornia.feature
    kornia.feature.LoFTR(pretrained="indoor_new")


gpu_image = (
    modal.Image.from_registry("pytorch/pytorch:2.4.0-cuda12.4-cudnn9-devel")
    .apt_install("ffmpeg", "libgl1", "libglib2.0-0")
    .pip_install("kornia", "opencv-python-headless", "numpy", "pillow", "boto3")
    .run_function(_download_loftr)
)


def _r2():
    import boto3
    return boto3.client(
        "s3",
        endpoint_url=f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
        region_name="auto",
    )


def equirect_tiles(img, fov_deg=90.0, yaw_step=15.0, pitches=(-35.0, -10.0, 15.0), size=512):
    """Cut an equirect image into perspective tiles (gnomonic projection)."""
    import cv2
    import numpy as np

    H, W = img.shape[:2]
    f = size / (2 * np.tan(np.radians(fov_deg) / 2))
    xs, ys = np.meshgrid(np.arange(size, dtype=np.float32), np.arange(size, dtype=np.float32))
    x = (xs - size / 2) / f
    y = (ys - size / 2) / f
    tiles = []
    for pitch in pitches:
        cp, sp = np.cos(np.radians(pitch)), np.sin(np.radians(pitch))
        for yaw in np.arange(0, 360, yaw_step):
            cy_, sy_ = np.cos(np.radians(yaw)), np.sin(np.radians(yaw))
            # ray in camera frame -> rotate by pitch then yaw
            dx, dy, dz = x, y, np.ones_like(x)
            dy2 = dy * cp - dz * sp
            dz2 = dy * sp + dz * cp
            dx3 = dx * cy_ + dz2 * sy_
            dz3 = -dx * sy_ + dz2 * cy_
            lon = np.arctan2(dx3, dz3)
            lat = np.arctan2(-dy2, np.sqrt(dx3**2 + dz3**2))
            u = ((lon / (2 * np.pi) + 0.5) * W).astype(np.float32)
            v = ((0.5 - lat / np.pi) * H).astype(np.float32)
            tile = cv2.remap(img, u, v, cv2.INTER_LINEAR, borderMode=cv2.BORDER_WRAP)
            tiles.append({"yaw": float(yaw), "pitch": float(pitch), "img": tile})
    return tiles


@app.function(gpu="A10G", image=gpu_image, secrets=[r2_secret], timeout=1800)
def dense_probe(pano_key: str, video_key: str, times: list, yaw_step: float = 15.0):
    import subprocess

    import cv2
    import kornia
    import kornia.feature as KF
    import numpy as np
    import torch

    s3 = _r2()
    bucket = os.environ.get("R2_BUCKET", "lvx-media")

    pano = cv2.imdecode(
        np.frombuffer(s3.get_object(Bucket=bucket, Key=pano_key)["Body"].read(), np.uint8),
        cv2.IMREAD_GRAYSCALE)
    s3.download_file(bucket, video_key, "/tmp/flight.mp4")

    frames = []
    for t in times:
        out = f"/tmp/f_{t}.png"
        subprocess.run(["ffmpeg", "-y", "-ss", str(t), "-i", "/tmp/flight.mp4",
                        "-frames:v", "1", out], capture_output=True, check=True)
        frames.append({"t": t, "img": cv2.imread(out, cv2.IMREAD_GRAYSCALE)})

    pano_tiles = equirect_tiles(pano, yaw_step=yaw_step)
    print(f"pano tiles: {len(pano_tiles)}  (target 200+ at fine steps; this run {len(pano_tiles)})")

    matcher = KF.LoFTR(pretrained="indoor_new").to("cuda").eval()

    def to_t(img):
        return torch.from_numpy(img).float()[None, None].to("cuda") / 255.0

    results = []
    best_viz = None
    for fr in frames:
        f_tiles = equirect_tiles(fr["img"], yaw_step=30.0, pitches=(-25.0, 0.0))
        total, best_pair = 0, (0, None, None)
        for pt in pano_tiles[:: max(1, len(pano_tiles) // 48)]:  # budget: ~48 pano tiles/frame
            for ft in f_tiles:
                with torch.no_grad():
                    out = matcher({"image0": to_t(pt["img"]), "image1": to_t(ft["img"])})
                n = int((out["confidence"] > 0.5).sum())
                total += n
                if n > best_pair[0]:
                    best_pair = (n, pt, ft, out)
        results.append({"t": fr["t"], "total_matches": total, "best_pair_matches": best_pair[0],
                        "best_yaws": (best_pair[1]["yaw"], best_pair[2]["yaw"]) if best_pair[1] else None})
        print(f"t={fr['t']:>6}s  total {total:>6} correspondences, best tile-pair {best_pair[0]}")
        if best_viz is None or best_pair[0] > best_viz[0]:
            best_viz = (best_pair[0], best_pair[1], best_pair[2], best_pair[3])

    viz_bytes = b""
    if best_viz and best_viz[1] is not None:
        n, pt, ft, out = best_viz
        canvas = np.concatenate([cv2.cvtColor(pt["img"], cv2.COLOR_GRAY2BGR),
                                 cv2.cvtColor(ft["img"], cv2.COLOR_GRAY2BGR)], axis=1)
        k0 = out["keypoints0"].cpu().numpy()
        k1 = out["keypoints1"].cpu().numpy()
        conf = out["confidence"].cpu().numpy()
        for (x0, y0), (x1, y1), c in zip(k0, k1, conf):
            if c > 0.5:
                cv2.line(canvas, (int(x0), int(y0)), (int(x1) + 512, int(y1)),
                         (0, int(255 * c), 255 - int(255 * c)), 1)
        viz_bytes = cv2.imencode(".jpg", canvas)[1].tobytes()

    return {"results": results, "viz": viz_bytes}


@app.local_entrypoint()
def main(pano_key: str, video_key: str, times: str, outdir: str = "."):
    ts = [float(t) for t in times.split(",")]
    out = dense_probe.remote(pano_key, video_key, ts)
    od = Path(outdir)
    od.mkdir(parents=True, exist_ok=True)
    if out["viz"]:
        (od / "dense_best_pair.jpg").write_bytes(out["viz"])
        print(f"saved {od / 'dense_best_pair.jpg'}")
    (od / "dense_probe.json").write_text(json.dumps(out["results"], indent=2))
    for r in out["results"]:
        print(r)
