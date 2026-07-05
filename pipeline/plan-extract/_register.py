"""First-pass registration of our photoreal floor onto the CubiCasa MLS floorplan.
Detect each footprint, fit a similarity transform (our floor -> CubiCasa main house),
warp, then composite CubiCasa's crisp walls/labels back on top."""
import cv2, numpy as np
D = r"C:\Users\jus24\dev\lvx-homes\pipeline\plan-extract"
FL = cv2.imread(D + r"\_fused_nadir_4k.jpg")     # our floor (1800x1800)
FP = cv2.imread(D + r"\_floorplan_mls.png")      # CubiCasa (1536x1152)


def our_footprint(fl):
    hsv = cv2.cvtColor(fl, cv2.COLOR_BGR2HSV)
    nonblack = fl.sum(2).astype(np.int32) > 45
    green = (hsv[:, :, 0] > 35) & (hsv[:, :, 0] < 92) & (hsv[:, :, 1] > 55) & (hsv[:, :, 2] > 45)
    m = ((nonblack & ~green).astype(np.uint8)) * 255
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((7, 7), np.uint8))
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((25, 25), np.uint8))
    cnts, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    return max(cnts, key=cv2.contourArea), m


def cubicasa_mainhouse(fp):
    g = cv2.cvtColor(fp, cv2.COLOR_BGR2GRAY)
    draw = ((g < 250).astype(np.uint8)) * 255
    draw = cv2.morphologyEx(draw, cv2.MORPH_CLOSE, np.ones((11, 11), np.uint8))
    er = cv2.erode(draw, np.ones((27, 27), np.uint8))   # disconnect casita/patio from main house
    n, lab, stats, cent = cv2.connectedComponentsWithStats(er)
    idx = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    blob = ((lab == idx).astype(np.uint8)) * 255
    blob = cv2.dilate(blob, np.ones((27, 27), np.uint8))
    cnts, _ = cv2.findContours(blob, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    return max(cnts, key=cv2.contourArea), blob


def order(box, ctr):
    a = np.arctan2(box[:, 1] - ctr[1], box[:, 0] - ctr[0])
    return box[np.argsort(a)]


cFL, mFL = our_footprint(FL)
cFP, mFP = cubicasa_mainhouse(FP)
rFL, rFP = cv2.minAreaRect(cFL), cv2.minAreaRect(cFP)
print("our floor  minAreaRect:", tuple(round(x, 1) if isinstance(x, float) else tuple(round(v, 1) for v in x) for x in rFL))
print("cubicasa   minAreaRect:", tuple(round(x, 1) if isinstance(x, float) else tuple(round(v, 1) for v in x) for x in rFP))
print("our floor footprint area px:", int(cv2.contourArea(cFL)), " cubicasa area px:", int(cv2.contourArea(cFP)))

boxFL = order(cv2.boxPoints(rFL).astype(np.float32), np.array(rFL[0], np.float32))
boxFP = order(cv2.boxPoints(rFP).astype(np.float32), np.array(rFP[0], np.float32))
M = cv2.getPerspectiveTransform(boxFL, boxFP)
warp = cv2.warpPerspective(FL, M, (FP.shape[1], FP.shape[0]))

g = cv2.cvtColor(FP, cv2.COLOR_BGR2GRAY)
walls = g < 120
out = warp.copy(); out[walls] = FP[walls]
cv2.imwrite(D + r"\_dollhouse_reg.jpg", out, [cv2.IMWRITE_JPEG_QUALITY, 92])
blend = cv2.addWeighted(warp, 0.65, FP, 0.35, 0)
cv2.imwrite(D + r"\_dollhouse_blend.jpg", blend, [cv2.IMWRITE_JPEG_QUALITY, 92])
# footprint diagnostics
dbg = FP.copy(); cv2.drawContours(dbg, [cFP], -1, (0, 0, 255), 3)
cv2.imwrite(D + r"\_fp_cubicasa.jpg", dbg, [cv2.IMWRITE_JPEG_QUALITY, 88])
dbg2 = FL.copy(); cv2.drawContours(dbg2, [cFL], -1, (0, 0, 255), 4)
cv2.imwrite(D + r"\_fp_ourfloor.jpg", dbg2, [cv2.IMWRITE_JPEG_QUALITY, 85])
print("wrote _dollhouse_reg.jpg, _dollhouse_blend.jpg, _fp_cubicasa.jpg, _fp_ourfloor.jpg")
