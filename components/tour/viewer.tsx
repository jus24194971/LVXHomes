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
// Flight altitude assumed for anchored-ring pitch (matches the render rig;
// close enough for real footage until per-tour heights land).
const CAMERA_HEIGHT_M = 1.35;

const norm180 = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type AuthorMark = { chapter: string; time: number; yaw: number; pitch: number };

type Engine = {
  camera: THREE.PerspectiveCamera;
  material: THREE.MeshBasicMaterial;
  videoTexture: THREE.VideoTexture;
  look: {
    lon: number;
    lat: number;
    /** Manual pan offset added on top of the gyro (persists between drags). */
    mlon: number;
    mlat: number;
    vLon: number;
    vLat: number;
    fov: number;
    dragging: boolean;
  };
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
  const [calibMsg, setCalibMsg] = useState<null | "hold" | "done">(null);
  const [motionNudge, setMotionNudge] = useState(false);
  const [fsAvail, setFsAvail] = useState(false);
  /** iOS Safari has no element Fullscreen API — fall back to a CSS overlay. */
  const [pseudoFs, setPseudoFs] = useState(false);
  /** True while the real Fullscreen API is active (drives the exit icon). */
  const [fsActive, setFsActive] = useState(false);
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
  /** Heading + pitch offsets captured at gyro calibration (degrees). */
  const calibLonRef = useRef(0);
  const calibLatRef = useRef(0);
  /** Gyro calibration phase: request → provisional zero → steady lock. */
  const calibPhaseRef = useRef<"off" | "kickoff" | "waiting" | "done">("off");
  /** Each chapter remembers where the viewer left it. */
  const chapterTimesRef = useRef<Record<string, number>>({});
  const triedFallbackRef = useRef(false);
  /** Device/browser capabilities, detected once on mount. */
  const capsRef = useRef({
    isIOS: false,
    isAndroid: false,
    isMobile: false,
    browser: "other" as "safari" | "chrome" | "firefox" | "samsung" | "edge" | "other",
    hasOrientation: false,
    needsMotionPermission: false,
  });
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
    const ua = navigator.userAgent;
    const isIOS =
      /iP(hone|od|ad)/.test(ua) ||
      // iPadOS 13+ reports as desktop Safari — sniff touch on a "Mac".
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    const isAndroid = /Android/.test(ua);
    const coarse = window.matchMedia?.("(pointer: coarse)")?.matches ?? false;
    const isMobile = isIOS || isAndroid || (coarse && navigator.maxTouchPoints > 0);
    const browser: (typeof capsRef.current)["browser"] = /SamsungBrowser/.test(ua)
      ? "samsung"
      : /Edg/.test(ua)
        ? "edge"
        : /(CriOS|Chrome)/.test(ua)
          ? "chrome"
          : /(FxiOS|Firefox)/.test(ua)
            ? "firefox"
            : /Safari/.test(ua)
              ? "safari"
              : "other";
    const hasOrientation = "DeviceOrientationEvent" in window;
    const needsMotionPermission =
      hasOrientation &&
      typeof (DeviceOrientationEvent as unknown as { requestPermission?: unknown })
        .requestPermission === "function";
    capsRef.current = {
      isIOS,
      isAndroid,
      isMobile,
      browser,
      hasOrientation,
      needsMotionPermission,
    };
    // Motion is a phone affordance; fullscreen shows on mobile (real API or the
    // CSS overlay) and on any desktop that supports the Fullscreen API.
    setMotionAvail(isMobile && hasOrientation);
    setFsAvail(isMobile || Boolean(document.fullscreenEnabled));
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
    const look = { lon: FRONT_LON, lat: 0, mlon: 0, mlat: 0, vLon: 0, vLat: 0, fov: 75, dragging: false };
    engineRef.current = { camera, material, videoTexture, look, video };
    const pointers = new Map<number, { x: number; y: number }>();
    let pinchDist = 0;
    let downAt = { x: 0, y: 0, t: 0 };

    const clampLat = () => { look.lat = Math.max(-85, Math.min(85, look.lat)); };
    const clampFov = () => { look.fov = Math.max(45, Math.min(95, look.fov)); };

    // ---------- device orientation ----------
    const orient = { alpha: 0, beta: 0, gamma: 0, has: false };
    const zee = new THREE.Vector3(0, 0, 1);
    const euler = new THREE.Euler();
    const qScreen = new THREE.Quaternion();
    const qWorld = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5));
    const qDevice = new THREE.Quaternion();
    const fwd = new THREE.Vector3();
    const screenAngle = () =>
      THREE.MathUtils.degToRad(
        (screen.orientation?.angle ??
          (window as unknown as { orientation?: number }).orientation ??
          0) as number,
      );

    // Gyro calibration: gravity gives absolute pitch/roll, but heading boots
    // to an arbitrary device frame. We zero it against the current view so
    // engaging Motion never jumps, then lock a clean reference once the
    // phone is held steady (detected from orientation deltas — same signal
    // as the accelerometer without a second iOS permission prompt).
    const calQ = new THREE.Quaternion();
    const calE = new THREE.Euler();
    const calV = new THREE.Vector3();
    const captureCalibration = () => {
      calE.set(orient.beta, orient.alpha, -orient.gamma, "YXZ");
      calQ.setFromEuler(calE);
      calQ.multiply(qWorld);
      calQ.multiply(qScreen.setFromAxisAngle(zee, -screenAngle()));
      calV.set(0, 0, -1).applyQuaternion(calQ);
      const latDev = (Math.asin(Math.max(-1, Math.min(1, calV.y))) * 180) / Math.PI;
      const lonDev = (Math.atan2(calV.z, calV.x) * 180) / Math.PI;
      // Heading offset preserves the current view lon (no horizontal jump on
      // engage); pitch offset zeroes against THIS pose so the rest position
      // reads level on any device — the fix for Android's floor-facing tilt.
      calibLonRef.current = lonDev - look.lon;
      calibLatRef.current = latDev;
    };
    const steadyBuf: { t: number; a: number; b: number; g: number }[] = [];
    let calibDeadline = 0;
    // Heading source. Relative `deviceorientation` alpha is gyro-integrated and
    // DRIFTS on Android, so we prefer `deviceorientationabsolute` — the OS-fused
    // absolute-orientation sensor (accel+gyro+magnetometer), which is north-
    // locked and doesn't wander. iOS never fires the absolute event, so it stays
    // on `deviceorientation`. If absolute goes quiet (sensor hiccup) we let the
    // relative stream resume after a short grace window.
    let lastAbsoluteAt = 0;
    const onOrient = (e: DeviceOrientationEvent, isAbsolute: boolean) => {
      if (e.alpha === null || e.beta === null || e.gamma === null) return;
      const now = performance.now();
      if (!isAbsolute && lastAbsoluteAt && now - lastAbsoluteAt < 2000) return;
      const firstAbsolute = isAbsolute && lastAbsoluteAt === 0;
      if (isAbsolute) lastAbsoluteAt = now;

      orient.alpha = THREE.MathUtils.degToRad(e.alpha);
      orient.beta = THREE.MathUtils.degToRad(e.beta);
      orient.gamma = THREE.MathUtils.degToRad(e.gamma);
      orient.has = true;

      // Relative→absolute handoff after we'd already calibrated: silently
      // re-zero heading against the absolute stream. captureCalibration keeps
      // the current look.lon, so the switch is seamless (no visible jump).
      if (firstAbsolute && calibPhaseRef.current === "done") captureCalibration();

      const phase = calibPhaseRef.current;
      if (phase === "kickoff") {
        look.mlon = 0; // a new calibration clears any prior finger pan
        look.mlat = 0;
        look.vLon = 0;
        look.vLat = 0;
        captureCalibration(); // provisional zero — no jump on engage
        calibPhaseRef.current = "waiting";
        calibDeadline = now + 8000;
        steadyBuf.length = 0;
        setCalibMsg("hold");
      } else if (phase === "waiting") {
        steadyBuf.push({ t: now, a: e.alpha, b: e.beta, g: e.gamma });
        while (steadyBuf.length && now - steadyBuf[0].t > 750) steadyBuf.shift();
        const windowFull = steadyBuf.length > 6 && now - steadyBuf[0].t > 600;
        let steady = false;
        if (windowFull) {
          let aMin = 360, aMax = -360, bMin = 360, bMax = -360, gMin = 360, gMax = -360;
          for (const s of steadyBuf) {
            aMin = Math.min(aMin, s.a); aMax = Math.max(aMax, s.a);
            bMin = Math.min(bMin, s.b); bMax = Math.max(bMax, s.b);
            gMin = Math.min(gMin, s.g); gMax = Math.max(gMax, s.g);
          }
          steady = aMax - aMin < 2 && bMax - bMin < 2 && gMax - gMin < 2;
        }
        if (steady || now > calibDeadline) {
          captureCalibration(); // clean locked reference
          calibPhaseRef.current = "done";
          setCalibMsg("done");
          setTimeout(() => setCalibMsg(null), 1400);
        }
      }
    };
    window.addEventListener(
      "deviceorientation",
      (e) => onOrient(e, false),
      { signal },
    );
    // Non-standard event (Android) — cast the name so TS infers the right type.
    window.addEventListener(
      "deviceorientationabsolute" as "deviceorientation",
      (e) => onOrient(e, true),
      { signal },
    );

    // Portrait↔landscape: the screen-angle term in the gyro math flips, so the
    // captured reference no longer reads level. Silently re-run the few-second
    // calibration for the new orientation ("a cal for each") whenever motion is
    // live. Harmless when it isn't.
    const onOrientationChange = () => {
      if (!motionOnRef.current) return;
      calibPhaseRef.current = "kickoff";
      setCalibMsg("hold");
    };
    window.addEventListener("orientationchange", onOrientationChange, { signal });
    screen.orientation?.addEventListener("change", onOrientationChange, { signal });

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
        look.vLon = -dx * DRAG_SPEED;
        look.vLat = dy * DRAG_SPEED;
        if (motionOnRef.current) {
          // Gyro is live: the finger pans ON TOP of it. The offset persists, so
          // releasing picks up exactly where you left off — the gyro keeps
          // tracking relative to your nudge instead of fighting it.
          look.mlon += look.vLon;
          look.mlat = Math.max(-80, Math.min(80, look.mlat + look.vLat));
        } else {
          look.lon += look.vLon;
          look.lat += look.vLat;
          clampLat();
        }
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
        setFsActive(Boolean(document.fullscreenElement));
        applySize();
        requestAnimationFrame(applySize);
      },
      { signal },
    );

    // ---------- render loop ----------
    const hsWorld = new THREE.Vector3();
    const hsCam = new THREE.Vector3();
    // Smoothed on-screen pixel position per hotspot, so a fast-moving ring
    // glides to its spot instead of jittering — a calmer, easier tap target.
    const hsScreen = new Map<string, { x: number; y: number; set: boolean }>();
    const EDGE = 0.86; // pin off-screen rings to ±86% of the frame, still tappable
    const flatHotspots = tour.chapters.flatMap((ch, ci) =>
      ch.hotspots.map((hs) => ({ ci, hs, key: `${ch.id}:${hs.id}` })),
    );
    renderer.setAnimationLoop(() => {
      const gyro = motionOnRef.current && orient.has;
      // Inertia after a flick. In gyro mode it decays the MANUAL offset (the
      // gyro itself is absolute); in drag mode it decays the view directly.
      if (!look.dragging) {
        if (gyro) {
          look.mlon += look.vLon;
          look.mlat = Math.max(-80, Math.min(80, look.mlat + look.vLat));
        } else {
          look.lon += look.vLon;
          look.lat += look.vLat;
          clampLat();
        }
        look.vLon *= 0.92;
        look.vLat *= 0.92;
      }
      camera.fov += (look.fov - camera.fov) * 0.2;
      camera.updateProjectionMatrix();

      if (gyro) {
        // Horizon-locked gyro: take the device's forward vector, convert to
        // lon/lat, subtract the calibration offsets on BOTH axes, then ADD the
        // manual pan offset, and render through the same lookAt path as drag.
        // Roll is intentionally dropped so the horizon stays flat — comfortable,
        // and standard for 360 tours.
        euler.set(orient.beta, orient.alpha, -orient.gamma, "YXZ");
        qDevice.setFromEuler(euler);
        qDevice.multiply(qWorld);
        qDevice.multiply(qScreen.setFromAxisAngle(zee, -screenAngle()));
        fwd.set(0, 0, -1).applyQuaternion(qDevice);
        const latDev = (Math.asin(Math.max(-1, Math.min(1, fwd.y))) * 180) / Math.PI;
        const lonDev = (Math.atan2(fwd.z, fwd.x) * 180) / Math.PI;
        look.lon = lonDev - calibLonRef.current + look.mlon;
        look.lat = Math.max(-85, Math.min(85, latDev - calibLatRef.current + look.mlat));
      }
      const phi = THREE.MathUtils.degToRad(90 - look.lat);
      const theta = THREE.MathUtils.degToRad(look.lon);
      camera.lookAt(
        500 * Math.sin(phi) * Math.cos(theta),
        500 * Math.cos(phi),
        500 * Math.sin(phi) * Math.sin(theta),
      );
      camera.updateMatrixWorld();

      // Project hotspots into the viewport (video mode only).
      const w = mount.clientWidth;
      const h = mount.clientHeight;
      const t = video.currentTime;
      const inVideo = startedRef.current && !panoRef.current;
      const chId = tour.chapters[chapterIdxRef.current]?.id ?? "";

      // Camera pose on the plan at time t — drives the you-are-here indicator
      // AND world-anchored hotspots. Heading: keyframed h or travel tangent.
      const interpPose = (path: NonNullable<NonNullable<typeof plan>["sheets"][0]["paths"]>[string]) => {
        if (!path || path.length === 0) return null;
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
        let heading: number;
        if (a.h !== undefined && b.h !== undefined) {
          heading = a.h + (((b.h - a.h + 540) % 360) - 180) * f;
        } else if (a.h !== undefined) {
          heading = a.h;
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
          heading = (Math.atan2(dx, -dy) * 180) / Math.PI;
        }
        return { x, y, heading };
      };
      // World pose for anchors: the first sheet carrying this chapter's path.
      let worldPose: { x: number; y: number; heading: number } | null = null;
      if (plan) {
        for (const s of plan.sheets) {
          const p = s.paths?.[chId];
          if (p && p.length) {
            worldPose = interpPose(p);
            break;
          }
        }
      }

      for (const { ci, hs, key } of flatHotspots) {
        const node = hotspotEls.current.get(key);
        if (!node) continue;
        const inChapter = inVideo && ci === chapterIdxRef.current;
        const gated =
          (hs.start === undefined || t >= hs.start) &&
          (hs.end === undefined || t <= hs.end);
        let visible = false;
        let yawDeg = 0;
        let pitchDeg = 0;
        let ringScale = 1;
        if (hs.anchor && worldPose) {
          // World-anchored: direction + distance from the live camera pose —
          // the ring is wherever the room actually is, from wherever you are.
          const dx = hs.anchor.x - worldPose.x;
          const dyPlan = hs.anchor.y - worldPose.y;
          const dist = Math.hypot(dx, dyPlan);
          const bearing = (Math.atan2(dx, -dyPlan) * 180) / Math.PI;
          yawDeg = norm180(bearing - worldPose.heading);
          pitchDeg =
            (Math.atan2((hs.anchor.h ?? 1) - CAMERA_HEIGHT_M, Math.max(dist, 0.1)) * 180) / Math.PI;
          ringScale = Math.min(1.15, Math.max(0.62, 2.6 / Math.max(dist, 0.4)));
          visible = inChapter && gated;
        } else if (hs.yaw !== undefined && hs.pitch !== undefined) {
          // Legacy timed mode: fixed frame-relative direction in a window.
          yawDeg = hs.yaw;
          pitchDeg = hs.pitch;
          visible = inChapter && gated && hs.start !== undefined;
        }
        if (visible) {
          const phi = THREE.MathUtils.degToRad(90 - pitchDeg);
          const theta = THREE.MathUtils.degToRad(FRONT_LON + yawDeg);
          hsWorld.set(
            490 * Math.sin(phi) * Math.cos(theta),
            490 * Math.cos(phi),
            490 * Math.sin(phi) * Math.sin(theta),
          );
          hsCam.copy(hsWorld).applyMatrix4(camera.matrixWorldInverse);

          // Resolve a target NDC position, pinning to a frame edge rather than
          // vanishing when the room is off-screen or behind — so every room
          // stays a reachable tap target the whole flight.
          let nx: number;
          let ny: number;
          let clamped = false;
          if (hsCam.z < -2) {
            hsWorld.project(camera);
            nx = hsWorld.x;
            ny = hsWorld.y;
            if (Math.abs(nx) > EDGE || Math.abs(ny) > EDGE) {
              const k = EDGE / Math.max(Math.abs(nx), Math.abs(ny));
              nx *= k;
              ny *= k;
              clamped = true;
            }
          } else {
            // Beside/behind: projection is degenerate, so pin to the edge on the
            // room's side (camera-space x/y carry the true direction).
            nx = (hsCam.x >= 0 ? 1 : -1) * EDGE;
            ny = Math.max(-EDGE, Math.min(EDGE, (hsCam.y / Math.max(Math.abs(hsCam.x), 1)) * EDGE));
            clamped = true;
          }

          const tx = (nx * 0.5 + 0.5) * w;
          const ty = (-ny * 0.5 + 0.5) * h;
          // Glide to the target; snap on first show or a big jump (edge flip).
          let sm = hsScreen.get(key);
          if (!sm) {
            sm = { x: tx, y: ty, set: true };
            hsScreen.set(key, sm);
          } else if (!sm.set || Math.hypot(tx - sm.x, ty - sm.y) > Math.max(w, h) * 0.5) {
            sm.x = tx;
            sm.y = ty;
            sm.set = true;
          } else {
            sm.x += (tx - sm.x) * 0.22;
            sm.y += (ty - sm.y) * 0.22;
          }
          node.style.transform = `translate(-50%, -50%) translate(${sm.x}px, ${sm.y}px)`;
          // Scale the VISUAL ring only (via --rs); the button keeps a fixed,
          // generous tap area. Edge-pinned rings hold a steady, easy size.
          node.style.setProperty("--rs", String(clamped ? 0.7 : ringScale));
        } else {
          const sm = hsScreen.get(key);
          if (sm) sm.set = false; // re-snap cleanly next time it appears
        }
        node.style.opacity = visible ? "1" : "0";
        node.style.pointerEvents = visible ? "auto" : "none";
      }

      // You-are-here: the displayed sheet's path for this chapter.
      const ind = planIndicatorRef.current;
      if (ind) {
        const sheetNow = plan?.sheets.find((s) => s.id === activeSheetIdRef.current);
        const dispPose = sheetNow?.paths?.[chId]
          ? interpPose(sheetNow.paths[chId])
          : null;
        if (inVideo && dispPose) {
          const yawDeg = norm180(look.lon - FRONT_LON);
          ind.setAttribute(
            "transform",
            `translate(${dispPose.x} ${dispPose.y}) rotate(${dispPose.heading + yawDeg})`,
          );
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

  // CSS pseudo-fullscreen (iOS): lock body scroll and allow Esc to exit while
  // the overlay is up. The real Fullscreen API handles both itself.
  useEffect(() => {
    if (!pseudoFs) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPseudoFs(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [pseudoFs]);

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

  /**
   * Go immersive on the Play tap. Android + desktop use the real Fullscreen
   * API; iOS Safari has none for non-video elements, so it gets a CSS overlay
   * that fills the viewport (pseudoFs). Orientation lock is best-effort.
   */
  const enterImmersive = () => {
    const caps = capsRef.current;
    const host = mountRef.current?.parentElement;
    if (!host) return;
    const useApi =
      !caps.isIOS &&
      document.fullscreenEnabled &&
      typeof host.requestFullscreen === "function";
    if (useApi) {
      host.requestFullscreen().then(
        () => {
          const so = screen.orientation as unknown as {
            lock?: (o: string) => Promise<void>;
            type?: string;
          };
          if (so?.lock && so.type) so.lock(so.type).catch(() => {});
        },
        () => setPseudoFs(true), // API rejected → fall back to the overlay
      );
    } else if (caps.isMobile) {
      setPseudoFs(true);
    }
  };

  const exitImmersive = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    setPseudoFs(false);
    (screen.orientation as unknown as { unlock?: () => void })?.unlock?.();
  };

  /**
   * The entry gesture: play the video and go fullscreen on mobile. Thumb-drag
   * is the default way to look around — far less fiddly than gyro for actually
   * steering. VR/motion stays OPT-IN behind its button (which requests the iOS
   * permission in its own gesture), so we neither prompt nor engage it here; we
   * just surface a gentle one-time hint that the option exists.
   */
  const start = () => {
    const video = videoRef.current;
    const caps = capsRef.current;
    if (!video) return;
    setLoading(true);

    // Both gesture-gated; fire synchronously so mobile honors the activation.
    const playP = video.play();
    if (caps.isMobile) enterImmersive();

    playP.then(
      () => {
        startedRef.current = true;
        setStarted(true);
        setLoading(false);
        setHint(true);
        setTimeout(() => setHint(false), 4500);
        // One-time nudge that VR/motion is available — drag remains default.
        if (caps.isMobile && caps.hasOrientation) {
          setTimeout(() => {
            if (!motionOnRef.current) {
              setMotionNudge(true);
              setTimeout(() => setMotionNudge(false), 5000);
            }
          }, 5000);
        }
      },
      () => {
        setFailed(true);
        setLoading(false);
      },
    );
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
      calibPhaseRef.current = "off";
      setCalibMsg(null);
      return;
    }
    const doe = DeviceOrientationEvent as unknown as {
      requestPermission?: () => Promise<string>;
    };
    try {
      if (typeof doe.requestPermission === "function") {
        const res = await doe.requestPermission();
        if (res !== "granted") return;
      }
      setMotionNudge(false);
      calibPhaseRef.current = "kickoff"; // re-enabling recalibrates
      setMotionOn(true);
    } catch {
      /* declined */
    }
  };

  const toggleFullscreen = () => {
    if (document.fullscreenElement || pseudoFs) {
      exitImmersive();
      return;
    }
    const caps = capsRef.current;
    const host = mountRef.current?.parentElement;
    if (!host) return;
    if (!caps.isIOS && document.fullscreenEnabled && host.requestFullscreen) {
      void host.requestFullscreen();
    } else {
      setPseudoFs(true);
    }
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
    <div
      className={cn(
        "relative overflow-hidden bg-ink [container-type:inline-size]",
        // iOS pseudo-fullscreen: fill the viewport above the page chrome.
        pseudoFs && "fixed inset-0 z-[60] !rounded-none",
        className,
      )}
    >
      <div
        ref={mountRef}
        tabIndex={0}
        role="application"
        aria-label="360 degree flight viewer. Drag, use arrow keys, or enable motion to look around."
        className={cn(
          "absolute inset-0 outline-none transition-[transform,filter] duration-300 ease-out",
          // Warp: the scene pushes in + softens behind the ink during a
          // transition (enter a room, resume, switch chapter), then settles.
          fading ? "scale-[1.06] blur-[1.5px]" : "scale-100 blur-0",
        )}
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
              className="group relative flex h-[clamp(3.5rem,5cqw,7.5rem)] w-[clamp(3.5rem,5cqw,7.5rem)] items-center justify-center"
            >
              {/* Only the ring visual scales with distance (--rs, set by the
                  render loop); the button above stays a fixed, easy tap target. */}
              <span className="relative flex h-full w-full items-center justify-center [scale:var(--rs,1)]">
                <span className="absolute inset-0 rounded-full border border-champagne/50 motion-safe:animate-ping" />
                <span className="relative flex h-[72%] w-[72%] items-center justify-center rounded-full border border-champagne bg-ink/40 text-champagne backdrop-blur-sm transition-transform duration-300 group-hover:scale-110">
                  <span className="h-[14%] w-[14%] rounded-full bg-champagne" />
                </span>
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
          (hint || motionNudge || calibMsg) && !pano ? "opacity-100" : "opacity-0",
        )}
      >
        <span
          className={cn(
            "rounded-full bg-ink/60 px-[1.5em] py-[0.65em] font-sans text-[clamp(0.6875rem,0.95cqw,1.125rem)] uppercase tracking-[0.2em] backdrop-blur-sm",
            calibMsg ? "text-champagne" : "text-paper/85",
          )}
        >
          {calibMsg === "hold"
            ? "Hold your phone steady — calibrating…"
            : calibMsg === "done"
              ? "Calibrated"
              : motionNudge
                ? "Prefer to look by moving your phone? Tap VR"
                : motionOn
                  ? "Move your phone to look · drag to pan · tap a gold ring"
                  : "Drag to look · tap a gold ring to step inside"}
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
                aria-label={motionOn ? "Disable VR motion view" : "Enable VR motion view — move your phone to look around"}
                className={cn(ctl, "w-auto gap-2 px-[1.4em]", motionOn && "border-champagne text-champagne")}
              >
                <svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                  <path d="M3 9.5A2.5 2.5 0 0 1 5.5 7h13A2.5 2.5 0 0 1 21 9.5v5a2.5 2.5 0 0 1-2.5 2.5h-3.2a2 2 0 0 1-1.6-.8l-.9-1.2a1 1 0 0 0-1.6 0l-.9 1.2a2 2 0 0 1-1.6.8H5.5A2.5 2.5 0 0 1 3 14.5z" />
                </svg>
                <span className="font-sans text-[clamp(0.625rem,0.8cqw,1rem)] uppercase tracking-[0.18em]">VR</span>
              </button>
            )}
            {fsAvail && (
              <button
                type="button"
                onClick={toggleFullscreen}
                aria-label={fsActive || pseudoFs ? "Exit fullscreen" : "Fullscreen"}
                className={cn(ctl, (fsActive || pseudoFs) && "border-champagne text-champagne")}
              >
                <svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  {fsActive || pseudoFs ? (
                    <path d="M9 5v3a1 1 0 0 1-1 1H5m14 0h-3a1 1 0 0 1-1-1V5m0 14v-3a1 1 0 0 1 1-1h3M5 15h3a1 1 0 0 1 1 1v3" />
                  ) : (
                    <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
                  )}
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
