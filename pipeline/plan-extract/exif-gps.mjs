import fs from "node:fs";

/**
 * Minimal pure-Node EXIF GPS reader — returns { lat, lon } (decimal, signed) or
 * null. Parses the JPEG APP1/Exif TIFF, follows the GPS IFD, converts the
 * deg/min/sec rationals. Enough for DJI stills; no dependencies.
 */
export function readGpsExif(file) {
  const buf = fs.readFileSync(file);
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null; // not JPEG

  // find the APP1 (Exif) segment
  let off = 2;
  let tiffStart = -1;
  while (off < buf.length - 4) {
    if (buf[off] !== 0xff) { off++; continue; }
    const marker = buf[off + 1];
    if (marker === 0xda || marker === 0xd9) break; // SOS / EOI
    const size = buf.readUInt16BE(off + 2);
    if (marker === 0xe1 && buf.toString("ascii", off + 4, off + 10) === "Exif\0\0") {
      tiffStart = off + 10;
      break;
    }
    off += 2 + size;
  }
  if (tiffStart < 0) return null;

  const le = buf.toString("ascii", tiffStart, tiffStart + 2) === "II";
  const u16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const T = (o) => tiffStart + o; // tiff-relative → absolute

  const ifd0 = u32(T(4));
  // locate the GPS IFD pointer (tag 0x8825) in IFD0
  let gpsRel = null;
  const n0 = u16(T(ifd0));
  for (let i = 0; i < n0; i++) {
    const e = T(ifd0 + 2 + i * 12);
    if (u16(e) === 0x8825) gpsRel = u32(e + 8);
  }
  if (gpsRel == null) return null;

  const dms = (rel) => {
    let v = 0;
    for (let k = 0; k < 3; k++) {
      const num = u32(T(rel + k * 8));
      const den = u32(T(rel + k * 8 + 4));
      v += (den ? num / den : 0) / 60 ** k;
    }
    return v;
  };

  let lat = null, lon = null, latRef = "N", lonRef = "E";
  const ng = u16(T(gpsRel));
  for (let i = 0; i < ng; i++) {
    const e = T(gpsRel + 2 + i * 12);
    const tag = u16(e);
    if (tag === 1) latRef = String.fromCharCode(buf[e + 8]);
    else if (tag === 3) lonRef = String.fromCharCode(buf[e + 8]);
    else if (tag === 2) lat = dms(u32(e + 8));
    else if (tag === 4) lon = dms(u32(e + 8));
  }
  if (lat == null || lon == null) return null;
  if (latRef === "S") lat = -lat;
  if (lonRef === "W") lon = -lon;
  return { lat, lon };
}

/** Full DJI still metadata: GPS + height-above-takeoff (AGL) + heading + the
 *  equirect dimensions, from EXIF + the DJI XMP block. */
export function readDjiMeta(file) {
  const buf = fs.readFileSync(file);
  const gps = readGpsExif(file);

  let xmp = "";
  let o = 2;
  while (o < buf.length - 4) {
    if (buf[o] !== 0xff) { o++; continue; }
    const m = buf[o + 1];
    if (m === 0xda || m === 0xd9) break;
    const size = buf.readUInt16BE(o + 2);
    if (m === 0xe1 && buf.toString("ascii", o + 4, o + 32).startsWith("http://ns.adobe.com/xap")) {
      xmp += buf.toString("utf8", o + 4, o + 2 + size);
    }
    o += 2 + size;
  }
  const grab = (k) => {
    const m = xmp.match(new RegExp(k + '[>="\\s]+([+\\-\\d.]+)'));
    return m ? parseFloat(m[1]) : null;
  };

  let w = null, h = null, o2 = 2;
  while (o2 < buf.length - 8) {
    if (buf[o2] !== 0xff) { o2++; continue; }
    const m = buf[o2 + 1];
    if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) {
      h = buf.readUInt16BE(o2 + 5);
      w = buf.readUInt16BE(o2 + 7);
      break;
    }
    if (m === 0xda) break;
    o2 += 2 + buf.readUInt16BE(o2 + 2);
  }

  return {
    lat: gps?.lat ?? null,
    lon: gps?.lon ?? null,
    relAlt: grab("RelativeAltitude"),
    flightYaw: grab("FlightYawDegree"),
    gimbalYaw: grab("GimbalYawDegree"),
    width: w,
    height: h,
  };
}

// CLI: node exif-gps.mjs <file...>
const run = process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("exif-gps.mjs");
if (run && process.argv.length > 2) {
  for (const f of process.argv.slice(2)) {
    const g = readGpsExif(f);
    const name = f.split(/[\\/]/).pop();
    console.log(name.padEnd(34), g ? `${g.lat.toFixed(6)}, ${g.lon.toFixed(6)}` : "— no GPS —");
  }
}
