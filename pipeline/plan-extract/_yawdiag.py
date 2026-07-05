"""Diagnose the nadir reframe's heading behavior: does the image rotate with the drone's
yaw (follow), a smoothed version (lag), or not at all (direction-locked / fixed heading)?
Method: pick frame pairs where VSLAM says the drone yawed a LOT, estimate the actual
image-to-image rotation with ORB + estimateAffinePartial2D, compare."""
import subprocess, sys
import numpy as np
import cv2

D = r"C:\Users\jus24\dev\lvx-homes\pipeline\plan-extract"
VID = r"C:\Users\jus24\Videos\Maria Real Estate\Scottsdale House\0618 (1)(1).mp4"
FF = r"C:\Users\jus24\AppData\Local\Programs\Python\Python312\Lib\site-packages\imageio_ffmpeg\binaries\ffmpeg-win-x86_64-v7.1.exe"

T = np.loadtxt(D + r"\_nadir_traj.txt")
ts = T[:, 0].copy()
fps = 30.0
if ts.max() > 299.5 * 2:
    ts = ts / fps


def quat2rot(q):
    x, y, z, w = q
    return np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ])


# up axis from camera positions' plane (cheap): use PCA of positions? use world Z-ish from quats.
# Simpler: derive up the same way the pipeline does but from the trajectory alone is unstable;
# instead compute nose-heading changes in the horizontal plane defined by mean camera up vector.
Rs = np.array([quat2rot(q) for q in T[:, 4:8]])
ok = np.isfinite(Rs.reshape(len(T), -1)).all(1) & np.isfinite(T[:, 1:4]).all(1)
upv = Rs[ok][:, :, 1].mean(0)  # camera +Y average ~ vertical-ish for a level drone
upv /= np.linalg.norm(upv)
fwd = Rs[:, :, 2]  # camera +Z = nose
fh = fwd - np.outer(fwd @ upv, upv)
n = np.linalg.norm(fh, axis=1) + 1e-9
fh = fh / n[:, None]
ref = fh[np.argmax(ok)]
side = np.cross(upv, ref)
yaw = np.degrees(np.arctan2(fh @ side, fh @ ref))
yaw[~ok] = np.nan

# pick pairs: a base frame early, then frames where |yaw - yaw_base| is large
base_i = np.argmax(ok)
tgt = []
for want in (30, 60, 90, 120):
    d = np.abs(((yaw - yaw[base_i]) + 180) % 360 - 180)
    d[~ok] = -1
    cands = np.where(np.abs(d - want) < 5)[0]
    if len(cands):
        tgt.append(int(cands[0]))
print("base pose t=%.1fs yaw=%.1f" % (ts[base_i], yaw[base_i]))
pairs = [(base_i, j) for j in tgt]


def grab(t):
    p = D + r"\_yd_%d.png" % int(t * 10)
    subprocess.run([FF, "-y", "-hide_banner", "-loglevel", "error", "-ss", str(t), "-i", VID,
                    "-frames:v", "1", p], check=True)
    im = cv2.imread(p, cv2.IMREAD_GRAYSCALE)
    return cv2.resize(im, (960, 540))


orb = cv2.ORB_create(3000)
bf = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=True)
imgs = {}
for i, j in pairs:
    for k in (i, j):
        t = float(ts[k])
        if k not in imgs:
            imgs[k] = grab(t)
    k1, d1 = orb.detectAndCompute(imgs[i], None)
    k2, d2 = orb.detectAndCompute(imgs[j], None)
    if d1 is None or d2 is None:
        print("pair skip (no features)"); continue
    m = bf.match(d1, d2)
    m = sorted(m, key=lambda x: x.distance)[:400]
    if len(m) < 30:
        print("pair t=%.1f->%.1f: too few matches (%d)" % (ts[i], ts[j], len(m))); continue
    p1 = np.float32([k1[x.queryIdx].pt for x in m])
    p2 = np.float32([k2[x.trainIdx].pt for x in m])
    A, inl = cv2.estimateAffinePartial2D(p1, p2, ransacReprojThreshold=3.0)
    if A is None:
        print("pair t=%.1f->%.1f: affine failed" % (ts[i], ts[j])); continue
    rot = np.degrees(np.arctan2(A[1, 0], A[0, 0]))
    dyaw = ((yaw[j] - yaw[i]) + 180) % 360 - 180
    print("pair t=%.1fs -> %.1fs | VSLAM dYaw = %+7.1f deg | image rotation = %+7.1f deg | inliers %d"
          % (ts[i], ts[j], dyaw, rot, int(inl.sum()) if inl is not None else -1))
