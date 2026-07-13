"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Plan, PlanSheet } from "@/data/plans";
import { loadDoc, saveDoc } from "@/lib/author-client";
import {
  generateMeasureDoc,
  parseFtIn,
  fmtFtIn,
  radiusFromChord,
  type MeasureAsk,
  type MeasureDoc,
} from "@/lib/measure";

/**
 * The Measure sheet — a BIM-style line drawing of the delivered floorplan where
 * every wall/diagonal/curve span the pipeline wants lasered is a tappable
 * dimension line with a fillable field. Tap a line (or walk the list), type the
 * Bosch reading, Enter — the value saves and selection advances to the next
 * unfilled ask. Each entry shows its delta against the capture's own locked
 * prediction the moment it lands.
 */

const ASK_COLOR: Record<string, string> = {
  pending: "#b7995c", // champagne
  filled: "#7fb069", // sage green
  selected: "#ffd25a",
};

export function MeasureSheet({ slug }: { slug: string }) {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [doc, setDoc] = useState<MeasureDoc | null>(null);
  const [sheetId, setSheetId] = useState<string | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<string>("");
  const [err, setErr] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [p, m] = await Promise.all([
          loadDoc<Plan>("plan", slug),
          loadDoc<MeasureDoc>("measure", slug),
        ]);
        if (!alive) return;
        setPlan(p);
        setDoc(m);
        const first = p?.sheets.find((s) => s.kind === "floor") ?? p?.sheets[0];
        setSheetId(first?.id ?? null);
        if (!p) setErr("No floorplan delivered for this property yet.");
      } catch (e) {
        if (alive) setErr(e instanceof Error ? e.message : "load failed");
      }
    })();
    return () => {
      alive = false;
    };
  }, [slug]);

  const persist = useCallback(
    async (next: MeasureDoc) => {
      setDoc(next);
      setStatus("saving…");
      try {
        await saveDoc("measure", slug, next);
        setStatus("saved");
      } catch (e) {
        setStatus("");
        setErr(e instanceof Error ? e.message : "save failed — value kept locally");
      }
    },
    [slug],
  );

  const generate = useCallback(() => {
    if (!plan) return;
    void persist(generateMeasureDoc(plan, slug, doc));
  }, [plan, slug, doc, persist]);

  const sheet: PlanSheet | null =
    plan?.sheets.find((s) => s.id === sheetId) ?? plan?.sheets[0] ?? null;
  const asks = useMemo(
    () => (doc && sheet ? doc.asks.filter((a) => a.sheetId === sheet.id) : []),
    [doc, sheet],
  );
  const selAsk = asks.find((a) => a.id === sel) ?? null;
  const filled = doc ? Object.keys(doc.values).length : 0;
  const total = doc?.asks.length ?? 0;

  const select = useCallback(
    (id: string | null) => {
      setSel(id);
      const v = id && doc?.values[id];
      setInput(v ? v.raw : "");
      // Let the panel render, then focus for the numeric keyboard.
      setTimeout(() => inputRef.current?.focus(), 30);
    },
    [doc],
  );

  const commit = useCallback(() => {
    if (!doc || !selAsk) return;
    const ft = parseFtIn(input);
    if (ft == null) {
      setErr(`Couldn't read "${input}" — try 11.53 or 11' 6-3/8"`);
      return;
    }
    setErr(null);
    const next: MeasureDoc = {
      ...doc,
      values: { ...doc.values, [selAsk.id]: { raw: input.trim(), ft, at: Date.now() } },
    };
    void persist(next);
    // Advance to the next unfilled ask on this sheet.
    const order = asks.map((a) => a.id);
    const from = order.indexOf(selAsk.id);
    const nextId =
      order.slice(from + 1).find((id) => !next.values[id]) ??
      order.find((id) => !next.values[id]) ??
      null;
    select(nextId);
  }, [doc, selAsk, input, asks, persist, select]);

  // ---------- drawing ----------
  if (err && !plan) {
    return <p className="font-sans text-sm text-red-300/90">{err}</p>;
  }
  if (!plan || !sheet) {
    return <p className="font-sans text-sm text-paper/50">Loading floorplan…</p>;
  }

  const PAD = 6;
  const vb = `${-PAD} ${-PAD} ${sheet.width + 2 * PAD} ${sheet.height + 2 * PAD}`;
  const fs = Math.max(sheet.width, sheet.height) / 46; // plan-unit font size
  const cx = sheet.width / 2;
  const cy = sheet.height / 2;
  const transforms: string[] = [];
  if (sheet.rotation) transforms.push(`rotate(${sheet.rotation} ${cx} ${cy})`);
  if (sheet.flipX) transforms.push(`translate(${2 * cx} 0) scale(-1 1)`);

  const parsed = parseFtIn(input);
  const delta =
    parsed != null && selAsk ? ((parsed - selAsk.predicted_ft) / selAsk.predicted_ft) * 100 : null;
  const groupMate =
    selAsk?.group != null
      ? doc?.asks.find((a) => a.group === selAsk.group && a.id !== selAsk.id)
      : null;
  const radius = (() => {
    if (!selAsk?.group || !doc) return null;
    const chord = doc.asks.find((a) => a.group === selAsk.group && a.kind === "chord");
    const depth = doc.asks.find((a) => a.group === selAsk.group && a.kind === "depth");
    const c = chord && doc.values[chord.id]?.ft;
    const s = depth && doc.values[depth.id]?.ft;
    return c && s ? radiusFromChord(c, s) : null;
  })();

  return (
    <div>
      {/* header row: sheets, progress, actions */}
      <div className="mb-3 flex flex-wrap items-center gap-3">
        {plan.sheets.length > 1 &&
          plan.sheets.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setSheetId(s.id)}
              className={
                "rounded-full border px-3 py-1 font-sans text-[0.7rem] uppercase tracking-[0.14em] " +
                (s.id === sheet.id
                  ? "border-champagne bg-champagne/15 text-champagne"
                  : "border-paper/25 text-paper/50 hover:border-champagne/60")
              }
            >
              {s.label}
            </button>
          ))}
        <span className="font-sans text-xs text-paper/55">
          {doc ? `${filled} / ${total} measured` : "no sheet yet"}
        </span>
        {status && <span className="font-sans text-xs text-paper/40">{status}</span>}
        <span className="flex-1" />
        <button
          type="button"
          onClick={generate}
          className="rounded-full border border-champagne/60 bg-champagne/[0.06] px-4 py-1.5 font-sans text-[0.7rem] uppercase tracking-[0.14em] text-champagne hover:bg-champagne/[0.12]"
        >
          {doc ? "Regenerate asks (keeps values)" : "Generate measurement sheet"}
        </button>
      </div>

      {doc && total > 0 && (
        <div className="mb-3 h-1.5 w-full overflow-hidden rounded-full bg-paper/10">
          <div
            className="h-full rounded-full bg-champagne transition-[width]"
            style={{ width: `${(100 * filled) / total}%` }}
          />
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        {/* the sheet */}
        <div className="rounded-lg border border-paper/15 bg-paper/[0.02] p-2">
          <svg viewBox={vb} className="h-auto w-full" style={{ maxHeight: "72vh" }}>
            <g transform={transforms.join(" ") || undefined}>
              {/* walls: BIM double-line read = wide soft + thin crisp strokes */}
              {sheet.zones.map((z) => {
                const d = `M ${z.points.map((p) => p.join(",")).join(" L ")} Z`;
                return (
                  <g key={z.id}>
                    <path d={d} fill="none" stroke="#f5f0e6" strokeOpacity={0.14} strokeWidth={fs * 0.55} strokeLinejoin="round" />
                    <path d={d} fill="#f5f0e6" fillOpacity={0.02} stroke="#f5f0e6" strokeOpacity={0.75} strokeWidth={fs * 0.09} strokeLinejoin="round" />
                    <text
                      x={z.points.reduce((s, p) => s + p[0], 0) / z.points.length}
                      y={z.points.reduce((s, p) => s + p[1], 0) / z.points.length}
                      fontSize={fs * 0.9}
                      fill="#f5f0e6"
                      fillOpacity={0.45}
                      textAnchor="middle"
                      style={{ textTransform: "uppercase", letterSpacing: "0.08em" }}
                    >
                      {z.label}
                    </text>
                  </g>
                );
              })}

              {/* dimension asks */}
              {asks.map((a) => {
                const v = doc?.values[a.id];
                const color = a.id === sel ? ASK_COLOR.selected : v ? ASK_COLOR.filled : ASK_COLOR.pending;
                const [x1, y1] = a.a;
                const [x2, y2] = a.b;
                const mx = (x1 + x2) / 2;
                const my = (y1 + y2) / 2;
                const L = Math.hypot(x2 - x1, y2 - y1) || 1;
                const tx = ((y2 - y1) / L) * fs * 0.45; // tick direction (perp)
                const ty = ((x1 - x2) / L) * fs * 0.45;
                const dash = a.kind === "diagonal" ? `${fs * 0.4} ${fs * 0.3}` : a.kind === "depth" ? `${fs * 0.2} ${fs * 0.2}` : undefined;
                const chip = v ? v.ft.toFixed(2) : "·";
                return (
                  <g key={a.id} onClick={() => select(a.id)} style={{ cursor: "pointer" }}>
                    {/* fat invisible hit line for touch */}
                    <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="#000" strokeOpacity={0.001} strokeWidth={fs * 1.4} />
                    <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={color} strokeWidth={fs * (a.id === sel ? 0.16 : 0.1)} strokeDasharray={dash} />
                    <line x1={x1 - tx} y1={y1 - ty} x2={x1 + tx} y2={y1 + ty} stroke={color} strokeWidth={fs * 0.08} />
                    <line x1={x2 - tx} y1={y2 - ty} x2={x2 + tx} y2={y2 + ty} stroke={color} strokeWidth={fs * 0.08} />
                    <g>
                      <rect
                        x={mx - fs * 1.6}
                        y={my - fs * 0.75}
                        width={fs * 3.2}
                        height={fs * 1.4}
                        rx={fs * 0.3}
                        fill="#211c16"
                        stroke={color}
                        strokeWidth={fs * 0.05}
                      />
                      <text x={mx} y={my + fs * 0.32} fontSize={fs * 0.85} fill={color} textAnchor="middle" fontWeight={700}>
                        {chip}
                      </text>
                    </g>
                  </g>
                );
              })}
            </g>
          </svg>
        </div>

        {/* entry panel + list */}
        <div className="space-y-4">
          <div className="rounded-lg border border-paper/15 bg-paper/[0.02] p-4">
            {selAsk ? (
              <>
                <p className="font-sans text-xs uppercase tracking-[0.16em] text-champagne">
                  {selAsk.label}
                </p>
                <p className="mt-1 font-sans text-xs text-paper/45">
                  capture predicts {selAsk.predicted_ft.toFixed(2)} ft ({fmtFtIn(selAsk.predicted_ft)})
                </p>
                <input
                  ref={inputRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commit();
                  }}
                  placeholder={`11' 6-3/8"  or  11.53`}
                  inputMode="text"
                  className="mt-3 w-full rounded-md border border-paper/25 bg-transparent px-3 py-2.5 font-sans text-lg text-paper/90 focus:border-champagne focus:outline-none"
                />
                <div className="mt-2 flex items-baseline justify-between font-sans text-xs">
                  <span className="text-paper/55">
                    {parsed != null ? `${parsed.toFixed(3)} ft — ${fmtFtIn(parsed)}` : input ? "…" : ""}
                  </span>
                  {delta != null && (
                    <span className={Math.abs(delta) > 4 ? "text-amber-300" : "text-green-300"}>
                      Δ {delta > 0 ? "+" : ""}
                      {delta.toFixed(1)}% vs capture
                    </span>
                  )}
                </div>
                {groupMate && (
                  <p className="mt-2 font-sans text-xs text-paper/45">
                    Curve pair: also laser “{groupMate.label.split("— ")[1]}”.
                    {radius != null && (
                      <span className="text-champagne"> Radius = {radius.toFixed(2)} ft.</span>
                    )}
                  </p>
                )}
                <button
                  type="button"
                  onClick={commit}
                  className="mt-3 w-full rounded-full border border-champagne/60 bg-champagne/[0.08] px-4 py-2.5 font-sans text-xs uppercase tracking-[0.16em] text-champagne hover:bg-champagne/[0.15]"
                >
                  Save & next
                </button>
              </>
            ) : (
              <p className="font-sans text-sm text-paper/50">
                {doc
                  ? "Tap any dimension line on the sheet — or a row below — then type the laser reading. Enter saves and jumps to the next unmeasured span."
                  : "Generate the measurement sheet from the delivered floorplan to begin."}
              </p>
            )}
            {err && <p className="mt-2 font-sans text-xs text-red-300/90">{err}</p>}
          </div>

          {asks.length > 0 && (
            <div className="max-h-[46vh] overflow-y-auto rounded-lg border border-paper/15 bg-paper/[0.02]">
              <ul className="divide-y divide-paper/10">
                {asks.map((a) => {
                  const v = doc?.values[a.id];
                  return (
                    <li key={a.id}>
                      <button
                        type="button"
                        onClick={() => select(a.id)}
                        className={
                          "flex w-full items-center justify-between gap-3 px-3 py-2 text-left font-sans text-xs " +
                          (a.id === sel ? "bg-champagne/10" : "hover:bg-paper/[0.04]")
                        }
                      >
                        <span className={v ? "text-paper/45" : "text-paper/80"}>{a.label}</span>
                        <span className={v ? "shrink-0 text-green-300" : "shrink-0 text-champagne/70"}>
                          {v ? `${v.ft.toFixed(2)} ft` : `~${a.predicted_ft.toFixed(1)}`}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
