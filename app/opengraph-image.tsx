import { ImageResponse } from "next/og";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Branded social card, rendered to a static PNG at build (no runtime needed).
// The gold Cinzel wordmark reads as a carved inscription — architectural, not glossy.
export const alt = "LVX Homes — Luxury Real Estate Aerial Cinematography";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpengraphImage() {
  // Read at build time (static generation) so the OG shows the real wordmark.
  const cinzel = readFileSync(join(process.cwd(), "assets", "Cinzel-600.woff"));

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: "#211c16",
          backgroundImage:
            "radial-gradient(120% 90% at 50% 0%, #3a3026 0%, #211c16 70%)",
        }}
      >
        <div
          style={{
            display: "flex",
            fontFamily: "Cinzel",
            fontSize: 170,
            letterSpacing: 26,
            paddingLeft: 26,
            color: "#b7995c",
          }}
        >
          LVX
        </div>
        <div
          style={{
            width: 96,
            height: 2,
            backgroundColor: "#b7995c",
            margin: "16px 0 30px",
          }}
        />
        <div
          style={{
            display: "flex",
            fontSize: 29,
            letterSpacing: 10,
            color: "#e5dac6",
            textTransform: "uppercase",
          }}
        >
          Luxury Real Estate Aerial Cinematography
        </div>
        <div
          style={{
            display: "flex",
            fontSize: 25,
            letterSpacing: 5,
            marginTop: 20,
            color: "#9b8a6c",
          }}
        >
          Phoenix · Mesa · Scottsdale
        </div>
      </div>
    ),
    {
      ...size,
      fonts: [{ name: "Cinzel", data: cinzel, weight: 600, style: "normal" }],
    },
  );
}
