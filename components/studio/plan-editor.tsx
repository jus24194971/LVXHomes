"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Plan, PlanSheet, PlanZone, PlanZoneKind, PlanWall } from "@/data/plans";
import { PLANS, layerTransform } from "@/data/plans";
import { ZONE_FILL } from "@/components/tour/plan";
import { smoothPathD, zoneFontSize } from "@/lib/plan-geometry";
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

type Tool = "select" | "zone" | "stroke" | "trace" | "measure";

type TraceImg = { url: string; opacity: number; scale: number; x: number; y: number };

type Drag =
  | { type: "vertex"; zi: number; vi: number }
  | { type: "zone"; zi: number; start: [number, number]; orig: [number, number][] }
  | { type: "layer"; li: number; start: [number, number]; origX: number; origY: number }
  | { type: "trace"; start: [number, number]; origX: number; origY: number }
  | { type: "wallpt"; wi: number; end: "a" | "b" }
  | null;

/** Segment length in plan units — which are ≈ feet, so this doubles as the
 *  "drawn" dimension shown next to the lased number. */
const wallLen = (w: PlanWall) => Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);

/** Feet (decimal) → builder ft-in, e.g. 18.33 → `18'4"`. */
const fmtFeet = (ft: number) => {
  let f = Math.floor(ft);
  let inch = Math.round((ft - f) * 12);
  if (inch === 12) { f += 1; inch = 0; }
  return inch ? `${f}'${inch}"` : `${f}'`;
};

const wallId = () => `w${Math.random().toString(36).slice(2, 8)}`;

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
  const [tourSlug, setTourSlug] = useState("the-george");
  const [sheets, setSheets] = useState<PlanSheet[]>([newSheet("floor", 1)]);
  const [sheetIdx, setSheetIdx] = useState(0);
  const [tool, setTool] = useState<Tool>("zone");
  const [draft, setDraft] = useState<[number, number][]>([]);
  const [selZone, setSelZone] = useState<number | null>(null);
  const [selVertex, setSelVertex] = useState<number | null>(null);
  const [selLayer, setSelLayer] = useState<number | null>(null);
  const [selWall, setSelWall] = useState<number | null>(null); // measured-wall selection
  const [wallStart, setWallStart] = useState<[number, number] | null>(null); // 1st click of a new wall
  const [traces, setTraces] = useState<Record<string, TraceImg>>({});
  const [importText, setImportText] = useState("");
  const [liveSlugs, setLiveSlugs] = useState<string[]>([]);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [saveMsg, setSaveMsg] = useState("");
  const [satLoading, setSatLoading] = useState(false);
  const [view, setView] = useState({ x: -2, y: -2, w: 104, h: 74 }); // zoom/pan viewBox
  const [panMode, setPanMode] = useState(false); // hold Space to pan
  const [zoneVis, setZoneVis] = useState(true); // show/hide the traced room zones
  const [zoneDim, setZoneDim] = useState(100); // zone opacity % (dim to see layers beneath)
  const [showPath, setShowPath] = useState(true); // toggle the flight-path layer
  const [clip, setClip] = useState(false); // trim the base image to drawn walls/zones

  const svgRef = useRef<SVGSVGElement>(null);
  const dragRef = useRef<Drag>(null);
  const undoStack = useRef<string[]>([]);
  const satTried = useRef<Set<string>>(new Set());
  const panRef = useRef<{ cx: number; cy: number; vx: number; vy: number; vw: number; vh: number } | null>(null);
  const justLoaded = useRef(true); // suppress autosave right after a load / hydrate

  const sheet = sheets[sheetIdx];
  const trace = sheet ? traces[sheet.id] : undefined;
  const allSlugs = Array.from(new Set([...PLANS.map((p) => p.tourSlug), ...liveSlugs]));

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
    setSelWall(null);
    setWallStart(null);
  }, []);

  const mutateSheet = useCallback(
    (fn: (s: PlanSheet) => PlanSheet) => {
      setSheets((prev) => prev.map((s, i) => (i === sheetIdx ? fn(s) : s)));
    },
    [sheetIdx],
  );

  /** Client coords → snapped plan units, un-rotating the content group so drawing
   *  lands in the same frame as the (rotated) image. */
  const toPlan = useCallback((e: { clientX: number; clientY: number }): [number, number] => {
    const svg = svgRef.current;
    if (!svg) return [0, 0];
    const m = svg.getScreenCTM();
    if (!m) return [0, 0];
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    const rot = sheet?.rotation ?? 0, flip = sheet?.flipX ?? false;
    if (!rot && !flip) return [snap(p.x), snap(p.y)];
    const cx = (sheet?.width ?? 0) / 2, cy = (sheet?.height ?? 0) / 2;
    let rx = p.x, ry = p.y;
    if (flip) rx = 2 * cx - rx; // un-flip in screen space first (flip is applied after rotate)
    if (rot) {
      const a = (rot * Math.PI) / 180, dx = rx - cx, dy = ry - cy;
      const nx = cx + dx * Math.cos(a) + dy * Math.sin(a);
      const ny = cy - dx * Math.sin(a) + dy * Math.cos(a);
      rx = nx; ry = ny;
    }
    return [snap(rx), snap(ry)];
  }, [sheet?.rotation, sheet?.flipX, sheet?.width, sheet?.height]);

  // ---------- zoom / pan (viewBox-driven; toPlan stays exact via getScreenCTM) ----------
  // The visible "world" = the sheet UNION every base layer + the trace, because a
  // locked/oversized plan image can extend well past the sheet. Zoom-out and fit
  // clamp to THIS, so you can always pull back to see the whole plan.
  const contentBounds = useCallback(() => {
    const w = sheet?.width ?? 100, h = sheet?.height ?? 70;
    let minX = 0, minY = 0, maxX = w, maxY = h;
    const grow = (x: number, y: number, bw: number, bh: number) => {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x + bw > maxX) maxX = x + bw;
      if (y + bh > maxY) maxY = y + bh;
    };
    for (const L of sheet?.layers ?? []) grow(L.x ?? 0, L.y ?? 0, L.width ?? w, L.height ?? h);
    if (trace) { const tw = w * trace.scale; grow(trace.x, trace.y, tw, tw); }
    return { minX, minY, maxX, maxY };
  }, [sheet?.width, sheet?.height, sheet?.layers, trace]);

  const fitView = useCallback(() => {
    const b = contentBounds();
    const w = b.maxX - b.minX, h = b.maxY - b.minY;
    const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
    const a = ((sheet?.rotation ?? 0) * Math.PI) / 180;
    const bw = Math.abs(w * Math.cos(a)) + Math.abs(h * Math.sin(a)); // rotated bbox
    const bh = Math.abs(w * Math.sin(a)) + Math.abs(h * Math.cos(a));
    return { x: cx - bw / 2 - 2, y: cy - bh / 2 - 2, w: bw + 4, h: bh + 4 };
  }, [contentBounds, sheet?.rotation]);
  // refit when switching sheets
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setView(fitView()); }, [sheetIdx, sheet?.id]);

  const zoomAt = useCallback(
    (factor: number, ox: number, oy: number) => {
      const el = svgRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      setView((v) => {
        const planX = v.x + (ox / rect.width) * v.w;
        const planY = v.y + (oy / rect.height) * v.h;
        const b = contentBounds();
        const fw = b.maxX - b.minX + 4, fh = b.maxY - b.minY + 4;
        const nw = Math.max(fw * 0.04, Math.min(v.w * factor, fw));
        const nh = nw * (fh / fw);
        return { x: planX - (ox / rect.width) * nw, y: planY - (oy / rect.height) * nh, w: nw, h: nh };
      });
    },
    [contentBounds],
  );

  // wheel-to-zoom (non-passive so we can stop the page from scrolling)
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

  // hold Space to pan (Figma-style); middle-mouse drag also pans
  useEffect(() => {
    const isField = (t: EventTarget | null) => {
      const n = (t as HTMLElement)?.tagName;
      return n === "INPUT" || n === "TEXTAREA" || n === "SELECT";
    };
    const down = (e: KeyboardEvent) => { if (e.code === "Space" && !isField(e.target)) { e.preventDefault(); setPanMode(true); } };
    const up = (e: KeyboardEvent) => { if (e.code === "Space") setPanMode(false); };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); };
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
      setSelWall(null);
      setTool("select");
    } else if (tool === "stroke" && draft.length >= 2) {
      snapshot();
      mutateSheet((s) => ({ ...s, strokes: [...(s.strokes ?? []), draft] }));
    }
    setDraft([]);
  }, [tool, draft, sheet, mutateSheet, snapshot]);

  const onSvgClick = useCallback(
    (e: React.MouseEvent) => {
      if (panMode) return; // Space-drag is panning, not drawing
      if (tool === "measure") {
        const pt = toPlan(e);
        if (!wallStart) { setWallStart(pt); return; } // first click drops the start
        if (Math.hypot(pt[0] - wallStart[0], pt[1] - wallStart[1]) < SNAP) return; // ignore a zero-length tap
        snapshot();
        const nextIdx = sheet.walls?.length ?? 0;
        mutateSheet((s) => ({ ...s, walls: [...(s.walls ?? []), { id: wallId(), a: wallStart, b: pt }] }));
        setSelWall(nextIdx);
        setSelZone(null);
        setWallStart(null);
        return;
      }
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
    [tool, draft, toPlan, commitDraft, panMode, wallStart, sheet, mutateSheet, snapshot],
  );

  // ---------- select / drag ----------
  const onSvgPointerDown = useCallback(
    (e: React.PointerEvent) => {
      // pan: middle-mouse or Space-held drag
      if (e.button === 1 || panMode) {
        e.preventDefault();
        panRef.current = { cx: e.clientX, cy: e.clientY, vx: view.x, vy: view.y, vw: view.w, vh: view.h };
        (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
        return;
      }
      if (tool === "trace" && trace) {
        dragRef.current = { type: "trace", start: toPlan(e), origX: trace.x, origY: trace.y };
        return;
      }
      if (tool !== "select") return;
      // background press clears selection (zones/vertices/walls stop propagation)
      setSelZone(null);
      setSelVertex(null);
      setSelWall(null);
    },
    [tool, trace, toPlan, panMode, view],
  );

  const onSvgPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const p = panRef.current;
      if (p) {
        const el = svgRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const dx = (e.clientX - p.cx) * (p.vw / rect.width);
        const dy = (e.clientY - p.cy) * (p.vh / rect.height);
        setView((v) => ({ ...v, x: p.vx - dx, y: p.vy - dy }));
        return;
      }
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
      } else if (drag.type === "layer") {
        const dx = pt[0] - drag.start[0];
        const dy = pt[1] - drag.start[1];
        mutateSheet((s) => ({
          ...s,
          layers: s.layers?.map((L, li) =>
            li === drag.li ? { ...L, x: drag.origX + dx, y: drag.origY + dy } : L,
          ),
        }));
      } else if (drag.type === "wallpt") {
        mutateSheet((s) => ({
          ...s,
          walls: s.walls?.map((w, wi) => (wi === drag.wi ? { ...w, [drag.end]: pt } : w)),
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
    panRef.current = null;
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
        setSelWall(null);
        setWallStart(null);
      } else if (e.key === "Delete" || e.key === "Backspace") {
        if (selWall !== null) {
          e.preventDefault();
          snapshot();
          mutateSheet((s) => ({ ...s, walls: s.walls?.filter((_, i) => i !== selWall) }));
          setSelWall(null);
          return;
        }
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
  }, [commitDraft, selZone, selVertex, selWall, sheet, mutateSheet, snapshot, undo]);

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
    justLoaded.current = true;
    undoStack.current = [];
    setTourSlug(plan.tourSlug);
    setSheets(JSON.parse(JSON.stringify(plan.sheets)) as PlanSheet[]);
    setSheetIdx(0);
    setSelZone(null);
    setSelVertex(null);
    setSelWall(null);
    setWallStart(null);
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

  // Load a tour's plan: saved live doc → baked plan → a fresh blank floor. This
  // is the "import the default base, then tweak" path — no Load button.
  const loadForSlug = useCallback(
    async (slugRaw: string) => {
      const slug = slugRaw.trim();
      if (!slug) return;
      // Suppress autosave for the ENTIRE async load window. The property picker
      // sets tourSlug=new synchronously while `sheets` still holds the OUTGOING
      // plan; without this a debounced save could fire mid-load and write the old
      // sheets under the new slug (clobbering that property's saved plan, walls
      // included). loadPlan re-arms this flag when the data actually lands.
      justLoaded.current = true;
      try {
        const doc = await loadDoc<Plan>("plan", slug);
        if (doc && Array.isArray(doc.sheets)) {
          loadPlan(doc);
          return;
        }
      } catch {
        /* fall through to baked / blank */
      }
      const baked = PLANS.find((p) => p.tourSlug === slug);
      loadPlan(baked ?? { tourSlug: slug, sheets: [newSheet("floor", 1)] });
    },
    [loadPlan],
  );

  // On open: land on ?tour=<slug> (deep-link from a property), else the last-edited.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    const url =
      typeof window !== "undefined"
        ? new URLSearchParams(window.location.search).get("tour")
        : null;
    const saved = typeof window !== "undefined" ? localStorage.getItem("lvx-plan-tourslug") : null;
    void loadForSlug(url || saved || "the-george");
  }, []);
  // pull live (cloud-delivered) plan slugs so they show up in the picker, not just baked ones
  useEffect(() => {
    fetch("/studio/api/plans")
      .then((r) => (r.ok ? r.json() : { slugs: [] }))
      .then((d: { slugs?: string[] }) => setLiveSlugs(d.slugs ?? []))
      .catch(() => {});
  }, []);
  // remember the tour for next session
  useEffect(() => {
    if (typeof window !== "undefined") localStorage.setItem("lvx-plan-tourslug", tourSlug);
  }, [tourSlug]);

  // Autosave to the live site, debounced — no Save button. Skipped right after a
  // load/hydrate so opening a plan never re-writes it.
  useEffect(() => {
    if (justLoaded.current) {
      justLoaded.current = false;
      return;
    }
    const t = setTimeout(() => void saveToSite(), 1200);
    return () => clearTimeout(t);
  }, [sheets, saveToSite]);

  const onTraceFile = useCallback(
    (file: File | undefined) => {
      if (!file || !sheet) return;
      const url = URL.createObjectURL(file);
      setTraces((t) => ({ ...t, [sheet.id]: { url, opacity: 0.4, scale: 1, x: 0, y: 0 } }));
      setTool("trace");
    },
    [sheet],
  );

  /** Weld the movable trace underlay into a SAVED base layer at its exact current
   *  position + scale. After this the plan and the measured walls share ONE
   *  coordinate system: zoom/pan moves them together, and the image persists to
   *  the doc (baked to a data-URL — the trace's blob: URL wouldn't survive a
   *  reload). This is the fix for "measurements don't stick to the plan". */
  const lockTraceAsLayer = useCallback(() => {
    if (!trace || !sheet) return;
    const img = new Image();
    img.onload = () => {
      const natW = img.naturalWidth || 1;
      const natH = img.naturalHeight || 1;
      // downscale so the baked data-URL stays small enough for the plan doc
      const dw = Math.min(natW, 1600);
      const dh = Math.max(1, Math.round(dw * (natH / natW)));
      const cv = document.createElement("canvas");
      cv.width = dw;
      cv.height = dh;
      cv.getContext("2d")?.drawImage(img, 0, 0, dw, dh);
      let url = trace.url;
      try {
        url = cv.toDataURL("image/jpeg", 0.85);
      } catch {
        /* tainted canvas — keep the (non-persistent) objectURL rather than fail */
      }
      // trace renders at x/y with width = sheet.width*scale, height by aspect
      const w = sheet.width * trace.scale;
      const h = w * (natH / natW);
      snapshot();
      mutateSheet((s) => ({
        ...s,
        layers: [
          ...(s.layers ?? []),
          { id: `plan-${s.id}-${(s.layers?.length ?? 0) + 1}`, label: "Plan", url, x: trace.x, y: trace.y, width: w, height: h, opacity: trace.opacity },
        ],
      }));
      setTraces((t) => {
        const n = { ...t };
        delete n[sheet.id];
        return n;
      });
      setTool("select");
    };
    img.src = trace.url;
  }, [trace, sheet, mutateSheet, snapshot]);

  /** One-click satellite trace: stitch Esri World Imagery tiles for the sheet's
   *  GPS bbox (via the same-origin proxy) and drop the cropped, aligned image in
   *  as the trace — so the path overlays the real grounds and you just draw. */
  const fetchSatellite = useCallback(async () => {
    const g = sheet?.geo;
    if (!g) return;
    setSatLoading(true);
    try {
      const lon2x = (lon: number, z: number) => ((lon + 180) / 360) * 2 ** z;
      const lat2y = (lat: number, z: number) => {
        const r = (lat * Math.PI) / 180;
        return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
      };
      // deepest zoom that keeps the image ≲ ~2200px wide. Cap at 19 — Esri
      // World Imagery returns a "Map data not yet available" placeholder past ~19
      // for most suburban areas.
      let z = 19;
      for (; z > 1; z--) {
        if ((lon2x(g.maxLon, z) - lon2x(g.minLon, z)) * 256 <= 2200) break;
      }
      const xNW = lon2x(g.minLon, z), yNW = lat2y(g.maxLat, z);
      const xSE = lon2x(g.maxLon, z), ySE = lat2y(g.minLat, z);
      const tx0 = Math.floor(xNW), ty0 = Math.floor(yNW);
      const tx1 = Math.floor(xSE), ty1 = Math.floor(ySE);

      const full = document.createElement("canvas");
      full.width = (tx1 - tx0 + 1) * 256;
      full.height = (ty1 - ty0 + 1) * 256;
      const fctx = full.getContext("2d");
      if (!fctx) throw new Error("no 2d context");

      const draw = (col: number, row: number) =>
        new Promise<void>((resolve) => {
          const img = new Image();
          img.onload = () => {
            fctx.drawImage(img, (col - tx0) * 256, (row - ty0) * 256);
            resolve();
          };
          img.onerror = () => resolve();
          img.src = `/studio/api/sat?z=${z}&x=${col}&y=${row}`;
        });
      const jobs: Promise<void>[] = [];
      for (let col = tx0; col <= tx1; col++)
        for (let row = ty0; row <= ty1; row++) jobs.push(draw(col, row));
      await Promise.all(jobs);

      // crop the tile mosaic to the exact bbox
      const out = document.createElement("canvas");
      out.width = Math.max(1, Math.round((xSE - xNW) * 256));
      out.height = Math.max(1, Math.round((ySE - yNW) * 256));
      out
        .getContext("2d")
        ?.drawImage(
          full,
          (xNW - tx0) * 256,
          (yNW - ty0) * 256,
          (xSE - xNW) * 256,
          (ySE - yNW) * 256,
          0,
          0,
          out.width,
          out.height,
        );
      const url = out.toDataURL("image/jpeg", 0.85);
      mutateSheet((s) => ({ ...s, satUrl: url }));
      setTool("select");
    } catch (e) {
      alert(e instanceof Error ? e.message : "Couldn't fetch satellite imagery");
    } finally {
      setSatLoading(false);
    }
  }, [sheet]);

  // Auto-stitch the satellite the first time a georeferenced sheet loads.
  useEffect(() => {
    if (sheet?.geo && !sheet.satUrl && !satTried.current.has(sheet.id)) {
      satTried.current.add(sheet.id);
      void fetchSatellite();
    }
  }, [sheet, fetchSatellite]);

  const centroid = (pts: [number, number][]): [number, number] => {
    let x = 0, y = 0;
    for (const [px, py] of pts) { x += px; y += py; }
    return [x / pts.length, y / pts.length];
  };

  if (!sheet) return null;

  const labelSize = Math.max(sheet.width, sheet.height) * 0.03;
  const handleR = Math.max(sheet.width, sheet.height) * 0.012;

  // plan coords → on-screen coords (undo sheet rotation + flip) so wall
  // dimension labels stay upright, exactly like the room labels do.
  const toScreen = ([x, y]: [number, number]): [number, number] => {
    const rotg = sheet.rotation ?? 0, flg = sheet.flipX ?? false;
    let lx = x, ly = y;
    if (rotg) {
      const a = (rotg * Math.PI) / 180, hx = sheet.width / 2, hy = sheet.height / 2;
      const dx = x - hx, dy = y - hy;
      lx = hx + dx * Math.cos(a) - dy * Math.sin(a);
      ly = hy + dx * Math.sin(a) + dy * Math.cos(a);
    }
    if (flg) lx = sheet.width - lx;
    return [lx, ly];
  };

  const toolBtn = (t: Tool, label: string) => (
    <button
      key={t}
      type="button"
      onClick={() => { setTool(t); setDraft([]); setWallStart(null); }}
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
              onClick={() => { setSheetIdx(i); setSelZone(null); setSelVertex(null); setSelWall(null); setWallStart(null); setDraft([]); }}
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
            onClick={() => { snapshot(); setSheets((p) => [...p, newSheet("floor", p.length + 1)]); setSheetIdx(sheets.length); setSelZone(null); setSelVertex(null); setSelWall(null); setWallStart(null); }}
            className="rounded-full border border-paper/30 px-3 py-1.5 font-sans text-[0.6875rem] uppercase tracking-[0.14em] text-paper/70 hover:border-champagne/60 hover:text-champagne"
          >
            + Floor
          </button>
          <button
            type="button"
            onClick={() => { snapshot(); setSheets((p) => [...p, newSheet("site", p.length + 1)]); setSheetIdx(sheets.length); setSelZone(null); setSelVertex(null); setSelWall(null); setWallStart(null); }}
            className="rounded-full border border-paper/30 px-3 py-1.5 font-sans text-[0.6875rem] uppercase tracking-[0.14em] text-paper/70 hover:border-champagne/60 hover:text-champagne"
          >
            + Grounds
          </button>
        </div>

        <div className="mb-3 flex flex-wrap items-center gap-2">
          {toolBtn("select", "Select")}
          {toolBtn("zone", "Draw zone")}
          {toolBtn("stroke", "Draw wall")}
          {toolBtn("measure", "Measure wall")}
          <label className="cursor-pointer rounded border border-paper/30 px-3 py-1.5 font-sans text-[0.6875rem] uppercase tracking-[0.14em] text-paper/70 hover:border-champagne/60 hover:text-champagne">
            Trace image…
            <input type="file" accept="image/*" className="hidden" onChange={(e) => onTraceFile(e.target.files?.[0])} />
          </label>
          {satLoading && (
            <span className="font-sans text-[0.625rem] uppercase tracking-[0.14em] text-champagne">
              Stitching satellite…
            </span>
          )}
          {trace && (
            <>
              {toolBtn("trace", "Move trace")}
              <button
                type="button"
                onClick={lockTraceAsLayer}
                title="Weld the plan into the sheet so it + your measurements zoom/pan together and persist"
                className="rounded border border-champagne bg-champagne px-3 py-1.5 font-sans text-[0.6875rem] uppercase tracking-[0.14em] text-ink transition-colors hover:bg-champagne/80"
              >
                Lock plan ✓
              </button>
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
          {sheet.satUrl && (
            <>
              <span className="flex items-center gap-1">
                <button type="button" title="Rotate left 5°"
                  onClick={() => mutateSheet((s) => ({ ...s, rotation: Math.round(((s.rotation ?? 0) - 5) * 10) / 10 }))}
                  className="rounded border border-paper/30 px-2 py-1.5 text-paper/70 hover:border-champagne/60 hover:text-champagne">⟲</button>
                <button type="button" title="Rotate right 5°"
                  onClick={() => mutateSheet((s) => ({ ...s, rotation: Math.round(((s.rotation ?? 0) + 5) * 10) / 10 }))}
                  className="rounded border border-paper/30 px-2 py-1.5 text-paper/70 hover:border-champagne/60 hover:text-champagne">⟳</button>
                {(sheet.rotation ?? 0) !== 0 && (
                  <button type="button" title="Reset rotation"
                    onClick={() => mutateSheet((s) => ({ ...s, rotation: 0 }))}
                    className="rounded border border-paper/30 px-2 py-1.5 font-sans text-[0.6rem] tabular-nums tracking-[0.1em] text-paper/60 hover:text-champagne">{Math.round(sheet.rotation ?? 0)}°</button>
                )}
              </span>
              <button type="button"
                onClick={() => mutateSheet((s) => ({ ...s, flipX: !s.flipX }))}
                className={cn(
                  "rounded border px-3 py-1.5 font-sans text-[0.6875rem] uppercase tracking-[0.14em] transition-colors",
                  sheet.flipX ? "border-champagne bg-champagne text-ink" : "border-paper/30 text-paper/70 hover:border-champagne/60 hover:text-champagne",
                )}>Flip</button>
              <button type="button"
                onClick={() => setClip((c) => !c)}
                className={cn(
                  "rounded border px-3 py-1.5 font-sans text-[0.6875rem] uppercase tracking-[0.14em] transition-colors",
                  clip ? "border-champagne bg-champagne text-ink" : "border-paper/30 text-paper/70 hover:border-champagne/60 hover:text-champagne",
                )}>Trim to walls</button>
            </>
          )}
          {sheet.paths && Object.keys(sheet.paths).length > 0 && (
            <button type="button"
              onClick={() => setShowPath((p) => !p)}
              className={cn(
                "rounded border px-3 py-1.5 font-sans text-[0.6875rem] uppercase tracking-[0.14em] transition-colors",
                showPath ? "border-champagne bg-champagne text-ink" : "border-paper/30 text-paper/70 hover:border-champagne/60 hover:text-champagne",
              )}>Flight path</button>
          )}
          <span className="ml-auto font-sans text-[0.625rem] uppercase tracking-[0.14em] text-paper/40">
            Scroll = zoom · Double-click = fit · Space-drag = pan · Enter closes · Del removes · Ctrl+Z
          </span>
        </div>

        <svg
          ref={svgRef}
          viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
          style={panMode ? { cursor: panRef.current ? "grabbing" : "grab" } : undefined}
          className={cn(
            "block w-full touch-none border border-champagne/30 bg-[#FBF8F1]",
            !panMode && (tool === "zone" || tool === "stroke" || tool === "measure") && "cursor-crosshair",
            !panMode && tool === "trace" && trace && "cursor-move",
          )}
          onClick={onSvgClick}
          onDoubleClick={() => setView(fitView())}
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

          {/* clip mask from drawn walls/zones — "Trim to walls" crops the base to it */}
          <defs>
            <clipPath id="planclip" clipPathUnits="userSpaceOnUse">
              {sheet.zones.map((z) => (
                <polygon key={z.id} points={z.points.map(([x, y]) => `${x},${y}`).join(" ")} />
              ))}
              {sheet.strokes?.map((line, i) => (
                <polygon key={`s${i}`} points={line.map(([x, y]) => `${x},${y}`).join(" ")} />
              ))}
            </clipPath>
          </defs>

          {/* rotatable + flippable content (base image + flight path + zones + walls + draft) */}
          <g
            transform={
              [
                // flip listed first → applied LAST (after rotate) = mirror in screen space
                sheet.flipX ? `translate(${sheet.width} 0) scale(-1 1)` : "",
                (sheet.rotation ?? 0) ? `rotate(${sheet.rotation} ${sheet.width / 2} ${sheet.height / 2})` : "",
              ]
                .filter(Boolean)
                .join(" ") || undefined
            }
          >

          {/* base layers (aerial overview / interior ortho / satellite), stacked bottom→top;
              falls back to the legacy single satUrl. Wider layers (satellite of the lot) carry
              their own x/y/width/height and extend beyond the sheet for the zoomed-out hybrid. */}
          {sheet.layers?.length ? (
            sheet.layers.map((L, li) =>
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
                  style={{ cursor: tool === "select" && selLayer === li ? "move" : undefined }}
                  onPointerDown={(e) => {
                    if (tool !== "select" || selLayer !== li) return;
                    e.stopPropagation();
                    dragRef.current = { type: "layer", li, start: toPlan(e), origX: L.x ?? 0, origY: L.y ?? 0 };
                  }}
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
              clipPath={
                clip && (sheet.zones.length > 0 || (sheet.strokes?.length ?? 0) > 0)
                  ? "url(#planclip)"
                  : undefined
              }
            />
          ) : null}

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

          {/* flight path (read-only context from GPS/VSLAM) — smoothed, toggle-able */}
          {showPath &&
            sheet.paths &&
            Object.values(sheet.paths).map((keys, ci) =>
              keys.length > 1 ? (
                <g key={`path-${ci}`} className="pointer-events-none">
                  <path
                    d={smoothPathD(keys)}
                    fill="none"
                    stroke="#B7995C"
                    strokeOpacity={0.85}
                    strokeWidth={Math.max(sheet.width, sheet.height) * 0.005}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                  />
                  <circle cx={keys[0].x} cy={keys[0].y} r={Math.max(sheet.width, sheet.height) * 0.011} fill="#4CAF50" />
                  <circle cx={keys[keys.length - 1].x} cy={keys[keys.length - 1].y} r={Math.max(sheet.width, sheet.height) * 0.011} fill="#E0533D" />
                </g>
              ) : null,
            )}

          {/* zones — toggleable + dimmable so the photo/plan layers stay visible under them */}
          {zoneVis && (
          <g opacity={zoneDim / 100}>
          {sheet.zones.map((z, zi) => {
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
                    if (tool !== "select" || panMode) return;
                    e.stopPropagation();
                    setSelZone(zi);
                    setSelVertex(null);
                    setSelWall(null);
                    dragRef.current = { type: "zone", zi, start: toPlan(e), orig: z.points.map((p) => [...p] as [number, number]) };
                  }}
                />
                {selected && tool === "select" &&
                  z.points.map(([x, y], vi) => (
                    <circle
                      key={vi}
                      cx={x} cy={y} r={handleR}
                      fill={vi === selVertex ? "#A6863F" : "#FBF8F1"}
                      stroke="#A6863F" strokeWidth={0.3}
                      className="cursor-grab"
                      onPointerDown={(e) => {
                        if (panMode) return;
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
          </g>
          )}

          {/* committed strokes — walls. Light halo + dark core so they read over a photo base. */}
          {sheet.strokes?.map((line, i) => {
            const pts = line.map(([x, y]) => `${x},${y}`).join(" ");
            const w = Math.max(sheet.width, sheet.height);
            const dash = sheet.kind === "site" ? `${sheet.width * 0.015} ${sheet.width * 0.012}` : undefined;
            return (
              <g key={i}>
                <polyline points={pts} fill="none" stroke="#FBF8F1" strokeOpacity={0.85}
                  strokeWidth={w * 0.02} strokeLinejoin="round" strokeLinecap="round" />
                <polyline points={pts} fill="none" stroke="#1F1812"
                  strokeWidth={w * 0.009} strokeLinejoin="round" strokeLinecap="round" strokeDasharray={dash} />
              </g>
            );
          })}

          {/* measured walls — click to select, drag either end, type the lased length.
              Green once measured, amber while still just drawn. */}
          {sheet.walls?.map((w, wi) => {
            const sel = wi === selWall;
            // screen-constant sizing: view.w spans the visible width, so widths taken
            // as a fraction of it stay hairline-thin at ANY zoom — precision for tight
            // spots like a fireplace, instead of fattening as you zoom in.
            const u = view.w;
            return (
              <g key={w.id}>
                {/* transparent hit-line so a thin wall stays easy to click */}
                <line
                  x1={w.a[0]} y1={w.a[1]} x2={w.b[0]} y2={w.b[1]}
                  stroke="transparent" strokeWidth={u * 0.012} strokeLinecap="round"
                  style={{ cursor: tool === "select" ? "pointer" : undefined, pointerEvents: tool === "select" ? "stroke" : "none" }}
                  onPointerDown={(e) => {
                    if (tool !== "select" || panMode) return;
                    e.stopPropagation();
                    setSelWall(wi); setSelZone(null); setSelVertex(null);
                  }}
                />
                <line x1={w.a[0]} y1={w.a[1]} x2={w.b[0]} y2={w.b[1]}
                  stroke="#FBF8F1" strokeOpacity={0.85} strokeWidth={u * 0.0045} strokeLinecap="round" className="pointer-events-none" />
                <line x1={w.a[0]} y1={w.a[1]} x2={w.b[0]} y2={w.b[1]}
                  stroke={sel ? "#A6863F" : w.measured ? "#1F6F45" : "#9A7A2E"}
                  strokeWidth={u * (sel ? 0.0032 : 0.0022)} strokeLinecap="round" className="pointer-events-none" />
                {sel && tool === "select" &&
                  (["a", "b"] as const).map((end) => (
                    <circle key={end} cx={w[end][0]} cy={w[end][1]} r={u * 0.006}
                      fill="#FBF8F1" stroke="#A6863F" strokeWidth={u * 0.0015} className="cursor-grab"
                      onPointerDown={(e) => {
                        if (panMode) return;
                        e.stopPropagation();
                        snapshot();
                        dragRef.current = { type: "wallpt", wi, end };
                      }}
                    />
                  ))}
              </g>
            );
          })}
          {/* in-progress measured wall: the dropped start point */}
          {tool === "measure" && wallStart && (
            <circle cx={wallStart[0]} cy={wallStart[1]} r={view.w * 0.008} fill="#A6863F" className="pointer-events-none" />
          )}

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

          {/* SELECTED-LAYER drag handle — rendered ABOVE zones/strokes so the layer can be
              grabbed anywhere, even under a traced room (zones otherwise eat the pointer). */}
          {tool === "select" && selLayer != null && sheet.layers?.[selLayer] && sheet.layers[selLayer].visible !== false && (() => {
            const L = sheet.layers![selLayer];
            return (
              <rect
                x={L.x ?? 0}
                y={L.y ?? 0}
                width={L.width ?? sheet.width}
                height={L.height ?? sheet.height}
                transform={layerTransform(L, sheet.width, sheet.height)}
                fill="#A6863F"
                fillOpacity={0.001}
                stroke="#A6863F"
                strokeWidth={0.35}
                strokeDasharray="1.6 1"
                style={{ cursor: "move", pointerEvents: "all" }}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  dragRef.current = { type: "layer", li: selLayer, start: toPlan(e), origX: L.x ?? 0, origY: L.y ?? 0 };
                }}
              />
            );
          })()}
          </g>

          {/* zone labels — drawn OUTSIDE the rotate/flip group, at each room's screen
              position, so they stay upright and readable no matter the sheet rotation */}
          {zoneVis && (
          <g opacity={zoneDim / 100}>
          {sheet.zones.map((z) => {
            const [cx, cy] = centroid(z.points);
            const fs = zoneFontSize(z.points, z.label, labelSize, labelSize * 0.34);
            const rotg = sheet.rotation ?? 0, flg = sheet.flipX ?? false;
            let lx = cx, ly = cy;
            if (rotg) {
              const a = (rotg * Math.PI) / 180, hx = sheet.width / 2, hy = sheet.height / 2;
              const dx = cx - hx, dy = cy - hy;
              lx = hx + dx * Math.cos(a) - dy * Math.sin(a);
              ly = hy + dx * Math.sin(a) + dy * Math.cos(a);
            }
            if (flg) lx = sheet.width - lx;
            return (
              <text
                key={`lbl-${z.id}`} x={lx} y={ly} textAnchor="middle" dominantBaseline="central"
                fontSize={fs} letterSpacing={fs * 0.1}
                fill="#6B5D45" className="pointer-events-none select-none font-sans uppercase"
              >
                {z.label}
              </text>
            );
          })}
          </g>
          )}

          {/* wall dimension labels — upright. The lased number once entered, else a
              faint drawn length for just the selected wall (so the plan stays clean). */}
          {sheet.walls?.map((w, wi) => {
            const [lx, ly] = toScreen([(w.a[0] + w.b[0]) / 2, (w.a[1] + w.b[1]) / 2]);
            const sel = wi === selWall;
            const text = w.measured ? w.measured : sel ? `≈ ${fmtFeet(wallLen(w))}` : "";
            if (!text) return null;
            const fs = view.w * 0.014; // screen-constant so numbers don't balloon on zoom-in
            const halfW = text.length * fs * 0.32 + fs * 0.4;
            return (
              <g key={`wl-${w.id}`} className="pointer-events-none select-none">
                <rect x={lx - halfW} y={ly - fs * 0.85} width={halfW * 2} height={fs * 1.7} rx={fs * 0.3}
                  fill="#FBF8F1" fillOpacity={0.92} stroke={sel ? "#A6863F" : "none"} strokeWidth={0.2} />
                <text x={lx} y={ly} textAnchor="middle" dominantBaseline="central" fontSize={fs}
                  fontWeight={w.measured ? 700 : 400} fill={w.measured ? "#1F6F45" : "#9A7A2E"}
                  className="font-sans tabular-nums">
                  {text}
                </text>
              </g>
            );
          })}
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
                  onClick={() => { snapshot(); setSheets((p) => p.filter((_, i) => i !== sheetIdx)); setSheetIdx(0); setSelZone(null); setSelVertex(null); setSelWall(null); setWallStart(null); }}
                  className="ml-auto text-paper/50 hover:text-champagne"
                >
                  Delete sheet
                </button>
              )}
            </div>
          </div>
        </div>

        {/* traced rooms — show/hide + dim, so the photo/plan layers underneath stay visible */}
        <div className="rounded border border-paper/15 p-4">
          <div className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={zoneVis}
              onChange={(e) => setZoneVis(e.target.checked)}
              className="accent-champagne"
            />
            <span className="flex-1 font-display text-[0.6875rem] uppercase tracking-[0.2em] text-champagne">Rooms</span>
            <input
              type="range"
              min={10}
              max={100}
              value={zoneDim}
              onChange={(e) => setZoneDim(Number(e.target.value))}
              className="w-24 accent-champagne"
              title="room overlay opacity"
            />
            <span className="w-9 text-right tabular-nums text-paper/45">{zoneDim}%</span>
          </div>
        </div>

        {/* base layers — toggle aerial / interior ortho / satellite, set opacity */}
        {(sheet.layers?.length ?? 0) > 0 && (
          <div className="rounded border border-paper/15 p-4">
            <p className="font-display text-[0.6875rem] uppercase tracking-[0.2em] text-champagne">Layers</p>
            <p className="mt-1 text-[0.65rem] text-paper/45">Select a layer to move it on the canvas, rotate &amp; resize.</p>
            <div className="mt-3 flex flex-col gap-2 text-xs">
              {sheet.layers!.map((L, li) => (
                <div key={L.id} className="flex flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={L.visible !== false}
                      onChange={(e) => mutateSheet((s) => ({ ...s, layers: s.layers!.map((x, i) => (i === li ? { ...x, visible: e.target.checked } : x)) }))}
                      className="accent-champagne"
                    />
                    <button
                      type="button"
                      onClick={() => setSelLayer(selLayer === li ? null : li)}
                      className={`flex-1 truncate text-left ${selLayer === li ? "text-champagne" : "text-paper/80"}`}
                    >
                      {L.label}
                    </button>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      value={Math.round((L.opacity ?? 1) * 100)}
                      onChange={(e) => mutateSheet((s) => ({ ...s, layers: s.layers!.map((x, i) => (i === li ? { ...x, opacity: Number(e.target.value) / 100 } : x)) }))}
                      className="w-16 accent-champagne"
                      title="opacity"
                    />
                  </div>
                  {selLayer === li && (
                    <div className="flex flex-wrap items-center gap-1.5 pl-6 text-[0.65rem] text-paper/70">
                      <span title="rotate" className="text-paper/50">↻</span>
                      <input
                        type="range"
                        min={-180}
                        max={180}
                        value={Math.round(L.rotation ?? 0)}
                        onChange={(e) => mutateSheet((s) => ({ ...s, layers: s.layers!.map((x, i) => (i === li ? { ...x, rotation: Number(e.target.value) } : x)) }))}
                        className="w-16 accent-champagne"
                        title="rotation"
                      />
                      <span className="w-8 tabular-nums text-paper/45">{Math.round(L.rotation ?? 0)}°</span>
                      <span title="size" className="ml-1 text-paper/50">⤢</span>
                      <input
                        type="range"
                        min={10}
                        max={300}
                        step={0.5}
                        value={Math.round(L.width ?? sheet.width)}
                        onChange={(e) => {
                          const nw = Number(e.target.value);
                          mutateSheet((s) => ({
                            ...s,
                            layers: s.layers!.map((x, i) => {
                              if (i !== li) return x;
                              const cw = x.width ?? s.width;
                              const ch = x.height ?? s.height;
                              return { ...x, width: nw, height: cw ? (ch * nw) / cw : nw };
                            }),
                          }));
                        }}
                        className="w-16 accent-champagne"
                        title="size"
                      />
                      <button
                        type="button"
                        onClick={() => mutateSheet((s) => ({ ...s, layers: s.layers!.map((x, i) => (i === li ? { ...x, flipH: !x.flipH } : x)) }))}
                        className={`rounded border px-1 ${L.flipH ? "border-champagne text-champagne" : "border-paper/25 text-paper/55"}`}
                        title="flip horizontal"
                      >
                        ⇆
                      </button>
                      <button
                        type="button"
                        onClick={() => mutateSheet((s) => ({ ...s, layers: s.layers!.map((x, i) => (i === li ? { ...x, flipV: !x.flipV } : x)) }))}
                        className={`rounded border px-1 ${L.flipV ? "border-champagne text-champagne" : "border-paper/25 text-paper/55"}`}
                        title="flip vertical"
                      >
                        ⇅
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

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
                    onClick={() => { setTool("select"); setSelZone(zi); setSelVertex(null); setSelWall(null); }}
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

        {/* measured walls — click a wall on the plan, type its lased length */}
        <div className="rounded border border-paper/15 p-4">
          <p className="font-display text-[0.6875rem] uppercase tracking-[0.2em] text-champagne">
            {selWall !== null && sheet.walls?.[selWall] ? "Selected wall" : "Walls"}
          </p>
          {selWall !== null && sheet.walls?.[selWall] ? (
            <div className="mt-3 flex flex-col gap-2 text-xs">
              <label className="flex flex-col gap-1 text-paper/60">
                Lased length
                <input
                  autoFocus
                  value={sheet.walls[selWall].measured ?? ""}
                  onChange={(e) =>
                    mutateSheet((s) => ({
                      ...s,
                      walls: s.walls?.map((w, i) => (i === selWall ? { ...w, measured: e.target.value || undefined } : w)),
                    }))
                  }
                  placeholder={`e.g. ${fmtFeet(wallLen(sheet.walls[selWall]))}`}
                  className="rounded border border-paper/20 bg-transparent px-2 py-1.5 text-sm text-paper outline-none focus:border-champagne"
                />
              </label>
              <p className="text-paper/45">
                Drawn ≈ {fmtFeet(wallLen(sheet.walls[selWall]))}
                <span className="text-paper/30"> · {wallLen(sheet.walls[selWall]).toFixed(1)} ft on plan</span>
              </p>
              <button
                type="button"
                onClick={() => {
                  snapshot();
                  mutateSheet((s) => ({ ...s, walls: s.walls?.filter((_, i) => i !== selWall) }));
                  setSelWall(null);
                }}
                className="self-start text-paper/50 hover:text-champagne"
              >
                Delete wall
              </button>
            </div>
          ) : (
            <>
              <p className="mt-1 text-[0.65rem] leading-relaxed text-paper/45">
                <b className="text-paper/70">Measure wall</b> tool: click a start, then an end, to lay a
                wall over the plan. In <b className="text-paper/70">Select</b>, click any wall to type its
                lased length — it prints right on the wall.
              </p>
              <ul className="mt-3 flex max-h-40 flex-col gap-1 overflow-auto text-xs">
                {(sheet.walls?.length ?? 0) === 0 && <li className="text-paper/40">No walls yet →</li>}
                {sheet.walls?.map((w, wi) => (
                  <li key={w.id}>
                    <button
                      type="button"
                      onClick={() => { setTool("select"); setSelWall(wi); setSelZone(null); }}
                      className="text-left text-paper/75 hover:text-champagne"
                    >
                      Wall {wi + 1}
                      <span className={w.measured ? "text-emerald-400/80" : "text-paper/35"}>
                        {" · "}{w.measured ? w.measured : `≈ ${fmtFeet(wallLen(w))} · unmeasured`}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              {(sheet.walls?.length ?? 0) > 0 && (
                <p className="mt-2 text-[0.65rem] uppercase tracking-[0.14em] text-paper/45">
                  {sheet.walls!.filter((w) => w.measured).length}/{sheet.walls!.length} measured
                </p>
              )}
            </>
          )}
        </div>

        {/* io */}
        <div className="rounded border border-paper/15 p-4">
          <p className="font-display text-[0.6875rem] uppercase tracking-[0.2em] text-champagne">Plan</p>
          <label className="mt-3 flex items-center gap-2 text-xs text-paper/60">
            Property
            <select
              value={tourSlug}
              onChange={(e) => {
                setTourSlug(e.target.value);
                void loadForSlug(e.target.value); // pick → live plan loads from the site
              }}
              className="flex-1 rounded border border-paper/20 bg-ink px-2 py-1.5 text-sm text-paper outline-none focus:border-champagne"
            >
              {!allSlugs.includes(tourSlug) && (
                <option value={tourSlug}>{tourSlug}</option>
              )}
              {allSlugs.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <p className="mt-2 font-sans text-[0.625rem] uppercase tracking-[0.14em] text-paper/40">
            {saveState === "saving"
              ? "Saving…"
              : saveState === "saved"
                ? "Saved ✓"
                : saveState === "error"
                  ? ""
                  : "Autosaves to the live site"}
          </p>
          {saveState === "error" && (
            <p className="mt-1 text-xs leading-snug text-red-400">{saveMsg}</p>
          )}
          <details className="mt-3 text-xs text-paper/60">
            <summary className="cursor-pointer uppercase tracking-[0.14em] hover:text-champagne">JSON</summary>
            <textarea
              readOnly
              value={exportJson}
              data-testid="plan-export"
              className="mt-2 h-32 w-full rounded border border-paper/20 bg-ink/60 p-2 font-mono text-[0.625rem] leading-relaxed text-paper/80"
            />
            <textarea
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              placeholder='Paste a Plan to import ({ "tourSlug": …, "sheets": […] })'
              className="mt-2 h-20 w-full rounded border border-paper/20 bg-ink/60 p-2 font-mono text-[0.625rem] text-paper/80"
            />
            <button
              type="button"
              onClick={importFromText}
              className="mt-2 rounded border border-paper/30 px-3 py-1.5 uppercase tracking-[0.14em] text-paper/70 hover:border-champagne/60 hover:text-champagne"
            >
              Import
            </button>
          </details>
        </div>
      </div>
    </div>
  );
}
