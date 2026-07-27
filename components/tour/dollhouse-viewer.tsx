"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Interactive 3D dollhouse — the merged, ceiling-cut, true-handed gaussian
 * splat of the whole property (both nadir flights fused through the laser-
 * anchored registration chain). Matterport-style: drag to orbit, scroll/pinch
 * to zoom, right-drag (two-finger) to pan. Splat units are VSLAM cloud units
 * (1 u = 2.63 ft); floor sits at y=0 and the model is centered on origin.
 */
export function DollhouseViewer({ splatUrl }: { splatUrl: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");

  useEffect(() => {
    let disposed = false;
    let viewer: { dispose?: () => void; stop?: () => void } | null = null;
    const host = hostRef.current;
    if (!host) return;
    (async () => {
      try {
        const GS = await import("@mkkellogg/gaussian-splats-3d");
        if (disposed) return;
        const v = new GS.Viewer({
          rootElement: host,
          cameraUp: [0, 1, 0],
          initialCameraPosition: [14, 16, 14],
          initialCameraLookAt: [0, 0.6, 0],
          sharedMemoryForWorkers: false, // no COOP/COEP headers needed
          gpuAcceleratedSort: false,
          antialiased: true,
        });
        viewer = v;
        await v.addSplatScene(splatUrl, {
          format: GS.SceneFormat.Splat,
          showLoadingUI: false,
          progressiveLoad: true,
        });
        if (disposed) return;
        v.start();
        setState("ready");
      } catch (e) {
        console.error("dollhouse viewer failed", e);
        if (!disposed) setState("failed");
      }
    })();
    return () => {
      disposed = true;
      try {
        viewer?.stop?.();
        viewer?.dispose?.();
      } catch {
        /* teardown best-effort */
      }
    };
  }, [splatUrl]);

  return (
    <div className="relative h-full w-full overflow-hidden bg-ink">
      <div ref={hostRef} className="absolute inset-0 [&_canvas]:!outline-none" />
      {state === "loading" && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 text-paper/70">
          <span className="h-8 w-8 animate-spin rounded-full border-2 border-champagne/60 border-t-transparent" />
          <span className="font-sans text-xs uppercase tracking-[0.25em]">
            Assembling the dollhouse
          </span>
        </div>
      )}
      {state === "failed" && (
        <div className="absolute inset-0 flex items-center justify-center text-paper/60">
          <span className="font-sans text-sm">
            The 3D dollhouse could not load on this device.
          </span>
        </div>
      )}
      {state === "ready" && (
        <div className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-ink/70 px-4 py-1.5 font-sans text-[0.65rem] uppercase tracking-[0.2em] text-paper/70 backdrop-blur">
          Drag to orbit · scroll to zoom · right-drag to pan
        </div>
      )}
    </div>
  );
}
