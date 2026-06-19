#!/usr/bin/env node
/**
 * Overview pass: assemble the 6 still-rooms at TRUE scale into the floorplan.
 * Each room's size comes from its HorizonNet layout (ceiling-calibrated feet);
 * kitchen+living merge into one open great room; arranged north-up per Justin's layout.
 *   node assemble.mjs  -> _assembly.png + _assembly.json (feet room rects)
 */
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

const dir = "C:/Users/jus24/dev/lvx-homes/pipeline/plan-extract";
const CEIL = 9;

// room footprint (w×h ft) from a still's HorizonNet layout, rotated to the building axis
function room(id) {
  const L = JSON.parse(fs.readFileSync(`${dir}/_layout_${id}.json`, "utf8"));
  const z0 = L.z0, z1 = Math.abs(L.z1), camH = CEIL * z1 / (z0 + z1);
  const floor = L.uv.filter((_, i) => i % 2 === 1).map(([u, v]) => {
    const lon = (u - 0.5) * 2 * Math.PI, lat = (0.5 - v) * Math.PI, d = camH / Math.tan(Math.abs(lat));
    return [Math.sin(lon) * d, Math.cos(lon) * d];
  });
  // HorizonNet already aligns walls to 0/90 in this frame -> bbox here is the true size
  const xs = floor.map((q) => q[0]), ys = floor.map((q) => q[1]);
  return { w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}

const R = { kitchen: room("0009"), living: room("0010"), guest: room("0011"), bonus: room("0012"), master: room("0013"), mbath: room("0014") };
const openW = Math.max(R.kitchen.w, R.living.w), openH = Math.max(R.kitchen.h, R.living.h);
const leftW = Math.max(R.bonus.w, R.guest.w), rightW = Math.max(R.master.w, R.mbath.w);

// north-up 3×2: left column (bonus/guest), center open great room (full height), right (master/mbath)
const cells = {
  bonus: { x: 0, y: 0, w: leftW, h: R.bonus.h, label: "Bonus" },
  guest: { x: 0, y: R.bonus.h, w: leftW, h: R.guest.h, label: "Guest Bath" },
  open: { x: leftW, y: 0, w: openW, h: openH, label: "Kitchen / Living" },
  master: { x: leftW + openW, y: 0, w: rightW, h: R.master.h, label: "Master Bed" },
  mbath: { x: leftW + openW, y: R.master.h, w: rightW, h: R.mbath.h, label: "Master Bath" },
};
const totW = leftW + openW + rightW, totH = openH;

const SC = 20, PAD = 24, PW = Math.round(totW * SC) + 2 * PAD, PH = Math.round(totH * SC) + 2 * PAD;
let svg = `<svg width="${PW}" height="${PH}" xmlns="http://www.w3.org/2000/svg"><rect width="${PW}" height="${PH}" fill="#FBF8F1"/>`;
for (const c of Object.values(cells)) {
  const x = PAD + c.x * SC, y = PAD + c.y * SC, w = c.w * SC, h = c.h * SC;
  svg += `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#ffffff" stroke="#1F1812" stroke-width="3"/>`;
  svg += `<text x="${x + w / 2}" y="${y + h / 2 - 4}" text-anchor="middle" font-size="15" font-family="sans-serif" fill="#3a2f20">${c.label}</text>`;
  svg += `<text x="${x + w / 2}" y="${y + h / 2 + 16}" text-anchor="middle" font-size="12" font-family="sans-serif" fill="#9a8c70">${c.w.toFixed(1)}×${c.h.toFixed(1)} ft</text>`;
}
svg += `<text x="${PAD}" y="${PH - 8}" font-size="13" font-family="sans-serif" fill="#6B5D45">↑ N · ${totW.toFixed(1)}×${totH.toFixed(1)} ft (apt ~34.8×34.1)</text></svg>`;
await sharp(Buffer.from(svg)).png().toFile(`${dir}/_assembly.png`);
fs.writeFileSync(`${dir}/_assembly.json`, JSON.stringify(cells, null, 1));
console.log(`assembly ${totW.toFixed(1)}×${totH.toFixed(1)}ft (apt 34.8×34.1) -> _assembly.png`);
