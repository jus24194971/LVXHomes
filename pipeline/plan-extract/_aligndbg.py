"""Debug the 8 alignment hypotheses: save a grid of rotated photo-masks + per-hypothesis
best score/loc so the wrong pick is visible."""
import numpy as np
import cv2

D = r"C:\Users\jus24\dev\lvx-homes\pipeline\plan-extract" + "\\"
ph = cv2.imread(D + "_nadir_lama2.jpg")
pl = cv2.imread(D + "_floorplan_mls.png")
Hp, Wp = ph.shape[:2]
PHOTO_FT_W = 69.2
MAIN_SQFT = 2666.0 - 347

hsv = cv2.cvtColor(ph, cv2.COLOR_BGR2HSV)
nonblack = ph.sum(2) > 40
green = (hsv[:, :, 0] > 33) & (hsv[:, :, 0] < 92) & (hsv[:, :, 1] > 45) & (hsv[:, :, 2] > 40)
pm = ((nonblack & ~green).astype(np.uint8)) * 255
pm = cv2.morphologyEx(pm, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
pm = cv2.morphologyEx(pm, cv2.MORPH_CLOSE, np.ones((25, 25), np.uint8))
n, lab, stats, _ = cv2.connectedComponentsWithStats(pm)
if n > 1:
    pm = ((lab == (1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA])))).astype(np.uint8)) * 255

g = cv2.cvtColor(pl, cv2.COLOR_BGR2GRAY)
ink = (g < 160).astype(np.uint8)
ink_c = cv2.morphologyEx(ink * 255, cv2.MORPH_CLOSE, np.ones((51, 51), np.uint8)) // 255
free_c = (1 - ink_c).astype(np.uint8)
ffm = np.zeros((free_c.shape[0] + 2, free_c.shape[1] + 2), np.uint8)
ext = free_c.copy(); cv2.floodFill(ext, ffm, (0, 0), 2)
free = (1 - ink).astype(np.uint8)
cells = ((free == 1) & (ext != 2)).astype(np.uint8) * 255
merged = cv2.dilate(cells, np.ones((17, 17), np.uint8))
n2, lab2, st2, _ = cv2.connectedComponentsWithStats(merged)
cluster = (lab2 == (1 + int(np.argmax(st2[1:, cv2.CC_STAT_AREA]))))
plan_area = float(((cells > 0) & cluster).sum())
px_ft = float(np.sqrt(plan_area / MAIN_SQFT))
cnts, _ = cv2.findContours((cluster.astype(np.uint8)) * 255, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
lm = np.zeros_like(cells); cv2.drawContours(lm, [max(cnts, key=cv2.contourArea)], -1, 255, -1)
lm = cv2.erode(lm, np.ones((17, 17), np.uint8))
s = px_ft / (Wp / PHOTO_FT_W)
print(f"px/ft plan {px_ft:.2f}, scale {s:.4f}")

pm_s = cv2.resize(pm, None, fx=s, fy=s, interpolation=cv2.INTER_NEAREST)
lmf = (lm > 0).astype(np.float32)
lmz = lmf - lmf.mean()
tiles = []
ANG = 45.0
for flip in (0, 1):
    base = cv2.flip(pm_s, 1) if flip else pm_s
    for k in range(4):
        rot = -ANG + 90 * k
        M = cv2.getRotationMatrix2D((base.shape[1] / 2, base.shape[0] / 2), rot, 1.0)
        cosr, sinr = abs(M[0, 0]), abs(M[0, 1])
        nw = int(base.shape[1] * cosr + base.shape[0] * sinr)
        nh = int(base.shape[1] * sinr + base.shape[0] * cosr)
        M[0, 2] += nw / 2 - base.shape[1] / 2; M[1, 2] += nh / 2 - base.shape[0] / 2
        r = cv2.warpAffine(base, M, (nw, nh), flags=cv2.INTER_NEAREST)
        ys, xs = np.where(r > 0)
        r = r[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
        rf = (r > 0).astype(np.float32)
        pad_y = max(0, rf.shape[0] - lmz.shape[0] + 8); pad_x = max(0, rf.shape[1] - lmz.shape[1] + 8)
        lmp = cv2.copyMakeBorder(lmz, pad_y, pad_y, pad_x, pad_x, cv2.BORDER_CONSTANT, value=float(-lmf.mean()))
        res = cv2.matchTemplate(lmp, rf, cv2.TM_CCORR)
        _, mx, _, loc = cv2.minMaxLoc(res)
        # normalize score by template mass so big diagonals don't win by area
        score = mx / rf.sum()
        th = cv2.resize(r, (240, int(240 * r.shape[0] / r.shape[1])))
        th = cv2.cvtColor(th, cv2.COLOR_GRAY2BGR)
        cv2.putText(th, f"f{flip} r{rot:.0f} s{score:.3f}", (4, 20), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 0), 1)
        tiles.append((score, th, flip, rot, loc, pad_x, pad_y))
        print(f"flip={flip} rot={rot:6.1f}  raw={mx:10.0f}  norm={score:.4f}  loc={loc} pad=({pad_x},{pad_y})")
hmax = max(t[1].shape[0] for t in tiles)
row1 = np.hstack([cv2.copyMakeBorder(t[1], 0, hmax - t[1].shape[0], 0, 0, cv2.BORDER_CONSTANT) for t in tiles[:4]])
row2 = np.hstack([cv2.copyMakeBorder(t[1], 0, hmax - t[1].shape[0], 0, 0, cv2.BORDER_CONSTANT) for t in tiles[4:]])
grid = np.vstack([row1, row2])
# plan mask thumbnail for reference
lt = cv2.resize(lm, (240, int(240 * lm.shape[0] / lm.shape[1])))
lt = cv2.cvtColor(lt, cv2.COLOR_GRAY2BGR)
cv2.putText(lt, "PLAN mask", (4, 20), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 200, 255), 1)
grid = np.vstack([grid, cv2.copyMakeBorder(lt, 0, 0, 0, grid.shape[1] - lt.shape[1], cv2.BORDER_CONSTANT)])
cv2.imwrite(D + "_align_grid.jpg", grid, [cv2.IMWRITE_JPEG_QUALITY, 88])
print("wrote _align_grid.jpg")
