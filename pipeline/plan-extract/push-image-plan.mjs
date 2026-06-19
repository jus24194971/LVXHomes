#!/usr/bin/env node
/** Point the live plan at the leveled partition image as its base, rotation reset (baked),
 *  zones/strokes/path cleared (rooms are in the image). -> _merged_plan.json */
import fs from "node:fs";

const dir = "C:/Users/jus24/dev/lvx-homes/pipeline/plan-extract";
const raw = fs.readFileSync(dir + "/_live_plan_raw.json", "utf8");
const live = JSON.parse(JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw)[0].results[0].body);
const meta = JSON.parse(fs.readFileSync(dir + "/_plan_meta.json", "utf8"));

const sh = live.sheets[0];
sh.satUrl = "https://media.lvxhomes.com/ortho/apartment-1112-plan.png?v=" + Math.floor(Date.now() / 1000);
sh.width = meta.feetW;
sh.height = meta.feetH;
sh.rotation = 0;
sh.flipX = false;
sh.zones = [];
sh.strokes = [];
sh.paths = {};

const body = JSON.stringify(live);
fs.writeFileSync(dir + "/_merged_plan.json", body);
console.log(`plan -> leveled image base · ${meta.feetW}x${meta.feetH}ft · rotation 0 · zones/path cleared · ${(body.length / 1024).toFixed(1)}KB`);
