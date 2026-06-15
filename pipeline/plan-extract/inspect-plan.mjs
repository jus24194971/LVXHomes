import fs from "node:fs";
const plan = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const strip = (o) => JSON.parse(JSON.stringify(o, (k, v) => (k === "satUrl" && typeof v === "string" ? `<${(v.length / 1024) | 0}KB data-url>` : v)));
for (const s of plan.sheets) {
  console.log("SHEET", s.id, "·", s.label, "·", s.width, "×", s.height, "· geo", !!s.geo, "· sat", !!s.satUrl);
  console.log("  keys:", Object.keys(s).join(", "));
  console.log("  paths:", s.paths ? Object.keys(s.paths).map((k) => `${k}[${s.paths[k].length}]`).join(" ") : "none");
  console.log("  zones:", (s.zones ?? []).length);
  if (s.zones?.[0]) console.log("  zone[0]:", JSON.stringify(strip(s.zones[0])));
  if (s.zones?.[1]) console.log("  zone[1]:", JSON.stringify(strip(s.zones[1])));
}
