#!/usr/bin/env node
/**
 * sat-tiles — stitch an Esri World Imagery satellite of the whole LOT (wider than the
 * drone aerial) and georeference it into the plan frame as a base LAYER. Gives the
 * zoomed-out hybrid: drone aerial for house detail, satellite for the surrounding lot.
 * No API key (Esri World Imagery tiles are public).
 *
 *   node sat-tiles.mjs <plan.json> [--zoom 20] [--expand 3] [--out sat.jpg]
 */
import fs from "node:fs";
import sharp from "sharp";

const A = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const plan = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const sheet = plan.sheets.find((s) => s.geo) ?? plan.sheets[0];
const g = sheet.geo;
if (!g) { console.error("plan sheet has no geo bbox"); process.exit(1); }
const Z = parseInt(A("zoom", "20"), 10);
const EXP = parseFloat(A("expand", "3"));
const outImg = A("out", process.argv[2].replace(/\.(plan\.)?json$/i, "-sat.jpg"));

// expand the house bbox to cover the lot
const cLon = (g.minLon + g.maxLon) / 2, cLat = (g.minLat + g.maxLat) / 2;
const hLon = ((g.maxLon - g.minLon) / 2) * EXP, hLat = ((g.maxLat - g.minLat) / 2) * EXP;
const bb = { minLon: cLon - hLon, maxLon: cLon + hLon, minLat: cLat - hLat, maxLat: cLat + hLat };

// web-mercator tile math
const n = 2 ** Z;
const lon2tx = (lon) => ((lon + 180) / 360) * n;
const lat2ty = (lat) => { const r = (lat * Math.PI) / 180; return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n; };
const tx2lon = (tx) => (tx / n) * 360 - 180;
const ty2lat = (ty) => { const m = Math.PI * (1 - (2 * ty) / n); return (Math.atan(Math.sinh(m)) * 180) / Math.PI; };

const tx0 = Math.floor(lon2tx(bb.minLon)), tx1 = Math.floor(lon2tx(bb.maxLon));
const ty0 = Math.floor(lat2ty(bb.maxLat)), ty1 = Math.floor(lat2ty(bb.minLat)); // north = smaller ty
const nx = tx1 - tx0 + 1, ny = ty1 - ty0 + 1;
console.log(`sat-tiles · z${Z} expand ${EXP} · ${nx}x${ny} tiles (${nx * ny})`);
if (nx * ny > 160) { console.error("too many tiles — raise --zoom or lower --expand"); process.exit(1); }

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const composites = [];
let ok = 0, fail = 0;
for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
  const url = `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${Z}/${ty}/${tx}`;
  try {
    const r = await fetch(url, { headers: { "user-agent": UA } });
    if (!r.ok) { fail++; continue; }
    composites.push({ input: Buffer.from(await r.arrayBuffer()), left: (tx - tx0) * 256, top: (ty - ty0) * 256 });
    ok++;
  } catch (e) { fail++; }
}
console.log(`  fetched ${ok} tiles (${fail} failed)`);
if (!ok) { console.error("no tiles fetched — Esri unreachable from here?"); process.exit(1); }

const W = nx * 256, H = ny * 256;
const img = await sharp({ create: { width: W, height: H, channels: 3, background: { r: 20, g: 20, b: 24 } } }).composite(composites).jpeg({ quality: 80 }).toBuffer();
fs.writeFileSync(outImg, img);

// stitched image spans exactly the tile-grid bbox; map that to plan coords (house geo -> 0..W,0..H)
const sLon0 = tx2lon(tx0), sLon1 = tx2lon(tx1 + 1), sLat0 = ty2lat(ty0), sLat1 = ty2lat(ty1 + 1);
const px = (lon) => ((lon - g.minLon) / (g.maxLon - g.minLon)) * sheet.width;
const py = (lat) => ((g.maxLat - lat) / (g.maxLat - g.minLat)) * sheet.height;
const lx = px(sLon0), rx = px(sLon1), top = py(sLat0), bot = py(sLat1);
const r2 = (v) => Math.round(v * 100) / 100;
const layer = { id: "satellite", label: "Satellite (lot)", x: r2(lx), y: r2(top), width: r2(rx - lx), height: r2(bot - top), opacity: 1 };
console.log(`  sat image ${W}x${H} (${(img.length / 1024).toFixed(0)} KB) -> ${outImg}`);
console.log(`  layer placement x=${layer.x} y=${layer.y} w=${layer.width} h=${layer.height}  (sheet ${sheet.width}x${sheet.height})`);
console.log(`  JSON: ${JSON.stringify(layer)}`);

// --write: assemble the plan's base LAYERS — satellite (wide, bottom) + aerial (sheet, top).
// With --slug, layers point at the R2-hosted images (media.lvxhomes.com); else local paths.
const writeP = A("write", "");
const slug = A("slug", "");
if (writeP) {
  const satLayer = { ...layer, url: slug ? `https://media.lvxhomes.com/plans/${slug}-sat.jpg` : outImg };
  const aerialUrl = slug ? `https://media.lvxhomes.com/plans/${slug}-base.jpg` : sheet.satUrl;
  sheet.layers = [satLayer];
  if (aerialUrl) sheet.layers.push({ id: "aerial", label: "Aerial (drone)", url: aerialUrl, x: 0, y: 0, width: sheet.width, height: sheet.height, opacity: 1 });
  delete sheet.satUrl;
  fs.writeFileSync(writeP, JSON.stringify(plan, null, 2));
  console.log(`  wrote ${writeP} · ${sheet.layers.length} layers (satellite + aerial)`);
}
