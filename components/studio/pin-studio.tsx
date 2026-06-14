"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { PROJECTS } from "@/data/projects";
import { streamHls } from "@/lib/stream";
import { type VideoPin, type VideoPinSet, getVideoPins, pinPosAt } from "@/data/video-pins";
import { PinOverlay } from "@/components/tour/pin-overlay";
import { loadDoc, saveDoc } from "@/lib/author-client";
import { cn } from "@/lib/utils";

/**
 * Pin Studio — guided room mapping on a real flat film.
 *
 * Per room you set just two frames: where it ENTERS and where it LEAVES. The
 * tool then walks you to the middle of the path and asks "does the dot still
 * sit on the room?" — drag it on if not (that adds an intermediary keyframe),
 * otherwise tap Aligned. It keeps offering the next-biggest gap until the
 * track is clean. You position by DRAGGING the dot, not pin-pointing a click.
 */

const round2 = (n: number) => Math.round(n * 100) / 100;
const round3 = (n: number) => Math.round(n * 1000) / 1000;
const fmt = (s: number) =>
  `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, "0")}.${Math.floor((s % 1) * 10)}`;
const SEG_MIN = 0.7; // don't bother refining gaps shorter than this

type RVFCVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: () => void) => number;
};
type Phase = "start" | "end" | "refine" | "done";
type Seg = { aT: number; bT: number };

export function PinStudio() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [uid, setUid] = useState(PROJECTS[0]?.streamUid ?? "");
  const [pins, setPins] = useState<VideoPin[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [copied, setCopied] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [saveMsg, setSaveMsg] = useState("");
  const [fps, setFps] = useState(30);
  const fpsRef = useRef(30);
  fpsRef.current = fps;

  const [phase, setPhase] = useState<Phase>("start");
  const [confirmed, setConfirmed] = useState<string[]>([]);
  const [checking, setChecking] = useState<Seg | null>(null);
  const [editedThisCheck, setEditedThisCheck] = useState(false);
  const [dragging, setDragging] = useState(false);
  const draggingRef = useRef(false);

  const active = pins.find((p) => p.id === activeId) ?? null;

  // ---------- HLS playback (plain <video> so we can overlay a drag handle) ----------
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !uid) return;
    const src = streamHls(uid);
    setTime(0);
    setDuration(0);
    let hls: { destroy: () => void } | undefined;
    let cancelled = false;
    // hls.js wherever MSE works (incl. Android Chrome, which misreports native
    // HLS); native HLS only as the Safari/iOS fallback.
    import("hls.js").then(({ default: Hls }) => {
      if (cancelled) return;
      if (Hls.isSupported()) {
        const h = new Hls({ enableWorker: true });
        h.loadSource(src);
        h.attachMedia(v);
        hls = h;
      } else if (v.canPlayType("application/vnd.apple.mpegurl")) {
        v.src = src;
      }
    });
    return () => {
      cancelled = true;
      hls?.destroy();
    };
  }, [uid]);

  // ---------- time tracking ----------
  useEffect(() => {
    const v = videoRef.current as RVFCVideo | null;
    if (!v) return;
    let raf = 0;
    let stop = false;
    const hasRVFC = typeof v.requestVideoFrameCallback === "function";
    const onFrame = () => {
      if (stop) return;
      setTime(v.currentTime);
      if (!v.paused && !v.ended) {
        if (hasRVFC) v.requestVideoFrameCallback!(onFrame);
        else raf = requestAnimationFrame(onFrame);
      }
    };
    const onPlay = () => {
      setPlaying(true);
      if (hasRVFC) v.requestVideoFrameCallback!(onFrame);
      else raf = requestAnimationFrame(onFrame);
    };
    const onPause = () => {
      setPlaying(false);
      setTime(v.currentTime);
    };
    const onMeta = () => setDuration(v.duration || 0);
    const onSeek = () => setTime(v.currentTime);
    v.addEventListener("play", onPlay);
    v.addEventListener("pause", onPause);
    v.addEventListener("loadedmetadata", onMeta);
    v.addEventListener("seeked", onSeek);
    v.addEventListener("timeupdate", onSeek);
    return () => {
      stop = true;
      cancelAnimationFrame(raf);
      v.removeEventListener("play", onPlay);
      v.removeEventListener("pause", onPause);
      v.removeEventListener("loadedmetadata", onMeta);
      v.removeEventListener("seeked", onSeek);
      v.removeEventListener("timeupdate", onSeek);
    };
  }, []);

  // ---------- pin storage (per film) ----------
  useEffect(() => {
    let loaded: VideoPin[] = [];
    try {
      const raw = localStorage.getItem(`lvx-pins:${uid}`);
      loaded = raw ? JSON.parse(raw) : getVideoPins(uid);
    } catch {
      loaded = getVideoPins(uid);
    }
    if (!Array.isArray(loaded)) loaded = [];
    setPins(loaded);
    selectPin(loaded[0]?.id ?? null, loaded);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid]);

  const save = (next: VideoPin[]) => {
    try {
      localStorage.setItem(`lvx-pins:${uid}`, JSON.stringify(next));
    } catch {
      /* storage unavailable */
    }
  };
  // updateLive = state only (cheap, for drag); persist = state + localStorage.
  const updateLive = (updater: (prev: VideoPin[]) => VideoPin[]) => setPins(updater);
  const persist = (updater: (prev: VideoPin[]) => VideoPin[]) =>
    setPins((prev) => {
      const next = updater(prev);
      save(next);
      return next;
    });

  // ---------- transport ----------
  const seek = useCallback((t: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = Math.max(0, Math.min(v.duration || t, t));
  }, []);
  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) void v.play();
    else v.pause();
  }, []);
  // Step exactly N frames, snapped to the frame grid (pauses first so the frame
  // holds). The +half-frame nudge lands inside the target frame, not on its
  // ambiguous boundary, so each press reliably advances one frame.
  const stepFrames = useCallback((n: number) => {
    const v = videoRef.current;
    if (!v) return;
    if (!v.paused) v.pause();
    const f = fpsRef.current || 30;
    const idx = Math.round(v.currentTime * f);
    // Land just inside the target frame (1ms past its boundary) so the decoder
    // shows that frame; small enough to stay reversible across ←/→.
    const target = (idx + n) / f + 0.001;
    v.currentTime = Math.max(0, Math.min(v.duration || target, target));
  }, []);

  // Keyboard scrubbing: ←/→ step one frame, Shift+←/→ jump 10, Space plays.
  // Ignored while typing a room name so those arrows still move the caret.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      const tag = el?.tagName;
      const inField =
        (tag === "INPUT" && (el as HTMLInputElement).type !== "range") ||
        tag === "TEXTAREA" ||
        el?.isContentEditable === true;
      // ←/→ or ,/. (the NLE convention) step frames. e.code is layout-stable,
      // so Shift+,/. (which yield </>) still register.
      const fwd = e.key === "ArrowRight" || e.code === "Period";
      const back = e.key === "ArrowLeft" || e.code === "Comma";
      if (fwd || back) {
        if (inField) return;
        e.preventDefault();
        stepFrames((fwd ? 1 : -1) * (e.shiftKey ? 10 : 1));
      } else if (e.code === "Space") {
        if (inField || tag === "BUTTON") return;
        e.preventDefault();
        togglePlay();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [stepFrames, togglePlay]);

  // ---------- guided flow ----------
  const newId = () =>
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID().slice(0, 8)
      : String(Math.floor(performance.now()));

  const phaseFor = (p: VideoPin | null): Phase =>
    !p || p.keys.length === 0 ? "start" : p.keys.length === 1 ? "end" : "done";

  const selectPin = (id: string | null, list: VideoPin[] = pins) => {
    setActiveId(id);
    setConfirmed([]);
    setChecking(null);
    setEditedThisCheck(false);
    setPhase(phaseFor(list.find((p) => p.id === id) ?? null));
  };

  const addPin = () => {
    const id = newId();
    persist((prev) => [...prev, { id, label: `Room ${prev.length + 1}`, keys: [] }]);
    setActiveId(id);
    setConfirmed([]);
    setChecking(null);
    setPhase("start");
  };
  const removePin = (id: string) => {
    persist((prev) => prev.filter((p) => p.id !== id));
    if (id === activeId) selectPin(null);
  };
  const renamePin = (id: string, label: string) =>
    persist((prev) => prev.map((p) => (p.id === id ? { ...p, label } : p)));

  // Insert/replace the active pin's keyframe at the current time.
  const upsertKey = (x: number, y: number, commit: boolean) => {
    if (!activeId) return 0;
    const t = round2(time);
    let len = 0;
    const updater = (prev: VideoPin[]) =>
      prev.map((p) => {
        if (p.id !== activeId) return p;
        const keys = p.keys.filter((k) => Math.abs(k.t - t) > 0.12);
        keys.push({ t, x: round3(Math.max(0, Math.min(1, x))), y: round3(Math.max(0, Math.min(1, y))) });
        keys.sort((a, b) => a.t - b.t);
        len = keys.length;
        return { ...p, keys };
      });
    if (commit) persist(updater);
    else updateLive(updater);
    if (phase === "refine") setEditedThisCheck(true);
    return len;
  };

  // Find the biggest gap not yet confirmed (and worth refining).
  const nextGap = (keys: VideoPin["keys"], done: string[]): Seg | null => {
    let best: Seg | null = null;
    for (let i = 0; i < keys.length - 1; i++) {
      const span = keys[i + 1].t - keys[i].t;
      if (span <= SEG_MIN) continue;
      const sig = `${keys[i].t}|${keys[i + 1].t}`;
      if (done.includes(sig)) continue;
      if (!best || span > best.bT - best.aT) best = { aT: keys[i].t, bT: keys[i + 1].t };
    }
    return best;
  };

  const advance = (keys: VideoPin["keys"], done: string[]) => {
    const gap = nextGap(keys, done);
    if (!gap) {
      setChecking(null);
      setPhase("done");
      return;
    }
    setChecking(gap);
    setEditedThisCheck(false);
    setPhase("refine");
    seek((gap.aT + gap.bT) / 2);
  };

  // When the 2nd keyframe lands, start the guided refine automatically.
  const lenRef = useRef(0);
  useEffect(() => {
    const len = active?.keys.length ?? 0;
    const was = lenRef.current;
    lenRef.current = len;
    if (!active) return;
    if (phase === "start" && len >= 1) setPhase("end");
    else if (phase === "end" && len >= 2 && was < 2) advance(active.keys, []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.keys.length]);

  const onAlignedNext = () => {
    if (!active) return;
    let done = confirmed;
    if (!editedThisCheck && checking) {
      done = [...confirmed, `${checking.aT}|${checking.bT}`];
      setConfirmed(done);
    }
    advance(active.keys, done);
  };
  const reRefine = () => {
    if (!active) return;
    setConfirmed([]);
    advance(active.keys, []);
  };

  // ---------- drag handle ----------
  const stageXY = (clientX: number, clientY: number) => {
    const r = stageRef.current?.getBoundingClientRect();
    if (!r) return null;
    return { x: (clientX - r.left) / r.width, y: (clientY - r.top) / r.height };
  };
  const onHandleDown = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    draggingRef.current = true; // ref: a synchronous move right after sees it
    setDragging(true);
  };
  const onHandleMove = (e: React.PointerEvent) => {
    if (!draggingRef.current) return;
    const p = stageXY(e.clientX, e.clientY);
    if (p) upsertKey(p.x, p.y, false);
  };
  const onHandleUp = (e: React.PointerEvent) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    setDragging(false);
    const p = stageXY(e.clientX, e.clientY);
    if (p) upsertKey(p.x, p.y, true); // flush to storage
  };
  // Click anywhere on the frame to drop/move the dot there at this time.
  const onStageClick = (e: React.MouseEvent) => {
    if (!activeId) return;
    const p = stageXY(e.clientX, e.clientY);
    if (p) upsertKey(p.x, p.y, true);
  };

  const copyJson = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify({ uid, pins }, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  // ---------- live site (Zero Trust backend) ----------
  const saveToSite = async () => {
    setSaveState("saving");
    setSaveMsg("");
    try {
      await saveDoc("pinset", uid, { uid, pins } satisfies VideoPinSet);
      setSaveState("saved");
      setTimeout(() => setSaveState("idle"), 2200);
    } catch (e) {
      setSaveState("error");
      setSaveMsg(e instanceof Error ? e.message : "Save failed");
    }
  };
  const loadFromSite = async () => {
    try {
      const doc = await loadDoc<VideoPinSet>("pinset", uid);
      if (doc && Array.isArray(doc.pins)) {
        setPins(doc.pins);
        save(doc.pins);
        selectPin(doc.pins[0]?.id ?? null, doc.pins);
      } else {
        alert("No saved pins for this film yet.");
      }
    } catch (e) {
      alert(e instanceof Error ? e.message : "Load failed");
    }
  };

  // Handle position = the active pin's point at the current time.
  const handlePos =
    active && (active.keys.length ? pinPosAt(active, time) : { x: 0.5, y: 0.5 });

  const ctl =
    "rounded-full border border-paper/30 px-3 py-1.5 font-sans text-xs uppercase tracking-[0.14em] text-paper/80 transition-colors hover:border-champagne hover:text-champagne disabled:opacity-30";
  const labelOf = active?.label || "the room";

  return (
    <div className="mx-auto max-w-4xl">
      {/* film picker */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className="font-sans text-[0.7rem] uppercase tracking-[0.18em] text-paper/50">Film</span>
        {PROJECTS.map((p) => (
          <button
            key={p.streamUid}
            type="button"
            onClick={() => setUid(p.streamUid)}
            className={cn(ctl, uid === p.streamUid && "border-champagne text-champagne")}
          >
            {p.title}
          </button>
        ))}
      </div>

      {/* ---------- stage ---------- */}
      <div
        ref={stageRef}
        onClick={onStageClick}
        className={cn(
          "relative aspect-video w-full overflow-hidden rounded-lg border border-paper/15 bg-black [container-type:inline-size]",
          activeId ? "cursor-crosshair" : "cursor-default",
        )}
      >
        <video ref={videoRef} muted playsInline className="h-full w-full object-cover" />
        <PinOverlay pins={pins} currentTime={time} activeId={activeId} />

        {/* draggable handle for the active pin's point at this time */}
        {active && handlePos && (
          <div
            onPointerDown={onHandleDown}
            onPointerMove={onHandleMove}
            onPointerUp={onHandleUp}
            onClick={(e) => e.stopPropagation()}
            className={cn(
              "absolute z-10 flex h-[clamp(2rem,4cqw,3.25rem)] w-[clamp(2rem,4cqw,3.25rem)] -translate-x-1/2 -translate-y-1/2 touch-none items-center justify-center rounded-full border-2 border-champagne bg-champagne/15 backdrop-blur-sm",
              dragging ? "cursor-grabbing scale-110" : "cursor-grab",
            )}
            style={{ left: `${handlePos.x * 100}%`, top: `${handlePos.y * 100}%` }}
            aria-label={`Drag ${labelOf} onto the room`}
          >
            <span className="h-1.5 w-1.5 rounded-full bg-champagne" />
            <span className="absolute h-full w-px bg-champagne/40" />
            <span className="absolute h-px w-full bg-champagne/40" />
          </div>
        )}
      </div>

      {/* transport */}
      <div className="mt-3 flex items-center gap-2">
        <button type="button" onClick={togglePlay} className={ctl} aria-label={playing ? "Pause" : "Play"}>
          {playing ? "❚❚" : "►"}
        </button>
        <button type="button" onClick={() => stepFrames(-1)} className={ctl} aria-label="Previous frame">‹ frame</button>
        <button type="button" onClick={() => stepFrames(1)} className={ctl} aria-label="Next frame">frame ›</button>
        <span className="ml-1 font-mono text-xs tabular-nums text-paper/60">
          {fmt(time)} / {fmt(duration || 0)}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <span className="font-sans text-[0.65rem] uppercase tracking-[0.14em] text-paper/40">fps</span>
          {[24, 30, 60].map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFps(f)}
              className={cn(
                "rounded-full border px-2 py-1 font-mono text-[0.7rem] transition-colors",
                fps === f ? "border-champagne text-champagne" : "border-paper/25 text-paper/60 hover:text-paper",
              )}
            >
              {f}
            </button>
          ))}
        </div>
      </div>
      <p className="mt-1.5 font-sans text-[0.7rem] text-paper/40">
        <kbd className="text-paper/60">←</kbd> <kbd className="text-paper/60">→</kbd> or{" "}
        <kbd className="text-paper/60">,</kbd> <kbd className="text-paper/60">.</kbd> step a frame ·{" "}
        <kbd className="text-paper/60">Shift</kbd> jumps 10 ·{" "}
        <kbd className="text-paper/60">Space</kbd> play/pause
      </p>
      <div className="relative mt-2">
        <input
          type="range"
          min={0}
          max={duration || 0}
          step={0.01}
          value={time}
          onChange={(e) => seek(parseFloat(e.target.value))}
          className="w-full accent-champagne"
          aria-label="Scrub"
        />
        {active && duration > 0 && (
          <div className="pointer-events-none absolute inset-x-0 top-1/2">
            {active.keys.map((k) => (
              <span
                key={k.t}
                className="absolute h-2 w-0.5 -translate-y-1/2 bg-champagne"
                style={{ left: `${(k.t / duration) * 100}%` }}
              />
            ))}
          </div>
        )}
      </div>

      {/* ---------- guided step bar ---------- */}
      {active && (
        <div className="mt-4 rounded-lg border border-champagne/30 bg-champagne/[0.04] p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="font-sans text-[0.7rem] uppercase tracking-[0.18em] text-champagne/80">
                {phase === "start" && `Step 1 · Set start — ${labelOf}`}
                {phase === "end" && `Step 2 · Set end — ${labelOf}`}
                {phase === "refine" && `Step 3 · Refine — ${labelOf}`}
                {phase === "done" && `Tracked — ${labelOf}`}
              </p>
              <p className="mt-1 font-sans text-sm leading-relaxed text-paper/80">
                {phase === "start" &&
                  "Scrub to where the room first comes into frame, then drag the gold dot onto it (or click it)."}
                {phase === "end" &&
                  "Now scrub to where it’s about to leave frame, and drag the dot onto it again."}
                {phase === "refine" &&
                  "I jumped to the middle of the path. Does the dot still sit on the room? Drag it on if it drifted — otherwise tap Aligned."}
                {phase === "done" &&
                  "Start and end are set and the path checks out. Re-check if you want a tighter track, or add another room."}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {phase === "refine" && (
                <>
                  <button type="button" onClick={onAlignedNext} className={cn(ctl, "border-champagne text-champagne")}>
                    {editedThisCheck ? "Next gap ›" : "Aligned ✓"}
                  </button>
                  <button type="button" onClick={() => setPhase("done")} className={ctl}>
                    Done
                  </button>
                </>
              )}
              {phase === "done" && active.keys.length >= 2 && (
                <button type="button" onClick={reRefine} className={ctl}>
                  Re-check
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ---------- pins ---------- */}
      <div className="mt-5">
        <div className="mb-2 flex items-center justify-between">
          <p className="font-sans text-[0.7rem] uppercase tracking-[0.18em] text-paper/50">
            Rooms ({pins.length})
          </p>
          <button type="button" onClick={addPin} className={ctl}>+ Add room</button>
        </div>
        <div className="flex flex-col gap-2">
          {pins.length === 0 && (
            <p className="font-sans text-xs leading-relaxed text-paper/40">
              Add a room to begin. You’ll set just a start and end frame; the tool asks for in-between
              corrections only where the path needs them.
            </p>
          )}
          {pins.map((p) => {
            const isActive = p.id === activeId;
            return (
              <div
                key={p.id}
                className={cn(
                  "flex items-center gap-2 rounded-lg border p-2.5 transition-colors",
                  isActive ? "border-champagne/60 bg-champagne/5" : "border-paper/15",
                )}
              >
                <button
                  type="button"
                  onClick={() => selectPin(p.id)}
                  aria-label="Select room"
                  className={cn(
                    "h-3.5 w-3.5 shrink-0 rounded-full border",
                    isActive ? "border-champagne bg-champagne" : "border-paper/40",
                  )}
                />
                <input
                  value={p.label}
                  onChange={(ev) => renamePin(p.id, ev.target.value)}
                  onFocus={() => selectPin(p.id)}
                  className="min-w-0 flex-1 bg-transparent font-sans text-sm text-paper outline-none placeholder:text-paper/30"
                  placeholder="Room name"
                />
                <span className="font-mono text-[0.7rem] text-paper/40">{p.keys.length} pts</span>
                <button
                  type="button"
                  onClick={() => removePin(p.id)}
                  aria-label="Delete room"
                  className="text-paper/40 transition-colors hover:text-red-400"
                >
                  ✕
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {/* ---------- save / export ---------- */}
      <div className="mt-6 border-t border-paper/10 pt-4">
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void saveToSite()}
            disabled={pins.length === 0 || saveState === "saving"}
            className="flex-1 rounded-full border border-champagne bg-champagne/90 px-4 py-2.5 font-sans text-xs font-semibold uppercase tracking-[0.16em] text-ink transition-colors hover:bg-champagne disabled:opacity-30"
          >
            {saveState === "saving" ? "Saving…" : saveState === "saved" ? "Saved ✓" : "Save to site"}
          </button>
          <button
            type="button"
            onClick={() => void loadFromSite()}
            className="rounded-full border border-paper/30 px-4 py-2.5 font-sans text-xs uppercase tracking-[0.16em] text-paper/70 transition-colors hover:border-champagne hover:text-champagne"
          >
            Load from site
          </button>
          <button
            type="button"
            onClick={copyJson}
            disabled={pins.length === 0}
            className="rounded-full border border-paper/30 px-4 py-2.5 font-sans text-xs uppercase tracking-[0.16em] text-paper/70 transition-colors hover:border-champagne hover:text-champagne disabled:opacity-30"
          >
            {copied ? "Copied ✓" : "Copy JSON"}
          </button>
        </div>
        {saveState === "error" && (
          <p className="mt-2 font-sans text-[0.7rem] text-red-400">{saveMsg}</p>
        )}
        <p className="mt-2 font-sans text-[0.7rem] leading-relaxed text-paper/40">
          Save writes straight to the live site (behind Zero Trust). Still
          autosaves to this browser as a draft; Copy JSON is a manual backup.
        </p>
      </div>
    </div>
  );
}
