"""AUTO-ALIGN the photoreal floor to the CubiCasa plan — Justin's dimensioned-structure match.
Scale: closed-form (photo ft/px known from VSLAM+GPS calibration; plan ft/px from its printed
net area over its drawn interior). Rotation: dominant-wall-angle mod 90 -> 8 hypotheses (x flip).
Translation: correlation of interior footprint masks. Outputs the transform + an overlay proof."""
import numpy as np
import cv2

D = r"C:\Users\jus24\dev\lvx-homes\pipeline\plan-extract" + "\\"
PHOTO = D + "_nadir_lama2.jpg"          # complete LaMa-filled floor (1800x1800)
PLAN = D + "_floorplan_mls.png"         # CubiCasa (1536x1152)
PHOTO_FT_W = 69.2                        # make_fused frame: 69.2 x 65.6 ft over 1800x1800
PHOTO_FT_H = 65.6
MAIN_SQFT = 2666.0 - (162 + 139 + 46)    # printed net total minus casita room+kitchen+bath

ph = cv2.imread(PHOTO)
pl = cv2.imread(PLAN)
Hp, Wp = ph.shape[:2]

# ---------- photo interior mask: non-black minus yard grass ----------
hsv = cv2.cvtColor(ph, cv2.COLOR_BGR2HSV)
nonblack = ph.sum(2) > 40
green = (hsv[:, :, 0] > 33) & (hsv[:, :, 0] < 92) & (hsv[:, :, 1] > 45) & (hsv[:, :, 2] > 40)
pm = ((nonblack & ~green).astype(np.uint8)) * 255
pm = cv2.morphologyEx(pm, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
pm = cv2.morphologyEx(pm, cv2.MORPH_CLOSE, np.ones((25, 25), np.uint8))
n, lab, stats, _ = cv2.connectedComponentsWithStats(pm)
if n > 1:
    keep = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    pm = ((lab == keep).astype(np.uint8)) * 255
ppx_per_ft = Wp / PHOTO_FT_W                                  # 26.0 px/ft
photo_sqft = pm.mean() / 255.0 * (PHOTO_FT_W * PHOTO_FT_H)
print(f"photo mask: {int(pm.sum()/255)} px = {photo_sqft:.0f} sqft-equivalent at calibrated scale")

# ---------- plan main-house interior mask (flood-fill: enclosed whitespace = net rooms) ----------
g = cv2.cvtColor(pl, cv2.COLOR_BGR2GRAY)
ink = (g < 160).astype(np.uint8)                              # solid walls (text is lighter/thin)
# bridge DOOR OPENINGS (drawn as gaps in the stroke, ~3 ft) before the exterior fill,
# else the fill leaks through every doorway and no room reads as enclosed
ink_closed = cv2.morphologyEx(ink * 255, cv2.MORPH_CLOSE, np.ones((51, 51), np.uint8)) // 255
free_cl = (1 - ink_closed).astype(np.uint8)
ffm = np.zeros((free_cl.shape[0] + 2, free_cl.shape[1] + 2), np.uint8)
ext = free_cl.copy()
cv2.floodFill(ext, ffm, (0, 0), 2)                            # exterior whitespace -> 2
free = (1 - ink).astype(np.uint8)
cells = ((free == 1) & (ext != 2)).astype(np.uint8) * 255     # enclosed room cells (net of walls)
cells = cv2.morphologyEx(cells, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
merged = cv2.dilate(cells, np.ones((17, 17), np.uint8))       # bridge across interior walls
n2, lab2, st2, _ = cv2.connectedComponentsWithStats(merged)
best = 1 + int(np.argmax(st2[1:, cv2.CC_STAT_AREA]))          # biggest cluster = main house
cluster = (lab2 == best)
lm_cells = ((cells > 0) & cluster).astype(np.uint8) * 255     # net room cells, main house only
plan_area_px = lm_cells.sum() / 255.0                          # px^2 of NET area == printed sqft basis
plan_px_per_ft = float(np.sqrt(plan_area_px / MAIN_SQFT))
# correlation target: the FILLED main-house region (rooms + interior walls)
cnts, _ = cv2.findContours((cluster.astype(np.uint8)) * 255, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
lm = np.zeros_like(cells)
cv2.drawContours(lm, [max(cnts, key=cv2.contourArea)], -1, 255, -1)
lm = cv2.erode(lm, np.ones((17, 17), np.uint8))               # undo the merge dilation
print(f"plan net cells: {int(plan_area_px)} px^2, {MAIN_SQFT:.0f} sqft -> {plan_px_per_ft:.2f} px/ft")

# ---------- closed-form relative scale: photo -> plan ----------
s = plan_px_per_ft / ppx_per_ft
print(f"scale photo->plan: x{s:.4f}")

# ---------- dominant wall angle of the photo (mod 90) ----------
gray = cv2.cvtColor(ph, cv2.COLOR_BGR2GRAY)
ed = cv2.Canny(gray, 40, 120); ed[pm == 0] = 0
lines = cv2.HoughLines(ed, 1, np.pi / 360, 140)
ang = 0.0
if lines is not None:
    deg = (np.degrees(lines[:, 0, 1]) % 90)
    hist, _ = np.histogram(deg, bins=180, range=(0, 90))
    hist = cv2.GaussianBlur(hist.astype(np.float32).reshape(-1, 1), (1, 5), 0).ravel()
    dom = float(np.argmax(hist)) / 2.0
    ang = dom if dom <= 45 else dom - 90
print(f"photo dominant wall offset: {ang:.1f} deg ({0 if lines is None else len(lines)} lines)")

# ---------- 8 hypotheses x translation correlation ----------
pm_s = cv2.resize(pm, None, fx=s, fy=s, interpolation=cv2.INTER_NEAREST)
lm_f = (lm > 0).astype(np.float32)
lm_z = lm_f - lm_f.mean()                                     # zero-mean: penalize off-plan mass
best_score = -1e18; best_cfg = None
for flip in (0, 1):
    base = cv2.flip(pm_s, 1) if flip else pm_s
    for k in range(4):
        rot = -ang + 90 * k
        M = cv2.getRotationMatrix2D((base.shape[1] / 2, base.shape[0] / 2), rot, 1.0)
        cosr, sinr = abs(M[0, 0]), abs(M[0, 1])
        nw = int(base.shape[1] * cosr + base.shape[0] * sinr)
        nh = int(base.shape[1] * sinr + base.shape[0] * cosr)
        M[0, 2] += nw / 2 - base.shape[1] / 2; M[1, 2] += nh / 2 - base.shape[0] / 2
        r = cv2.warpAffine(base, M, (nw, nh), flags=cv2.INTER_NEAREST)
        ys, xs = np.where(r > 0)
        if not len(ys):
            continue
        r = r[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
        rf = (r > 0).astype(np.float32)
        if rf.shape[0] > lm_f.shape[0] or rf.shape[1] > lm_f.shape[1]:
            pad_y = max(0, rf.shape[0] - lm_f.shape[0]); pad_x = max(0, rf.shape[1] - lm_f.shape[1])
            lm_pad = cv2.copyMakeBorder(lm_z, pad_y, pad_y, pad_x, pad_x, cv2.BORDER_CONSTANT, value=float(-lm_f.mean()))
        else:
            lm_pad = lm_z
        res = cv2.matchTemplate(lm_pad, rf, cv2.TM_CCORR)
        _, mx, _, loc = cv2.minMaxLoc(res)
        if mx > best_score:
            best_score = mx; best_cfg = (flip, k, rot, loc, rf.shape, (ys.min(), xs.min()))
flip, k, rot, loc, rshape, _ = best_cfg
print(f"BEST: flip={flip} k={k*90}deg rot={rot:.1f} loc={loc} score={best_score:.0f}")

# ---------- overlay proof ----------
base = cv2.flip(ph, 1) if flip else ph
basem = cv2.flip(pm, 1) if flip else pm
sc = cv2.resize(base, None, fx=s, fy=s)
scm = cv2.resize(basem, None, fx=s, fy=s, interpolation=cv2.INTER_NEAREST)
M = cv2.getRotationMatrix2D((sc.shape[1] / 2, sc.shape[0] / 2), rot, 1.0)
cosr, sinr = abs(M[0, 0]), abs(M[0, 1])
nw = int(sc.shape[1] * cosr + sc.shape[0] * sinr); nh = int(sc.shape[1] * sinr + sc.shape[0] * cosr)
M[0, 2] += nw / 2 - sc.shape[1] / 2; M[1, 2] += nh / 2 - sc.shape[0] / 2
rimg = cv2.warpAffine(sc, M, (nw, nh))
rm = cv2.warpAffine(scm, M, (nw, nh), flags=cv2.INTER_NEAREST)
ys, xs = np.where(rm > 0)
rimg = rimg[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
rm2 = rm[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
canvas = pl.copy().astype(np.float32)
y0, x0 = loc[1], loc[0]
h2, w2 = rimg.shape[:2]
h2 = min(h2, canvas.shape[0] - y0); w2 = min(w2, canvas.shape[1] - x0)
patch = canvas[y0:y0 + h2, x0:x0 + w2]
m = (rm2[:h2, :w2] > 0)[..., None] * 0.55
canvas[y0:y0 + h2, x0:x0 + w2] = patch * (1 - m) + rimg[:h2, :w2].astype(np.float32) * m
cv2.imwrite(D + "_autoalign_overlay.jpg", canvas.astype(np.uint8), [cv2.IMWRITE_JPEG_QUALITY, 90])
print("wrote _autoalign_overlay.jpg")
