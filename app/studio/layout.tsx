import type { Metadata } from "next";
import { StudioNav } from "@/components/studio/studio-nav";

/**
 * The /studio back office — a gated (Cloudflare Access) authoring area with its
 * own dark shell and top nav, separate from the public marketing site. The
 * public Nav/Footer are suppressed here by components/site-frame.tsx.
 */
export const metadata: Metadata = {
  title: { default: "Studio", template: "%s · LVX Studio" },
  robots: { index: false, follow: false },
};

export default function StudioLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-dvh bg-ink text-paper">
      <StudioNav />
      {children}
    </div>
  );
}
