import { readDjiMeta } from "./exif-gps.mjs";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
const dir = "C:/Users/jus24/Videos/Maria Real Estate/Scottsdale House";
const base = "C:/Users/jus24/dev/scottsdale-base-test-base.jpg";
const g = JSON.parse(fs.readFileSync("C:/Users/jus24/dev/scottsdale-base-test.plan.json", "utf8")).sheets[0].geo;
const jpgs = fs.readdirSync(dir).filter((f) => /\.jpe?g$/i.test(f)).sort();
const m0 = await sharp(base).metadata();
const W = m0.width, H = m0.height;
const x = (lon) => ((lon - g.minLon) / (g.maxLon - g.minLon)) * W;
const y = (lat) => ((g.maxLat - lat) / (g.maxLat - g.minLat)) * H;
let svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">`;
let n = 0;
for (const f of jpgs) {
  const m = readDjiMeta(path.join(dir, f));
  if (m.lat == null) continue;
  const interior = m.relAlt != null && m.relAlt < 10;
  const px = x(m.lon).toFixed(1), py = y(m.lat).toFixed(1);
  const col = interior ? "#39ff88" : "#ff9a3c";
  const lbl = interior ? String(++n) : "H";
  svg += `<circle cx="${px}" cy="${py}" r="15" fill="${col}" fill-opacity="0.6" stroke="#0a0a0a" stroke-width="2.5"/>`;
  svg += `<text x="${px}" y="${(parseFloat(py) + 6).toFixed(1)}" font-size="19" font-family="sans-serif" font-weight="bold" fill="#0a0a0a" text-anchor="middle">${lbl}</text>`;
  console.log(`${interior ? "room " + n : "HIGH "}  ${f}  AGL ${m.relAlt}m  -> (${px}, ${py})`);
}
svg += `</svg>`;
await sharp(base).composite([{ input: Buffer.from(svg) }]).jpeg({ quality: 88 }).toFile("C:/Users/jus24/dev/scottsdale-capture-map.jpg");
console.log(`placed ${n} interior room scan-points + the high overviews on the base`);