import fs from "node:fs";
const raw = fs.readFileSync("C:/Users/jus24/dev/lvx-homes/pipeline/plan-extract/_check.json", "utf8");
const r = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw)[0].results[0];
console.log("updated_by:", r.updated_by, "| updated_at:", r.updated_at);
const s = JSON.parse(r.body).sheets[0];
console.log("zones:", (s.zones || []).length, "[" + (s.zones || []).map((z) => z.label).join(", ") + "]");
console.log("rotation:", s.rotation, "| flipX:", s.flipX, "| strokes:", (s.strokes || []).length, "| flight:", s.paths?.flight?.length);
console.log("satUrl:", (s.satUrl || "").slice(0, 70));
