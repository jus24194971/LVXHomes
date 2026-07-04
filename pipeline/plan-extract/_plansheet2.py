"""PLANSHEET v2 — tightened walls: solid redrawn wall strokes, photo inset from wall lines,
white-halo labels, and thin-boundary (patio/porch/casita-island) exclusion."""
import numpy as np
import cv2

D = r"C:\Users\jus24\dev\lvx-homes\pipeline\plan-extract" + "\\"
photo = cv2.imread(D + "_composed_v2.jpg")
plan = cv2.imread(D + "_floorplan_mls.png")
Him, Wim = photo.shape[:2]
Hp, Wp = plan.shape[:2]
# fitted to the splat's wall evidence vs CubiCasa ink by _fitalign.py (overlap .218->.382);
# Justin's hand calibration was FX,FY,FW,ROT = 11.5, -1.0, 60.5, 108.0
FX, FY, FW, FH, ROT, FLIPH = 13.600, 0.100, 57.671, 54.670665, 109.900, True
CX, CY, CW, CH = 0.0, 0.0, 90.0, 68.0
K = 2
Ho, Wo = Hp * K, Wp * K

# photo resampled into the plan frame via Justin's transform
yy, xx = np.mgrid[0:Ho, 0:Wo].astype(np.float32)
sx = (xx / K) / Wp * CW + CX
sy = (yy / K) / Hp * CH + CY
cx = FX + FW / 2.0; cy = FY + FH / 2.0
th = np.radians(ROT); c, s = np.cos(-th), np.sin(-th)
dx = sx - cx; dy = sy - cy
p1x = cx + c * dx - s * dy
p1y = cy + s * dx + c * dy
if FLIPH:
    p1x = 2 * cx - p1x
u = ((p1x - FX) / FW * Wim).astype(np.float32)
v = ((p1y - FY) / FH * Him).astype(np.float32)
sampled = cv2.remap(photo, u, v, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=(0, 0, 0))

# --- plan structure ---
g = cv2.cvtColor(plan, cv2.COLOR_BGR2GRAY)
ink = (g < 160).astype(np.uint8)
thick = cv2.dilate(cv2.erode(ink, np.ones((3, 3), np.uint8), iterations=2),
                   np.ones((3, 3), np.uint8), iterations=3)          # walls survive, text/thin lines don't
text = ((g < 200).astype(np.uint8) & (1 - thick)).astype(np.uint8)   # labels, dims, thin marks

# enclosed cells (door-bridged flood fill)
ink_cl = cv2.morphologyEx(ink * 255, cv2.MORPH_CLOSE, np.ones((51, 51), np.uint8)) // 255
ffm = np.zeros((Hp + 2, Wp + 2), np.uint8)
ext = (1 - ink_cl).astype(np.uint8); cv2.floodFill(ext, ffm, (0, 0), 2)
cells = (((1 - ink) == 1) & (ext != 2)).astype(np.uint8) * 255

# INSIDE = inside a filled THICK-WALL WEB. The main house and the casita each have a connected
# web of thick wall strokes; filling each web's outer contour gives its gross footprint. The
# patio/porch are drawn with thin strokes OUTSIDE those webs -> cut at the exterior wall.
# rooms interconnect through doorways -> the fill yields exactly TWO real cells: main house +
# casita. Keep both; the patio rides along as a sparse band at the main cell's top — trim it
# with a row-density cut (patio strip covers few columns vs the full-width house body).
nbc, labc, stc, _ = cv2.connectedComponentsWithStats(cells)
order = sorted(range(1, nbc), key=lambda i: -stc[i, cv2.CC_STAT_AREA])[:2]
rooms = np.zeros((Hp, Wp), np.uint8)
mainc = ((labc == order[0]).astype(np.uint8)) * 255
rowc = (mainc > 0).sum(1).astype(np.float32)
dense = np.where(rowc > 0.9 * rowc.max())[0]
if len(dense):
    mainc[: dense[0]] = 0                                            # drop the sparse patio band above the body
rooms |= mainc
if len(order) > 1:
    rooms |= ((labc == order[1]).astype(np.uint8)) * 255             # casita stays
rooms = rooms.astype(np.uint8)
rooms_inset = cv2.erode(rooms, np.ones((3, 3), np.uint8))            # photo stays a hair off the walls

# --- compose at 2x ---
up = lambda m, interp=cv2.INTER_NEAREST: cv2.resize(m, (Wo, Ho), interpolation=interp)
roomsb = up(rooms_inset) > 0
thickb = up(thick * 255) > 0
textb = up(text * 255) > 0
halob = cv2.dilate((textb.astype(np.uint8)) * 255, np.ones((7, 7), np.uint8)) > 0

out = np.full((Ho, Wo, 3), 252, np.uint8)                            # clean paper white
photo_ok = roomsb & (sampled.sum(2) > 30)
out[photo_ok] = sampled[photo_ok]
# solid tightened walls: uniform near-black strokes redrawn over everything
wallsb = cv2.dilate((thickb.astype(np.uint8)) * 255, np.ones((3, 3), np.uint8)) > 0
out[wallsb] = (26, 21, 18)
# labels: soft white halo, then the plan's own text
alpha = 0.78
oh = out.astype(np.float32)
oh[halob & ~wallsb] = oh[halob & ~wallsb] * (1 - alpha) + 252 * alpha
out = oh.astype(np.uint8)
planb = up(plan, cv2.INTER_CUBIC)
out[textb & ~wallsb] = planb[textb & ~wallsb]
cv2.imwrite(D + "_plansheet_v3.jpg", out, [cv2.IMWRITE_JPEG_QUALITY, 93])
cov = int(photo_ok.sum() / max(roomsb.sum(), 1) * 100)
print(f"plansheet v3: {Wo}x{Ho}, photo fills {cov}% of kept rooms -> _plansheet_v3.jpg")
