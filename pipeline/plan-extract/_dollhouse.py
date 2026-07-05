"""Option B — standalone dollhouse cleanup of our photoreal floor.
Drop the yard, square (best-effort), inpaint the worst reconstruction shards,
output a transparent-background PNG (interior only) to drop into the editor as a layer."""
import cv2, numpy as np
D = r"C:\Users\jus24\dev\lvx-homes\pipeline\plan-extract" + "\\"
FL = cv2.imread(D + "_fused_nadir_4k.jpg")
H, W = FL.shape[:2]
hsv = cv2.cvtColor(FL, cv2.COLOR_BGR2HSV)

# --- masks ---
black = FL.sum(2) < 40                                                    # outside the capture
green = (hsv[:, :, 0] > 33) & (hsv[:, :, 0] < 92) & (hsv[:, :, 1] > 45) & (hsv[:, :, 2] > 40)  # yard grass
interior = ((~black) & (~green)).astype(np.uint8) * 255
interior = cv2.morphologyEx(interior, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
interior = cv2.morphologyEx(interior, cv2.MORPH_CLOSE, np.ones((27, 27), np.uint8))
n, lab, stats, _ = cv2.connectedComponentsWithStats(interior)
if n > 1:
    idx = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    interior = (lab == idx).astype(np.uint8) * 255                       # largest interior blob
interior = cv2.morphologyEx(interior, cv2.MORPH_CLOSE, np.ones((35, 35), np.uint8))

# --- dominant wall angle (square it) ---
gray = cv2.cvtColor(FL, cv2.COLOR_BGR2GRAY)
edges = cv2.Canny(gray, 40, 120); edges[interior == 0] = 0
lines = cv2.HoughLines(edges, 1, np.pi / 360, 160)
ang = 0.0
if lines is not None:
    deg = (np.degrees(lines[:, 0, 1]) % 90)
    hist, _ = np.histogram(deg, bins=90, range=(0, 90))
    dom = float(np.argmax(hist)) + 0.5
    ang = dom if dom < 45 else dom - 90
print("dominant wall offset:", round(ang, 2), "deg | hough lines:", 0 if lines is None else len(lines))

# --- inpaint the bright low-texture shards (reconstruction tears) ---
v, s = hsv[:, :, 2], hsv[:, :, 1]
shard = (((v > 185) & (s < 38)).astype(np.uint8)) * 255
shard[interior == 0] = 0
shard = cv2.morphologyEx(shard, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
shard = cv2.dilate(shard, np.ones((5, 5), np.uint8))
clean = cv2.inpaint(FL, shard, 6, cv2.INPAINT_NS)

# --- assemble BGRA, rotate to square, crop to content ---
bgra = cv2.cvtColor(clean, cv2.COLOR_BGR2BGRA); bgra[:, :, 3] = interior
M = cv2.getRotationMatrix2D((W / 2, H / 2), ang, 1.0)
rot = cv2.warpAffine(bgra, M, (W, H), flags=cv2.INTER_LINEAR, borderValue=(0, 0, 0, 0))
ys, xs = np.where(rot[:, :, 3] > 10)
crop = rot[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
cv2.imwrite(D + "_dollhouse_b1.png", crop)
a = crop[:, :, 3:4] / 255.0
white = (crop[:, :, :3] * a + 245 * (1 - a)).astype(np.uint8)
cv2.imwrite(D + "_dollhouse_b1_white.jpg", white, [cv2.IMWRITE_JPEG_QUALITY, 92])
cv2.imwrite(D + "_dollhouse_b1_shard.jpg", shard)
ig = FL.copy(); ig[interior == 0] = (0, 0, 0)
cv2.imwrite(D + "_dollhouse_b1_interior.jpg", ig, [cv2.IMWRITE_JPEG_QUALITY, 85])
print("crop size:", crop.shape, "-> _dollhouse_b1.png / _white / _shard / _interior")
