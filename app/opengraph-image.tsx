import { ImageResponse } from "next/og";
import { CINZEL_600_WOFF_BASE64 } from "@/lib/cinzel-600";

// Branded social card. The gold Cinzel wordmark reads as a carved inscription.
// The font is base64-embedded and decoded in-memory (no fs), so this renders on
// the Cloudflare Workers runtime as well as at build time.
export const alt = "LVX Homes — Luxury Real Estate Aerial Cinematography";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// atob + Uint8Array are available on both Node (build) and Workers (runtime).
function fontData(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

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
      fonts: [
        {
          name: "Cinzel",
          data: fontData(CINZEL_600_WOFF_BASE64),
          weight: 600,
          style: "normal",
        },
      ],
    },
  );
}
