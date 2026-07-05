// Bump the floor layer's URL cache-buster on the LIVE plan (image content was replaced on R2),
// preserving zones + all layer transforms exactly as Justin left them.
import fs from "node:fs";
const D = "C:/Users/jus24/dev/lvx-homes/pipeline/plan-extract/";
let raw = fs.readFileSync(D + "_plan_dump.json", "utf16le");
if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
const dump = JSON.parse(raw);
const find = (o) => {
  if (o && typeof o === "object") {
    if (typeof o.body === "string" && o.body.includes("sheets")) return o.body;
    for (const k in o) { const r = find(o[k]); if (r) return r; }
  }
  return null;
};
const plan = JSON.parse(find(dump));
const sh = plan.sheets[0];
const fl = (sh.layers || []).find((l) => l.id === "floor");
if (!fl) { console.error("no floor layer"); process.exit(1); }
fl.url = `https://media.lvxhomes.com/plans/old-town-scottsdale-home-floor.jpg?v=${Date.now()}`;
fl.label = "Photoreal Floor (dollhouse)";
fs.writeFileSync(D + "_plan_merged.json", JSON.stringify(plan), "utf8");
console.log("floor url bumped | zones:", (sh.zones || []).length, "| layers:", (sh.layers || []).map((l) => `${l.id}${l.rotation ? `@${l.rotation}` : ""}`).join(","));
