"use client";

import { useEffect, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Pre-flight coaching overlay. Animated directional arrows demonstrate the real
 * gestures — drag up/right to look, tap a ring, tap to reveal the scrub bar, and
 * (mobile) an arrow pointing at the VR button — tailored to desktop vs mobile.
 * Auto-advances (~10s), loops until the visitor hits Begin. Shown once per
 * device (localStorage), replayable from the player's "How to fly?" link.
 */

const CSS = `
@keyframes lvxRise{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
@keyframes lvxUp{0%,100%{transform:translate(-50%,9px);opacity:.12}50%{transform:translate(-50%,-15px);opacity:1}}
@keyframes lvxRight{0%,100%{transform:translate(-9px,-50%);opacity:.12}50%{transform:translate(15px,-50%);opacity:1}}
@keyframes lvxDown{0%,100%{transform:translateY(-7px);opacity:.3}50%{transform:translateY(5px);opacity:1}}
@keyframes lvxRing{0%,100%{opacity:.45;transform:translate(-50%,-50%) scale(.9)}50%{opacity:1;transform:translate(-50%,-50%) scale(1.08)}}
@keyframes lvxRipple{0%{opacity:.5;transform:translate(-50%,-50%) scale(.5)}100%{opacity:0;transform:translate(-50%,-50%) scale(2)}}
@keyframes lvxBar{0%,100%{opacity:.3}50%{opacity:1}}
@keyframes lvxScroll{0%,100%{transform:translateY(0);opacity:.35}50%{transform:translateY(0.4em);opacity:1}}
`;

function Chevron({ className }: { className?: string }) {
  return (
    <svg
      width="1em"
      height="1em"
      viewBox="0 0 24 24"
      fill="none"
      className={className}
      aria-hidden
    >
      <path
        d="M12 5v14M12 5l-6.5 7M12 5l6.5 7"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Look() {
  return (
    <>
      <span
        className="absolute left-1/2 top-[15%] text-champagne"
        style={{ animation: "lvxUp 1.5s ease-in-out infinite" }}
      >
        <Chevron />
      </span>
      <span
        className="absolute right-[11%] top-1/2 text-champagne"
        style={{ animation: "lvxRight 1.5s ease-in-out infinite" }}
      >
        <Chevron className="rotate-90" />
      </span>
      <span className="h-[0.55em] w-[0.55em] rounded-full border border-paper/50 bg-paper/10" />
    </>
  );
}

function Ring() {
  return (
    <>
      <span
        className="absolute left-1/2 top-1/2 h-[2.3em] w-[2.3em] rounded-full border-2 border-champagne"
        style={{ animation: "lvxRing 1.7s ease-in-out infinite" }}
      />
      <span
        className="absolute left-1/2 top-1/2 h-[1.5em] w-[1.5em] rounded-full border border-champagne/50"
        style={{ animation: "lvxRipple 1.7s ease-out infinite" }}
      />
      <span className="absolute left-1/2 top-1/2 h-[0.5em] w-[0.5em] -translate-x-1/2 -translate-y-1/2 rounded-full bg-champagne" />
    </>
  );
}

function Controls() {
  return (
    <>
      <span className="absolute left-1/2 top-[40%] h-[0.5em] w-[0.5em] -translate-x-1/2 -translate-y-1/2 rounded-full bg-paper" />
      <span
        className="absolute left-1/2 top-[40%] h-[1.1em] w-[1.1em] rounded-full border border-paper/70"
        style={{ animation: "lvxRipple 1.5s ease-out infinite" }}
      />
      <span
        className="absolute inset-x-[14%] bottom-[12%] h-[0.55em] rounded-full bg-champagne/30"
        style={{ animation: "lvxBar 1.5s ease-in-out infinite" }}
      />
    </>
  );
}

function Vr() {
  return (
    <>
      <span className="absolute inset-x-[12%] bottom-[16%] flex items-center justify-end gap-[0.35em]">
        <span className="h-[0.6em] w-[0.6em] rounded-full bg-paper/25" />
        <span className="h-[0.6em] w-[0.6em] rounded-full bg-paper/25" />
        <span className="rounded-full border border-champagne bg-champagne/15 px-[0.45em] py-[0.12em] text-[0.42em] font-semibold uppercase tracking-[0.12em] text-champagne">
          VR
        </span>
      </span>
      <span
        className="absolute bottom-[31%] right-[15%] text-[0.85em] text-champagne"
        style={{ animation: "lvxDown 1.2s ease-in-out infinite" }}
      >
        <Chevron className="rotate-180" />
      </span>
    </>
  );
}

function Zoom() {
  return (
    <span className="relative flex h-[2em] w-[1.25em] items-start justify-center rounded-full border-2 border-paper/55">
      <span
        className="mt-[0.28em] h-[0.45em] w-[0.13em] rounded-full bg-champagne"
        style={{ animation: "lvxScroll 1.3s ease-in-out infinite" }}
      />
    </span>
  );
}

function MiniMap() {
  return (
    <span className="relative h-[1.7em] w-[2.4em] rounded border border-paper/40">
      <span className="absolute left-[14%] top-[18%] h-[0.4em] w-[0.6em] rounded-sm bg-paper/15" />
      <span className="absolute right-[14%] bottom-[18%] h-[0.5em] w-[0.7em] rounded-sm bg-paper/15" />
      <span
        className="absolute left-1/2 top-1/2 h-[0.42em] w-[0.42em] -translate-x-1/2 -translate-y-1/2 rounded-full bg-champagne"
        style={{ animation: "lvxBar 1.4s ease-in-out infinite" }}
      />
    </span>
  );
}

type Step = { key: string; label: string; sub: string; graphic: ReactNode };

function buildSteps(isMobile: boolean, hasMotion: boolean): Step[] {
  if (isMobile) {
    const steps: Step[] = [
      { key: "look", label: "Swipe to look", sub: "Drag any direction — all the way around.", graphic: <Look /> },
      { key: "ring", label: "Tap a gold ring", sub: "Step inside that room in full 360°.", graphic: <Ring /> },
      { key: "controls", label: "Tap to show controls", sub: "Reveal play, the scrub bar, and the map.", graphic: <Controls /> },
    ];
    if (hasMotion) {
      steps.push({ key: "vr", label: "Tap “VR” for motion", sub: "Then look just by moving your phone.", graphic: <Vr /> });
    }
    return steps;
  }
  return [
    { key: "look", label: "Drag to look", sub: "Click and drag anywhere in the view.", graphic: <Look /> },
    { key: "zoom", label: "Scroll to zoom", sub: "Or pinch on a trackpad.", graphic: <Zoom /> },
    { key: "ring", label: "Click a gold ring", sub: "Step inside that room in full 360°.", graphic: <Ring /> },
    { key: "map", label: "Open the map", sub: "Jump straight to any room.", graphic: <MiniMap /> },
  ];
}

export function TourTutorial({
  isMobile,
  hasMotion,
  onBegin,
  onSkip,
}: {
  isMobile: boolean;
  hasMotion: boolean;
  onBegin: () => void;
  onSkip: () => void;
}) {
  const steps = buildSteps(isMobile, hasMotion);
  const [i, setI] = useState(0);

  useEffect(() => {
    const t = setTimeout(() => setI((x) => (x + 1) % steps.length), 2600);
    return () => clearTimeout(t);
  }, [i, steps.length]);

  const step = steps[i] ?? steps[0];

  return (
    <div className="absolute inset-0 z-40 flex flex-col items-center justify-center gap-[clamp(0.6rem,1.5cqw,1.4rem)] bg-ink/80 px-6 text-center backdrop-blur-sm [container-type:inline-size]">
      <style>{CSS}</style>
      <p className="font-sans text-[clamp(0.55rem,0.85cqw,0.8rem)] uppercase tracking-[0.3em] text-champagne/80">
        How to fly
      </p>

      <div
        key={step.key}
        className="relative flex h-[clamp(6rem,15cqw,11rem)] w-[clamp(10.5rem,26cqw,19rem)] items-center justify-center rounded-2xl border border-paper/15 bg-ink/40 text-[clamp(1.4rem,3.4cqw,2.6rem)]"
        style={{ animation: "lvxRise .4s ease-out" }}
      >
        {step.graphic}
      </div>

      <div key={`t-${step.key}`} className="min-h-[3.6em]" style={{ animation: "lvxRise .45s ease-out" }}>
        <p className="font-display text-[clamp(1rem,1.9cqw,1.6rem)] uppercase tracking-[0.08em] text-paper">
          {step.label}
        </p>
        <p className="mt-1 font-sans text-[clamp(0.7rem,0.95cqw,0.95rem)] font-light text-paper/55">
          {step.sub}
        </p>
      </div>

      <div className="flex items-center gap-1.5">
        {steps.map((s, n) => (
          <button
            key={s.key}
            type="button"
            aria-label={s.label}
            onClick={() => setI(n)}
            className={cn(
              "h-1.5 rounded-full transition-all",
              n === i ? "w-5 bg-champagne" : "w-1.5 bg-paper/30 hover:bg-paper/50",
            )}
          />
        ))}
      </div>

      <div className="mt-1 flex flex-col items-center gap-2.5">
        <button
          type="button"
          onClick={onBegin}
          className="flex items-center gap-2 rounded-full bg-champagne px-[clamp(1.25rem,2.4cqw,2rem)] py-[clamp(0.6rem,1cqw,0.9rem)] font-sans text-[clamp(0.7rem,0.95cqw,1rem)] font-semibold uppercase tracking-[0.18em] text-ink transition-transform duration-300 hover:scale-105"
        >
          <svg width="0.9em" height="0.9em" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <path d="M8 5v14l11-7z" />
          </svg>
          Begin the flight
        </button>
        <button
          type="button"
          onClick={onSkip}
          className="font-sans text-[clamp(0.6rem,0.8cqw,0.8rem)] uppercase tracking-[0.2em] text-paper/40 transition-colors hover:text-paper/70"
        >
          Skip
        </button>
      </div>
    </div>
  );
}
