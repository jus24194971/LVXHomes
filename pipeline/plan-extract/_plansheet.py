"""PLANSHEET BAKE v1 — photo floor inside the CubiCasa walls, using Justin's hand-verified
layer transform (the authoritative photo<->plan mapping). Output is cardinal, yard-free,
walls/labels/dimensions intact: the industry-standard 'photo floor in drawn walls' hybrid."""
import numpy as np
import cv2

D = r"C:\Users\jus24\dev\lvx-homes\pipeline\plan-extract" + "\\"
photo = cv2.imread(D + "_composed_v2.jpg")       # 2266x2148 composed dollhouse
plan = cv2.imread(D + "_floorplan_mls.png")      # 1536x1152 CubiCasa
Him, Wim = photo.shape[:2]
Hp, Wp = plan.shape[:2]

# Justin's floor layer transform (sheet units) + cubicasa placement
FX, FY, FW, FH, ROT, FLIPH = 11.5, -1.0, 60.5, 57.35260115606939, 108.0, True
CX, CY, CW, CH = 0.0, 0.0, 90.0, 68.0
K = 2                                             # output at 2x plan resolution
Ho, Wo = Hp * K, Wp * K

# out px -> plan px -> sheet -> inverse floor transform -> photo px
yy, xx = np.mgrid[0:Ho, 0:Wo].astype(np.float32)
sx = (xx / K) / Wp * CW + CX
sy = (yy / K) / Hp * CH + CY
cx = FX + FW / 2.0; cy = FY + FH / 2.0
th = np.radians(ROT)
c, s = np.cos(-th), np.sin(-th)                   # inverse rotation (SVG y-down convention)
dx = sx - cx; dy = sy - cy
p1x = cx + c * dx - s * dy
p1y = cy + s * dx + c * dy
if FLIPH:
    p1x = 2 * cx - p1x                            # un-mirror about the layer centre
u = ((p1x - FX) / FW * Wim).astype(np.float32)
v = ((p1y - FY) / FH * Him).astype(np.float32)
sampled = cv2.remap(photo, u, v, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=(0, 0, 0))

# interior room cells from the plan (door-bridged flood fill), MAIN HOUSE cluster only
g = cv2.cvtColor(plan, cv2.COLOR_BGR2GRAY)
ink = (g < 160).astype(np.uint8)
ink_cl = cv2.morphologyEx(ink * 255, cv2.MORPH_CLOSE, np.ones((51, 51), np.uint8)) // 255
free_cl = (1 - ink_cl).astype(np.uint8)
ffm = np.zeros((Hp + 2, Wp + 2), np.uint8)
ext = free_cl.copy(); cv2.floodFill(ext, ffm, (0, 0), 2)
cells = (((1 - ink) == 1) & (ext != 2)).astype(np.uint8) * 255
merged = cv2.dilate(cells, np.ones((17, 17), np.uint8))
n2, lab2, st2, _ = cv2.connectedComponentsWithStats(merged)
main = (lab2 == (1 + int(np.argmax(st2[1:, cv2.CC_STAT_AREA]))))
cells_main = ((cells > 0) & main).astype(np.uint8) * 255

interior = cv2.resize(cells_main, (Wo, Ho), interpolation=cv2.INTER_NEAREST) > 0
inkbig = cv2.resize((g < 200).astype(np.uint8) * 255, (Wo, Ho), interpolation=cv2.INTER_NEAREST) > 0
planbig = cv2.resize(plan, (Wo, Ho), interpolation=cv2.INTER_CUBIC)

out = planbig.copy()
photo_ok = interior & (sampled.sum(2) > 30)       # inside rooms AND the photo actually has content
out[photo_ok] = sampled[photo_ok]
out[inkbig] = planbig[inkbig]                      # walls + labels + dimensions punch through on top
cv2.imwrite(D + "_plansheet_v1.jpg", out, [cv2.IMWRITE_JPEG_QUALITY, 93])
cov = int(photo_ok.sum() / max(interior.sum(), 1) * 100)
print(f"plansheet: {Wo}x{Ho}, photo fills {cov}% of main-house interior -> _plansheet_v1.jpg")
