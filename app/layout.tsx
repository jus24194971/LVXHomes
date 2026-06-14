import type { Metadata } from "next";
import { Cinzel, Cormorant_Garamond, Jost } from "next/font/google";
import "./globals.css";
import { SiteFrame } from "@/components/site-frame";
import { Footer } from "@/components/footer";
import { SITE } from "@/data/site";

// Display — Roman-inscription capitals. Wordmark + hero headlines + eyebrows.
const cinzel = Cinzel({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-cinzel",
  display: "swap",
});

// Editorial serif — statements, pull quotes, taglines (incl. italic).
const cormorant = Cormorant_Garamond({
  subsets: ["latin"],
  weight: ["400", "500"],
  style: ["normal", "italic"],
  variable: "--font-cormorant",
  display: "swap",
});

// Functional sans — body, nav, buttons, labels. 300 for body.
const jost = Jost({
  subsets: ["latin"],
  weight: ["300", "400", "500"],
  variable: "--font-jost",
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL(SITE.url),
  title: {
    default: "LVX Homes — Luxury Real Estate Aerial Cinematography",
    template: "%s · LVX Homes",
  },
  description: SITE.description,
  openGraph: {
    type: "website",
    siteName: SITE.name,
    url: SITE.url,
    title: "LVX Homes — Luxury Real Estate Aerial Cinematography",
    description: SITE.description,
  },
  twitter: {
    card: "summary_large_image",
    title: "LVX Homes",
    description: SITE.description,
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${cinzel.variable} ${cormorant.variable} ${jost.variable}`}
    >
      <body className="flex min-h-dvh flex-col">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[100] focus:bg-ink focus:px-4 focus:py-2 focus:font-sans focus:text-sm focus:uppercase focus:tracking-[0.16em] focus:text-paper"
        >
          Skip to content
        </a>
        <SiteFrame footer={<Footer />}>{children}</SiteFrame>
      </body>
    </html>
  );
}
