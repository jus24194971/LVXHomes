"use client";

import { Stream } from "@cloudflare/stream-react";
import { useEffect, useRef, useState } from "react";
import { CF_STREAM_CUSTOMER_CODE, streamPoster, streamReady } from "@/lib/stream";
import { cn } from "@/lib/utils";

// Used wherever a real video isn't set yet — a warm, dark vignette.
const PLACEHOLDER_BG =
  "radial-gradient(120% 90% at 50% 0%, #3a3026 0%, #211c16 70%)";

/**
 * Full-bleed autoplay hero loop. Renders the placeholder vignette until a real
 * video UID is set, a static poster under prefers-reduced-motion, and the
 * looping reel otherwise. Meant to sit absolutely inside a positioned hero.
 */
export function StreamHero({
  uid,
  poster,
  className,
}: {
  uid: string;
  poster?: string;
  className?: string;
}) {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  if (!streamReady(uid)) {
    return (
      <div
        aria-hidden
        className={cn("absolute inset-0", className)}
        style={{ background: PLACEHOLDER_BG }}
      />
    );
  }

  const posterUrl = poster ?? streamPoster(uid);

  if (reduced) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={posterUrl}
        alt=""
        aria-hidden
        className={cn("absolute inset-0 h-full w-full object-cover", className)}
      />
    );
  }

  const embedUrl =
    `https://customer-${CF_STREAM_CUSTOMER_CODE}.cloudflarestream.com/${uid}/iframe` +
    `?autoplay=true&muted=true&loop=true&controls=false&preload=auto&poster=${encodeURIComponent(
      posterUrl,
    )}`;

  // Full-bleed COVER: the Stream player is a fixed 16:9 iframe, so we oversize it
  // (at least 100% in BOTH axes, locked to 16:9) and clip the overflow. Fills any
  // screen shape — tall, wide, 4K — with no dark gaps or letterboxing.
  return (
    <div aria-hidden className={cn("absolute inset-0 overflow-hidden", className)}>
      <iframe
        src={embedUrl}
        title="LVX background reel"
        tabIndex={-1}
        allow="autoplay; muted; loop; fullscreen"
        className="pointer-events-none absolute left-1/2 top-1/2 h-[56.25vw] min-h-[100dvh] w-[100vw] min-w-[177.78dvh] max-w-none -translate-x-1/2 -translate-y-1/2 border-0"
      />
    </div>
  );
}

/**
 * Standard 16:9 player. Lazily mounts the heavy Stream embed only after a click
 * (poster-first), and only fetches the poster once near the viewport.
 */
export function StreamPlayer({
  uid,
  poster,
  title,
  className,
}: {
  uid: string;
  poster?: string;
  title?: string;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  const [play, setPlay] = useState(false);
  const ready = streamReady(uid);
  const posterUrl = poster ?? streamPoster(uid);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setNear(true);
          io.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      className={cn("relative aspect-video overflow-hidden bg-ink", className)}
    >
      {ready && play ? (
        <Stream src={uid} controls autoplay poster={posterUrl} />
      ) : (
        <button
          type="button"
          onClick={() => ready && setPlay(true)}
          aria-label={ready ? `Play ${title ?? "film"}` : "Film coming soon"}
          className="group absolute inset-0 flex items-center justify-center"
        >
          {ready && near ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={posterUrl}
              alt=""
              className="absolute inset-0 h-full w-full object-cover transition-transform duration-[1200ms] ease-out group-hover:scale-[1.03]"
            />
          ) : (
            <div
              aria-hidden
              className="absolute inset-0"
              style={{ background: PLACEHOLDER_BG }}
            />
          )}
          <span className="relative flex h-16 w-16 items-center justify-center rounded-full border border-paper/60 text-paper transition-colors duration-300 group-hover:border-champagne group-hover:text-champagne">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M8 5v14l11-7z" />
            </svg>
          </span>
        </button>
      )}
    </div>
  );
}
