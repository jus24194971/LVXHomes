"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Plan, PlanSheet, PlanZone, PlanZoneKind } from "@/data/plans";
import { PLANS } from "@/data/plans";
import { ZONE_FILL } from "@/components/tour/plan";
import { loadDoc, saveDoc } from "@/lib/author-client";
import { cn } from "@/lib/utils";

/**
 * LVX Floorplan Studio — Phase B.
 *
 * In-browser editor for plan sheets (floors AND grounds/site plans):
 *   · draw zones (click vertices, Enter/click-the-first-dot to close)
 *   · draw strokes (exterior walls, boundaries)
 *   · select / drag vertices / drag whole zones / delete
 *   · trace mode: dim any reference image (builder plan, sketch, CubiCasa
 *     export, SLAM wall-evidence) under the canvas and draw over it
 *   · multi-sheet (floors + grounds), link zones to chapters/times/panos
 *   · import existing plans, export JSON ready for data/plans.ts
 *
 * No backend by design — output is pasted into the repo like all authoring.
 */

const SNAP = 0.5;
const snap = (n: number) => Math.round(n / SNAP) * SNAP;

const KINDS: PlanZoneKind[] = ["room", "structure", "outdoor", "water", "hardscape"];

type Tool = "select" | "zone" | "stroke" | "trace";

type TraceImg = { url: string; opacity: number; scale: number; x: number; y: number };

type Drag =
  | { type: "vertex"; zi: number; vi: number }
  | { type: "zone"; zi: number; start: [number, number]; orig: [number, number][] }
  | { type: "trace"; start: [number, number]; origX: number; origY: number }
  | null;

const newSheet = (kind: "floor" | "site", n: number): PlanSheet => ({
  id: `sheet-${n}`,
  label: kind === "floor" ? `Floor ${n}` : "Grounds",
  kind,
  width: kind === "floor" ? 100 : 140,
  height: kind === "floor" ? 70 : 100,
  zones: [],
  strokes: [],
});

const slugify = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "zone";

export function PlanEditor() {
  const [tourSlug, setTourSlug] = useState("test");
  const [sheets, setSheets] = useState<PlanSheet[]>([newSheet("floor", 1)]);
  const [sheetIdx, setSheetIdx] = useState(0);
  const [tool, setTool] = useState<Tool>("zone");
  const [draft, setDraft] = useState<[number, number][]>([]);
  const [selZone, setSelZone] = useState<number | null>(null);
  const [selVertex, setSelVertex] = useState<number | null>(null);
  const [traces, setTraces] = useState<Record<string, TraceImg>>({});
  const [showExport, setShowExport] = useState(false);
  const [importText, setImportText] = useState("");
  const [copied, setCopied] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [saveMsg, setSaveMsg] = useState("");

  const svgRef = useRef<SVGSVGElement>(null);
  const dragRef = useRef<Drag>(null);
  const undoStack = useRef<string[]>([]);

  const sheet = sheets[sheetIdx];
  const trace = sheet ? traces[sheet.id] : undefined;

  const snapshot = useCallback(() => {
    undoStack.current.push(JSON.stringify(sheets));
    if (undoStack.current.length > 60) undoStack.current.shift();
  }, [sheets]);

  const undo = useCallback(() => {
    const prev = undoStack.current.pop();
    if (!prev) return;
    setSheets(JSON.parse(prev) as PlanSheet[]);
    setSelZone(null);
    setSelVertex(null);
  }, []);

  const mutateSheet = useCallback(
    (fn: (s: PlanSheet) => PlanSheet) => {
      setSheets((prev) => prev.map((s, i) => (i === sheetIdx ? fn(s) : s)));
    },
    [sheetIdx],
  );

  /** Client coords → snapped plan units. */
  const toPlan = useCallback((e: { clientX: number; clientY: number }): [number, number] => {
    const svg = svgRef.current;
    if (!svg) return [0, 0];
    const m = svg.getScreenCTM();
    if (!m) return [0, 0];
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    return [snap(p.x), snap(p.y)];
  }, []);

  // ---------- drawing ----------
  const commitDraft = useCallback(() => {
    if (tool === "zone" && draft.length >= 3) {
      snapshot();
      const n = sheet.zones.length + 1;
      mutateSheet((s) => ({
        ...s,
        zones: [
          ...s.zones,
          { id: `${slugify(s.label)}-z${n}`, label: `Room ${n}`, kind: s.kind === "site" ? "outdoor" : "room", points: draft },
        ],
      }));
      setSelZone(sheet.zones.length);
      setSelVertex(null);
      setTool("select");
    } else if (tool === "stroke" && draft.length >= 2) {
      snapshot();
      mutateSheet((s) => ({ ...s, strokes: [...(s.strokes ?? []), draft] }));
    }
    setDraft([]);
  }, [tool, draft, sheet, mutateSheet, snapshot]);

  const onSvgClick = useCallback(
    (e: React.MouseEvent) => {
      if (tool !== "zone" && tool !== "stroke") return;
      const pt = toPlan(e);
      // Closing click on the first vertex finishes a zone.
      if (tool === "zone" && draft.length >= 3) {
        const [fx, fy] = draft[0];
        if (Math.hypot(pt[0] - fx, pt[1] - fy) < 2) {
          commitDraft();
          return;
        }
      }
      setDraft((d) => [...d, pt]);
    },
    [tool, draft, toPlan, commitDraft],
  );

  // ---------- select / drag ----------
  const onSvgPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (tool === "trace" && trace) {
        dragRef.current = { type: "trace", start: toPlan(e), origX: trace.x, origY: trace.y };
        return;
      }
      if (tool !== "select") return;
      // background press clears selection (zones/vertices stop propagation)
      setSelZone(null);
      setSelVertex(null);
    },
    [tool, trace, toPlan],
  );

  const onSvgPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const pt = toPlan(e);
      if (drag.type === "vertex") {
        mutateSheet((s) => ({
          ...s,
          zones: s.zones.map((z, zi) =>
            zi === drag.zi
              ? { ...z, points: z.points.map((p, vi) => (vi === drag.vi ? pt : p)) }
              : z,
          ),
        }));
      } else if (drag.type === "zone") {
        const dx = pt[0] - drag.start[0];
        const dy = pt[1] - drag.start[1];
        mutateSheet((s) => ({
          ...s,
          zones: s.zones.map((z, zi) =>
            zi === drag.zi
              ? { ...z, points: drag.orig.map(([x, y]) => [snap(x + dx), snap(y + dy)] as [number, number]) }
              : z,
          ),
        }));
      } else if (drag.type === "trace" && sheet) {
        const dx = pt[0] - drag.start[0];
        const dy = pt[1] - drag.start[1];
        setTraces((t) => ({
          ...t,
          [sheet.id]: { ...t[sheet.id], x: drag.origX + dx, y: drag.origY + dy },
        }));
      }
    },
    [toPlan, mutateSheet, sheet],
  );

  const endDrag = useCallback(() => {
    dragRef.current = null;
  }, []);

  // ---------- keyboard ----------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.key === "Enter") commitDraft();
      else if (e.key === "Escape") {
        setDraft([]);
        setSelZone(null);
        setSelVertex(null);
      } else if (e.key === "Delete" || e.key === "Backspace") {
        if (selZone === null) return;
        e.preventDefault();
        snapshot();
        if (selVertex !== null && sheet.zones[selZone]?.points.length > 3) {
          mutateSheet((s) => ({
            ...s,
            zones: s.zones.map((z, zi) =>
              zi === selZone ? { ...z, points: z.points.filter((_, vi) => vi !== selVertex) } : z,
            ),
          }));
          setSelVertex(null);
        } else {
          mutateSheet((s) => ({ ...s, zones: s.zones.filter((_, zi) => zi !== selZone) }));
          setSelZone(null);
          setSelVertex(null);
        }
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        undo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [commitDraft, selZone, selVertex, sheet, mutateSheet, snapshot, undo]);

  // ---------- zone meta ----------
  const updateZone = useCallback(
    (zi: number, patch: Partial<PlanZone>) => {
      mutateSheet((s) => ({
        ...s,
        zones: s.zones.map((z, i) => (i === zi ? { ...z, ...patch } : z)),
      }));
    },
    [mutateSheet],
  );

  // ---------- import / export ----------
  const exportJson = JSON.stringify({ tourSlug, sheets } satisfies Plan, null, 2);

  const loadPlan = useCallback((plan: Plan) => {
    undoStack.current = [];
    setTourSlug(plan.tourSlug);
    setSheets(JSON.parse(JSON.stringify(plan.sheets)) as PlanSheet[]);
    setSheetIdx(0);
    setSelZone(null);
    setSelVertex(null);
    setDraft([]);
  }, []);

  const importFromText = useCallback(() => {
    try {
      const parsed = JSON.parse(importText) as Plan;
      if (!Array.isArray(parsed.sheets)) throw new Error("no sheets");
      loadPlan(parsed);
      setImportText("");
    } catch {
      alert("Couldn't parse that JSON — expected a Plan ({ tourSlug, sheets }).");
    }
  }, [importText, loadPlan]);

  // ---------- live site (Zero Trust backend) ----------
  const saveToSite = useCallback(async () => {
    setSaveState("saving");
    setSaveMsg("");
    try {
      await saveDoc("plan", tourSlug, { tourSlug, sheets } satisfies Plan);
      setSaveState("saved");
      setTimeout(() => setSaveState("idle"), 2200);
    } catch (e) {
      setSaveState("error");
      setSaveMsg(e instanceof Error ? e.message : "Save failed");
    }
  }, [tourSlug, sheets]);

  const loadFromSite = useCallback(async () => {
    try {
      const doc = await loadDoc<Plan>("plan", tourSlug);
      if (doc && Array.isArray(doc.sheets)) loadPlan(doc);
      else alert(`No saved plan for "${tourSlug}" yet.`);
    } catch (e) {
      alert(e instanceof Error ? e.message : "Load failed");
    }
  }, [tourSlug, loadPlan]);

  const onTraceFile = useCallback(
    (file: File | undefined) => {
      if (!file || !sheet) return;
      const url = URL.createObjectURL(file);
      setTraces((t) => ({ ...t, [sheet.id]: { url, opacity: 0.4, scale: 1, x: 0, y: 0 } }));
      setTool("trace");
    },
    [sheet],
  );

  const centroid = (pts: [number, number][]): [number, number] => {
    let x = 0, y = 0;
    for (const [px, py] of pts) { x += px; y += py; }
    return [x / pts.length, y / pts.length];
  };

  if (!sheet) return null;

  const labelSize = Math.max(sheet.width, sheet.height) * 0.03;
  const handleR = Math.max(sheet.width, sheet.height) * 0.012;

  const toolBtn = (t: Tool, label: string) => (
    <button
      key={t}
      type="button"
      onClick={() => { setTool(t); setDraft([]); }}
      className={cn(
        "rounded border px-3 py-1.5 font-sans text-[0.6875rem] uppercase tracking-[0.14em] transition-colors",
        tool === t
          ? "border-champagne bg-champagne text-ink"
          : "border-paper/30 text-paper/70 hover:border-champagne/60 hover:text-champagne",
      )}
    >
      {label}
    </button>
  );

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
      {/* ---------- canvas ---------- */}
      <div>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {sheets.map((s, i) => (
            <button
              key={s.id}
              type="button"
              onClick={() => { setSheetIdx(i); setSelZone(null); setSelVertex(null); setDraft([]); }}
              className={cn(
                "rounded-full px-4 py-1.5 font-sans text-[0.6875rem] uppercase tracking-[0.16em] transition-colors",
                i === sheetIdx ? "bg-champagne text-ink" : "text-paper/70 hover:text-champagne",
              )}
            >
              {s.label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => { snapshot(); setSheets((p) => [...p, newSheet("floor", p.length + 1)]); setSheetIdx(sheets.length); }}
            className="rounded-full border border-paper/30 px-3 py-1.5 font-sans text-[0.6875rem] uppercase tracking-[0.14em] text-paper/70 hover:border-champagne/60 hover:text-champagne"
          >
            + Floor
          </button>
          <button
            type="button"
            onClick={() => { snapshot(); setSheets((p) => [...p, newSheet("site", p.length + 1)]); setSheetIdx(sheets.length); }}
            className="rounded-full border border-paper/30 px-3 py-1.5 font-sans text-[0.6875rem] uppercase tracking-[0.14em] text-paper/70 hover:border-champagne/60 hover:text-champagne"
          >
            + Grounds
          </button>
        </div>

        <div className="mb-3 flex flex-wrap items-center gap-2">
          {toolBtn("select", "Select")}
          {toolBtn("zone", "Draw zone")}
          {toolBtn("stroke", "Draw wall")}
          <label className="cursor-pointer rounded border border-paper/30 px-3 py-1.5 font-sans text-[0.6875rem] uppercase tracking-[0.14em] text-paper/70 hover:border-champagne/60 hover:text-champagne">
            Trace image…
            <input type="file" accept="image/*" className="hidden" onChange={(e) => onTraceFile(e.target.files?.[0])} />
          </label>
          {trace && (
            <>
              {toolBtn("trace", "Move trace")}
              <label className="flex items-center gap-2 font-sans text-[0.625rem] uppercase tracking-[0.14em] text-paper/60">
                Dim
                <input
                  type="range" min={0.1} max={1} step={0.05} value={trace.opacity}
                  onChange={(e) => setTraces((t) => ({ ...t, [sheet.id]: { ...trace, opacity: Number(e.target.value) } }))}
                />
              </label>
              <label className="flex items-center gap-2 font-sans text-[0.625rem] uppercase tracking-[0.14em] text-paper/60">
                Size
                <input
                  type="range" min={0.2} max={3} step={0.05} value={trace.scale}
                  onChange={(e) => setTraces((t) => ({ ...t, [sheet.id]: { ...trace, scale: Number(e.target.value) } }))}
                />
              </label>
            </>
          )}
          <span className="ml-auto font-sans text-[0.625rem] uppercase tracking-[0.14em] text-paper/40">
            Enter closes · Esc cancels · Del removes · Ctrl+Z undo
          </span>
        </div>

        <svg
          ref={svgRef}
          viewBox={`-2 -2 ${sheet.width + 4} ${sheet.height + 4}`}
          className={cn(
            "block w-full touch-none border border-champagne/30 bg-[#FBF8F1]",
            (tool === "zone" || tool === "stroke") && "cursor-crosshair",
            tool === "trace" && trace && "cursor-move",
          )}
          onClick={onSvgClick}
          onPointerDown={onSvgPointerDown}
          onPointerMove={onSvgPointerMove}
          onPointerUp={endDrag}
          onPointerLeave={endDrag}
        >
          {/* grid */}
          <defs>
            <pattern id="grid" width={5} height={5} patternUnits="userSpaceOnUse">
              <path d={`M 5 0 L 0 0 0 5`} fill="none" stroke="#B7995C" strokeOpacity={0.12} strokeWidth={0.15} />
            </pattern>
          </defs>
          <rect x={0} y={0} width={sheet.width} height={sheet.height} fill="url(#grid)" stroke="#CBBC9C" strokeWidth={0.3} />

          {/* trace underlay */}
          {trace && (
            <image
              href={trace.url}
              x={trace.x}
              y={trace.y}
              width={sheet.width * trace.scale}
              opacity={trace.opacity}
              preserveAspectRatio="xMinYMin meet"
            />
          )}

          {/* zones */}
          {sheet.zones.map((z, zi) => {
            const [cx, cy] = centroid(z.points);
            const selected = zi === selZone;
            return (
              <g key={z.id}>
                <path
                  d={`M ${z.points.map(([x, y]) => `${x} ${y}`).join(" L ")} Z`}
                  fill={ZONE_FILL[z.kind]}
                  fillOpacity={selected ? 0.95 : 0.8}
                  stroke={selected ? "#A6863F" : "#CBBC9C"}
                  strokeWidth={selected ? 0.6 : 0.3}
                  className={tool === "select" ? "cursor-pointer" : undefined}
                  onPointerDown={(e) => {
                    if (tool !== "select") return;
                    e.stopPropagation();
                    setSelZone(zi);
                    setSelVertex(null);
                    dragRef.current = { type: "zone", zi, start: toPlan(e), orig: z.points.map((p) => [...p] as [number, number]) };
                  }}
                />
                <text
                  x={cx} y={cy} textAnchor="middle" dominantBaseline="central"
                  fontSize={labelSize} letterSpacing={labelSize * 0.1}
                  fill="#6B5D45" className="pointer-events-none select-none font-sans uppercase"
                >
                  {z.label}
                </text>
                {selected && tool === "select" &&
                  z.points.map(([x, y], vi) => (
                    <circle
                      key={vi}
                      cx={x} cy={y} r={handleR}
                      fill={vi === selVertex ? "#A6863F" : "#FBF8F1"}
                      stroke="#A6863F" strokeWidth={0.3}
                      className="cursor-grab"
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        snapshot();
                        setSelVertex(vi);
                        dragRef.current = { type: "vertex", zi, vi };
                      }}
                    />
                  ))}
              </g>
            );
          })}

          {/* committed strokes */}
          {sheet.strokes?.map((line, i) => (
            <polyline
              key={i}
              points={line.map(([x, y]) => `${x},${y}`).join(" ")}
              fill="none"
              stroke={sheet.kind === "floor" ? "#3A3026" : "#6B5D45"}
              strokeWidth={sheet.width * (sheet.kind === "floor" ? 0.012 : 0.006)}
              strokeDasharray={sheet.kind === "site" ? `${sheet.width * 0.015} ${sheet.width * 0.012}` : undefined}
            />
          ))}

          {/* draft */}
          {draft.length > 0 && (
            <g>
              <polyline
                points={draft.map(([x, y]) => `${x},${y}`).join(" ")}
                fill="none" stroke="#B7995C" strokeWidth={0.4} strokeDasharray="1 0.8"
              />
              {draft.map(([x, y], i) => (
                <circle key={i} cx={x} cy={y} r={i === 0 ? handleR * 1.4 : handleR * 0.8} fill={i === 0 ? "#B7995C" : "#A6863F"} />
              ))}
            </g>
          )}
        </svg>
      </div>

      {/* ---------- side panel ---------- */}
      <div className="flex flex-col gap-5 font-sans text-sm text-paper/85">
        {/* sheet meta */}
        <div className="rounded border border-paper/15 p-4">
          <p className="font-display text-[0.6875rem] uppercase tracking-[0.2em] text-champagne">Sheet</p>
          <div className="mt-3 flex flex-col gap-2">
            <input
              value={sheet.label}
              onChange={(e) => mutateSheet((s) => ({ ...s, label: e.target.value }))}
              className="rounded border border-paper/20 bg-transparent px-2 py-1.5 text-paper outline-none focus:border-champagne"
            />
            <div className="flex items-center gap-2 text-xs text-paper/60">
              <label>W <input type="number" value={sheet.width} onChange={(e) => mutateSheet((s) => ({ ...s, width: Number(e.target.value) || s.width }))} className="w-16 rounded border border-paper/20 bg-transparent px-1 py-0.5 text-paper" /></label>
              <label>H <input type="number" value={sheet.height} onChange={(e) => mutateSheet((s) => ({ ...s, height: Number(e.target.value) || s.height }))} className="w-16 rounded border border-paper/20 bg-transparent px-1 py-0.5 text-paper" /></label>
              <span className="text-paper/40">{sheet.kind}</span>
              {sheets.length > 1 && (
                <button
                  type="button"
                  onClick={() => { snapshot(); setSheets((p) => p.filter((_, i) => i !== sheetIdx)); setSheetIdx(0); }}
                  className="ml-auto text-paper/50 hover:text-champagne"
                >
                  Delete sheet
                </button>
              )}
            </div>
          </div>
        </div>

        {/* selected zone */}
        <div className="rounded border border-paper/15 p-4">
          <p className="font-display text-[0.6875rem] uppercase tracking-[0.2em] text-champagne">
            {selZone !== null && sheet.zones[selZone] ? "Selected zone" : "Zones"}
          </p>
          {selZone !== null && sheet.zones[selZone] ? (
            <div className="mt-3 flex flex-col gap-2 text-xs">
              <label className="flex flex-col gap-1 text-paper/60">
                Label
                <input
                  value={sheet.zones[selZone].label}
                  onChange={(e) => updateZone(selZone, { label: e.target.value, id: `${slugify(e.target.value)}-${selZone}` })}
                  className="rounded border border-paper/20 bg-transparent px-2 py-1.5 text-sm text-paper outline-none focus:border-champagne"
                />
              </label>
              <label className="flex flex-col gap-1 text-paper/60">
                Kind
                <select
                  value={sheet.zones[selZone].kind}
                  onChange={(e) => updateZone(selZone, { kind: e.target.value as PlanZoneKind })}
                  className="rounded border border-paper/20 bg-ink px-2 py-1.5 text-sm text-paper outline-none focus:border-champagne"
                >
                  {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
                </select>
              </label>
              <div className="grid grid-cols-2 gap-2">
                <label className="flex flex-col gap-1 text-paper/60">
                  Chapter id
                  <input
                    value={sheet.zones[selZone].chapterId ?? ""}
                    onChange={(e) => updateZone(selZone, { chapterId: e.target.value || undefined })}
                    placeholder="(first)"
                    className="rounded border border-paper/20 bg-transparent px-2 py-1.5 text-sm text-paper outline-none focus:border-champagne"
                  />
                </label>
                <label className="flex flex-col gap-1 text-paper/60">
                  Video time (s)
                  <input
                    type="number"
                    value={sheet.zones[selZone].videoTime ?? ""}
                    onChange={(e) => updateZone(selZone, { videoTime: e.target.value === "" ? undefined : Number(e.target.value) })}
                    className="rounded border border-paper/20 bg-transparent px-2 py-1.5 text-sm text-paper outline-none focus:border-champagne"
                  />
                </label>
              </div>
              <label className="flex flex-col gap-1 text-paper/60">
                Pano id (overrides time)
                <input
                  value={sheet.zones[selZone].panoId ?? ""}
                  onChange={(e) => updateZone(selZone, { panoId: e.target.value || undefined })}
                  className="rounded border border-paper/20 bg-transparent px-2 py-1.5 text-sm text-paper outline-none focus:border-champagne"
                />
              </label>
            </div>
          ) : (
            <ul className="mt-3 flex max-h-44 flex-col gap-1 overflow-auto text-xs">
              {sheet.zones.length === 0 && <li className="text-paper/40">Draw your first zone →</li>}
              {sheet.zones.map((z, zi) => (
                <li key={z.id}>
                  <button
                    type="button"
                    onClick={() => { setTool("select"); setSelZone(zi); setSelVertex(null); }}
                    className="text-paper/75 hover:text-champagne"
                  >
                    {z.label} <span className="text-paper/35">· {z.kind}{z.panoId ? " · pano" : z.videoTime !== undefined ? ` · ${z.videoTime}s` : ""}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {(sheet.strokes?.length ?? 0) > 0 && (
            <button
              type="button"
              onClick={() => { snapshot(); mutateSheet((s) => ({ ...s, strokes: (s.strokes ?? []).slice(0, -1) })); }}
              className="mt-3 text-xs text-paper/50 hover:text-champagne"
            >
              Remove last wall ({sheet.strokes?.length})
            </button>
          )}
        </div>

        {/* io */}
        <div className="rounded border border-paper/15 p-4">
          <p className="font-display text-[0.6875rem] uppercase tracking-[0.2em] text-champagne">Plan</p>
          <label className="mt-3 flex items-center gap-2 text-xs text-paper/60">
            Tour slug
            <input
              value={tourSlug}
              onChange={(e) => setTourSlug(e.target.value)}
              className="flex-1 rounded border border-paper/20 bg-transparent px-2 py-1.5 text-sm text-paper outline-none focus:border-champagne"
            />
          </label>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => { setShowExport((v) => !v); }}
              className="rounded border border-champagne/60 px-3 py-1.5 text-xs uppercase tracking-[0.14em] text-champagne transition-colors hover:bg-champagne hover:text-ink"
            >
              {showExport ? "Hide JSON" : "Export JSON"}
            </button>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard?.writeText(exportJson).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                });
              }}
              className="rounded border border-paper/30 px-3 py-1.5 text-xs uppercase tracking-[0.14em] text-paper/70 hover:border-champagne/60 hover:text-champagne"
            >
              {copied ? "Copied" : "Copy"}
            </button>
            <button
              type="button"
              onClick={() => void saveToSite()}
              disabled={saveState === "saving"}
              className="rounded border border-champagne bg-champagne/90 px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.14em] text-ink transition-colors hover:bg-champagne disabled:opacity-40"
            >
              {saveState === "saving" ? "Saving…" : saveState === "saved" ? "Saved ✓" : "Save to site"}
            </button>
            <button
              type="button"
              onClick={() => void loadFromSite()}
              className="rounded border border-paper/30 px-3 py-1.5 text-xs uppercase tracking-[0.14em] text-paper/70 hover:border-champagne/60 hover:text-champagne"
            >
              Load from site
            </button>
            {PLANS.map((p) => (
              <button
                key={p.tourSlug}
                type="button"
                onClick={() => loadPlan(p)}
                className="rounded border border-paper/30 px-3 py-1.5 text-xs uppercase tracking-[0.14em] text-paper/70 hover:border-champagne/60 hover:text-champagne"
              >
                Load “{p.tourSlug}”
              </button>
            ))}
          </div>
          {saveState === "error" && (
            <p className="mt-2 text-xs leading-snug text-red-400">{saveMsg}</p>
          )}
          {showExport && (
            <textarea
              readOnly
              value={exportJson}
              data-testid="plan-export"
              className="mt-3 h-40 w-full rounded border border-paper/20 bg-ink/60 p-2 font-mono text-[0.625rem] leading-relaxed text-paper/80"
            />
          )}
          <details className="mt-3 text-xs text-paper/60">
            <summary className="cursor-pointer uppercase tracking-[0.14em] hover:text-champagne">Import JSON…</summary>
            <textarea
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              placeholder='Paste a Plan ({ "tourSlug": …, "sheets": […] })'
              className="mt-2 h-24 w-full rounded border border-paper/20 bg-ink/60 p-2 font-mono text-[0.625rem] text-paper/80"
            />
            <button
              type="button"
              onClick={importFromText}
              className="mt-2 rounded border border-paper/30 px-3 py-1.5 uppercase tracking-[0.14em] text-paper/70 hover:border-champagne/60 hover:text-champagne"
            >
              Load
            </button>
          </details>
        </div>
      </div>
    </div>
  );
}
