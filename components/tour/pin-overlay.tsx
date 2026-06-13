"use client";

import { cn } from "@/lib/utils";
import { type VideoPin, pinPosAt, pinVisibleAt } from "@/data/video-pins";

/**
 * Presentational overlay of room pins on a flat video. Given the pins and the
 * player's current time, it places each marker at its interpolated position and
 * fades it in only inside its window. Pure + pointer-transparent, so it drops
 * over any 16:9 player — the Pin Studio preview now, the public film later.
 */
export function PinOverlay({
  pins,
  currentTime,
  activeId,
  className,
}: {
  pins: VideoPin[];
  currentTime: number;
  activeId?: string | null;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "pointer-events-none absolute inset-0 overflow-hidden [container-type:inline-size]",
        className,
      )}
    >
      {pins.map((pin) => {
        const pos = pinPosAt(pin, currentTime);
        if (!pos) return null;
        const visible = pinVisibleAt(pin, currentTime);
        const active = pin.id === activeId;
        return (
          <div
            key={pin.id}
            className={cn(
              "absolute -translate-x-1/2 -translate-y-1/2 transition-opacity duration-200",
              visible ? "opacity-100" : "opacity-0",
            )}
            style={{ left: `${pos.x * 100}%`, top: `${pos.y * 100}%` }}
          >
            {/* Label floats just above the marker */}
            <span
              className={cn(
                "absolute bottom-[calc(100%+0.5rem)] left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-ink/70 px-[0.95em] py-[0.4em] font-sans text-[clamp(0.5625rem,1cqw,0.95rem)] uppercase tracking-[0.16em] backdrop-blur-sm",
                active ? "text-champagne ring-1 ring-champagne/60" : "text-paper/90",
              )}
            >
              {pin.label}
            </span>
            {/* Marker: champagne ring + dot, with a soft pulse */}
            <span
              className={cn(
                "relative flex items-center justify-center rounded-full border bg-ink/40 backdrop-blur-sm",
                "h-[clamp(1.1rem,2cqw,2rem)] w-[clamp(1.1rem,2cqw,2rem)]",
                active ? "border-champagne" : "border-champagne/80",
              )}
            >
              <span className="absolute inset-0 rounded-full border border-champagne/40 motion-safe:animate-ping" />
              <span className="h-[34%] w-[34%] rounded-full bg-champagne" />
            </span>
          </div>
        );
      })}
    </div>
  );
}
