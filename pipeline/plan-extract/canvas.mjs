#!/usr/bin/env node
/**
 * Clean identification canvas: fused photo in display orientation (rotate + mirror),
 * with a faint flight path + kitchen start/end markers. For Justin to mark rooms on.
 *
 *   node canvas.mjs <rooms.json> <fused.jpg> [rotDeg=32] [flip=1]  -> _canvas.png
 */
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

const roomsPath = process.argv[2] || "_rooms.json";
const photoPath = process.argv[3] || "_fused.jpg";
const ROT = parseFloat(process.argv[4] || "32");
const FLIP = (process.argv[5] || "1") === "1";

const { ftw, fth, flight } = JSON.parse(fs.readFileSync(roomsPath, "utf8"));
const meta = await sharp(photoPath).metadata();
const SC = 1000 / meta.width, PW = Math.round(meta.width * SC), PH = Math.round(meta.height * SC);
const X = (x) => (x / ftw * PW).toFixed(1), Y = (y) => (y / fth * PH).toFixed(1);

let svg = `<svg width="${PW}" height="${PH}" xmlns="http://www.w3.org/2000/svg">`;
svg += `<polyline points="${flight.map((p) => `${X(p[0])},${Y(p[1])}`).join(" ")}" fill="none" stroke="#ffffff" stroke-width="2" opacity="0.45"/>`;
const s = flight[0], e = flight[flight.length - 1];
svg += `<circle cx="${X(s[0])}" cy="${Y(s[1])}" r="8" fill="#39ff88" stroke="#000" stroke-width="1.5"/>`;
svg += `<circle cx="${X(e[0])}" cy="${Y(e[1])}" r="8" fill="#ff5555" stroke="#000" stroke-width="1.5"/>`;
svg += `</svg>`;

const composited = await sharp(photoPath).resize(PW, PH).composite([{ input: Buffer.from(svg) }]).png().toBuffer();
let v = sharp(composited);
if (ROT) v = v.rotate(ROT, { background: { r: 12, g: 12, b: 12 } });
if (FLIP) v = v.flop();
await v.png().toFile(path.join(path.dirname(roomsPath), "_canvas.png"));
console.log(`canvas -> _canvas.png  (rot ${ROT}, flip ${FLIP})  · green dot = flight start (kitchen), red = end (kitchen/door)`);
