// Merge the Photoreal Floor + CubiCasa floorplan as layers into the LIVE Scottsdale plan
// (read from the D1 dump so we don't clobber any editor work), write _plan_merged.json.
import fs from "node:fs";
const D = "C:/Users/jus24/dev/lvx-homes/pipeline/plan-extract/";
let raw = fs.readFileSync(D + "_plan_dump.json", "utf16le");
if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);   // strip BOM from PowerShell redirect
const dump = JSON.parse(raw);

function findBody(o) {
  if (o && typeof o === "object") {
    if (typeof o.body === "string" && o.body.includes("sheets")) return o.body;
    for (const k in o) { const r = findBody(o[k]); if (r) return r; }
  }
  return null;
}
const body = findBody(dump);
if (!body) { console.error("no plan body found in dump"); process.exit(1); }
const plan = JSON.parse(body);
const sheet = plan.sheets[0];
sheet.layers = (sheet.layers || []).filter((l) => l.id !== "floor" && l.id !== "cubicasa");
sheet.layers.push(
  { id: "floor", label: "Photoreal Floor", url: "https://media.lvxhomes.com/plans/old-town-scottsdale-home-floor.jpg",
    x: 0, y: 0, width: 69.2, height: 65.6, opacity: 1, visible: true },
  { id: "cubicasa", label: "Floorplan (CubiCasa)", url: "https://media.lvxhomes.com/plans/old-town-scottsdale-home-cubicasa.png",
    x: 0, y: 0, width: 90, height: 68, opacity: 0.7, visible: true },
);
fs.writeFileSync(D + "_plan_merged.json", JSON.stringify(plan), "utf8");
console.log("merged: slug", plan.tourSlug || plan.slug, "| sheets", plan.sheets.length,
            "| zones", (sheet.zones || []).length, "| layers", sheet.layers.map((l) => l.id).join(","));
