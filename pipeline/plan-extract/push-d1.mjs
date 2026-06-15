#!/usr/bin/env node
/**
 * Emit a D1 upsert for a plan doc → _push.sql, then apply with:
 *   npx wrangler d1 execute lvx-content --remote --file=_push.sql
 *
 *   node push-d1.mjs <plan.json> [docId=the-george] [ts]
 *
 * ts (epoch ms) is optional so the SQL is deterministic; defaults to Date.now().
 */
import fs from "node:fs";
import path from "node:path";

const planPath = process.argv[2];
const docId = process.argv[3] || "the-george";
const tsArg = process.argv.slice(4).find((a) => /^\d+$/.test(a)); // numeric arg only
const ts = tsArg ? parseInt(tsArg, 10) : Date.now();

// --satUrl <url>: replace any sheet.satUrl (e.g. a heavy data-URL) with a URL
// (e.g. an R2 link) before serializing, so the D1 statement stays small.
const sIdx = process.argv.indexOf("--satUrl");
const satUrl = sIdx >= 0 ? process.argv[sIdx + 1] : null;

const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
if (satUrl) {
  for (const s of plan.sheets) if (s.satUrl) s.satUrl = satUrl;
}
const body = JSON.stringify(plan);
const q = (s) => s.replace(/'/g, "''"); // SQL single-quote escape

const sql =
  `INSERT INTO doc (kind, id, body, updated_at, updated_by) VALUES ` +
  `('plan', '${q(docId)}', '${q(body)}', ${ts}, 'aerial-base') ` +
  `ON CONFLICT(kind, id) DO UPDATE SET ` +
  `body = excluded.body, updated_at = excluded.updated_at, updated_by = excluded.updated_by;\n`;

const outSql = path.join(path.dirname(planPath), "_push.sql");
fs.writeFileSync(outSql, sql, "utf8");
console.log(`wrote ${outSql}  (${(sql.length / 1024).toFixed(0)} KB)  ·  plan '${docId}'  ·  ts ${ts}`);
console.log(`apply:  npx wrangler d1 execute lvx-content --remote --file="${outSql}"`);
