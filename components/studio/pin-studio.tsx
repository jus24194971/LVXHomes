"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { PROJECTS } from "@/data/projects";
import { streamHls } from "@/lib/stream";
import { type VideoPin, getVideoPins, pinWindow } from "@/data/video-pins";
import { PinOverlay } from "@/components/tour/pin-overlay";
import { cn } from "@/lib/utils";

/**
 * Pin Studio — map where rooms live in a real flat film. Pick a Stream film,
 * scrub, select a pin, and click the room to drop a tracking keyframe. Pins
 * interpolate between keyframes so they follow the room as the drone moves.
 * Work autosaves to localStorage; "Copy JSON" exports for data/video-pins.ts.
 */

const round2 = (n: number) => Math.round(n * 100) / 100;
const round3 = (n: number) => Math.round(n * 1000) / 1000;
const fmt = (s: number) =>
  `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, "0")}.${Math.floor((s % 1) * 10)}`;

type RVFCVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: () => void) => number;
};

export function PinStudio() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [uid, setUid] = useState(PROJECTS[0]?.streamUid ?? "");
  const [pins, setPins] = useState<VideoPin[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [copied, setCopied] = useState(false);

  // ---------- HLS playback (plain <video> so we can overlay click targets) ----------
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !uid) return;
    const src = streamHls(uid);
    setTime(0);
    setDuration(0);
    let hls: { destroy: () => void } | undefined;
    let cancelled = false;
    // Prefer hls.js wherever MSE works (Chrome/Firefox/Edge, incl. Android —
    // which reports a misleading "maybe" for native HLS but can't actually play
    // it). Fall back to native HLS only when hls.js isn't supported (Safari/iOS).
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

  // ---------- time tracking (frame-accurate while playing) ----------
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

  // ---------- pins: load on film change (localStorage WIP, else committed data) ----------
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
    setActiveId(loaded[0]?.id ?? null);
  }, [uid]);

  // Every mutation goes through here so saves always target the current film.
  const persist = useCallback(
    (updater: (prev: VideoPin[]) => VideoPin[]) => {
      setPins((prev) => {
        const next = updater(prev);
        try {
          localStorage.setItem(`lvx-pins:${uid}`, JSON.stringify(next));
        } catch {
          /* storage unavailable */
        }
        return next;
      });
    },
    [uid],
  );

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

  // ---------- authoring ----------
  const newId = () =>
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID().slice(0, 8)
      : String(Math.floor(performance.now()));

  const addPin = () => {
    const id = newId();
    persist((prev) => [
      ...prev,
      { id, label: `Room ${prev.length + 1}`, keys: [] },
    ]);
    setActiveId(id);
  };
  const removePin = (id: string) => {
    persist((prev) => prev.filter((p) => p.id !== id));
    setActiveId((cur) => (cur === id ? null : cur));
  };
  const renamePin = (id: string, label: string) =>
    persist((prev) => prev.map((p) => (p.id === id ? { ...p, label } : p)));

  const addKeyframeAt = (x: number, y: number) => {
    if (!activeId) return;
    const t = round2(time);
    persist((prev) =>
      prev.map((p) => {
        if (p.id !== activeId) return p;
        const keys = p.keys.filter((k) => Math.abs(k.t - t) > 0.12);
        keys.push({ t, x: round3(x), y: round3(y) });
        keys.sort((a, b) => a.t - b.t);
        return { ...p, keys };
      }),
    );
  };
  const removeKey = (id: string, t: number) =>
    persist((prev) =>
      prev.map((p) => (p.id === id ? { ...p, keys: p.keys.filter((k) => k.t !== t) } : p)),
    );

  const onStageClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!activeId) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    if (x < 0 || x > 1 || y < 0 || y > 1) return;
    addKeyframeAt(x, y);
  };

  const copyJson = async () => {
    const payload = JSON.stringify({ uid, pins }, null, 2);
    try {
      await navigator.clipboard.writeText(payload);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  const active = pins.find((p) => p.id === activeId) ?? null;
  const ctl =
    "rounded-full border border-paper/30 px-3 py-1.5 font-sans text-xs uppercase tracking-[0.14em] text-paper/80 transition-colors hover:border-champagne hover:text-champagne";

  return (
    <div className="grid gap-6 lg:grid-cols-[1.6fr_1fr]">
      {/* ---------- stage ---------- */}
      <div>
        <div className="relative aspect-video overflow-hidden rounded-lg border border-paper/15 bg-black [container-type:inline-size]">
          <video
            ref={videoRef}
            muted
            playsInline
            poster={undefined}
            className="h-full w-full object-cover"
          />
          <PinOverlay pins={pins} currentTime={time} activeId={activeId} />
          {/* click-capture: drop a keyframe for the active pin */}
          <div
            onClick={onStageClick}
            className={cn(
              "absolute inset-0",
              activeId ? "cursor-crosshair" : "cursor-default",
            )}
          />
          {!activeId && (
            <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
              <span className="rounded-full bg-ink/70 px-3 py-1 font-sans text-[0.7rem] uppercase tracking-[0.16em] text-paper/70 backdrop-blur-sm">
                Add or select a pin, then click the room
              </span>
            </div>
          )}
        </div>

        {/* transport */}
        <div className="mt-3 flex items-center gap-3">
          <button type="button" onClick={togglePlay} className={ctl} aria-label={playing ? "Pause" : "Play"}>
            {playing ? "❚❚" : "►"}
          </button>
          <button type="button" onClick={() => seek(time - 1 / 30)} className={ctl} aria-label="Back one frame">
            ‹ frame
          </button>
          <button type="button" onClick={() => seek(time + 1 / 30)} className={ctl} aria-label="Forward one frame">
            frame ›
          </button>
          <span className="font-mono text-xs tabular-nums text-paper/60">
            {fmt(time)} / {fmt(duration || 0)}
          </span>
        </div>
        {/* scrub + active-pin keyframe ticks */}
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
            <div className="pointer-events-none absolute inset-x-0 top-1/2 -z-0">
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
      </div>

      {/* ---------- panel ---------- */}
      <div className="flex flex-col gap-5">
        {/* film picker */}
        <div>
          <p className="mb-2 font-sans text-[0.7rem] uppercase tracking-[0.18em] text-paper/50">Film</p>
          <div className="flex flex-wrap gap-2">
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
        </div>

        {/* pins */}
        <div>
          <div className="mb-2 flex items-center justify-between">
            <p className="font-sans text-[0.7rem] uppercase tracking-[0.18em] text-paper/50">
              Pins ({pins.length})
            </p>
            <button type="button" onClick={addPin} className={ctl}>
              + Add pin
            </button>
          </div>
          <div className="flex flex-col gap-2">
            {pins.length === 0 && (
              <p className="font-sans text-xs leading-relaxed text-paper/40">
                No pins yet. Add one, scrub to where a room appears, and click it in the frame to drop a
                keyframe. Drop a few across the flight and the pin will track the room.
              </p>
            )}
            {pins.map((p) => {
              const [s, e] = pinWindow(p);
              const isActive = p.id === activeId;
              return (
                <div
                  key={p.id}
                  className={cn(
                    "rounded-lg border p-2.5 transition-colors",
                    isActive ? "border-champagne/60 bg-champagne/5" : "border-paper/15",
                  )}
                >
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setActiveId(p.id)}
                      aria-label="Select pin"
                      className={cn(
                        "h-3.5 w-3.5 shrink-0 rounded-full border",
                        isActive ? "border-champagne bg-champagne" : "border-paper/40",
                      )}
                    />
                    <input
                      value={p.label}
                      onChange={(ev) => renamePin(p.id, ev.target.value)}
                      onFocus={() => setActiveId(p.id)}
                      className="min-w-0 flex-1 bg-transparent font-sans text-sm text-paper outline-none placeholder:text-paper/30"
                      placeholder="Room name"
                    />
                    <span className="font-mono text-[0.7rem] text-paper/40">{p.keys.length}k</span>
                    <button
                      type="button"
                      onClick={() => removePin(p.id)}
                      aria-label="Delete pin"
                      className="text-paper/40 transition-colors hover:text-red-400"
                    >
                      ✕
                    </button>
                  </div>
                  {isActive && p.keys.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5 pl-6">
                      {p.keys.map((k) => (
                        <span key={k.t} className="inline-flex items-center overflow-hidden rounded-full border border-paper/20">
                          <button
                            type="button"
                            onClick={() => seek(k.t)}
                            className="px-2 py-0.5 font-mono text-[0.7rem] text-paper/70 transition-colors hover:text-champagne"
                            title={`x ${k.x} · y ${k.y}`}
                          >
                            {fmt(k.t)}
                          </button>
                          <button
                            type="button"
                            onClick={() => removeKey(p.id, k.t)}
                            aria-label="Delete keyframe"
                            className="border-l border-paper/20 px-1.5 py-0.5 text-[0.7rem] text-paper/40 hover:text-red-400"
                          >
                            ✕
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                  {isActive && (
                    <p className="mt-1.5 pl-6 font-sans text-[0.7rem] text-paper/40">
                      shows {fmt(s)}–{fmt(e)} · click the frame to add a keyframe here
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* export */}
        <div className="mt-auto border-t border-paper/10 pt-4">
          <button
            type="button"
            onClick={copyJson}
            disabled={pins.length === 0}
            className={cn(
              "w-full rounded-full border border-champagne/60 px-4 py-2.5 font-sans text-xs uppercase tracking-[0.16em] text-champagne transition-colors hover:bg-champagne/10 disabled:opacity-30",
            )}
          >
            {copied ? "Copied ✓" : "Copy JSON for video-pins.ts"}
          </button>
          <p className="mt-2 font-sans text-[0.7rem] leading-relaxed text-paper/40">
            Autosaves to this browser. Paste the JSON into{" "}
            <code className="text-champagne/80">data/video-pins.ts</code> to ship it.
          </p>
        </div>
      </div>
    </div>
  );
}
