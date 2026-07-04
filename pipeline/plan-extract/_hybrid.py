"""Multi-source composite v2: REAL pixels (nadir mosaic master, else trueortho+LaMa)
only where the splat's geometry says FLOOR *and* the real pixels structurally AGREE
with the splat at low frequency (kills mosaic serration/layover/exposure patches).
Real pixels are color-anchored to the splat (majority source). Output overwrites
_composed_v2.jpg for the plansheet bake; master saved as _hybrid_composed.png."""
import numpy as np
import cv2

D = r"C:\Users\jus24\dev\lvx-homes\pipeline\plan-extract" + "\\"
splat = cv2.imread(D + "_splat_ortho.png")
H, W = splat.shape[:2]
rs = lambda p, flags=cv2.IMREAD_COLOR, interp=cv2.INTER_LINEAR: cv2.resize(
    cv2.imread(D + p, flags), (W, H), interpolation=interp)
hgt = rs("_splat_height.png", cv2.IMREAD_UNCHANGED, cv2.INTER_NEAREST).astype(np.float32) / 1000.0 - 5.0
nad = rs("_nadir_master.png")
gap = rs("_nadir_gap.png", cv2.IMREAD_GRAYSCALE, cv2.INTER_NEAREST)
tol = rs("_trueortho_lama.png")

stex = rs("_still_tex.png")
stw = rs("_still_texw.png", cv2.IMREAD_GRAYSCALE, cv2.INTER_NEAREST)
ftx = rs("_floortex.png")
ftm = rs("_floortex_mask.png", cv2.IMREAD_GRAYSCALE, cv2.INTER_NEAREST)
nad_cov = (nad.sum(2) > 25) & (gap < 128)
tol_cov = tol.sum(2) > 25
floor = hgt < 0.45                                     # ft above floor: floors + rugs
# horizon-bounded floor unwrap replaces the mosaic wherever it reached (it is the
# same photographic pixels, but projected only up to each pano's line-of-sight horizon)
ftx_cov = (ftm > 128) & (ftx.sum(2) > 25)
nad = np.where(ftx_cov[..., None], ftx, nad)
nad_cov = nad_cov | ftx_cov
# priority 1: the 8K STILL texture (true-ortho at surface height through refined poses;
# occlusion handled at projection — furniture included, no floor restriction)
stex_cov = (stw > 50) & (stex.sum(2) > 25) & (splat.sum(2) > 25)
real = np.where(nad_cov[..., None], nad, tol).astype(np.uint8)
cov = floor & (nad_cov | tol_cov) & (splat.sum(2) > 25)

# color-anchor MOSAIC -> SPLAT via mean/std matching (still patches are already
# anchored per-still at the projector, so they stay out of this fit)
radj = real.astype(np.float32)
for c in range(3):
    x = real[cov][:, c].astype(np.float32); y = splat[cov][:, c].astype(np.float32)
    a = float(np.clip(y.std() / max(x.std(), 1e-3), 0.7, 1.4))
    b = float(y.mean() - a * x.mean())
    radj[:, :, c] = radj[:, :, c] * a + b
    print(f"real->splat ch{c}: x{a:.3f} {b:+.1f}")
radj = np.clip(radj, 0, 255).astype(np.uint8)
radj = np.where(stex_cov[..., None], stex, radj)       # stills in untouched, top priority
cov = cov | stex_cov

# structural agreement gate: low-frequency gray difference (serration/layover/exposure
# patches disagree hard with the splat -> keep splat there)
gs = cv2.GaussianBlur(cv2.cvtColor(splat, cv2.COLOR_BGR2GRAY), (17, 17), 0).astype(np.float32)
gr = cv2.GaussianBlur(cv2.cvtColor(radj, cv2.COLOR_BGR2GRAY), (17, 17), 0).astype(np.float32)
agree = np.abs(gs - gr) < np.where(stex_cov, 34, 22)   # trust the sharp stills more
# serration gate: mosaic tearing = high-frequency energy far above the splat's at the
# same spot (real floor detail is only modestly sharper than the splat's blur)
es = cv2.GaussianBlur(np.abs(cv2.Laplacian(cv2.cvtColor(splat, cv2.COLOR_BGR2GRAY),
                                           cv2.CV_32F)), (21, 21), 0)
er = cv2.GaussianBlur(np.abs(cv2.Laplacian(cv2.cvtColor(radj, cv2.COLOR_BGR2GRAY),
                                           cv2.CV_32F)), (21, 21), 0)
calm = er < np.maximum(3.5 * es, 18.0)
use = (cov & agree & (calm | stex_cov)).astype(np.uint8)   # stills are sharp by right
use = cv2.morphologyEx(use, cv2.MORPH_OPEN, np.ones((7, 7), np.uint8))     # no confetti
use = cv2.morphologyEx(use, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
print(f"floor {floor.mean()*100:.0f}% | covered {cov.mean()*100:.0f}% | used (agreeing) {use.mean()*100:.0f}% of frame")

mf = cv2.GaussianBlur(use.astype(np.float32), (11, 11), 0)[..., None]
out = splat.astype(np.float32) * (1 - mf) + radj.astype(np.float32) * mf
out[splat.sum(2) < 12] = 0                             # keep the outside void black
out = np.clip(out, 0, 255).astype(np.uint8)
cv2.imwrite(D + "_hybrid_composed.png", out)
cv2.imwrite(D + "_composed_v2.jpg", out, [cv2.IMWRITE_JPEG_QUALITY, 95])
print(f"-> _hybrid_composed.png + _composed_v2.jpg ({W}x{H})")
