/**
 * Tiny local frame receiver for the synthetic flight renderer
 * (/studio/render). The browser POSTs JPEG frames here; ffmpeg assembles
 * them afterward. Dev-only tooling — never deployed.
 *
 *   node scripts/render-receiver.cjs   → http://localhost:4599
 *   GET  /progress      → {count}
 *   POST /frame?n=42    → saves frame-0042.jpg
 *   POST /frame?name=x  → saves x (pano stills)
 */
const http = require("http");
const fs = require("fs");
const path = require("path");

const OUT = path.join(process.env.TEMP || "/tmp", "lvxframes");
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

let count = 0;

const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  if (req.method === "OPTIONS") return res.end();

  const url = new URL(req.url, "http://x");
  if (req.method === "GET" && url.pathname === "/progress") {
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ count, out: OUT }));
  }
  if (req.method === "POST" && url.pathname === "/frame") {
    const n = url.searchParams.get("n");
    const name = url.searchParams.get("name");
    const file = name
      ? path.join(OUT, name)
      : path.join(OUT, `frame-${String(n).padStart(4, "0")}.jpg`);
    const ws = fs.createWriteStream(file);
    req.pipe(ws);
    ws.on("finish", () => {
      if (!name) count++;
      res.end("ok");
    });
    ws.on("error", () => {
      res.statusCode = 500;
      res.end("write error");
    });
    return;
  }
  res.statusCode = 404;
  res.end("not found");
});

server.listen(4599, () => console.log(`receiver on :4599 → ${OUT}`));
