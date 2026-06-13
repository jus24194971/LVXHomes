"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import type { Plan, PlanZone } from "@/data/plans";
import type { Tour, TourPano } from "@/data/tours";
import { PlanPanel } from "@/components/tour/plan";
import { cn } from "@/lib/utils";

/**
 * LVX 360 flight viewer — Phase 2.
 *
 * One Three.js sphere renders both modes: the equirectangular flythrough video
 * and, when a hotspot is tapped, a still 360 room pano (texture swap behind an
 * ink fade). Hotspots are DOM buttons projected into the scene each frame —
 * accessible, clickable, styled with the site's tokens.
 *
 * Authoring: append ?author=1 — click anywhere in the world to record
 * {time, yaw, pitch}, then copy the JSON into data/tours.ts.
 */

// Texture center (u=0.5) sits at lon=180 in the classic panorama camera math.
const FRONT_LON = 180;

const norm180 = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type AuthorMark = { chapter: string; time: number; yaw: number; pitch: number };

type Engine = {
  camera: THREE.PerspectiveCamera;
  material: THREE.MeshBasicMaterial;
  videoTexture: THREE.VideoTexture;
  look: { lon: number; lat: number; vLon: number; vLat: number; fov: number; dragging: boolean };
  video: HTMLVideoElement;
};

export function TourViewer({
  tour,
  plan,
  className,
}: {
  tour: Tour;
  plan?: Plan;
  className?: string;
}) {
  const mountRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const engineRef = useRef<Engine | null>(null);
  const hotspotEls = useRef(new Map<string, HTMLDivElement>());
  const panoCache = useRef(new Map<string, THREE.Texture>());
  const readoutRef = useRef<HTMLSpanElement | null>(null);

  const [started, setStarted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [hint, setHint] = useState(false);
  const [motionAvail, setMotionAvail] = useState(false);
  const [motionOn, setMotionOn] = useState(false);
  const [fsAvail, setFsAvail] = useState(false);
  const [failed, setFailed] = useState(false);
  const [fading, setFading] = useState(false);
  const [pano, setPano] = useState<TourPano | null>(null);
  const [author, setAuthor] = useState(false);
  const [marks, setMarks] = useState<AuthorMark[]>([]);
  const [pathMarks, setPathMarks] = useState<
    Record<string, Record<string, { t: number; x: number; y: number }[]>>
  >({});
  const [copied, setCopied] = useState(false);
  const [copiedPaths, setCopiedPaths] = useState(false);
  const [planOpen, setPlanOpen] = useState(false);
  const [activeSheetId, setActiveSheetId] = useState(plan?.sheets[0]?.id ?? "");
  const [chapterIdx, setChapterIdx] = useState(0);

  const startedRef = useRef(false);
  const motionOnRef = useRef(false);
  const panoRef = useRef<TourPano | null>(null);
  const authorRef = useRef(false);
  const chapterIdxRef = useRef(0);
  const activeSheetIdRef = useRef("");
  const planIndicatorRef = useRef<SVGGElement | null>(null);
  /** Each chapter remembers where the viewer left it. */
  const chapterTimesRef = useRef<Record<string, number>>({});
  const triedFallbackRef = useRef(false);
  motionOnRef.current = motionOn;
  panoRef.current = pano;
  authorRef.current = author;
  chapterIdxRef.current = chapterIdx;
  activeSheetIdRef.current = activeSheetId;

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const ac = new AbortController();
    const { signal } = ac;

    // ---------- capability detection ----------
    const isTouch = "ontouchstart" in window || navigator.maxTouchPoints > 0;
    setMotionAvail(isTouch && "DeviceOrientationEvent" in window);
    setFsAvail(Boolean(document.fullscreenEnabled));
    setAuthor(new URLSearchParams(window.location.search).has("author"));

    // ---------- video ----------
    const video = document.createElement("video");
    video.crossOrigin = "anonymous"; // required to use the frames as a WebGL texture
    video.src = tour.chapters[0].video.src;
    video.loop = true;
    video.muted = true;
    video.playsInline = true;
    video.setAttribute("webkit-playsinline", "true");
    video.preload = "metadata";
    videoRef.current = video;
    video.addEventListener("playing", () => setPlaying(true), { signal });
    video.addEventListener("pause", () => setPlaying(false), { signal });
    video.addEventListener(
      "error",
      () => {
        const chapter = tour.chapters[chapterIdxRef.current];
        if (chapter.video.fallbackSrc && !triedFallbackRef.current) {
          triedFallbackRef.current = true;
          video.src = chapter.video.fallbackSrc;
          video.load();
          if (startedRef.current && !panoRef.current) void video.play();
          return;
        }
        setFailed(true);
      },
      { signal },
    );

    // ---------- three ----------
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(
      75,
      mount.clientWidth / Math.max(mount.clientHeight, 1),
      1,
      1100,
    );
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    renderer.domElement.className = "h-full w-full";
    mount.appendChild(renderer.domElement);

    const geometry = new THREE.SphereGeometry(500, 60, 40);
    geometry.scale(-1, 1, 1);
    const videoTexture = new THREE.VideoTexture(video);
    videoTexture.colorSpace = THREE.SRGBColorSpace;
    videoTexture.minFilter = THREE.LinearFilter;
    videoTexture.generateMipmaps = false;
    const material = new THREE.MeshBasicMaterial({ map: videoTexture });
    scene.add(new THREE.Mesh(geometry, material));

    // ---------- look state ----------
    const look = { lon: FRONT_LON, lat: 0, vLon: 0, vLat: 0, fov: 75, dragging: false };
    engineRef.current = { camera, material, videoTexture, look, video };
    const pointers = new Map<number, { x: number; y: number }>();
    let pinchDist = 0;
    let downAt = { x: 0, y: 0, t: 0 };

    const clampLat = () => { look.lat = Math.max(-85, Math.min(85, look.lat)); };
    const clampFov = () => { look.fov = Math.max(45, Math.min(95, look.fov)); };

    // ---------- device orientation ----------
    const orient = { alpha: 0, beta: 0, gamma: 0, has: false };
    window.addEventListener(
      "deviceorientation",
      (e) => {
        if (e.alpha === null || e.beta === null || e.gamma === null) return;
        orient.alpha = THREE.MathUtils.degToRad(e.alpha);
        orient.beta = THREE.MathUtils.degToRad(e.beta);
        orient.gamma = THREE.MathUtils.degToRad(e.gamma);
        orient.has = true;
      },
      { signal },
    );
    const zee = new THREE.Vector3(0, 0, 1);
    const euler = new THREE.Euler();
    const qScreen = new THREE.Quaternion();
    const qWorld = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5));
    const qYaw = new THREE.Quaternion();
    const yAxis = new THREE.Vector3(0, 1, 0);
    const screenAngle = () =>
      THREE.MathUtils.degToRad(
        (screen.orientation?.angle ??
          (window as unknown as { orientation?: number }).orientation ??
          0) as number,
      );

    // ---------- pointer controls ----------
    const el = renderer.domElement;
    el.style.touchAction = "none";
    const DRAG_SPEED = 0.18;

    el.addEventListener(
      "pointerdown",
      (e) => {
        try {
          el.setPointerCapture(e.pointerId);
        } catch {
          /* stale/synthetic pointer — drag still works without capture */
        }
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pointers.size === 2) {
          const [a, b] = [...pointers.values()];
          pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
        }
        downAt = { x: e.clientX, y: e.clientY, t: performance.now() };
        look.dragging = true;
        look.vLon = 0;
        look.vLat = 0;
        setHint(false);
      },
      { signal },
    );
    el.addEventListener(
      "pointermove",
      (e) => {
        const prev = pointers.get(e.pointerId);
        if (!prev) return;
        const cur = { x: e.clientX, y: e.clientY };
        pointers.set(e.pointerId, cur);
        if (pointers.size === 2) {
          const [a, b] = [...pointers.values()];
          const d = Math.hypot(a.x - b.x, a.y - b.y);
          if (pinchDist > 0) {
            look.fov *= pinchDist / d;
            clampFov();
          }
          pinchDist = d;
          return;
        }
        const dx = cur.x - prev.x;
        const dy = cur.y - prev.y;
        look.lon -= dx * DRAG_SPEED;
        look.lat += dy * DRAG_SPEED;
        look.vLon = -dx * DRAG_SPEED;
        look.vLat = dy * DRAG_SPEED;
        clampLat();
      },
      { signal },
    );
    const endPointer = (e: PointerEvent) => {
      // Author mode: a press that barely moved is a placement click.
      if (
        authorRef.current &&
        pointers.has(e.pointerId) &&
        Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) < 6 &&
        performance.now() - downAt.t < 400
      ) {
        const rect = el.getBoundingClientRect();
        const ndcX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        const ndcY = -(((e.clientY - rect.top) / rect.height) * 2 - 1);
        camera.updateMatrixWorld();
        const v = new THREE.Vector3(ndcX, ndcY, 0.5).unproject(camera).normalize();
        const lat = 90 - THREE.MathUtils.radToDeg(Math.acos(Math.max(-1, Math.min(1, v.y))));
        const lon = THREE.MathUtils.radToDeg(Math.atan2(v.z, v.x));
        setMarks((prev) => [
          ...prev,
          {
            chapter: tour.chapters[chapterIdxRef.current].id,
            time: Math.round(video.currentTime * 10) / 10,
            yaw: Math.round(norm180(lon - FRONT_LON) * 10) / 10,
            pitch: Math.round(lat * 10) / 10,
          },
        ]);
      }
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinchDist = 0;
      if (pointers.size === 0) look.dragging = false;
    };
    el.addEventListener("pointerup", endPointer, { signal });
    el.addEventListener("pointercancel", endPointer, { signal });
    el.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        look.fov += e.deltaY * 0.02;
        clampFov();
      },
      { passive: false, signal },
    );
    mount.addEventListener(
      "keydown",
      (e) => {
        const step = 4;
        if (e.key === "ArrowLeft") look.lon -= step;
        else if (e.key === "ArrowRight") look.lon += step;
        else if (e.key === "ArrowUp") look.lat += step;
        else if (e.key === "ArrowDown") look.lat -= step;
        else return;
        e.preventDefault();
        clampLat();
        setHint(false);
      },
      { signal },
    );

    // ---------- resize ----------
    const applySize = () => {
      const w = mount.clientWidth;
      const h = Math.max(mount.clientHeight, 1);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    const ro = new ResizeObserver(applySize);
    ro.observe(mount);
    // Belt-and-suspenders for fullscreen: kick the resize immediately and once
    // the top-layer layout settles, in case the observer lags the transition.
    document.addEventListener(
      "fullscreenchange",
      () => {
        applySize();
        requestAnimationFrame(applySize);
      },
      { signal },
    );

    // ---------- render loop ----------
    const hsWorld = new THREE.Vector3();
    const hsCam = new THREE.Vector3();
    const flatHotspots = tour.chapters.flatMap((ch, ci) =>
      ch.hotspots.map((hs) => ({ ci, hs, key: `${ch.id}:${hs.id}` })),
    );
    renderer.setAnimationLoop(() => {
      if (!look.dragging) {
        look.lon += look.vLon;
        look.lat += look.vLat;
        look.vLon *= 0.92;
        look.vLat *= 0.92;
        clampLat();
      }
      camera.fov += (look.fov - camera.fov) * 0.2;
      camera.updateProjectionMatrix();

      if (motionOnRef.current && orient.has) {
        euler.set(orient.beta, orient.alpha, -orient.gamma, "YXZ");
        camera.quaternion.setFromEuler(euler);
        camera.quaternion.multiply(qWorld);
        camera.quaternion.multiply(qScreen.setFromAxisAngle(zee, -screenAngle()));
        qYaw.setFromAxisAngle(yAxis, THREE.MathUtils.degToRad(-(look.lon - FRONT_LON)));
        camera.quaternion.premultiply(qYaw);
      } else {
        const phi = THREE.MathUtils.degToRad(90 - look.lat);
        const theta = THREE.MathUtils.degToRad(look.lon);
        camera.lookAt(
          500 * Math.sin(phi) * Math.cos(theta),
          500 * Math.cos(phi),
          500 * Math.sin(phi) * Math.sin(theta),
        );
      }
      camera.updateMatrixWorld();

      // Project hotspots into the viewport (video mode only).
      const w = mount.clientWidth;
      const h = mount.clientHeight;
      const t = video.currentTime;
      const inVideo = startedRef.current && !panoRef.current;
      for (const { ci, hs, key } of flatHotspots) {
        const node = hotspotEls.current.get(key);
        if (!node) continue;
        let visible =
          inVideo &&
          ci === chapterIdxRef.current &&
          t >= hs.start &&
          t <= hs.end;
        if (visible) {
          const phi = THREE.MathUtils.degToRad(90 - hs.pitch);
          const theta = THREE.MathUtils.degToRad(FRONT_LON + hs.yaw);
          hsWorld.set(
            490 * Math.sin(phi) * Math.cos(theta),
            490 * Math.cos(phi),
            490 * Math.sin(phi) * Math.sin(theta),
          );
          hsCam.copy(hsWorld).applyMatrix4(camera.matrixWorldInverse);
          if (hsCam.z > -2) {
            // Behind or beside the viewer — at ~90° off-axis the projection
            // divides by ~0 and explodes to astronomic coordinates.
            visible = false;
          } else {
            hsWorld.project(camera);
            if (Math.abs(hsWorld.x) > 1.15 || Math.abs(hsWorld.y) > 1.15) {
              visible = false; // outside the viewport (plus a small margin)
            } else {
              const x = (hsWorld.x * 0.5 + 0.5) * w;
              const y = (-hsWorld.y * 0.5 + 0.5) * h;
              node.style.transform = `translate(-50%, -50%) translate(${x}px, ${y}px)`;
            }
          }
        }
        node.style.opacity = visible ? "1" : "0";
        node.style.pointerEvents = visible ? "auto" : "none";
      }

      // You-are-here: interpolate the flight path and aim the view cone.
      const ind = planIndicatorRef.current;
      if (ind) {
        const sheetNow = plan?.sheets.find((s) => s.id === activeSheetIdRef.current);
        const chapterNow = tour.chapters[chapterIdxRef.current];
        const path = sheetNow?.paths?.[chapterNow?.id ?? ""];
        if (inVideo && path && path.length > 0) {
          let a = path[0];
          let b = path[path.length - 1];
          if (t <= a.t) b = a;
          else if (t >= b.t) a = b;
          else {
            for (let i = 0; i < path.length - 1; i++) {
              if (t >= path[i].t && t <= path[i + 1].t) {
                a = path[i];
                b = path[i + 1];
                break;
              }
            }
          }
          const f = b.t === a.t ? 0 : (t - a.t) / (b.t - a.t);
          const x = a.x + (b.x - a.x) * f;
          const y = a.y + (b.y - a.y) * f;
          // Base heading: keyframed (shortest-arc lerp) or direction of travel.
          let base: number;
          if (a.h !== undefined && b.h !== undefined) {
            base = a.h + (((b.h - a.h + 540) % 360) - 180) * f;
          } else if (a.h !== undefined) {
            base = a.h;
          } else {
            let dx = b.x - a.x;
            let dy = b.y - a.y;
            if (dx === 0 && dy === 0) {
              const ai = path.indexOf(a);
              const na = path[Math.max(ai - 1, 0)];
              const nb = path[Math.min(ai + 1, path.length - 1)];
              dx = nb.x - na.x;
              dy = nb.y - na.y;
            }
            base = (Math.atan2(dx, -dy) * 180) / Math.PI;
          }
          const yawDeg = norm180(look.lon - FRONT_LON);
          ind.setAttribute("transform", `translate(${x} ${y}) rotate(${base + yawDeg})`);
          ind.style.display = "";
        } else {
          ind.style.display = "none";
        }
      }

      if (authorRef.current && readoutRef.current) {
        readoutRef.current.textContent = `t ${t.toFixed(1)}s · yaw ${norm180(
          look.lon - FRONT_LON,
        ).toFixed(0)}° · pitch ${look.lat.toFixed(0)}°`;
      }

      renderer.render(scene, camera);
    });

    const cache = panoCache.current;
    return () => {
      ac.abort();
      ro.disconnect();
      renderer.setAnimationLoop(null);
      video.pause();
      video.removeAttribute("src");
      video.load();
      videoTexture.dispose();
      material.dispose();
      geometry.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      cache.forEach((tex) => tex.dispose());
      cache.clear();
      engineRef.current = null;
    };
    // The engine is rebuilt only when the tour changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tour.slug]);

  // ---------- pano transitions ----------
  const loadPano = useCallback((p: TourPano): Promise<THREE.Texture> => {
    const cached = panoCache.current.get(p.id);
    if (cached) return Promise.resolve(cached);
    return new Promise((resolve, reject) => {
      const loader = new THREE.TextureLoader();
      loader.setCrossOrigin("anonymous");
      loader.load(
        p.src,
        (tex) => {
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.minFilter = THREE.LinearFilter;
          tex.generateMipmaps = false;
          panoCache.current.set(p.id, tex);
          resolve(tex);
        },
        undefined,
        reject,
      );
    });
  }, []);

  const enterPano = useCallback(
    async (panoId: string) => {
      const engine = engineRef.current;
      const target = tour.panos.find((p) => p.id === panoId);
      if (!engine || !target) return;
      try {
        const texPromise = loadPano(target);
        setFading(true);
        const [tex] = await Promise.all([texPromise, sleep(350)]);
        engine.video.pause();
        engine.material.map = tex;
        engine.material.needsUpdate = true;
        engine.look.lon = FRONT_LON + (target.initialYaw ?? 0);
        engine.look.lat = 0;
        engine.look.vLon = 0;
        engine.look.vLat = 0;
        setPano(target);
        setFading(false);
      } catch {
        setFading(false);
      }
    },
    [tour.panos, loadPano],
  );

  const resumeFlight = useCallback(async () => {
    const engine = engineRef.current;
    if (!engine) return;
    setFading(true);
    await sleep(350);
    engine.material.map = engine.videoTexture;
    engine.material.needsUpdate = true;
    setPano(null);
    void engine.video.play();
    setFading(false);
  }, []);

  /**
   * Switch flight chapters behind the ink fade. The chapter being left
   * remembers its position; the new one resumes where it was last left
   * (or at seekT / its start).
   */
  const switchChapter = useCallback(
    async (idx: number, seekT?: number) => {
      const engine = engineRef.current;
      const chapter = tour.chapters[idx];
      if (!engine || !chapter || idx === chapterIdxRef.current) return;
      setFading(true);
      await sleep(350);
      const leaving = tour.chapters[chapterIdxRef.current];
      if (leaving) chapterTimesRef.current[leaving.id] = engine.video.currentTime;
      if (panoRef.current) {
        engine.material.map = engine.videoTexture;
        engine.material.needsUpdate = true;
        setPano(null);
      }
      triedFallbackRef.current = false;
      const target = seekT ?? chapterTimesRef.current[chapter.id] ?? 0;
      const v = engine.video;
      v.src = chapter.video.src;
      v.load();
      if (target > 0) {
        v.addEventListener(
          "loadedmetadata",
          () => {
            v.currentTime = target;
          },
          { once: true },
        );
      }
      setChapterIdx(idx);
      chapterIdxRef.current = idx;
      await v.play().catch(() => undefined);
      setFading(false);
    },
    [tour.chapters],
  );

  /** Jump the flight to a moment (switching chapter / leaving a pano first). */
  const seekFlight = useCallback(
    async (t: number, chapterId?: string) => {
      const engine = engineRef.current;
      if (!engine) return;
      if (chapterId) {
        const idx = tour.chapters.findIndex((c) => c.id === chapterId);
        if (idx >= 0 && idx !== chapterIdxRef.current) {
          await switchChapter(idx, t);
          return;
        }
      }
      if (panoRef.current) await resumeFlight();
      engine.video.currentTime = t;
      void engine.video.play();
    },
    [resumeFlight, switchChapter, tour.chapters],
  );

  const handleZoneClick = useCallback(
    (zone: PlanZone) => {
      if (zone.panoId) void enterPano(zone.panoId);
      else if (zone.videoTime !== undefined)
        void seekFlight(zone.videoTime, zone.chapterId);
    },
    [enterPano, seekFlight],
  );

  // ---------- basic controls ----------
  const start = async () => {
    const video = videoRef.current;
    if (!video) return;
    setLoading(true);
    try {
      await video.play();
      startedRef.current = true;
      setStarted(true);
      setHint(true);
      setTimeout(() => setHint(false), 4500);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  };

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video || pano) return;
    if (video.paused) void video.play();
    else video.pause();
  };

  const toggleMotion = async () => {
    if (motionOn) {
      setMotionOn(false);
      return;
    }
    type IOSOrientation = { requestPermission?: () => Promise<string> };
    const doe = DeviceOrientationEvent as unknown as IOSOrientation;
    try {
      if (typeof doe.requestPermission === "function") {
        const res = await doe.requestPermission();
        if (res !== "granted") return;
      }
      setMotionOn(true);
    } catch {
      /* declined */
    }
  };

  const toggleFullscreen = () => {
    const host = mountRef.current?.parentElement;
    if (!host) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void host.requestFullscreen();
  };

  const copyMarks = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(marks, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  /** Author mode: a click on the plan drops a timed path keyframe. */
  const recordPathMark = useCallback(
    (x: number, y: number) => {
      const v = videoRef.current;
      const ch = tour.chapters[chapterIdxRef.current]?.id;
      const sh = activeSheetIdRef.current;
      if (!v || !ch || !sh) return;
      const t = Math.round(v.currentTime * 10) / 10;
      setPathMarks((prev) => {
        const bySheet = { ...(prev[sh] ?? {}) };
        bySheet[ch] = [...(bySheet[ch] ?? []), { t, x, y }].sort((p, q) => p.t - q.t);
        return { ...prev, [sh]: bySheet };
      });
    },
    [tour.chapters],
  );

  const copyPathMarks = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(pathMarks, null, 2));
      setCopiedPaths(true);
      setTimeout(() => setCopiedPaths(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  const pathMarkCount = Object.values(pathMarks).reduce(
    (n, byCh) => n + Object.values(byCh).reduce((m, arr) => m + arr.length, 0),
    0,
  );

  // Sizes use container-query units so the UI keeps the same visual weight
  // whether the player is a 400px embed or a fullscreen 4K monitor.
  const ctl =
    "flex h-[clamp(2.5rem,3cqw,4.25rem)] w-[clamp(2.5rem,3cqw,4.25rem)] items-center justify-center rounded-full border border-paper/40 text-[clamp(0.875rem,1cqw,1.35rem)] text-paper/90 backdrop-blur-sm transition-colors hover:border-champagne hover:text-champagne";

  return (
    <div className={cn("relative overflow-hidden bg-ink [container-type:inline-size]", className)}>
      <div
        ref={mountRef}
        tabIndex={0}
        role="application"
        aria-label="360 degree flight viewer. Drag, use arrow keys, or enable motion to look around."
        className="absolute inset-0 outline-none"
      />

      {/* Hotspots — projected into the world each frame (all chapters; only
          the active chapter's are made visible by the render loop) */}
      <div aria-hidden={!started} className="pointer-events-none absolute inset-0">
        {tour.chapters.flatMap((ch) =>
          ch.hotspots.map((hs) => (
          <div
            key={`${ch.id}:${hs.id}`}
            ref={(node) => {
              const key = `${ch.id}:${hs.id}`;
              if (node) hotspotEls.current.set(key, node);
              else hotspotEls.current.delete(key);
            }}
            className="absolute left-0 top-0 flex flex-col items-center gap-[clamp(0.5rem,0.7cqw,1rem)] opacity-0 transition-opacity duration-300"
            style={{ pointerEvents: "none" }}
          >
            <button
              type="button"
              onClick={() => void enterPano(hs.panoId)}
              aria-label={`Step into ${hs.label}`}
              className="group relative flex h-[clamp(3rem,4.5cqw,7.5rem)] w-[clamp(3rem,4.5cqw,7.5rem)] items-center justify-center"
            >
              <span className="absolute inset-0 rounded-full border border-champagne/50 motion-safe:animate-ping" />
              <span className="relative flex h-[72%] w-[72%] items-center justify-center rounded-full border border-champagne bg-ink/40 text-champagne backdrop-blur-sm transition-transform duration-300 group-hover:scale-110">
                <span className="h-[14%] w-[14%] rounded-full bg-champagne" />
              </span>
            </button>
            <span className="rounded-full bg-ink/60 px-[1.3em] py-[0.45em] font-sans text-[clamp(0.625rem,1cqw,1.25rem)] uppercase tracking-[0.18em] text-paper/90 backdrop-blur-sm">
              {hs.label}
            </span>
          </div>
          )),
        )}
      </div>

      {/* Ink fade for scene transitions */}
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-0 bg-ink transition-opacity duration-300",
          fading ? "opacity-100" : "opacity-0",
        )}
      />

      {/* Pano chrome */}
      {pano && !fading && (
        <>
          <div className="pointer-events-none absolute inset-x-0 top-0 flex justify-center p-4">
            <span className="rounded-full bg-ink/60 px-[1.5em] py-[0.65em] font-sans text-[clamp(0.6875rem,0.95cqw,1.125rem)] uppercase tracking-[0.2em] text-champagne backdrop-blur-sm">
              {pano.label} · Still 360
            </span>
          </div>
          <div className="absolute left-4 top-4">
            <button
              type="button"
              onClick={() => void resumeFlight()}
              className="rounded-full border border-paper/40 bg-ink/40 px-[1.5em] py-[0.65em] font-sans text-[clamp(0.6875rem,0.95cqw,1.125rem)] uppercase tracking-[0.18em] text-paper/90 backdrop-blur-sm transition-colors hover:border-champagne hover:text-champagne"
            >
              ← Resume the flight
            </button>
          </div>
        </>
      )}

      {/* Pre-flight cover */}
      {!started && (
        <button
          type="button"
          onClick={start}
          disabled={loading || failed}
          className="group absolute inset-0 flex flex-col items-center justify-center gap-5 bg-ink/60"
        >
          <span className="flex h-[clamp(5rem,7cqw,9rem)] w-[clamp(5rem,7cqw,9rem)] items-center justify-center rounded-full border border-champagne/70 text-[clamp(1.375rem,1.9cqw,2.5rem)] text-champagne transition-transform duration-300 group-hover:scale-105">
            {loading ? (
              <span className="h-[30%] w-[30%] animate-spin rounded-full border-2 border-champagne/30 border-t-champagne" />
            ) : (
              <svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M8 5v14l11-7z" />
              </svg>
            )}
          </span>
          <span className="font-sans text-[clamp(0.75rem,0.95cqw,1.125rem)] uppercase tracking-[0.22em] text-paper/80">
            {failed ? "Couldn't start the flight" : "Take the flight"}
          </span>
        </button>
      )}

      {/* Hint */}
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-x-0 bottom-16 flex justify-center transition-opacity duration-700",
          hint && !pano ? "opacity-100" : "opacity-0",
        )}
      >
        <span className="rounded-full bg-ink/60 px-[1.5em] py-[0.65em] font-sans text-[clamp(0.6875rem,0.95cqw,1.125rem)] uppercase tracking-[0.2em] text-paper/85 backdrop-blur-sm">
          Drag to look · tap a gold ring to step inside
        </span>
      </div>

      {/* Controls */}
      {started && (
        <div className="absolute inset-x-0 bottom-0 flex items-center justify-between p-4">
          {/* Chapter switcher — only when the tour has multiple flight chapters */}
          {tour.chapters.length > 1 && !pano && (
            <div className="absolute left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full border border-paper/30 bg-ink/40 px-2 py-1 backdrop-blur-sm">
              <button
                type="button"
                onClick={() => void switchChapter((chapterIdx - 1 + tour.chapters.length) % tour.chapters.length)}
                aria-label="Previous chapter"
                className="px-[0.6em] font-sans text-[clamp(0.75rem,0.9cqw,1.125rem)] text-paper/70 transition-colors hover:text-champagne"
              >
                ‹
              </button>
              <span className="min-w-[7em] text-center font-sans text-[clamp(0.625rem,0.8cqw,1rem)] uppercase tracking-[0.16em] text-champagne">
                {tour.chapters[chapterIdx]?.label}
              </span>
              <button
                type="button"
                onClick={() => void switchChapter((chapterIdx + 1) % tour.chapters.length)}
                aria-label="Next chapter"
                className="px-[0.6em] font-sans text-[clamp(0.75rem,0.9cqw,1.125rem)] text-paper/70 transition-colors hover:text-champagne"
              >
                ›
              </button>
            </div>
          )}
          <div>
            {!pano && (
              <button type="button" onClick={togglePlay} aria-label={playing ? "Pause" : "Play"} className={ctl}>
                {playing ? (
                  <svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <path d="M6 4h4v16H6zM14 4h4v16h-4z" />
                  </svg>
                ) : (
                  <svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <path d="M8 5v14l11-7z" />
                  </svg>
                )}
              </button>
            )}
          </div>
          <div className="flex items-center gap-3">
            {plan && (
              <button
                type="button"
                onClick={() => setPlanOpen((o) => !o)}
                aria-pressed={planOpen}
                aria-label="Toggle plan"
                className={cn(ctl, "w-auto gap-2 px-[1.4em]", planOpen && "border-champagne text-champagne")}
              >
                <span className="font-sans text-[clamp(0.625rem,0.8cqw,1rem)] uppercase tracking-[0.18em]">Plan</span>
              </button>
            )}
            {motionAvail && (
              <button
                type="button"
                onClick={toggleMotion}
                aria-pressed={motionOn}
                aria-label="Toggle device motion"
                className={cn(ctl, "w-auto gap-2 px-[1.4em]", motionOn && "border-champagne text-champagne")}
              >
                <span className="font-sans text-[clamp(0.625rem,0.8cqw,1rem)] uppercase tracking-[0.18em]">Motion</span>
              </button>
            )}
            {fsAvail && (
              <button type="button" onClick={toggleFullscreen} aria-label="Fullscreen" className={ctl}>
                <svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
                </svg>
              </button>
            )}
          </div>
        </div>
      )}

      {/* Living minimap */}
      {plan && started && planOpen && (
        <div className="absolute bottom-[clamp(4.5rem,6cqw,7rem)] right-4">
          <PlanPanel
            plan={plan}
            activeSheetId={activeSheetId}
            onSheetChange={setActiveSheetId}
            activeZoneId={
              pano
                ? plan.sheets
                    .flatMap((s) => s.zones)
                    .find((z) => z.panoId === pano.id)?.id
                : undefined
            }
            onZoneClick={handleZoneClick}
            onClose={() => setPlanOpen(false)}
            indicatorRef={planIndicatorRef}
            authorMode={author}
            onCanvasClick={author ? recordPathMark : undefined}
          />
        </div>
      )}

      {/* Authoring overlay */}
      {author && started && (
        <div className="absolute right-4 top-4 w-64 rounded border border-champagne/40 bg-ink/85 p-4 font-sans text-xs text-paper backdrop-blur">
          <p className="font-display text-[0.6875rem] uppercase tracking-[0.2em] text-champagne">
            Authoring
          </p>
          <p className="mt-2 leading-relaxed text-paper/70">
            Click anywhere in the world to mark a hotspot.
          </p>
          <p className="mt-2 tabular-nums text-champagne/90">
            <span ref={readoutRef} />
          </p>
          {marks.length > 0 && (
            <ul className="mt-3 flex max-h-40 flex-col gap-1 overflow-auto border-t border-paper/15 pt-3 tabular-nums">
              {marks.map((m, i) => (
                <li key={i} className="flex items-center justify-between gap-2">
                  <span>
                    t{m.time}s · y{m.yaw}° · p{m.pitch}°
                  </span>
                  <button
                    type="button"
                    onClick={() => setMarks((prev) => prev.filter((_, j) => j !== i))}
                    aria-label="Remove mark"
                    className="text-paper/50 hover:text-champagne"
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => void copyMarks()}
              disabled={marks.length === 0}
              className="flex-1 rounded border border-champagne/60 px-2 py-1.5 uppercase tracking-[0.14em] text-champagne transition-colors hover:bg-champagne hover:text-ink disabled:opacity-40"
            >
              {copied ? "Copied" : "Copy JSON"}
            </button>
            <button
              type="button"
              onClick={() => setMarks([])}
              disabled={marks.length === 0}
              className="rounded border border-paper/30 px-2 py-1.5 uppercase tracking-[0.14em] text-paper/70 transition-colors hover:border-paper/60 disabled:opacity-40"
            >
              Clear
            </button>
          </div>
          <div className="mt-4 border-t border-paper/15 pt-3">
            <p className="text-paper/70">
              Path keys: <span className="tabular-nums text-champagne">{pathMarkCount}</span>
              <span className="text-paper/40"> — open the Plan, fly, click your position</span>
            </p>
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                onClick={() => void copyPathMarks()}
                disabled={pathMarkCount === 0}
                className="flex-1 rounded border border-champagne/60 px-2 py-1.5 uppercase tracking-[0.14em] text-champagne transition-colors hover:bg-champagne hover:text-ink disabled:opacity-40"
              >
                {copiedPaths ? "Copied" : "Copy paths"}
              </button>
              <button
                type="button"
                onClick={() => setPathMarks({})}
                disabled={pathMarkCount === 0}
                className="rounded border border-paper/30 px-2 py-1.5 uppercase tracking-[0.14em] text-paper/70 transition-colors hover:border-paper/60 disabled:opacity-40"
              >
                Clear
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
