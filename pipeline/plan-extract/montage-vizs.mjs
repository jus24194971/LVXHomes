#!/usr/bin/env node
/** Montage the 6 still HorizonNet detection overlays (_viz_*.png), labeled by room. */
import path from "node:path";
import sharp from "sharp";

const rooms = { "0009": "Kitchen", "0010": "Living", "0011": "Guest Bath", "0012": "Bonus", "0013": "Master Bed", "0014": "Master Bath" };
const ids = Object.keys(rooms);
const dir = "C:/Users/jus24/dev/lvx-homes/pipeline/plan-extract";
const TW = 520, TH = 260, COLS = 2;

const tiles = [];
for (const id of ids) {
  try { tiles.push({ id, buf: await sharp(path.join(dir, `_viz_${id}.png`)).resize(TW, TH, { fit: "fill" }).png().toBuffer() }); }
  catch { tiles.push({ id, buf: null }); }
}
const ROWS = Math.ceil(ids.length / COLS), W = COLS * TW, H = ROWS * TH;
const comp = tiles.filter((t) => t.buf).map((t) => ({ input: t.buf, left: (ids.indexOf(t.id) % COLS) * TW, top: Math.floor(ids.indexOf(t.id) / COLS) * TH }));
let svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">`;
ids.forEach((id, i) => {
  const x = (i % COLS) * TW + 8, y = Math.floor(i / COLS) * TH + 26;
  svg += `<rect x="${x - 6}" y="${y - 20}" width="230" height="28" fill="#000" opacity="0.62" rx="4"/>`;
  svg += `<text x="${x}" y="${y}" fill="#39ff88" font-size="19" font-family="sans-serif" font-weight="bold">${id} · ${rooms[id]}</text>`;
});
svg += `</svg>`;
comp.push({ input: Buffer.from(svg), left: 0, top: 0 });
await sharp({ create: { width: W, height: H, channels: 3, background: { r: 20, g: 20, b: 20 } } }).composite(comp).jpeg({ quality: 82 }).toFile(path.join(dir, "_vizs_montage.jpg"));
console.log("montage -> _vizs_montage.jpg");
