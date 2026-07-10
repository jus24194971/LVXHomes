"""Single-photo furniture metrology experiment — "no-measurement dims" layer test.

Test case #1: Justin's sectional, PXL_20260710_225911586.jpg (Pixel 10 Pro XL,
8160x6144, EXIF 6.9mm / 24mm-equiv). Bosch GLM ground truth:
  long side 127.47in, short side 89.0in, back height 41.63in.

Two metric monocular depth models run on the same photo; hand-picked pixel
pairs are unprojected through the camera intrinsics and compared against the
laser. Heights come from a fitted floor plane so points with hidden floor
contact (couch back) are still measurable.

  modal run pipeline/cloud/metrology_experiment.py --image "C:\\...\\PXL_20260710_225911586.jpg" --outdir "C:\\...\\scratchpad"
"""

import io
import json
from pathlib import Path

import modal

app = modal.App("lvx-metrology")

# fx from EXIF: 35mm-equiv focal maps by diagonal. diag_px = sqrt(8160^2+6144^2)
# = 10214, f_px = 24 / 43.267 * 10214 = 5666. Cross-check via real focal:
# 6.9mm on a 12.44mm-diagonal sensor (crop 3.478) gives the same ~5660.
FPX_EXIF = 5666.0

# Measurement pairs, full-res pixel coords. truth_in = Bosch laser (None = pending).
# "in1"/"in2" = unit direction pointing INTO the object from a silhouette point;
# the sampler probes along it and keeps the nearest surface, so the depth window
# never mixes object with background wall (which poisoned v1 at the couch back).
PAIRS = [
    {"name": "couch_long_side", "p1": (4230, 2100), "p2": (7388, 3564), "truth_in": 127.47,
     "in1": (0, 1), "in2": (-0.6, 0.8),
     "note": "L-junction back top -> right arm outer-back top corner"},
    {"name": "couch_short_side", "p1": (4230, 2100), "p2": (802, 2763), "truth_in": 89.0,
     "in1": (0, 1), "in2": (0.5, 0.85),
     "note": "L-junction back top -> left arm outer-back top corner"},
    {"name": "left_arm_height", "p1": (1180, 3172), "p2": (1175, 4075), "truth_in": None,
     "in1": (0, 1),
     "note": "left arm front-top corner -> its base at rug (laser pending)"},
    {"name": "right_arm_height", "p1": (7234, 3971), "p2": (6970, 5247), "truth_in": None,
     "in1": (-0.5, 0.9),
     "note": "right arm front-top corner -> its base at rug (laser pending)"},
    {"name": "zebra_box_length", "p1": (3430, 4452), "p2": (4250, 4505), "truth_in": 11.25,
     "note": "Little Debbie 10ct box, assumed 11.25 +/- 0.25"},
    {"name": "door_handle_height", "p1": (165, 2346), "p2": (132, 3714), "truth_in": 36.0,
     "note": "lever center -> door bottom; 36in is typical install, not laser"},
    {"name": "table_length", "p1": (1856, 5027), "p2": (3660, 5040), "truth_in": None,
     "in1": (0.7, -0.5), "in2": (-0.6, -0.8),
     "note": "coffee table front edge; Claude predicted 48 (laser pending)"},
    {"name": "table_width", "p1": (3660, 5040), "p2": (4485, 4155), "truth_in": None,
     "in1": (-0.6, -0.8), "in2": (-0.7, 0.7),
     "note": "coffee table right edge; Claude predicted 24 (laser pending)"},
]

# Visible floor points for the plane fit (planks left side, rug adds ~0.6in).
FLOOR_PTS = [
    {"p": (608, 3865), "kind": "plank"},
    {"p": (765, 4495), "kind": "plank"},
    {"p": (612, 5651), "kind": "plank"},
    {"p": (245, 4814), "kind": "plank"},
    {"p": (3672, 6038), "kind": "rug"},
    {"p": (6528, 5304), "kind": "rug"},
]

# Points whose HEIGHT above the floor plane we want (floor contact hidden).
PLANE_QUERIES = [
    {"name": "back_height_at_corner", "p": (4230, 2100), "truth_in": 41.63, "in": (0, 1),
     "note": "couch back top at the L-junction; Bosch says 3ft 5-5/8in"},
    {"name": "table_top_height", "p": (3660, 5040), "truth_in": None, "in": (-0.6, -0.8),
     "note": "coffee table front-right corner; Claude predicted 18 (laser pending)"},
    {"name": "right_arm_top_height", "p": (7234, 3971), "truth_in": None, "in": (-0.5, 0.9),
     "note": "right arm top via plane (vs direct pair above)"},
]


def _download_weights():
    from huggingface_hub import hf_hub_download, snapshot_download
    hf_hub_download("apple/DepthPro", "depth_pro.pt", local_dir="/checkpoints")
    snapshot_download("depth-anything/Depth-Anything-V2-Metric-Indoor-Large-hf")


gpu_image = (
    modal.Image.from_registry("pytorch/pytorch:2.4.0-cuda12.4-cudnn9-devel")
    .apt_install("git")
    .pip_install("pillow", "pillow-heif", "numpy", "matplotlib", "huggingface_hub",
                 "transformers>=4.45", "timm")
    .pip_install("git+https://github.com/apple/ml-depth-pro.git")
    .run_function(_download_weights)
)


@app.function(gpu="A10G", image=gpu_image, timeout=1200)
def measure(img_bytes: bytes, fpx_exif: float, pairs: list, floor_pts: list, plane_queries: list):
    import numpy as np
    import torch
    from PIL import Image, ImageDraw

    dev = "cuda"
    path = "/tmp/in.jpg"
    Path(path).write_bytes(img_bytes)
    pil = Image.open(path).convert("RGB")
    W, H = pil.size
    cx, cy = W / 2.0, H / 2.0

    def depth_at(dm, u, v, k=9):
        y0, y1 = max(0, v - k), min(dm.shape[0], v + k + 1)
        x0, x1 = max(0, u - k), min(dm.shape[1], u + k + 1)
        return float(np.median(dm[y0:y1, x0:x1]))

    def depth_at_edge(dm, u, v, into, step=22):
        # silhouette point: probe into the object, keep the nearest surface so
        # the window never averages object depth with the wall behind it
        cands = []
        for t in (0, 1, 2):
            uu, vv = int(u + into[0] * step * t), int(v + into[1] * step * t)
            cands.append(depth_at(dm, uu, vv, k=7))
        return min(cands)

    def unproject(dm, fpx, u, v, into=None):
        z = depth_at_edge(dm, u, v, into) if into else depth_at(dm, u, v)
        return np.array([(u - cx) * z / fpx, (v - cy) * z / fpx, z])

    def fit_plane(pts3):
        c = pts3.mean(axis=0)
        _, _, vt = np.linalg.svd(pts3 - c)
        n = vt[2]
        if n @ c > 0:  # normal toward the camera (camera at origin looks +Z)
            n = -n
        resid = np.abs((pts3 - c) @ n)
        return n, c, float(resid.max())

    def evaluate(dm, fpx, tag):
        out = {"tag": tag, "fpx": float(fpx), "pairs": {}, "floor": {}, "heights": {}}
        for pr in pairs:
            a = unproject(dm, fpx, *pr["p1"], into=pr.get("in1"))
            b = unproject(dm, fpx, *pr["p2"], into=pr.get("in2"))
            dist_in = float(np.linalg.norm(a - b)) * 39.3701
            out["pairs"][pr["name"]] = {
                "inches": round(dist_in, 1),
                "z1_m": round(float(a[2]), 2), "z2_m": round(float(b[2]), 2),
            }
        pts3 = np.array([unproject(dm, fpx, *fp["p"]) for fp in floor_pts])
        n, c, rmax = fit_plane(pts3)
        out["floor"] = {"max_resid_in": round(rmax * 39.3701, 1)}
        for q in plane_queries:
            p3 = unproject(dm, fpx, *q["p"], into=q.get("in"))
            h_in = float(abs((p3 - c) @ n)) * 39.3701
            out["heights"][q["name"]] = round(h_in, 1)
        return out

    results, previews = [], {}

    # ---- Depth Pro (run with model-estimated focal AND with EXIF focal) ----
    import depth_pro
    from depth_pro.depth_pro import DEFAULT_MONODEPTH_CONFIG_DICT
    cfg = DEFAULT_MONODEPTH_CONFIG_DICT
    cfg.checkpoint_uri = "/checkpoints/depth_pro.pt"
    model, transform = depth_pro.create_model_and_transforms(config=cfg, device=dev, precision=torch.half)
    model.eval()
    img_np = np.asarray(pil)
    with torch.no_grad():
        pred = model.infer(transform(img_np))  # focal estimated by the model
        dp_depth = pred["depth"].detach().cpu().numpy().astype(np.float32)
        dp_fpx = float(pred["focallength_px"])
        pred2 = model.infer(transform(img_np), f_px=torch.tensor(fpx_exif))
        dp_depth_exif = pred2["depth"].detach().cpu().numpy().astype(np.float32)
    results.append(evaluate(dp_depth, dp_fpx, "depth_pro_selffocal"))
    results.append(evaluate(dp_depth_exif, fpx_exif, "depth_pro_exiffocal"))

    # ---- Depth Anything V2 metric indoor ----
    from transformers import AutoImageProcessor, AutoModelForDepthEstimation
    name = "depth-anything/Depth-Anything-V2-Metric-Indoor-Large-hf"
    proc = AutoImageProcessor.from_pretrained(name)
    da = AutoModelForDepthEstimation.from_pretrained(name, torch_dtype=torch.float16).to(dev)
    with torch.no_grad():
        inputs = proc(images=pil, return_tensors="pt").to(dev, torch.float16)
        da_out = da(**inputs).predicted_depth[0]
        da_depth = torch.nn.functional.interpolate(
            da_out[None, None].float(), size=(H, W), mode="bicubic", align_corners=False
        )[0, 0].cpu().numpy().astype(np.float32)
    results.append(evaluate(da_depth, fpx_exif, "dav2_metric_exiffocal"))

    # ---- previews: colorized depth + point overlay ----
    import matplotlib.cm as cm
    for tag, dm in [("depth_pro", dp_depth), ("dav2", da_depth)]:
        small = np.asarray(Image.fromarray(dm).resize((W // 6, H // 6)))
        norm = (small - small.min()) / max(1e-6, small.max() - small.min())
        rgb = (cm.turbo(norm)[..., :3] * 255).astype(np.uint8)
        buf = io.BytesIO()
        Image.fromarray(rgb).save(buf, format="JPEG", quality=88)
        previews[f"depth_{tag}.jpg"] = buf.getvalue()

    ov = pil.resize((W // 4, H // 4))
    dr = ImageDraw.Draw(ov)
    def mark(p, color, label):
        x, y = p[0] / 4, p[1] / 4
        dr.ellipse([x - 10, y - 10, x + 10, y + 10], outline=color, width=4)
        dr.text((x + 12, y - 8), label, fill=color)
    for i, pr in enumerate(pairs):
        dr.line([tuple(v / 4 for v in pr["p1"]), tuple(v / 4 for v in pr["p2"])], fill="#FFD700", width=3)
        mark(pr["p1"], "#FFD700", pr["name"])
        mark(pr["p2"], "#FFD700", "")
    for fp in floor_pts:
        mark(fp["p"], "#00FF66", fp["kind"])
    for q in plane_queries:
        mark(q["p"], "#FF4444", q["name"])
    buf = io.BytesIO()
    ov.save(buf, format="JPEG", quality=88)
    previews["points_overlay.jpg"] = buf.getvalue()

    return {"results": results, "previews": previews, "dp_estimated_fpx": dp_fpx}


@app.local_entrypoint()
def main(image: str, outdir: str = "."):
    img_bytes = Path(image).read_bytes()
    out = measure.remote(img_bytes, FPX_EXIF, PAIRS, FLOOR_PTS, PLANE_QUERIES)

    od = Path(outdir)
    od.mkdir(parents=True, exist_ok=True)
    for fname, data in out["previews"].items():
        (od / fname).write_bytes(data)
        print(f"saved {od / fname}")

    print(f"\nEXIF fx = {FPX_EXIF:.0f} px | Depth Pro self-estimated fx = {out['dp_estimated_fpx']:.0f} px\n")
    truth_pairs = {p["name"]: p["truth_in"] for p in PAIRS}
    truth_q = {q["name"]: q["truth_in"] for q in PLANE_QUERIES}
    for res in out["results"]:
        print(f"=== {res['tag']} (fx={res['fpx']:.0f}) | floor-plane max resid {res['floor']['max_resid_in']}in ===")
        for name, r in res["pairs"].items():
            t = truth_pairs.get(name)
            err = f"  err {100 * (r['inches'] - t) / t:+.1f}%" if t else "  (truth pending)"
            print(f"  {name:24s} {r['inches']:7.1f} in   truth {t or '?':>7}{err}   z {r['z1_m']}-{r['z2_m']}m")
        for name, h in res["heights"].items():
            t = truth_q.get(name)
            err = f"  err {100 * (h - t) / t:+.1f}%" if t else "  (truth pending)"
            print(f"  {name:24s} {h:7.1f} in   truth {t or '?':>7}{err}   (via floor plane)")
        print()
    (od / "metrology_results.json").write_text(json.dumps(out["results"], indent=2))
    print(f"saved {od / 'metrology_results.json'}")
