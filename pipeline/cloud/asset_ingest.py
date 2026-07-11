"""Scene ingest — the buyer-facing "photograph your room" pipeline.

One casual photo -> every furniture item detected, segmented, dimensioned, and
scored. Per-item, per-axis confidence comes from the two signals the couch
experiment validated (metrology_experiment.py): distance from camera and
span-direction vs the view axis. Low-confidence items get a directed capture
suggestion ("stand square to the long side") instead of a silent wrong number.

Stages: GroundingDINO (open-vocab detect) -> SAM (masks) -> Depth Pro (metric
depth) -> floor plane (RANSAC, gravity prior from image-up) -> per-instance
oriented bbox in floor coords -> dims + confidence + category-prior sanity.

CLI:  modal run pipeline/cloud/asset_ingest.py --image photo.jpg --outdir out
Web:  modal deploy pipeline/cloud/asset_ingest.py
      POST raw image bytes to the printed endpoint with x-lvx-token (must
      equal LVX_CALLBACK_TOKEN in the `lvx-callback` Modal secret — same
      shared-token pattern as the VSLAM callback). The Studio Lab tab proxies
      to it via /studio/api/ingest.
"""

import base64
import io
import json
import math
import os
from pathlib import Path

import modal

app = modal.App("lvx-asset-ingest")

DETECT_PROMPT = ("sofa. couch. sectional. coffee table. side table. end table. dining table. "
                 "chair. armchair. rug. carpet. lamp. floor lamp. tv stand. bookshelf. "
                 "dresser. bed. nightstand. ottoman. bench. speaker. mirror. plant pot.")

# rough category priors, inches (min, max) on the LONGEST axis — sanity flags only
PRIORS = {
    "sofa": (60, 140), "couch": (60, 140), "sectional": (80, 160),
    "coffee table": (30, 60), "side table": (14, 30), "end table": (14, 30),
    "dining table": (48, 110), "rug": (36, 144), "carpet": (36, 144),
    "chair": (24, 40), "armchair": (28, 44), "bed": (70, 90),
    "tv stand": (40, 80), "dresser": (30, 72), "nightstand": (16, 30),
    "ottoman": (18, 48), "bench": (36, 72), "speaker": (6, 50),
    "lamp": (10, 72), "floor lamp": (48, 72), "mirror": (12, 72), "plant pot": (6, 30),
}


def _download_weights():
    from huggingface_hub import hf_hub_download, snapshot_download
    hf_hub_download("apple/DepthPro", "depth_pro.pt", local_dir="/checkpoints")
    snapshot_download("IDEA-Research/grounding-dino-base")
    snapshot_download("facebook/sam-vit-large")


gpu_image = (
    modal.Image.from_registry("pytorch/pytorch:2.4.0-cuda12.4-cudnn9-devel")
    .apt_install("git")
    .pip_install("pillow", "pillow-heif", "numpy", "matplotlib", "huggingface_hub",
                 "transformers==4.49.0", "timm", "fastapi[standard]")
    .pip_install("git+https://github.com/apple/ml-depth-pro.git")
    .run_function(_download_weights)
)



def load_models():
    """Load all three models onto the GPU once (they co-reside fine on an A10G)."""
    import torch
    import depth_pro
    from depth_pro.depth_pro import DEFAULT_MONODEPTH_CONFIG_DICT
    from transformers import (AutoProcessor, AutoModelForZeroShotObjectDetection,
                              SamModel, SamProcessor)

    dev = "cuda"
    cfg = DEFAULT_MONODEPTH_CONFIG_DICT
    cfg.checkpoint_uri = "/checkpoints/depth_pro.pt"
    dp, dp_transform = depth_pro.create_model_and_transforms(config=cfg, device=dev, precision=torch.half)
    dp.eval()
    gp = AutoProcessor.from_pretrained("IDEA-Research/grounding-dino-base")
    gd = AutoModelForZeroShotObjectDetection.from_pretrained("IDEA-Research/grounding-dino-base").to(dev)
    sp = SamProcessor.from_pretrained("facebook/sam-vit-large")
    sam = SamModel.from_pretrained("facebook/sam-vit-large").to(dev)
    return {"dp": dp, "dp_transform": dp_transform, "gp": gp, "gd": gd, "sp": sp, "sam": sam}


def fx_from_exif(pil):
    """EXIF 35mm-equivalent focal -> focal in pixels (diagonal convention)."""
    try:
        f35 = pil.getexif().get_ifd(0x8769).get(41989)
        if not f35:
            return None
        diag = math.hypot(*pil.size)
        return float(f35) / 43.2666 * diag
    except Exception:
        return None


def run_ingest(models, img_bytes: bytes, fpx_exif: float | None = None):
    import numpy as np
    import torch
    from PIL import Image, ImageDraw, ImageOps

    dev = "cuda"
    pil = ImageOps.exif_transpose(Image.open(io.BytesIO(img_bytes))).convert("RGB")
    W, H = pil.size
    cx, cy = W / 2.0, H / 2.0
    fpx_exif = fpx_exif or fx_from_exif(Image.open(io.BytesIO(img_bytes)))

    # ---------- metric depth ----------
    with torch.no_grad():
        f_px = torch.tensor(fpx_exif) if fpx_exif else None
        pred = models["dp"].infer(models["dp_transform"](np.asarray(pil)), f_px=f_px)
    depth = pred["depth"].detach().cpu().numpy().astype(np.float32)
    fpx = float(fpx_exif or pred["focallength_px"])

    def unproject_grid(us, vs):
        zs = depth[vs, us]
        return np.stack([(us - cx) * zs / fpx, (vs - cy) * zs / fpx, zs], axis=-1)

    # ---------- floor plane: RANSAC over low points, gravity prior = image-up ----------
    step = max(8, W // 400)
    gv, gu = np.mgrid[0:H:step, 0:W:step]
    pts = unproject_grid(gu.ravel(), gv.ravel())
    up_img = np.array([0.0, -1.0, 0.0])
    rng = np.random.default_rng(7)
    heights = pts @ up_img
    cand = pts[heights < np.quantile(heights, 0.25)]
    best_n, best_d, best_in = None, None, -1
    for _ in range(300):
        s = cand[rng.choice(len(cand), 3, replace=False)]
        n = np.cross(s[1] - s[0], s[2] - s[0])
        nn = np.linalg.norm(n)
        if nn < 1e-9:
            continue
        n = n / nn
        if n @ up_img < 0:
            n = -n
        if n @ up_img < 0.7:
            continue
        d = n @ s[0]
        inl = np.sum(np.abs(cand @ n - d) < 0.03)
        if inl > best_in:
            best_n, best_d, best_in = n, d, inl
    n, d = best_n, best_d
    inliers = cand[np.abs(cand @ n - d) < 0.03]
    c0 = inliers.mean(axis=0)
    _, _, vt = np.linalg.svd(inliers - c0)
    n = vt[2] if vt[2] @ up_img > 0 else -vt[2]
    d = n @ c0
    e1 = np.cross(n, np.array([0.0, 0.0, 1.0]))
    e1 /= np.linalg.norm(e1)
    e2 = np.cross(n, e1)
    cam_height_in = float(abs(d)) * 39.3701

    # ---------- detect ----------
    with torch.no_grad():
        gi = models["gp"](images=pil, text=DETECT_PROMPT, return_tensors="pt").to(dev)
        go = models["gd"](**gi)
    det = models["gp"].post_process_grounded_object_detection(
        go, gi.input_ids, box_threshold=0.35, text_threshold=0.3, target_sizes=[(H, W)])[0]

    boxes = det["boxes"].cpu().numpy()
    scores = det["scores"].cpu().numpy()
    labels = det["labels"]
    order = np.argsort(-scores)
    kept = []
    for i in order:
        b = boxes[i]
        dup = False
        for j in kept:
            bj = boxes[j]
            ix = max(0, min(b[2], bj[2]) - max(b[0], bj[0]))
            iy = max(0, min(b[3], bj[3]) - max(b[1], bj[1]))
            inter = ix * iy
            uni = (b[2]-b[0])*(b[3]-b[1]) + (bj[2]-bj[0])*(bj[3]-bj[1]) - inter
            if inter / max(uni, 1) > 0.6:
                dup = True
                break
        if not dup:
            kept.append(i)
    kept = kept[:12]

    # ---------- segment + measure ----------
    items = []
    for i in kept:
        box = boxes[i].tolist()
        with torch.no_grad():
            si = models["sp"](pil, input_boxes=[[box]], return_tensors="pt").to(dev)
            so = models["sam"](**si)
        mask = models["sp"].image_processor.post_process_masks(
            so.pred_masks.cpu(), si["original_sizes"].cpu(), si["reshaped_input_sizes"].cpu())[0][0]
        mask = mask[int(np.argmax(so.iou_scores[0, 0].detach().cpu().numpy()))].numpy()

        ys, xs = np.nonzero(mask[::step, ::step])
        if len(xs) < 30:
            continue
        p3 = unproject_grid(xs * step, ys * step)
        h = (p3 @ n) - d
        uv = np.stack([p3 @ e1, p3 @ e2], axis=-1)
        uvc = uv - uv.mean(axis=0)
        _, _, pvt = np.linalg.svd(uvc, full_matrices=False)
        a = uvc @ pvt.T
        lo = np.percentile(a, 2, axis=0)
        hi = np.percentile(a, 98, axis=0)
        dims_in = np.abs(hi - lo) * 39.3701
        # floor-standing items measure from the plane; only visibly wall-mounted
        # things (lowest point well off the floor) measure their own extent
        h_lo, h_hi = np.percentile(h, 2), np.percentile(h, 98)
        height_in = float(h_hi - (h_lo if h_lo * 39.3701 > 6.0 else 0.0)) * 39.3701
        z_mean = float(p3[:, 2].mean())

        view = p3.mean(axis=0)
        view /= np.linalg.norm(view)
        conf, why = [], []
        for k in range(2):
            axis3 = pvt[k, 0] * e1 + pvt[k, 1] * e2
            along = abs(float(axis3 @ view))
            c = "high" if (along < 0.45 and z_mean < 3.5) else ("medium" if along < 0.7 and z_mean < 4.5 else "low")
            conf.append(c)
            if c != "high":
                why.append(f"axis{k}: {'receding from camera' if along >= 0.45 else 'far away'}")
        label = labels[i]
        prior = PRIORS.get(label if label in PRIORS else label.split()[0] if label.split() else "")
        prior_flag = ""
        if prior and not (prior[0] * 0.6 <= max(dims_in) <= prior[1] * 1.5):
            prior_flag = f"outside prior {prior} for '{label}'"

        suggest = None
        if "low" in conf or prior_flag:
            suggest = "take one more photo standing square to this item's long side"
        if z_mean > 4.0:
            suggest = "step closer (item is far from camera) and " + (suggest or "reshoot this item")

        items.append({
            "label": label, "score": round(float(scores[i]), 2),
            "box": [round(v) for v in box],
            "dims_in": [round(float(dims_in[0]), 1), round(float(dims_in[1]), 1), round(height_in, 1)],
            "z_mean_m": round(z_mean, 2),
            "conf": conf, "why": why, "prior_flag": prior_flag, "suggest": suggest,
        })

    # ---------- overlay ----------
    ov = pil.resize((W // 4, H // 4))
    dr = ImageDraw.Draw(ov)
    palette = ["#FFD700", "#00E5FF", "#FF6EC7", "#7CFC00", "#FFA500", "#B39DFF",
               "#FF5555", "#55FFAA", "#FFFF66", "#66AAFF", "#FF99CC", "#AAFFEE"]
    for idx, it in enumerate(items):
        col = palette[idx % len(palette)]
        b = [v / 4 for v in it["box"]]
        dr.rectangle(b, outline=col, width=4)
        L, Wd, Hh = it["dims_in"]
        txt = f"{it['label']} {L:.0f}x{Wd:.0f}x{Hh:.0f}in [{'/'.join(it['conf'])}]"
        dr.text((b[0] + 4, max(2, b[1] - 14)), txt, fill=col)
    buf = io.BytesIO()
    ov.save(buf, format="JPEG", quality=88)

    return {"items": items, "camera_height_in": round(cam_height_in, 1),
            "fpx": round(fpx), "overlay": buf.getvalue()}


@app.function(gpu="A10G", image=gpu_image, timeout=1200)
def ingest(img_bytes: bytes, fpx_exif: float | None = None):
    """One-shot CLI path (loads models per call)."""
    return run_ingest(load_models(), img_bytes, fpx_exif)


@app.cls(gpu="A10G", image=gpu_image, timeout=600, scaledown_window=240,
         secrets=[modal.Secret.from_name("lvx-callback")])
class IngestService:
    """Warm web path for the Studio Lab tab: models load once per container."""

    @modal.enter()
    def setup(self):
        self.models = load_models()

    @modal.asgi_app()
    def web(self):
        # The FastAPI app is built inside the container so the Request
        # annotation resolves natively (module-level fastapi types don't
        # survive Modal's local import of this file).
        from fastapi import FastAPI, Request
        from fastapi.responses import JSONResponse

        api = FastAPI()
        service = self

        @api.post("/")
        async def ingest_route(request: Request):
            sent = (request.headers.get("x-lvx-token") or "").strip()
            want = (os.environ.get("LVX_CALLBACK_TOKEN") or "").strip()
            if not want or sent != want:
                return JSONResponse({"error": "bad token"}, status_code=403)

            img_bytes = await request.body()
            if not img_bytes or len(img_bytes) < 1000:
                return JSONResponse({"error": "no image body"}, status_code=400)
            try:
                out = run_ingest(service.models, img_bytes)
            except Exception as e:  # surface the reason to the Lab UI
                return JSONResponse({"error": f"ingest failed: {e}"}, status_code=500)
            overlay = out.pop("overlay")
            out["overlay_b64"] = "data:image/jpeg;base64," + base64.b64encode(overlay).decode()
            return JSONResponse(out)

        return api


@app.local_entrypoint()
def main(image: str, outdir: str = ".", fpx: float = 0.0):
    img_bytes = Path(image).read_bytes()
    out = ingest.remote(img_bytes, fpx or None)
    od = Path(outdir)
    od.mkdir(parents=True, exist_ok=True)
    (od / "ingest_overlay.jpg").write_bytes(out.pop("overlay"))
    (od / "ingest_items.json").write_text(json.dumps(out, indent=2))
    print(f"camera height {out['camera_height_in']}in | fx {out['fpx']}")
    for it in out["items"]:
        L, Wd, Hh = it["dims_in"]
        flag = f"  !! {it['prior_flag']}" if it["prior_flag"] else ""
        sug = f"  -> {it['suggest']}" if it["suggest"] else ""
        print(f"  {it['label']:16s} {L:6.1f} x {Wd:5.1f} x {Hh:5.1f} in  z={it['z_mean_m']}m  conf={'/'.join(it['conf'])}{flag}{sug}")
    print(f"\nsaved {od / 'ingest_overlay.jpg'}\nsaved {od / 'ingest_items.json'}")
