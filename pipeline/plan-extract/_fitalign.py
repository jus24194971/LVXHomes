"""Fit the plansheet photo<->plan transform to DATA: project the splat's wall-evidence
mask through the transform and maximize overlap with the CubiCasa wall ink. Refines
Justin's hand-calibrated constants (FX, FY, FW, ROT; FH locked to the frame aspect,
FLIPH fixed). Prints baseline vs fitted score + the new constants line."""
import numpy as np
import cv2

D = r"C:\Users\jus24\dev\lvx-homes\pipeline\plan-extract" + "\\"
ev = cv2.imread(D + "_splat_wallev.png", 0)
plan = cv2.imread(D + "_floorplan_mls.png")
Him, Wim = ev.shape[:2]
Hp, Wp = plan.shape[:2]
CX, CY, CW, CH = 0.0, 0.0, 90.0, 68.0
FX0, FY0, FW0, ROT0 = 11.5, -1.0, 60.5, 108.0
ASPECT = 57.35260115606939 / 60.5                      # FH/FW from the hand calibration

# CubiCasa wall ink (thick strokes), generously dilated -> tolerant score target
g = cv2.cvtColor(plan, cv2.COLOR_BGR2GRAY)
ink = (g < 160).astype(np.uint8)
thick = cv2.dilate(cv2.erode(ink, np.ones((3, 3), np.uint8), iterations=2),
                   np.ones((3, 3), np.uint8), iterations=3)
target = cv2.dilate(thick, np.ones((9, 9), np.uint8)) > 0

ys, xs = np.where(ev > 0)
sel = np.random.default_rng(0).choice(len(xs), min(6000, len(xs)), replace=False)
u = xs[sel].astype(np.float64); v = ys[sel].astype(np.float64)


def score(FX, FY, FW, ROT):
    FH = FW * ASPECT
    cx = FX + FW / 2.0; cy = FY + FH / 2.0
    p1x = u / Wim * FW + FX
    p1y = v / Him * FH + FY
    p1x = 2 * cx - p1x                                  # FLIPH
    th = np.radians(ROT); c, s = np.cos(-th), np.sin(-th)
    dx = p1x - cx; dy = p1y - cy                        # invert the -ROT rotation
    sx = cx + c * dx + s * dy
    sy = cy - s * dx + c * dy
    px = ((sx - CX) / CW * Wp).astype(int)
    py = ((sy - CY) / CH * Hp).astype(int)
    ok = (px >= 0) & (px < Wp) & (py >= 0) & (py < Hp)
    if ok.sum() < len(u) * 0.5:
        return 0.0
    return float(target[py[ok], px[ok]].mean() * ok.mean())


base = score(FX0, FY0, FW0, ROT0)
best = (base, FX0, FY0, FW0, ROT0)
grids = [(0.5, 0.5, 0.01, 0.5, 2.0, 2.0, 0.05, 2.5),   # (stepFX, stepFY, stepFWfrac, stepROT, winFX, winFY, winFWfrac, winROT)
         (0.15, 0.15, 0.004, 0.15, 0.6, 0.6, 0.015, 0.6),
         (0.05, 0.05, 0.0015, 0.05, 0.2, 0.2, 0.005, 0.2)]
for sfx, sfy, sfw, srot, wfx, wfy, wfw, wrot in grids:
    _, bFX, bFY, bFW, bROT = best
    for FX in np.arange(bFX - wfx, bFX + wfx + 1e-9, sfx):
        for FY in np.arange(bFY - wfy, bFY + wfy + 1e-9, sfy):
            for FW in bFW * np.arange(1 - wfw, 1 + wfw + 1e-9, sfw):
                for ROT in np.arange(bROT - wrot, bROT + wrot + 1e-9, srot):
                    sc = score(FX, FY, FW, ROT)
                    if sc > best[0]:
                        best = (sc, FX, FY, FW, ROT)
sc, FX, FY, FW, ROT = best
FH = FW * ASPECT
print(f"baseline overlap {base:.4f} -> fitted {sc:.4f}")
print(f"deltas: FX {FX-FX0:+.2f}ft FY {FY-FY0:+.2f}ft FW {FW-FW0:+.2f}ft ({(FW/FW0-1)*100:+.1f}%) ROT {ROT-ROT0:+.2f}deg")
print(f"FX, FY, FW, FH, ROT, FLIPH = {FX:.3f}, {FY:.3f}, {FW:.3f}, {FH:.6f}, {ROT:.3f}, True")

# plan_align.json: the plan<->floor-frame transform for the pipeline (capture-pin
# conversion in localize_stills). Upload with:
#   modal run pipeline/cloud/modal_app.py::putr2 --key layout/<slug>/plan_align.json --path plan_align.json
import json
json.dump({"FX": round(FX, 3), "FY": round(FY, 3), "FW": round(FW, 3), "FH": round(FH, 6),
           "ROT": round(ROT, 3), "FLIPH": True, "CX": CX, "CY": CY, "CW": CW, "CH": CH,
           "fit_overlap": round(sc, 4)},
          open(D + "plan_align.json", "w"), indent=1)
print("-> plan_align.json")
