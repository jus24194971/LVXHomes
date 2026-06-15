#!/usr/bin/env node
/**
 * make-mask — generate the SLAM mask image (8-bit, white = use, black = ignore)
 * that hides the drone body/props at the nadir so ORB/PatchMatch don't lock onto
 * them. stella_vslam_dense takes it via `--mask`.
 *
 *   node make-mask.mjs <width> <height> [out.png] [nadirFrac] [zenithFrac]
 *   e.g. node make-mask.mjs 3840 1920 mask.png 0.14 0.03
 *
 * Open one exported frame, see how far up the aircraft reaches, and bump
 * nadirFrac until it's fully covered. Needs `sharp` (run from the lvx-homes repo).
 */
import sharp from "sharp";

const W = parseInt(process.argv[2] || "3840", 10);
const H = parseInt(process.argv[3] || "1920", 10);
const out = process.argv[4] || "mask.png";
const nadir = Math.round(H * parseFloat(process.argv[5] || "0.14")); // bottom band (drone body)
const zenith = Math.round(H * parseFloat(process.argv[6] || "0.03")); // thin top band (stitch smear)

const svg =
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">` +
  `<rect width="100%" height="100%" fill="white"/>` +
  `<rect x="0" y="${H - nadir}" width="${W}" height="${nadir}" fill="black"/>` +
  `<rect x="0" y="0" width="${W}" height="${zenith}" fill="black"/>` +
  `</svg>`;

await sharp(Buffer.from(svg)).grayscale().png().toFile(out);
console.log(`mask ${W}×${H} → ${out}  (nadir ${nadir}px + zenith ${zenith}px masked)`);
