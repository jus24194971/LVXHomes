#!/usr/bin/env node
/**
 * preview-plan — render a plan's base image with its flight path + amenity
 * zones overlaid, so you can eyeball registration (does the aerial line up with
 * the GPS-driven path/dots?). Pure QA; writes a PNG.
 *
 *   node preview-plan.mjs <plan.json> [out.png]
 */
import fs from "node:fs";
import sharp from "sharp";

const planPath = process.argv[2];
const rest = process.argv.slice(3);
const beforeI = rest.indexOf("--before");
const before = beforeI >= 0 ? parseFloat(rest[beforeI + 1]) : Infinity; // only path keys with t <= before
const outImg = rest.find((a) => !a.startsWith("--") && !/^\d+(\.\d+)?$/.test(a)) || planPath.replace(/\.json$/, ".preview.png");
const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
const sheet = plan.sheets.find((s) => s.satUrl) ?? plan.sheets.find((s) => s.geo) ?? plan.sheets[0];

const W = 1500;
const H = Math.round((W * sheet.height) / sheet.width);
const sx = W / sheet.width;
const sy = H / sheet.height;

let base;
if (typeof sheet.satUrl === "string" && sheet.satUrl.startsWith("data:")) {
  base = await sharp(Buffer.from(sheet.satUrl.split(",")[1], "base64")).resize(W, H, { fit: "fill" }).toBuffer();
} else {
  base = await sharp({ create: { width: W, height: H, channels: 3, background: { r: 22, g: 21, b: 25 } } }).jpeg().toBuffer();
}

const esc = (s) => String(s).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
const PX = (p) => (Array.isArray(p) ? p[0] : p.x); // points come as [x,y] or {x,y}
const PY = (p) => (Array.isArray(p) ? p[1] : p.y);
const ptsOf = (arr) => arr.map((p) => `${(PX(p) * sx).toFixed(1)},${(PY(p) * sy).toFixed(1)}`).join(" ");

let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">`;

const flight = (sheet.paths?.flight ?? sheet.paths?.path ?? []).filter((k) => (k.t ?? 0) <= before);
if (flight.length) {
  svg += `<polyline points="${ptsOf(flight)}" fill="none" stroke="#E9C77E" stroke-width="3" stroke-opacity="0.92"/>`;
  const a = flight[0], b = flight[flight.length - 1];
  svg += `<circle cx="${(PX(a) * sx).toFixed(1)}" cy="${(PY(a) * sy).toFixed(1)}" r="6" fill="#3FB950"/>`; // start green
  svg += `<circle cx="${(PX(b) * sx).toFixed(1)}" cy="${(PY(b) * sy).toFixed(1)}" r="6" fill="#F85149"/>`; // end red
}

for (const z of sheet.zones ?? []) {
  const pts = z.points ? ptsOf(z.points) : null;
  let cx, cy;
  if (pts) {
    svg += `<polygon points="${pts}" fill="#E9C77E" fill-opacity="0.16" stroke="#E9C77E" stroke-width="2"/>`;
    cx = (z.points.reduce((s, p) => s + PX(p), 0) / z.points.length) * sx;
    cy = (z.points.reduce((s, p) => s + PY(p), 0) / z.points.length) * sy;
  } else if (z.rect) {
    svg += `<rect x="${(z.rect.x * sx).toFixed(1)}" y="${(z.rect.y * sy).toFixed(1)}" width="${(z.rect.w * sx).toFixed(1)}" height="${(z.rect.h * sy).toFixed(1)}" fill="#E9C77E" fill-opacity="0.16" stroke="#E9C77E" stroke-width="2"/>`;
    cx = (z.rect.x + z.rect.w / 2) * sx;
    cy = (z.rect.y + z.rect.h / 2) * sy;
  }
  if (cx != null) {
    const x = cx.toFixed(1), y = cy.toFixed(1);
    svg += `<circle cx="${x}" cy="${y}" r="13" fill="none" stroke="#E9C77E" stroke-width="2.5"/>`;
    svg += `<line x1="${x}" y1="${(cy - 20).toFixed(1)}" x2="${x}" y2="${(cy + 20).toFixed(1)}" stroke="#E9C77E" stroke-width="1.5" stroke-opacity="0.8"/>`;
    svg += `<line x1="${(cx - 20).toFixed(1)}" y1="${y}" x2="${(cx + 20).toFixed(1)}" y2="${y}" stroke="#E9C77E" stroke-width="1.5" stroke-opacity="0.8"/>`;
    svg += `<circle cx="${x}" cy="${y}" r="4" fill="#FBF8F1" stroke="#000" stroke-width="1"/>`;
    svg += `<text x="${(cx + 17).toFixed(1)}" y="${(cy + 6).toFixed(1)}" fill="#FBF8F1" font-size="19" font-weight="bold" font-family="sans-serif" stroke="#000" stroke-width="0.8" paint-order="stroke">${esc(z.label ?? "")}</text>`;
  }
}
svg += `</svg>`;

const png = await sharp(base).composite([{ input: Buffer.from(svg) }]).png().toBuffer();
fs.writeFileSync(outImg, png);
console.log(`wrote ${outImg} (${(png.length / 1024).toFixed(0)} KB)  ·  ${W}×${H}  ·  flight ${flight.length} pts  ·  ${(sheet.zones ?? []).length} zones`);
