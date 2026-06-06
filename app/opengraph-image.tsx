import { ImageResponse } from "next/og";

// Branded social card. Rendered to a static PNG at build, so it needs no edge
// runtime at request time and works on any host.
export const alt = "LVX Homes — Luxury Real Estate Aerial Cinematography";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpengraphImage() {
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
            fontSize: 150,
            letterSpacing: 24,
            paddingLeft: 24,
            color: "#f5f0e6",
          }}
        >
          LVX
        </div>
        <div
          style={{
            width: 90,
            height: 2,
            backgroundColor: "#b7995c",
            margin: "14px 0 30px",
          }}
        />
        <div
          style={{
            display: "flex",
            fontSize: 30,
            letterSpacing: 10,
            color: "#b7995c",
            textTransform: "uppercase",
          }}
        >
          Luxury Real Estate Aerial Cinematography
        </div>
        <div
          style={{
            display: "flex",
            fontSize: 26,
            letterSpacing: 4,
            marginTop: 20,
            color: "#e5dac6",
          }}
        >
          Phoenix · Mesa · Scottsdale
        </div>
      </div>
    ),
    { ...size },
  );
}
