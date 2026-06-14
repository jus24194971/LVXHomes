import type { Metadata } from "next";
import { Container } from "@/components/ui/container";
import { AssetLibrary } from "@/components/studio/asset-library";

export const metadata: Metadata = { title: "Library" };

export default function LibraryPage() {
  return (
    <Container className="max-w-[1400px] py-10 sm:py-14">
      <p className="font-sans text-[0.7rem] uppercase tracking-[0.22em] text-champagne">
        Media
      </p>
      <h1 className="mt-3 font-display text-3xl font-normal tracking-[0.04em] text-paper sm:text-4xl">
        LIBRARY
      </h1>
      <p className="mt-3 max-w-2xl font-sans text-sm font-light leading-relaxed text-paper/60">
        Upload, browse, rename, and retire every video and pano. Films transcode
        on Cloudflare Stream; 360 clips and panos upload straight to R2. Pick from
        here when you build a tour.
      </p>
      <div className="mt-8">
        <AssetLibrary />
      </div>
    </Container>
  );
}
