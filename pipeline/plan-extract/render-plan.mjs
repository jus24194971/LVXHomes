#!/usr/bin/env node
/**
 * Quick visual proof of a fused plan — draw the room polygons (and optionally the
 * aerial base under them) to a PNG so we can eyeball placement/shape/orientation.
 *
 *   node render-plan.mjs <plan.json> <out.png> [--scale 14] [--base base.png]
 */
import fs from "node:fs";
import sharp from "sharp";

const A = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const planPath = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "plan.json";
const outPath = process.argv[3] && !process.argv[3].startsWith("--") ? process.argv[3] : "plan-preview.png";
const S = parseFloat(A("scale", "14"));          // px per foot
const basePath = A("base", null);

const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
const sheet = plan.sheets[0];
const W = Math.round(sheet.width * S), H = Math.round(sheet.height * S);
const palette = ["#c0a062", "#6ea3c0", "#c06e8f", "#7fc06e", "#a66ec0", "#c0986e", "#6ec0b3", "#b9c06e", "#c07e6e", "#6e86c0"];

let g = "";
sheet.zones.forEach((z, i) => {
  const pts = z.points.map(([x, y]) => `${(x * S).toFixed(1)},${(y * S).toFixed(1)}`).join(" ");
  const c = palette[i % palette.length];
  g += `<polygon points="${pts}" fill="${c}" fill-opacity="0.28" stroke="${c}" stroke-width="2.5" stroke-linejoin="round"/>`;
  const cx = (z.points.reduce((a, p) => a + p[0], 0) / z.points.length * S).toFixed(1);
  const cy = (z.points.reduce((a, p) => a + p[1], 0) / z.points.length * S).toFixed(1);
  g += `<circle cx="${cx}" cy="${cy}" r="10" fill="#1a1a1a" fill-opacity="0.78"/>`;
  g += `<text x="${cx}" y="${(parseFloat(cy) + 4).toFixed(1)}" font-size="13" fill="#fff" text-anchor="middle" font-family="sans-serif" font-weight="700">${i + 1}</text>`;
});

const overlay = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${g}</svg>`;

if (basePath && fs.existsSync(basePath)) {
  const base = await sharp(basePath).resize(W, H, { fit: "fill" }).toBuffer();
  await sharp(base).composite([{ input: Buffer.from(overlay) }]).png().toFile(outPath);
  console.log(`rendered ${sheet.zones.length} zones over base · ${W}x${H}px (${sheet.width}x${sheet.height}ft @ ${S}px/ft) -> ${outPath}`);
} else {
  const full = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#faf8f4"/>${g}</svg>`;
  await sharp(Buffer.from(full)).png().toFile(outPath);
  console.log(`rendered ${sheet.zones.length} zones · ${W}x${H}px (${sheet.width}x${sheet.height}ft @ ${S}px/ft) -> ${outPath}`);
}
