"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Plan, PlanSheet, PlanZone } from "@/data/plans";
import { layerTransform } from "@/data/plans";
import { cn } from "@/lib/utils";
import { centroidOf, zoneFontSize } from "@/lib/plan-geometry";

/**
 * The living minimap — renders a plan sheet (floor or grounds) in brand
 * style and lets the viewer tap a zone to jump the flight there. Zoomable
 * (wheel / pinch-drag / buttons) so amenities are tappable even on a small map.
 */

// Zone fills per kind, tuned for the cream plan card. (Shared with the Studio.)
export const ZONE_FILL: Record<PlanZone["kind"], string> = {
  room: "#F5F0E6",
  structure: "#EFE8D8",
  outdoor: "#E5DAC6",
  water: "#9FB0B5", // one-off slate for water — reads "pool" on the warm palette
  hardscape: "#DCD2BE",
};

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

function PlanSheetSVG({
  sheet,
  activeZoneId,
  onZoneClick,
  indicatorRef,
  authorMode,
  onCanvasClick,
  fit,
}: {
  sheet: PlanSheet;
  activeZoneId?: string;
  onZoneClick: (zone: PlanZone) => void;
  /** Mutated each frame by the player loop — the traveling dot + view cone. */
  indicatorRef?: React.RefObject<SVGGElement | null>;
  /** Author mode: every click reports plan coords instead of zone actions. */
  authorMode?: boolean;
  onCanvasClick?: (x: number, y: number) => void;
  /** Expanded/pop-out mode: fit the sheet inside the viewport height too. */
  fit?: boolean;
}) {
  const labelBase = Math.max(sheet.width, sheet.height) * 0.034;
  const indScale = Math.max(sheet.width, sheet.height) * 0.014;
  const hasFlightPath = !!(sheet.paths && Object.keys(sheet.paths).length);

  // ----- zoom / pan (viewBox-driven, so the click→plan mapping stays exact) -----
  const full = { x: 0, y: 0, w: sheet.width, h: sheet.height };
  const [view, setView] = useState(full);
  const svgRef = useRef<SVGSVGElement>(null);
  const pan = useRef<{ cx: number; cy: number; vx: number; vy: number; vw: number; vh: number } | null>(null);
  const didPan = useRef(false);

  // reset the view whenever the sheet changes
  useEffect(() => {
    setView({ x: 0, y: 0, w: sheet.width, h: sheet.height });
  }, [sheet.id, sheet.width, sheet.height]);

  const zoomAt = useCallback(
    (factor: number, ox: number, oy: number) => {
      const el = svgRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      setView((v) => {
        const fw = sheet.width, fh = sheet.height;
        const planX = v.x + (ox / rect.width) * v.w;
        const planY = v.y + (oy / rect.height) * v.h;
        let nw = clamp(v.w * factor, fw * 0.06, fw);
        let nh = clamp(v.h * factor, fh * 0.06, fh);
        // keep aspect locked to the sheet
        nh = nw * (fh / fw);
        let nx = clamp(planX - (ox / rect.width) * nw, 0, fw - nw);
        let ny = clamp(planY - (oy / rect.height) * nh, 0, fh - nh);
        return { x: nx, y: ny, w: nw, h: nh };
      });
    },
    [sheet.width, sheet.height],
  );

  // non-passive wheel so we can preventDefault the page scroll
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      zoomAt(e.deltaY > 0 ? 1.18 : 1 / 1.18, e.clientX - rect.left, e.clientY - rect.top);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  const onDown = (e: React.PointerEvent) => {
    didPan.current = false;
    if (view.w >= sheet.width - 0.5) return; // not zoomed → let taps fall straight through to jump
    pan.current = { cx: e.clientX, cy: e.clientY, vx: view.x, vy: view.y, vw: view.w, vh: view.h };
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    const p = pan.current;
    const el = svgRef.current;
    if (!p || !el) return;
    const rect = el.getBoundingClientRect();
    if (Math.hypot(e.clientX - p.cx, e.clientY - p.cy) > 4) didPan.current = true;
    const dx = (e.clientX - p.cx) * (p.vw / rect.width);
    const dy = (e.clientY - p.cy) * (p.vh / rect.height);
    setView((v) => ({
      ...v,
      x: clamp(p.vx - dx, 0, sheet.width - v.w),
      y: clamp(p.vy - dy, 0, sheet.height - v.h),
    }));
  };
  const onUp = () => {
    pan.current = null;
  };

  const zoomed = view.w < sheet.width - 0.5;

  return (
    <div className="relative">
      <svg
        ref={svgRef}
        viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
        className={fit ? "mx-auto block" : "block h-auto w-full"}
        style={{
          touchAction: "none",
          cursor: zoomed ? "grab" : undefined,
          ...(fit ? { maxHeight: "68vh", width: "auto", maxWidth: "100%" } : null),
        }}
        role="group"
        aria-label={`${sheet.label} plan`}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerLeave={onUp}
        onClick={
          authorMode && onCanvasClick
            ? (e) => {
                if (didPan.current) return;
                const svg = e.currentTarget;
                const m = svg.getScreenCTM();
                if (!m) return;
                const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
                onCanvasClick(Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10);
              }
            : undefined
        }
      >
        {/* Base — stacked layers (aerial / ortho / satellite) if present, else the
            legacy single satUrl, else the cream card */}
        {sheet.layers?.length ? (
          sheet.layers.map((L) =>
            L.visible === false ? null : (
              <image
                key={L.id}
                href={L.url}
                x={L.x ?? 0}
                y={L.y ?? 0}
                width={L.width ?? sheet.width}
                height={L.height ?? sheet.height}
                opacity={L.opacity ?? 1}
                preserveAspectRatio="none"
                transform={layerTransform(L, sheet.width, sheet.height)}
              />
            ),
          )
        ) : sheet.satUrl ? (
          <image
            href={sheet.satUrl}
            x={0}
            y={0}
            width={sheet.width}
            height={sheet.height}
            preserveAspectRatio="none"
          />
        ) : (
          <rect x={0} y={0} width={sheet.width} height={sheet.height} fill="#FBF8F1" />
        )}

        {/* The flight path line is intentionally omitted — the living gold dot
            (position + heading, driven each frame) carries the motion. */}

        {sheet.zones.map((z) => {
          const active = z.id === activeZoneId;
          // Any named amenity is tappable: it has a pano/time, OR the sheet has a
          // georeferenced flight path we can fly to (GPS/VSLAM closest approach).
          const interactive =
            !authorMode &&
            !!z.label &&
            (z.panoId !== undefined || z.videoTime !== undefined || hasFlightPath);
          const [cx, cy] = centroidOf(z.points);
          const fs = zoneFontSize(z.points, z.label, labelBase, labelBase * 0.34);
          const d = `M ${z.points.map(([x, y]) => `${x} ${y}`).join(" L ")} Z`;
          return (
            <g key={z.id}>
              <path
                d={d}
                fill={active ? "#B7995C" : sheet.satUrl ? "#B7995C" : ZONE_FILL[z.kind]}
                fillOpacity={active ? 0.55 : sheet.satUrl ? 0.22 : 1}
                stroke={active ? "#A6863F" : sheet.satUrl ? "#E9C77E" : "#CBBC9C"}
                strokeWidth={sheet.width * 0.004}
                className={cn(
                  interactive &&
                    "cursor-pointer transition-[fill-opacity] hover:fill-champagne hover:fill-opacity-40",
                )}
                role={interactive ? "button" : undefined}
                tabIndex={interactive ? 0 : undefined}
                aria-label={
                  interactive
                    ? `${z.label} — ${z.panoId ? "step inside" : "fly there"}`
                    : z.label
                }
                onClick={interactive ? () => { if (!didPan.current) onZoneClick(z); } : undefined}
                onKeyDown={
                  interactive
                    ? (e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          onZoneClick(z);
                        }
                      }
                    : undefined
                }
              />
              {z.label && (
                <text
                  x={cx}
                  y={cy}
                  textAnchor="middle"
                  dominantBaseline="central"
                  fontSize={fs}
                  letterSpacing={fs * 0.12}
                  fill={active ? "#211C16" : sheet.satUrl ? "#FBF8F1" : "#6B5D45"}
                  className="pointer-events-none select-none font-sans uppercase [paint-order:stroke]"
                  stroke={sheet.satUrl && !active ? "#211C16" : undefined}
                  strokeWidth={sheet.satUrl && !active ? fs * 0.12 : undefined}
                  strokeOpacity={0.5}
                >
                  {z.label}
                </text>
              )}
              {interactive && (
                <circle
                  cx={cx}
                  cy={cy + fs * 1.3}
                  r={sheet.width * 0.008}
                  fill="#B7995C"
                  className="pointer-events-none"
                />
              )}
            </g>
          );
        })}

        {/* Exterior walls / boundaries */}
        {sheet.strokes?.map((line, i) => (
          <polyline
            key={i}
            points={line.map(([x, y]) => `${x},${y}`).join(" ")}
            fill="none"
            stroke={sheet.kind === "floor" ? "#3A3026" : "#6B5D45"}
            strokeWidth={sheet.width * (sheet.kind === "floor" ? 0.012 : 0.006)}
            strokeDasharray={sheet.kind === "site" ? `${sheet.width * 0.015} ${sheet.width * 0.012}` : undefined}
            strokeLinejoin="miter"
            className="pointer-events-none"
          />
        ))}

        {/* You-are-here — positioned/rotated each frame by the player loop */}
        {indicatorRef && (
          <g ref={indicatorRef} style={{ display: "none" }} aria-hidden>
            <g transform={`scale(${indScale})`}>
              {/* view cone points "up"; the loop rotates the outer group */}
              <path d="M 0 0 L -2.4 -5.6 A 6.1 6.1 0 0 1 2.4 -5.6 Z" fill="#B7995C" fillOpacity={0.35} />
              <circle r={2.6} fill="none" stroke="#B7995C" strokeOpacity={0.45} strokeWidth={0.35} className="motion-safe:animate-ping" style={{ transformOrigin: "0 0" }} />
              <circle r={1.5} fill="#A6863F" stroke="#FBF8F1" strokeWidth={0.45} />
            </g>
          </g>
        )}
      </svg>

      {/* zoom controls */}
      <div className="absolute right-1.5 top-1.5 flex flex-col gap-1">
        <button
          type="button"
          aria-label="Zoom in"
          onClick={() => zoomAt(1 / 1.5, (svgRef.current?.clientWidth ?? 0) / 2, (svgRef.current?.clientHeight ?? 0) / 2)}
          className="flex h-6 w-6 items-center justify-center rounded border border-champagne/50 bg-ink/80 text-sm leading-none text-paper/90 backdrop-blur transition-colors hover:border-champagne hover:text-champagne"
        >
          +
        </button>
        <button
          type="button"
          aria-label="Zoom out"
          onClick={() => zoomAt(1.5, (svgRef.current?.clientWidth ?? 0) / 2, (svgRef.current?.clientHeight ?? 0) / 2)}
          className="flex h-6 w-6 items-center justify-center rounded border border-champagne/50 bg-ink/80 text-sm leading-none text-paper/90 backdrop-blur transition-colors hover:border-champagne hover:text-champagne"
        >
          −
        </button>
        {zoomed && (
          <button
            type="button"
            aria-label="Reset zoom"
            onClick={() => setView({ x: 0, y: 0, w: sheet.width, h: sheet.height })}
            className="flex h-6 w-6 items-center justify-center rounded border border-champagne/50 bg-ink/80 text-[0.7rem] leading-none text-paper/90 backdrop-blur transition-colors hover:border-champagne hover:text-champagne"
          >
            ⤢
          </button>
        )}
      </div>
    </div>
  );
}

export function PlanPanel({
  plan,
  activeSheetId,
  onSheetChange,
  activeZoneId,
  onZoneClick,
  onClose,
  indicatorRef,
  authorMode,
  onCanvasClick,
  className,
  expanded,
  onToggleExpand,
}: {
  plan: Plan;
  activeSheetId: string;
  onSheetChange: (id: string) => void;
  activeZoneId?: string;
  onZoneClick: (zone: PlanZone) => void;
  onClose: () => void;
  indicatorRef?: React.RefObject<SVGGElement | null>;
  authorMode?: boolean;
  onCanvasClick?: (x: number, y: number) => void;
  className?: string;
  /** Pop-out: the plan is a hero feature — let it take the stage. */
  expanded?: boolean;
  onToggleExpand?: () => void;
}) {
  const sheet =
    plan.sheets.find((s) => s.id === activeSheetId) ?? plan.sheets[0];
  return (
    <div
      className={cn(
        "w-[clamp(14rem,30cqw,26rem)] overflow-hidden rounded border border-champagne/40 bg-ink/85 backdrop-blur",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <div className="flex items-center gap-1">
          {plan.sheets.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => onSheetChange(s.id)}
              className={cn(
                "rounded-full px-[1em] py-[0.35em] font-sans text-[clamp(0.5625rem,0.7cqw,0.875rem)] uppercase tracking-[0.16em] transition-colors",
                s.id === sheet.id
                  ? "bg-champagne text-ink"
                  : "text-paper/70 hover:text-champagne",
              )}
            >
              {s.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2.5">
          {onToggleExpand && (
            <button
              type="button"
              onClick={onToggleExpand}
              aria-label={expanded ? "Shrink plan" : "Expand plan"}
              aria-pressed={expanded}
              className="font-sans text-[clamp(0.75rem,0.8cqw,1rem)] text-paper/60 transition-colors hover:text-champagne"
            >
              {expanded ? "⤡" : "⤢"}
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close plan"
            className="font-sans text-[clamp(0.75rem,0.8cqw,1rem)] text-paper/60 transition-colors hover:text-champagne"
          >
            ✕
          </button>
        </div>
      </div>
      <div className="border-t border-champagne/25 p-2">
        <PlanSheetSVG
          sheet={sheet}
          activeZoneId={activeZoneId}
          onZoneClick={onZoneClick}
          indicatorRef={indicatorRef}
          authorMode={authorMode}
          onCanvasClick={onCanvasClick}
          fit={expanded}
        />
      </div>
      <p className="px-3 pb-2 font-sans text-[clamp(0.5625rem,0.65cqw,0.8125rem)] uppercase tracking-[0.14em] text-paper/45">
        {authorMode ? "Author mode · click the plan to drop a path key" : "Scroll/pinch to zoom · tap a space to fly there"}
      </p>
    </div>
  );
}
