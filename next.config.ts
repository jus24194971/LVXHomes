import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        // The embeddable player must be framable on any agent / brokerage site.
        // Explicitly allow all ancestors (and set NO X-Frame-Options) so the
        // iframe works everywhere. Tighten to an allowlist later if needed.
        source: "/embed/:path*",
        headers: [{ key: "Content-Security-Policy", value: "frame-ancestors *" }],
      },
    ];
  },
};

export default nextConfig;
