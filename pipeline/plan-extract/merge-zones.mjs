#!/usr/bin/env node
/** Merge the 6 still-room polygons into the live plan as draggable ZONES (named, pano-linked),
 *  clear the old square strokes, keep flipX/rotation/flight/satUrl. -> _merged_plan.json */
import fs from "node:fs";
import path from "node:path";

const dir = "C:/Users/jus24/dev/lvx-homes/pipeline/plan-extract";
const raw = fs.readFileSync(dir + "/_live_plan_raw.json", "utf8");
const live = JSON.parse(JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw)[0].results[0].body);
const zones = JSON.parse(fs.readFileSync(dir + "/_zones.json", "utf8"));
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

const sh = live.sheets[0];
sh.zones = zones.map((z, i) => ({ id: `${slug(z.label)}-${i}`, label: z.label, kind: "room", points: z.points, panoId: z.id }));
sh.strokes = []; // rooms are zones now — clear the old squares
const f = (sh.paths && sh.paths.flight) || [];
if (f.length > 18) { const st = Math.ceil(f.length / 18); sh.paths.flight = f.filter((_, i) => i % st === 0 || i === f.length - 1); }

const body = JSON.stringify(live);
fs.writeFileSync(dir + "/_merged_plan.json", body);
console.log(`zones ${sh.zones.length} (${sh.zones.map((z) => z.label).join(", ")}) · flight ${sh.paths.flight.length} · flipX ${sh.flipX} · rot ${sh.rotation} · ${(body.length / 1024).toFixed(1)}KB`);
