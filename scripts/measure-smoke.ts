/** Smoke test: generate a measure sheet from the baked 1112 plan + parser checks.
 *  Run: npx tsx scripts/measure-smoke.ts */
import { PLANS } from "../data/plans";
import { generateMeasureDoc, parseFtIn, fmtFtIn, radiusFromChord } from "../lib/measure";

const plan = PLANS.find((p) => p.tourSlug === "apartment-1112") ?? PLANS[0];
console.log("plan:", plan.tourSlug, "sheets:", plan.sheets.map((s) => `${s.id}(${s.zones.length}z)`).join(", "));

const doc = generateMeasureDoc(plan, plan.tourSlug);
const byKind: Record<string, number> = {};
for (const a of doc.asks) byKind[a.kind] = (byKind[a.kind] ?? 0) + 1;
console.log("asks:", doc.asks.length, byKind);
for (const a of doc.asks.slice(0, 6))
  console.log(` ${a.id.padEnd(28)} ${a.label.padEnd(40)} ~${a.predicted_ft.toFixed(2)} ft`);

// value merge on regenerate
doc.values[doc.asks[0].id] = { raw: "12.5", ft: 12.5, at: 1 };
const re = generateMeasureDoc(plan, plan.tourSlug, doc);
console.log("regen keeps value:", re.values[doc.asks[0].id]?.ft === 12.5);

const cases: [string, number | null][] = [
  ["11.53", 11.53],
  ["11' 6\"", 11.5],
  ["11'6-3/8\"", 11 + (6 + 3 / 8) / 12],
  ["11 ft 6 3/8 in", 11 + (6 + 3 / 8) / 12],
  ["138.5\"", 138.5 / 12],
  ["3/8\"", 3 / 8 / 12],
  ["11'", 11],
  ["garbage", null],
];
let ok = true;
for (const [raw, want] of cases) {
  const got = parseFtIn(raw);
  const pass = want == null ? got == null : got != null && Math.abs(got - want) < 1e-9;
  if (!pass) ok = false;
  console.log(`${pass ? "ok " : "FAIL"} parse(${JSON.stringify(raw)}) = ${got} want ${want}`);
}
console.log("fmt:", fmtFtIn(11.53), "| radius(c=10,s=1):", radiusFromChord(10, 1));
console.log(ok ? "PARSER OK" : "PARSER FAILURES");
