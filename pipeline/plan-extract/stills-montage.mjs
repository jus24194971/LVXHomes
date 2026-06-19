#!/usr/bin/env node
/**
 * Pull the 6 interior-1112 stills' XMP attitude + build a labeled montage so each
 * 360 still can be matched to its room. -> _stills_montage.jpg + _stills.json
 */
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

const dir = "C:/Users/jus24/Videos/The George 360/Interior 1112";
const out = "C:/Users/jus24/dev/lvx-homes/pipeline/plan-extract";
const files = fs.readdirSync(dir).filter((f) => /_\d{4}_D\.JPG$/i.test(f)).sort();

const TW = 760, TH = 380, COLS = 2;
const manifest = [], tiles = [];
for (const f of files) {
  const full = path.join(dir, f);
  const s = fs.readFileSync(full, "latin1");
  const get = (k) => { const m = s.match(new RegExp(`drone-dji:${k}="([^"]+)"`)); return m ? m[1] : null; };
  const id = f.match(/_(\d{4})_D/)[1];
  manifest.push({ id, gimbalYaw: get("GimbalYawDegree"), flightYaw: get("FlightYawDegree"), relAlt: get("RelativeAltitude"), imu: get("ImuDataValue") });
  tiles.push({ id, buf: await sharp(full, { limitInputPixels: 300000000 }).resize(TW, TH, { fit: "fill" }).jpeg({ quality: 78 }).toBuffer() });
}

const ROWS = Math.ceil(tiles.length / COLS), W = COLS * TW, H = ROWS * TH;
const comp = tiles.map((t, i) => ({ input: t.buf, left: (i % COLS) * TW, top: Math.floor(i / COLS) * TH }));
let svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">`;
tiles.forEach((t, i) => {
  const x = (i % COLS) * TW + 10, y = Math.floor(i / COLS) * TH + 30;
  svg += `<rect x="${x - 7}" y="${y - 24}" width="220" height="32" fill="#000" opacity="0.62" rx="4"/>`;
  svg += `<text x="${x}" y="${y}" fill="#ffea00" font-size="22" font-family="sans-serif" font-weight="bold">${t.id} · yaw ${manifest[i].gimbalYaw}°</text>`;
});
svg += `</svg>`;
comp.push({ input: Buffer.from(svg), left: 0, top: 0 });
await sharp({ create: { width: W, height: H, channels: 3, background: { r: 0, g: 0, b: 0 } } }).composite(comp).jpeg({ quality: 80 }).toFile(path.join(out, "_stills_montage.jpg"));
fs.writeFileSync(path.join(out, "_stills.json"), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify(manifest, null, 1));
