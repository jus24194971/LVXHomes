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


def _bearing_from_tile_px(p, size, fov_deg, yaw_deg, pitch_deg):
    """Tile pixel -> unit bearing in the RIG (equirect camera) frame, matching
    equirect_tiles' composition: d_rig = Ry(yaw) @ Rx(pitch) @ [x, y, 1]."""
    import numpy as np
    f = size / (2 * np.tan(np.radians(fov_deg) / 2))
    x = (p[0] - size / 2) / f
    y = (p[1] - size / 2) / f
    v = np.array([x, y, 1.0])
    th = np.radians(pitch_deg)
    Rx = np.array([[1, 0, 0], [0, np.cos(th), -np.sin(th)], [0, np.sin(th), np.cos(th)]])
    ya = np.radians(yaw_deg)
    Ry = np.array([[np.cos(ya), 0, np.sin(ya)], [0, 1, 0], [-np.sin(ya), 0, np.cos(ya)]])
    d = Ry @ Rx @ v
    return d / np.linalg.norm(d)


@app.function(gpu="A10G", image=gpu_image, secrets=[r2_secret], timeout=1800)
def stage2(pano_key: str, video_key: str, traj_key: str, times: list, pair_gap: float = 1.5,
           tile_size: int = 512, fov: float = 90.0):
    """Solve the pano's SE3 pose in the VSLAM frame from dense tile matches.
    frame-pair triangulation -> 3D points -> pano-tile PnP -> rig pose."""
    import math
    import subprocess
    import cv2
    import kornia.feature as KF
    import numpy as np
    import torch

    s3 = _r2()
    bucket = os.environ.get("R2_BUCKET", "lvx-media")

    # trajectory (TUM, camera-to-world)
    traj = []
    for line in s3.get_object(Bucket=bucket, Key=traj_key)["Body"].read().decode().splitlines():
        p = line.split()
        if len(p) >= 8:
            traj.append([float(v) for v in p[:8]])
    traj = np.array(traj)

    def pose_at(t):
        i = int(np.argmin(np.abs(traj[:, 0] - t)))
        row = traj[i]
        q = row[4:8]  # qx qy qz qw
        x, y, z, w = q
        R = np.array([
            [1 - 2*(y*y + z*z), 2*(x*y - z*w), 2*(x*z + y*w)],
            [2*(x*y + z*w), 1 - 2*(x*x + z*z), 2*(y*z - x*w)],
            [2*(x*z - y*w), 2*(y*z + x*w), 1 - 2*(x*x + y*y)],
        ])
        return R, row[1:4], abs(traj[i, 0] - t)

    pano = cv2.imdecode(np.frombuffer(s3.get_object(Bucket=bucket, Key=pano_key)["Body"].read(), np.uint8),
                        cv2.IMREAD_GRAYSCALE)
    s3.download_file(bucket, video_key, "/tmp/flight.mp4")

    def grab(t):
        out = f"/tmp/f_{t:.2f}.png"
        subprocess.run(["ffmpeg", "-y", "-ss", str(t), "-i", "/tmp/flight.mp4",
                        "-frames:v", "1", out], capture_output=True, check=True)
        return cv2.imread(out, cv2.IMREAD_GRAYSCALE)

    matcher = KF.LoFTR(pretrained="indoor_new").to("cuda").eval()

    def to_t(img):
        return torch.from_numpy(img).float()[None, None].to("cuda") / 255.0

    def loftr(a, b, conf=0.55):
        with torch.no_grad():
            out = matcher({"image0": to_t(a), "image1": to_t(b)})
        m = out["confidence"].cpu().numpy() > conf
        return out["keypoints0"].cpu().numpy()[m], out["keypoints1"].cpu().numpy()[m]

    PITCHES = (-30.0, 0.0)
    YAWS = tuple(np.arange(0, 360, 30.0))

    def tiles_of(img):
        ts = equirect_tiles(img, fov_deg=fov, yaw_step=30.0, pitches=PITCHES, size=tile_size)
        return {(t["yaw"], t["pitch"]): t["img"] for t in ts}

    K = np.array([[tile_size / (2 * math.tan(math.radians(fov) / 2)), 0, tile_size / 2],
                  [0, tile_size / (2 * math.tan(math.radians(fov) / 2)), tile_size / 2],
                  [0, 0, 1]])

    def kf_pair_near(t, lo=0.25, hi=2.0):
        """Adjacent-ish keyframes near t with a usable triangulation baseline."""
        i = int(np.argmin(np.abs(traj[:, 0] - t)))
        for j in range(i + 1, min(i + 7, len(traj))):
            b = np.linalg.norm(traj[j, 1:4] - traj[i, 1:4])
            if lo <= b <= hi:
                return i, j
        for j in range(i - 1, max(i - 7, -1), -1):
            b = np.linalg.norm(traj[j, 1:4] - traj[i, 1:4])
            if lo <= b <= hi:
                return j, i
        return None

    obj_pts_all, img_pts_all, tile_ids = [], [], []
    diags = []
    for t in times:
        pair = kf_pair_near(t)
        if pair is None:
            diags.append({"t": t, "skip": "no keyframe pair with usable baseline"})
            print(diags[-1])
            continue
        ia, ib = pair
        Ra, ca, dta = pose_at(traj[ia, 0])
        Rb, cb, dtb = pose_at(traj[ib, 0])
        base = np.linalg.norm(cb - ca)
        fa, fb = grab(traj[ia, 0]), grab(traj[ib, 0])
        ta_, tb_ = tiles_of(fa), tiles_of(fb)
        pano_tiles = tiles_of(pano)

        n3d, npnp = 0, 0
        for key in ta_:
            yaw, pitch = key
            # frame-frame triangulation (same tile key both frames: small motion)
            k0, k1 = loftr(ta_[key], tb_[key])
            if len(k0) < 8:
                continue
            pts3, kept = [], []
            for pa, pb in zip(k0, k1):
                da = Ra @ _bearing_from_tile_px(pa, tile_size, fov, yaw, pitch)
                db = Rb @ _bearing_from_tile_px(pb, tile_size, fov, yaw, pitch)
                # midpoint of closest approach
                w0 = ca - cb
                a_ = da @ da; b_ = da @ db; c_ = db @ db
                d_ = da @ w0; e_ = db @ w0
                den = a_ * c_ - b_ * b_
                if abs(den) < 1e-9:
                    continue
                s_ = (b_ * e_ - c_ * d_) / den
                u_ = (a_ * e_ - b_ * d_) / den
                p1 = ca + s_ * da
                p2 = cb + u_ * db
                if np.linalg.norm(p1 - p2) > 0.15 * max(base, 1e-3) + 0.05:
                    continue
                pts3.append((p1 + p2) / 2)
                kept.append(pa)
            if len(pts3) < 6:
                continue
            n3d += len(pts3)
            # pano tile vs frame tile: transfer 3D via nearest frame keypoint
            for pkey, ptile in pano_tiles.items():
                pk, fk = loftr(ptile, ta_[key])
                if len(pk) < 4:
                    continue
                kept_arr = np.array(kept)
                pts3_arr = np.array(pts3)
                for pp, pf in zip(pk, fk):
                    dists = np.linalg.norm(kept_arr - pf, axis=1)
                    near = np.where(dists < 12.0)[0]
                    if len(near) == 0:
                        continue
                    X = np.median(pts3_arr[near[np.argsort(dists[near])[:3]]], axis=0)
                    obj_pts_all.append(X)
                    img_pts_all.append(pp)
                    tile_ids.append(pkey)
                    npnp += 1
        diags.append({"t": t, "kf_dt": round(float(dta), 2), "baseline_u": round(float(base), 3),
                      "tri_pts": n3d, "pnp_pairs": npnp})
        print(diags[-1])

    # ---- per-pano-tile PnP, aggregate rig pose ----
    results = []
    by_tile = {}
    for X, p, tid in zip(obj_pts_all, img_pts_all, tile_ids):
        by_tile.setdefault(tid, ([], []))
        by_tile[tid][0].append(X)
        by_tile[tid][1].append(p)
    best = None
    centers = []
    for tid, (Xs, ps) in by_tile.items():
        if len(Xs) < 10:
            continue
        ok, rvec, tvec, inl = cv2.solvePnPRansac(
            np.array(Xs, dtype=np.float64), np.array(ps, dtype=np.float64), K, None,
            reprojectionError=4.0, iterationsCount=300, flags=cv2.SOLVEPNP_EPNP)
        if not ok or inl is None or len(inl) < 8:
            continue
        Rt, _ = cv2.Rodrigues(rvec)
        C = (-Rt.T @ tvec).ravel()
        yaw, pitch = tid
        th = np.radians(pitch); ya = np.radians(yaw)
        Rx = np.array([[1, 0, 0], [0, np.cos(th), -np.sin(th)], [0, np.sin(th), np.cos(th)]])
        Ry = np.array([[np.cos(ya), 0, np.sin(ya)], [0, 1, 0], [-np.sin(ya), 0, np.cos(ya)]])
        R_rig_w = (Ry @ Rx) @ Rt          # world -> rig
        centers.append(C)
        rec = {"tile": tid, "inliers": int(len(inl)), "C": [round(float(v), 3) for v in C]}
        results.append(rec)
        if best is None or len(inl) > best[0]:
            best = (len(inl), R_rig_w, C)
    out = {"per_tile": results, "n_pairs": len(obj_pts_all), "diag": diags}
    if centers:
        med = np.median(np.array(centers), axis=0)
        out["pano_center_units"] = [round(float(v), 3) for v in med]
        out["pano_center_spread_u"] = round(float(np.median(np.linalg.norm(np.array(centers) - med, axis=1))), 3)
        if best:
            out["R_rig_w_best"] = [[round(float(v), 4) for v in row] for row in best[1]]
    return out


@app.local_entrypoint()
def localize(pano_key: str, video_key: str, traj_key: str, times: str, pair_gap: float = 1.5):
    ts = [float(t) for t in times.split(",")]
    res = stage2.remote(pano_key, video_key, traj_key, ts, pair_gap)
    print(json.dumps(res, indent=2))


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
