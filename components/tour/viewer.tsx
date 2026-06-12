"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { cn } from "@/lib/utils";

/**
 * LVX 360 flight viewer — Phase 1 engine.
 *
 * Renders an equirectangular video on the inside of a sphere (Three.js) with
 * free-look controls: pointer drag (with inertia), wheel/pinch zoom, arrow
 * keys, and device motion on phones (iOS permission flow included).
 *
 * The video element is same-origin for now, which sidesteps the iOS
 * video-texture CORS rules; when real footage moves to media.lvxhomes.com we
 * add crossOrigin + CORS headers there.
 */

// Texture center (u=0.5) sits at lon=180 in the classic panorama camera math,
// so 180 = "look at the middle of the equirect frame" (our FRONT).
const FRONT_LON = 180;

type Props = {
  src: string;
  /** Extra yaw in degrees added to the initial view (0 = face FRONT). */
  initialYaw?: number;
  className?: string;
};

export function TourViewer({ src, initialYaw = 0, className }: Props) {
  const mountRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const [started, setStarted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [hint, setHint] = useState(false);
  const [motionAvail, setMotionAvail] = useState(false);
  const [motionOn, setMotionOn] = useState(false);
  const [fsAvail, setFsAvail] = useState(false);
  const [failed, setFailed] = useState(false);

  const motionOnRef = useRef(false);
  motionOnRef.current = motionOn;

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const ac = new AbortController();
    const { signal } = ac;

    // ---------- capability detection ----------
    const isTouch = "ontouchstart" in window || navigator.maxTouchPoints > 0;
    setMotionAvail(isTouch && "DeviceOrientationEvent" in window);
    setFsAvail(Boolean(document.fullscreenEnabled));

    // ---------- video ----------
    const video = document.createElement("video");
    video.src = src;
    video.loop = true;
    video.muted = true;
    video.playsInline = true;
    video.setAttribute("webkit-playsinline", "true");
    video.preload = "metadata";
    videoRef.current = video;
    video.addEventListener("playing", () => setPlaying(true), { signal });
    video.addEventListener("pause", () => setPlaying(false), { signal });
    video.addEventListener("error", () => setFailed(true), { signal });

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
    geometry.scale(-1, 1, 1); // view from inside
    const texture = new THREE.VideoTexture(video);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    const material = new THREE.MeshBasicMaterial({ map: texture });
    const sphere = new THREE.Mesh(geometry, material);
    scene.add(sphere);

    // ---------- look state ----------
    const look = {
      lon: FRONT_LON + initialYaw,
      lat: 0,
      vLon: 0,
      vLat: 0,
      fov: 75,
      dragging: false,
    };
    const pointers = new Map<number, { x: number; y: number }>();
    let pinchDist = 0;

    const clampLat = () => {
      look.lat = Math.max(-85, Math.min(85, look.lat));
    };
    const clampFov = () => {
      look.fov = Math.max(45, Math.min(95, look.fov));
    };

    // ---------- device orientation ----------
    const orient = { alpha: 0, beta: 0, gamma: 0, has: false };
    const onOrient = (e: DeviceOrientationEvent) => {
      if (e.alpha === null || e.beta === null || e.gamma === null) return;
      orient.alpha = THREE.MathUtils.degToRad(e.alpha);
      orient.beta = THREE.MathUtils.degToRad(e.beta);
      orient.gamma = THREE.MathUtils.degToRad(e.gamma);
      orient.has = true;
    };
    window.addEventListener("deviceorientation", onOrient, { signal });

    const zee = new THREE.Vector3(0, 0, 1);
    const euler = new THREE.Euler();
    const qScreen = new THREE.Quaternion();
    const qWorld = new THREE.Quaternion(
      -Math.sqrt(0.5),
      0,
      0,
      Math.sqrt(0.5),
    );
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
        el.setPointerCapture(e.pointerId);
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pointers.size === 2) {
          const [a, b] = [...pointers.values()];
          pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
        }
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
    const ro = new ResizeObserver(() => {
      const w = mount.clientWidth;
      const h = Math.max(mount.clientHeight, 1);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    });
    ro.observe(mount);

    // ---------- render loop ----------
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
        // Device drives the view; drag offset is applied as extra world yaw.
        euler.set(orient.beta, orient.alpha, -orient.gamma, "YXZ");
        camera.quaternion.setFromEuler(euler);
        camera.quaternion.multiply(qWorld);
        camera.quaternion.multiply(
          qScreen.setFromAxisAngle(zee, -screenAngle()),
        );
        qYaw.setFromAxisAngle(
          yAxis,
          THREE.MathUtils.degToRad(-(look.lon - FRONT_LON - initialYaw)),
        );
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
      renderer.render(scene, camera);
    });

    return () => {
      ac.abort();
      ro.disconnect();
      renderer.setAnimationLoop(null);
      video.pause();
      video.removeAttribute("src");
      video.load();
      texture.dispose();
      material.dispose();
      geometry.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
    // The engine is rebuilt only when the source changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  const start = async () => {
    const video = videoRef.current;
    if (!video) return;
    setLoading(true);
    try {
      await video.play();
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
    if (!video) return;
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
      /* user declined */
    }
  };

  const toggleFullscreen = () => {
    const mount = mountRef.current?.parentElement;
    if (!mount) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void mount.requestFullscreen();
  };

  const ctl =
    "flex h-10 w-10 items-center justify-center rounded-full border border-paper/40 text-paper/90 backdrop-blur-sm transition-colors hover:border-champagne hover:text-champagne";

  return (
    <div className={cn("relative bg-ink", className)}>
      <div
        ref={mountRef}
        tabIndex={0}
        role="application"
        aria-label="360 degree flight viewer. Drag, use arrow keys, or enable motion to look around."
        className="absolute inset-0 outline-none"
      />

      {/* Pre-flight cover */}
      {!started && (
        <button
          type="button"
          onClick={start}
          disabled={loading || failed}
          className="group absolute inset-0 flex flex-col items-center justify-center gap-5 bg-ink/60"
        >
          <span className="flex h-20 w-20 items-center justify-center rounded-full border border-champagne/70 text-champagne transition-transform duration-300 group-hover:scale-105">
            {loading ? (
              <span className="h-6 w-6 animate-spin rounded-full border-2 border-champagne/30 border-t-champagne" />
            ) : (
              <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M8 5v14l11-7z" />
              </svg>
            )}
          </span>
          <span className="font-sans text-xs uppercase tracking-[0.22em] text-paper/80">
            {failed ? "Couldn't start the flight" : "Take the flight"}
          </span>
        </button>
      )}

      {/* Hint */}
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-x-0 bottom-16 flex justify-center transition-opacity duration-700",
          hint ? "opacity-100" : "opacity-0",
        )}
      >
        <span className="rounded-full bg-ink/60 px-4 py-2 font-sans text-[0.6875rem] uppercase tracking-[0.2em] text-paper/85 backdrop-blur-sm">
          Drag to look around
        </span>
      </div>

      {/* Controls */}
      {started && (
        <div className="absolute inset-x-0 bottom-0 flex items-center justify-between p-4">
          <button type="button" onClick={togglePlay} aria-label={playing ? "Pause" : "Play"} className={ctl}>
            {playing ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M6 4h4v16H6zM14 4h4v16h-4z" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M8 5v14l11-7z" />
              </svg>
            )}
          </button>
          <div className="flex items-center gap-3">
            {motionAvail && (
              <button
                type="button"
                onClick={toggleMotion}
                aria-pressed={motionOn}
                aria-label="Toggle device motion"
                className={cn(ctl, "w-auto gap-2 px-4", motionOn && "border-champagne text-champagne")}
              >
                <span className="font-sans text-[0.625rem] uppercase tracking-[0.18em]">Motion</span>
              </button>
            )}
            {fsAvail && (
              <button type="button" onClick={toggleFullscreen} aria-label="Fullscreen" className={ctl}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
                </svg>
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
