#!/usr/bin/env node
/** inject-base — copy a rendered base (sheet.satUrl) from one plan onto another, for a
 *  quick overlay/QA without regenerating the aerial. Same property/stills ⇒ geos ~match.
 *    node inject-base.mjs <dst.plan.json> <src.plan.json> <out.plan.json> */
import fs from "node:fs";
const dst = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const src = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
dst.sheets[0].satUrl = src.sheets[0].satUrl;
fs.writeFileSync(process.argv[4], JSON.stringify(dst));
console.log(`injected base from ${process.argv[3]} -> ${process.argv[4]}`);
