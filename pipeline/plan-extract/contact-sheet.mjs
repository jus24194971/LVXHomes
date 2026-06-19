#!/usr/bin/env node
/**
 * Contact sheet of the fused photo at chosen rotations (+mirror), labeled, so Justin can
 * pick the orientation with bonus-left / living-center / master-right across the top.
 *   node contact-sheet.mjs <fused.jpg> [flip=1] [angles=csv]  -> _contact.png
 */
import path from "node:path";
import sharp from "sharp";

const photoPath = process.argv[2] || "_fused.jpg";
const FLIP = (process.argv[3] || "1") === "1";
const angles = (process.argv[4] ? process.argv[4].split(",").map(Number) : [0, 45, 90, 135, 180, 225, 270, 315]);
const TILE = 300, BG = { r: 18, g: 18, b: 18 };
const COLS = Math.min(angles.length, 3), ROWS = Math.ceil(angles.length / COLS);

const tiles = [];
for (const a of angles) {
  let r = sharp(photoPath).rotate(a, { background: BG });
  if (FLIP) r = r.flop();
  tiles.push({ a, buf: await r.resize(TILE, TILE, { fit: "contain", background: BG }).png().toBuffer() });
}

const W = COLS * TILE, H = ROWS * TILE;
const comp = tiles.map((t, i) => ({ input: t.buf, left: (i % COLS) * TILE, top: Math.floor(i / COLS) * TILE }));
let svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">`;
tiles.forEach((t, i) => {
  const x = (i % COLS) * TILE + 10, y = Math.floor(i / COLS) * TILE + 30;
  svg += `<rect x="${x - 7}" y="${y - 24}" width="74" height="32" fill="#000" opacity="0.6" rx="5"/>`;
  svg += `<text x="${x}" y="${y}" fill="#ffea00" font-size="24" font-family="sans-serif" font-weight="bold">${t.a}°</text>`;
});
svg += `</svg>`;
comp.push({ input: Buffer.from(svg), left: 0, top: 0 });

await sharp({ create: { width: W, height: H, channels: 3, background: BG } }).composite(comp).png().toFile(path.join(path.dirname(photoPath), "_contact.png"));
console.log(`contact -> _contact.png  (${angles.join(",")}, flip ${FLIP})`);
