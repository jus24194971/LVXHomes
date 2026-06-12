"use client";

import type { Plan, PlanSheet, PlanZone } from "@/data/plans";
import { cn } from "@/lib/utils";

/**
 * The living minimap — renders a plan sheet (floor or grounds) in brand
 * style and lets the viewer tap a zone to jump the flight there.
 */

// Zone fills per kind, tuned for the cream plan card.
const ZONE_FILL: Record<PlanZone["kind"], string> = {
  room: "#F5F0E6",
  structure: "#EFE8D8",
  outdoor: "#E5DAC6",
  water: "#9FB0B5", // one-off slate for water — reads "pool" on the warm palette
  hardscape: "#DCD2BE",
};

const centroid = (pts: [number, number][]): [number, number] => {
  let x = 0;
  let y = 0;
  for (const [px, py] of pts) {
    x += px;
    y += py;
  }
  return [x / pts.length, y / pts.length];
};

function PlanSheetSVG({
  sheet,
  activeZoneId,
  onZoneClick,
}: {
  sheet: PlanSheet;
  activeZoneId?: string;
  onZoneClick: (zone: PlanZone) => void;
}) {
  const labelSize = Math.max(sheet.width, sheet.height) * 0.034;
  return (
    <svg
      viewBox={`0 0 ${sheet.width} ${sheet.height}`}
      className="block h-auto w-full"
      role="group"
      aria-label={`${sheet.label} plan`}
    >
      {/* Plan card */}
      <rect x={0} y={0} width={sheet.width} height={sheet.height} fill="#FBF8F1" />

      {sheet.zones.map((z) => {
        const active = z.id === activeZoneId;
        const interactive = z.panoId !== undefined || z.videoTime !== undefined;
        const [cx, cy] = centroid(z.points);
        const d = `M ${z.points.map(([x, y]) => `${x} ${y}`).join(" L ")} Z`;
        return (
          <g key={z.id}>
            <path
              d={d}
              fill={active ? "#B7995C" : ZONE_FILL[z.kind]}
              fillOpacity={active ? 0.55 : 1}
              stroke={active ? "#A6863F" : "#CBBC9C"}
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
              onClick={interactive ? () => onZoneClick(z) : undefined}
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
            <text
              x={cx}
              y={cy}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={labelSize}
              letterSpacing={labelSize * 0.12}
              fill={active ? "#211C16" : "#6B5D45"}
              className="pointer-events-none select-none font-sans uppercase"
            >
              {z.label}
            </text>
            {interactive && (
              <circle
                cx={cx}
                cy={cy + labelSize * 1.3}
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
        />
      ))}
    </svg>
  );
}

export function PlanPanel({
  plan,
  activeSheetId,
  onSheetChange,
  activeZoneId,
  onZoneClick,
  onClose,
  className,
}: {
  plan: Plan;
  activeSheetId: string;
  onSheetChange: (id: string) => void;
  activeZoneId?: string;
  onZoneClick: (zone: PlanZone) => void;
  onClose: () => void;
  className?: string;
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
        <button
          type="button"
          onClick={onClose}
          aria-label="Close plan"
          className="font-sans text-[clamp(0.75rem,0.8cqw,1rem)] text-paper/60 transition-colors hover:text-champagne"
        >
          ✕
        </button>
      </div>
      <div className="border-t border-champagne/25 p-2">
        <PlanSheetSVG
          sheet={sheet}
          activeZoneId={activeZoneId}
          onZoneClick={onZoneClick}
        />
      </div>
      <p className="px-3 pb-2 font-sans text-[clamp(0.5625rem,0.65cqw,0.8125rem)] uppercase tracking-[0.14em] text-paper/45">
        Tap a space to fly there
      </p>
    </div>
  );
}
