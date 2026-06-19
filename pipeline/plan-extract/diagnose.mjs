#!/usr/bin/env node
/** Diagnostic: RAW overview + flight path + kitchen anchored at flight-start + where the
 *  localization actually dropped each room. Read it: is each dot on its objects? */
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

const dir = "C:/Users/jus24/dev/lvx-homes/pipeline/plan-extract";
const { ftw, fth, flight } = JSON.parse(fs.readFileSync(dir + "/_rooms.json", "utf8"));
const loc = JSON.parse(fs.readFileSync(dir + "/_localize.json", "utf8"));
const names = { "0009": "KITCHEN", "0010": "LIVING", "0011": "GUEST BATH", "0012": "BONUS", "0013": "MASTER BED", "0014": "MASTER BATH" };
const cols = { KITCHEN: "#5c9bff", LIVING: "#5cff8f", "GUEST BATH": "#ffd24d", BONUS: "#ff5c5c", "MASTER BED": "#d98cff", "MASTER BATH": "#4dd9d9" };

const photo = dir + "/_overview_hd.jpg", meta = await sharp(photo).metadata();
const W = meta.width, H = meta.height, X = (x) => (x / ftw * W).toFixed(1), Y = (y) => (y / fth * H).toFixed(1);
let svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">`;
svg += `<polyline points="${flight.map((p) => `${X(p[0])},${Y(p[1])}`).join(" ")}" fill="none" stroke="#ffcc22" stroke-width="3" opacity="0.85"/>`;
const s = flight[0], e = flight[flight.length - 1];
svg += `<circle cx="${X(s[0])}" cy="${Y(s[1])}" r="14" fill="#39ff88" stroke="#000" stroke-width="2"/>`;
svg += `<text x="${X(s[0])}" y="${Y(s[1]) - 18}" text-anchor="middle" font-size="22" fill="#39ff88" font-family="sans-serif" font-weight="bold">START = KITCHEN</text>`;
svg += `<circle cx="${X(e[0])}" cy="${Y(e[1])}" r="10" fill="#ff5555" stroke="#000" stroke-width="2"/>`;
for (const id of Object.keys(names)) {
  if (!loc[id]) continue;
  const [px, py] = loc[id].feet, c = cols[names[id]];
  svg += `<circle cx="${X(px)}" cy="${Y(py)}" r="12" fill="${c}" stroke="#000" stroke-width="2"/>`;
  svg += `<rect x="${X(px) - 70}" y="${Y(py) + 14}" width="140" height="24" fill="#000" opacity="0.62" rx="3"/>`;
  svg += `<text x="${X(px)}" y="${Y(py) + 31}" text-anchor="middle" font-size="17" fill="${c}" font-family="sans-serif" font-weight="bold">${names[id]} (${loc[id].matches})</text>`;
}
svg += `</svg>`;
await sharp(photo).composite([{ input: Buffer.from(svg) }]).resize(1000).png().toFile(dir + "/_diagnose.png");
console.log("diagnose -> _diagnose.png  (RAW overview · flight · green=kitchen@start · dots=localized rooms w/ match counts)");
