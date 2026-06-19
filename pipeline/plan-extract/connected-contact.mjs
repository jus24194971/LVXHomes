#!/usr/bin/env node
/** Contact sheet of the connected grid at 8 orientations (gridRot × flip) over the photo,
 *  so we can pick the one whose colored rooms land on the real rooms.
 *  legend: bonus=red guest=yellow living=green kitchen=blue master=purple mbath=cyan */
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

const dir = "C:/Users/jus24/dev/lvx-homes/pipeline/plan-extract";
const CEIL = 9, ROT = 300, FLIP = 1;
const { ftw, fth } = JSON.parse(fs.readFileSync(dir + "/_rooms.json", "utf8"));
const size = (id) => {
  const L = JSON.parse(fs.readFileSync(`${dir}/_layout_${id}.json`, "utf8"));
  const z0 = L.z0, z1 = Math.abs(L.z1), camH = CEIL * z1 / (z0 + z1);
  const f = L.uv.filter((_, i) => i % 2 === 1).map(([u, v]) => { const lon = (u - 0.5) * 2 * Math.PI, lat = (0.5 - v) * Math.PI, d = camH / Math.tan(Math.abs(lat)); return [Math.sin(lon) * d, Math.cos(lon) * d]; });
  const xs = f.map((p) => p[0]), ys = f.map((p) => p[1]);
  return { w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
};
const R = { kitchen: size("0009"), living: size("0010"), guest: size("0011"), bonus: size("0012"), master: size("0013"), mbath: size("0014") };
const openW = Math.max(R.kitchen.w, R.living.w), openH = Math.max(R.kitchen.h, R.living.h);
const leftW = Math.max(R.bonus.w, R.guest.w), rightW = Math.max(R.master.w, R.mbath.w);
const livH = openH * R.living.h / (R.living.h + R.kitchen.h);
const cells = [
  [0, 0, leftW, R.bonus.h], [0, R.bonus.h, leftW, R.guest.h],
  [leftW, 0, openW, livH], [leftW, livH, openW, openH - livH],
  [leftW + openW, 0, rightW, R.master.h], [leftW + openW, R.master.h, rightW, R.mbath.h],
];
const totW = leftW + openW + rightW, totH = openH;
const cols = ["#ff5c5c", "#ffd24d", "#5cff8f", "#5c9bff", "#d98cff", "#4dd9d9"];

const photo = dir + "/_fused.jpg", meta = await sharp(photo).metadata();
const W = meta.width, Hh = meta.height, X = (x) => (x / ftw * W).toFixed(1), Y = (y) => (y / fth * Hh).toFixed(1);
async function render(gr, gf) {
  const r = gr * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
  const place = ([x, y]) => { let lx = x - totW / 2, ly = y - totH / 2; if (gf) lx = -lx; return [ftw / 2 + lx * c - ly * s, fth / 2 + lx * s + ly * c]; };
  let svg = `<svg width="${W}" height="${Hh}" xmlns="http://www.w3.org/2000/svg">`;
  cells.forEach(([x, y, w, h], i) => { const pts = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]].map(place); svg += `<polygon points="${pts.map((p) => `${X(p[0])},${Y(p[1])}`).join(" ")}" fill="${cols[i]}" fill-opacity="0.42" stroke="${cols[i]}" stroke-width="4"/>`; });
  svg += `</svg>`;
  let v = sharp(await sharp(photo).composite([{ input: Buffer.from(svg) }]).png().toBuffer());
  if (ROT) v = v.rotate(ROT, { background: { r: 18, g: 18, b: 18 } });
  if (FLIP) v = v.flop();
  return v.resize(310, 310, { fit: "contain", background: { r: 18, g: 18, b: 18 } }).png().toBuffer();
}

const combos = []; for (const gr of [27.5, 117.5, 207.5, 297.5]) for (const gf of [0, 1]) combos.push([gr, gf]);
const tiles = []; for (const [gr, gf] of combos) tiles.push({ gr, gf, buf: await render(gr, gf) });
const TILE = 310, COLS = 4, ROWS = 2, Wc = COLS * TILE, Hc = ROWS * TILE;
const comp = tiles.map((t, i) => ({ input: t.buf, left: (i % COLS) * TILE, top: Math.floor(i / COLS) * TILE }));
let lsvg = `<svg width="${Wc}" height="${Hc}" xmlns="http://www.w3.org/2000/svg">`;
tiles.forEach((t, i) => { const x = (i % COLS) * TILE + 8, y = Math.floor(i / COLS) * TILE + 24; lsvg += `<rect x="${x - 6}" y="${y - 18}" width="120" height="26" fill="#000" opacity="0.62" rx="4"/><text x="${x}" y="${y}" fill="#ffea00" font-size="17" font-family="sans-serif" font-weight="bold">${t.gr}° f${t.gf}</text>`; });
lsvg += `</svg>`;
comp.push({ input: Buffer.from(lsvg), left: 0, top: 0 });
await sharp({ create: { width: Wc, height: Hc, channels: 3, background: { r: 18, g: 18, b: 18 } } }).composite(comp).png().toFile(dir + "/_connected_contact.png");
console.log("legend: bonus=RED guest=YELLOW living=GREEN kitchen=BLUE master=PURPLE mbath=CYAN");
console.log("target: master(purple)=right · bonus(red)=upper-center · master-bath(cyan)=lower-left  -> _connected_contact.png");
