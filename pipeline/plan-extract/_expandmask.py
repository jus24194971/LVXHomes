"""Expand the LaMa fill mask to include the thin white furniture-edge smears
(bright + low-sat + THIN — blobby real furniture is spared by an opening)."""
import cv2, numpy as np
D = r"C:\Users\jus24\dev\lvx-homes\pipeline\plan-extract" + "\\"
clean = cv2.imread(D + "_nadir_clean.jpg")
gap = cv2.imread(D + "_nadir_gap.png", 0)
hsv = cv2.cvtColor(clean, cv2.COLOR_BGR2HSV)
v, s = hsv[:, :, 2], hsv[:, :, 1]
content = clean.sum(2) > 25                                  # inside the captured region

bright = (((v > 178) & (s < 45) & content).astype(np.uint8)) * 255
blob = cv2.morphologyEx(bright, cv2.MORPH_OPEN, np.ones((23, 23), np.uint8))   # keep blobby furniture
thin = cv2.subtract(bright, blob)                            # the thin/jagged smears only
thin = cv2.morphologyEx(thin, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))
thin = cv2.dilate(thin, np.ones((5, 5), np.uint8))

exp = cv2.bitwise_or(gap, thin)
exp = cv2.morphologyEx(exp, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))         # drop pinpricks
cv2.imwrite(D + "_nadir_gap2.png", exp)
dbg = clean.copy(); dbg[exp > 0] = (0, 0, 255)
cv2.imwrite(D + "_nadir_gap2_dbg.jpg", dbg, [cv2.IMWRITE_JPEG_QUALITY, 85])
print("gap-only %:", round((gap > 0).mean() * 100, 1),
      "| +smears %:", round((thin > 0).mean() * 100, 1),
      "| expanded %:", round((exp > 0).mean() * 100, 1))
