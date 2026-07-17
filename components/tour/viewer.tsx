"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import type { Plan, PlanZone } from "@/data/plans";
import type { Tour, TourPano, TourHotspot } from "@/data/tours";
import {
  loadDoc,
  listRevisions,
  restoreRevision,
  saveDoc,
  type RevisionMeta,
} from "@/lib/author-client";
import { TourTutorial } from "@/components/tour/tour-tutorial";
import { PlanPanel } from "@/components/tour/plan";
import { centroidOf, closestApproachNearT } from "@/lib/plan-geometry";
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
// A lone-keyframe ring shows for ±this many seconds around its time (so a
// single click still produces a visible, fading ring at a fixed spot).
const SOLO_RING = 2.5;
// Keyframes farther apart than this start a SEPARATE visible window — so an
// amenity the drone passes twice fades in/out on each pass instead of lingering
// (and drifting) across the long gap between them.
const RING_GAP = 20;

/**
 * The contiguous keyframe window [s, e] (with faded time bounds t0/tn) that the
 * time t falls in — windows break where consecutive keys are more than RING_GAP
 * apart. A lone key gets a ±SOLO_RING window. Returns null when t is in no
 * window (between passes, or before/after the ring's life).
 */
function ringWindow(
  ks: { t: number }[],
  t: number,
): { s: number; e: number; t0: number; tn: number } | null {
  let s = 0;
  while (s < ks.length) {
    let e = s;
    while (e + 1 < ks.length && ks[e + 1].t - ks[e].t <= RING_GAP) e++;
    const solo = s === e;
    const t0 = solo ? ks[s].t - SOLO_RING : ks[s].t;
    const tn = solo ? ks[s].t + SOLO_RING : ks[e].t;
    if (t >= t0 && t <= tn) return { s, e, t0, tn };
    s = e + 1;
  }
  return null;
}

const norm180 = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;

/** Best-effort link from a plan zone's label to a tour pano id — exact label
 *  match first, then a shared significant word — so naming an amenity to match
 *  its 360 photo is enough to wire the "step inside" jump (no manual linking). */
function matchPanoByLabel(
  label: string | undefined,
  panos: { id: string; label: string }[],
): string | undefined {
  if (!label) return undefined;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const L = norm(label);
  const exact = panos.find((p) => norm(p.label) === L);
  if (exact) return exact.id;
  const want = new Set(L.split(" ").filter((w) => w.length >= 4));
  let best: string | undefined;
  let score = 0;
  for (const p of panos) {
    const s = norm(p.label).split(" ").filter((w) => w.length >= 4 && want.has(w)).length;
    if (s > score) { score = s; best = p.id; }
  }
  return score > 0 ? best : undefined;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));


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
  authorMode = false,
}: {
  tour: Tour;
  plan?: Plan;
  className?: string;
  /** Force author mode (used by the gated /studio/tours route). Public tours
   *  still opt in via ?author=1. */
  authorMode?: boolean;
}) {
  const mountRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const engineRef = useRef<Engine | null>(null);
  const hotspotEls = useRef(new Map<string, HTMLDivElement>());
  /** Screen positions of the visible flight rings, for tap hit-testing — so the
   *  canvas owns dragging and a ring never steals a drag-look. */
  const ringHitsRef = useRef<{ x: number; y: number; r: number; node: HTMLDivElement }[]>([]);
  const panoCache = useRef(new Map<string, THREE.Texture>());
  const readoutRef = useRef<HTMLSpanElement | null>(null);
  /** Compass HUD needle — rotated imperatively each frame (heading-stabilized
   *  captures carry a fixed front→north offset in chapter.northYaw). */
  const compassRef = useRef<HTMLDivElement | null>(null);

  const [started, setStarted] = useState(false);
  const [isMobileUi, setIsMobileUi] = useState(false);
  const [showTutorial, setShowTutorial] = useState(false);
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
  /** Keyframed flight rings being authored (?author=1). */
  const [rings, setRings] = useState<TourHotspot[]>([]);
  const [activeRing, setActiveRing] = useState<string | null>(null);
  const [authTime, setAuthTime] = useState(0);
  const [authDur, setAuthDur] = useState(0);
  const [pathMarks, setPathMarks] = useState<
    Record<string, Record<string, { t: number; x: number; y: number }[]>>
  >({});
  const [copied, setCopied] = useState(false);
  const [copiedPaths, setCopiedPaths] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [saveMsg, setSaveMsg] = useState("");
  const [revs, setRevs] = useState<RevisionMeta[]>([]);
  const [revsOpen, setRevsOpen] = useState(false);
  const [planOpen, setPlanOpen] = useState(false);
  const [planExpanded, setPlanExpanded] = useState(false);
  /** Auto-hiding player chrome for the immersive mobile flight. */
  const [controlsVisible, setControlsVisible] = useState(true);
  const [isPortrait, setIsPortrait] = useState(false);
  const [activeSheetId, setActiveSheetId] = useState(plan?.sheets[0]?.id ?? "");
  const [chapterIdx, setChapterIdx] = useState(0);

  const startedRef = useRef(false);
  const motionOnRef = useRef(false);
  const panoRef = useRef<TourPano | null>(null);
  /** The flight's look direction when you stepped into a pano — restored on resume. */
  const flightLookRef = useRef<{ lon: number; lat: number; mlon: number; mlat: number } | null>(null);
  /** Entering a pano from the MAP sets this; on resume the flight jumps to the
   *  amenity's keyframe time (facing it) instead of where it was paused. */
  const resumeAtRef = useRef<{ t: number; yaw: number } | null>(null);
  const authorRef = useRef(false);
  const ringsRef = useRef<TourHotspot[]>([]);
  const activeRingRef = useRef<string | null>(null);
  const chapterIdxRef = useRef(0);
  const activeSheetIdRef = useRef("");
  const planIndicatorRef = useRef<SVGGElement | null>(null);

  // Auto-rings: derive an anchored ring per georeferenced amenity straight from
  // the plan — no hand-authored keyframes. The amenity's box centre is the world
  // anchor; the viewer tracks it live and fades it by distance. Skips building
  // footprints (no label) and amenities already covered by an authored hotspot.
  const autoRings = useMemo<Record<string, TourHotspot[]>>(() => {
    const out: Record<string, TourHotspot[]> = {};
    if (!plan) return out;
    for (const ch of tour.chapters) {
      const sheet = plan.sheets.find((s) => s.paths?.[ch.id]?.length);
      if (!sheet) continue;
      const made: TourHotspot[] = [];
      for (const z of sheet.zones) {
        if (!z.label) continue;
        const panoId = z.panoId ?? matchPanoByLabel(z.label, tour.panos);
        if (!panoId) continue;
        if (ch.hotspots.some((h) => h.panoId === panoId)) continue;
        const [cx, cy] = centroidOf(z.points);
        made.push({
          id: `auto-${z.id}`,
          label: z.label,
          panoId,
          anchor: { x: cx, y: cy, h: 0 },
          fadeNear: 14,
          fadeFar: 42,
        });
      }
      if (made.length) out[ch.id] = made;
    }
    return out;
  }, [plan, tour.chapters, tour.panos]);

  /** Heading + pitch offsets captured at gyro calibration (degrees). */
  const calibLonRef = useRef(0);
  const calibLatRef = useRef(0);
  /** Gyro calibration phase: request → provisional zero → steady lock. */
  const calibPhaseRef = useRef<"off" | "kickoff" | "waiting" | "done">("off");
  /** Each chapter remembers where the viewer left it. */
  const chapterTimesRef = useRef<Record<string, number>>({});
  const triedFallbackRef = useRef(false);
  /** Pending auto-hide of the player chrome. */
  const hideTimerRef = useRef<number | null>(null);
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
  ringsRef.current = rings;
  activeRingRef.current = activeRing;
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
    setIsMobileUi(isMobile);
    // First-visit coaching overlay (once per device; replayable from the player).
    try {
      if (!localStorage.getItem("lvx-tutorial-seen")) setShowTutorial(true);
    } catch {
      setShowTutorial(true);
    }
    setAuthor(authorMode || new URLSearchParams(window.location.search).has("author"));

    // ---------- video ----------
    const video = document.createElement("video");
    video.crossOrigin = "anonymous"; // required to use the frames as a WebGL texture
    video.src = tour.chapters[0].video.src;
    video.loop = true;
    video.muted = true;
    video.playsInline = true;
    video.setAttribute("webkit-playsinline", "true");
    video.preload = "auto";
    videoRef.current = video;
    // Keep the element attached (offscreen) so the browser buffers the whole
    // clip — a DETACHED <video> gets a small buffer cap and starves a couple
    // seconds into a heavy 4K file.
    video.style.cssText =
      "position:absolute;left:-9999px;top:0;width:2px;height:2px;opacity:0.01;pointer-events:none;";
    mount.appendChild(video);
    video.addEventListener(
      "playing",
      () => {
        setPlaying(true);
        setLoading(false);
      },
      { signal },
    );
    video.addEventListener("pause", () => setPlaying(false), { signal });
    // Recover from buffer-starvation stalls — re-kick playback when it stalls.
    const onStall = () => {
      if (startedRef.current && !panoRef.current && !video.paused) {
        void video.play().catch(() => {});
      }
    };
    video.addEventListener("waiting", onStall, { signal });
    video.addEventListener("stalled", onStall, { signal });
    // Author scrub readout (cheap; only surfaced in the authoring panel).
    video.addEventListener("timeupdate", () => setAuthTime(video.currentTime), { signal });
    video.addEventListener("seeked", () => setAuthTime(video.currentTime), { signal });
    video.addEventListener("loadedmetadata", () => setAuthDur(video.duration || 0), { signal });
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
    const look = {
      lon: FRONT_LON + (tour.chapters[0]?.startYaw ?? 0), // face the drone's forward
      lat: 0, mlon: 0, mlat: 0, vLon: 0, vLat: 0, fov: 75, dragging: false,
    };
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
      // A press that barely moved is a tap (vs a drag-look).
      const tap =
        pointers.has(e.pointerId) &&
        Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) < 6 &&
        performance.now() - downAt.t < 400;
      // Author mode: a tap places a ring keyframe.
      if (authorRef.current && tap) {
        const rect = el.getBoundingClientRect();
        const ndcX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        const ndcY = -(((e.clientY - rect.top) / rect.height) * 2 - 1);
        camera.updateMatrixWorld();
        const v = new THREE.Vector3(ndcX, ndcY, 0.5).unproject(camera).normalize();
        const lat = 90 - THREE.MathUtils.radToDeg(Math.acos(Math.max(-1, Math.min(1, v.y))));
        const lon = THREE.MathUtils.radToDeg(Math.atan2(v.z, v.x));
        // Drop/replace a keyframe for the active ring at the current time.
        const ringId = activeRingRef.current;
        if (ringId) {
          const tt = Math.round(video.currentTime * 100) / 100;
          const yaw = Math.round(norm180(lon - FRONT_LON) * 10) / 10;
          const pitch = Math.round(lat * 10) / 10;
          setRings((prev) => {
            const next = prev.map((r) => {
              if (r.id !== ringId) return r;
              const keys = (r.keys ?? []).filter((k) => Math.abs(k.t - tt) > 0.12);
              keys.push({ t: tt, yaw, pitch });
              keys.sort((a, b) => a.t - b.t);
              return { ...r, keys };
            });
            try {
              localStorage.setItem(`lvx-rings:${tour.slug}`, JSON.stringify(next));
            } catch {
              /* storage unavailable */
            }
            return next;
          });
        }
      } else if (tap && startedRef.current && !panoRef.current) {
        // Tap → step into a ring if one was hit (the canvas owns the hit-test so
        // a drag is never stolen by a ring); else, on mobile, toggle the chrome.
        const rect = el.getBoundingClientRect();
        const tx = e.clientX - rect.left;
        const ty = e.clientY - rect.top;
        const hit = ringHitsRef.current.find(
          (hp) => Math.hypot(tx - hp.x, ty - hp.y) <= hp.r,
        );
        if (hit) {
          hit.node.querySelector("button")?.click();
        } else if (capsRef.current.isMobile) {
          if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
          setControlsVisible((vis) => {
            const next = !vis;
            if (next) hideTimerRef.current = window.setTimeout(() => setControlsVisible(false), 4000);
            return next;
          });
        }
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
        if (authorRef.current) return; // arrows step frames while authoring
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
        const on = Boolean(document.fullscreenElement);
        setFsActive(on);
        applySize();
        requestAnimationFrame(applySize);
        if (!on) {
          // Accidental exit (ESC / back-gesture / swipe): make sure the player
          // and its controls are actually on screen and visible again.
          setControlsVisible(true);
          requestAnimationFrame(() =>
            mount.parentElement?.scrollIntoView({ block: "center" }),
          );
        }
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
      ch.hotspots
        .concat(autoRings[ch.id] ?? [])
        .map((hs) => ({ ci, hs, key: `${ch.id}:${hs.id}` })),
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

      // Compass HUD: counter-rotate the needle so it always points at compass
      // north — facing bearing = view yaw minus the chapter's front→north offset.
      const northYaw = tour.chapters[0]?.northYaw;
      if (compassRef.current && northYaw != null) {
        const bearing = norm180(look.lon - FRONT_LON - northYaw);
        compassRef.current.style.transform = `rotate(${-bearing}deg)`;
      }

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
        const n = path.length;
        if (n === 1) return { x: path[0].x, y: path[0].y, heading: path[0].h ?? 0, alt: path[0].z };
        // Segment [i, i+1] that holds t.
        let i = 0;
        if (t <= path[0].t) i = 0;
        else if (t >= path[n - 1].t) i = n - 2;
        else {
          for (let k = 0; k < n - 1; k++) {
            if (t >= path[k].t && t <= path[k + 1].t) {
              i = k;
              break;
            }
          }
        }
        const k0 = path[Math.max(i - 1, 0)];
        const k1 = path[i];
        const k2 = path[i + 1];
        const k3 = path[Math.min(i + 2, n - 1)];
        const seg = k2.t - k1.t;
        const f = seg <= 0 ? 0 : Math.min(1, Math.max(0, (t - k1.t) / seg));
        // Catmull-Rom: position AND its tangent stay continuous across
        // keyframes (C1), so the camera glides instead of cornering — and the
        // heading derived from that tangent no longer snaps once per second,
        // which is what made the anchored rings stutter.
        const f2 = f * f;
        const f3 = f2 * f;
        const cr = (p0: number, p1: number, p2: number, p3: number) =>
          0.5 *
          (2 * p1 + (-p0 + p2) * f + (2 * p0 - 5 * p1 + 4 * p2 - p3) * f2 + (-p0 + 3 * p1 - 3 * p2 + p3) * f3);
        const crD = (p0: number, p1: number, p2: number, p3: number) =>
          0.5 * (-p0 + p2 + 2 * (2 * p0 - 5 * p1 + 4 * p2 - p3) * f + 3 * (-p0 + 3 * p1 - 3 * p2 + p3) * f2);
        const x = cr(k0.x, k1.x, k2.x, k3.x);
        const y = cr(k0.y, k1.y, k2.y, k3.y);
        const alt =
          k1.z !== undefined ? cr(k0.z ?? k1.z, k1.z, k2.z ?? k1.z, k3.z ?? k1.z) : undefined;
        let heading: number;
        if (k1.h !== undefined && k2.h !== undefined) {
          heading = k1.h + (((k2.h - k1.h + 540) % 360) - 180) * f;
        } else if (k1.h !== undefined) {
          heading = k1.h;
        } else {
          let dx = crD(k0.x, k1.x, k2.x, k3.x);
          let dy = crD(k0.y, k1.y, k2.y, k3.y);
          if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) {
            dx = k2.x - k1.x;
            dy = k2.y - k1.y;
          }
          heading = (Math.atan2(dx, -dy) * 180) / Math.PI;
        }
        return { x, y, heading, alt };
      };
      // World pose for anchors: the first sheet carrying this chapter's path.
      let worldPose: { x: number; y: number; heading: number; alt?: number } | null = null;
      if (plan) {
        for (const s of plan.sheets) {
          const p = s.paths?.[chId];
          if (p && p.length) {
            worldPose = interpPose(p);
            break;
          }
        }
      }

      // Pass 1 — gather each visible ring's target screen position.
      const vis: {
        node: HTMLDivElement;
        key: string;
        tx: number;
        ty: number;
        scale: number;
        dist: number;
        opacity: number;
      }[] = [];
      // In author mode the rings being authored preview live alongside any the
      // tour already ships, so you see the fade + tracking as you scrub.
      const authoring = authorRef.current;
      const liveHotspots =
        authoring && ringsRef.current.length
          ? flatHotspots.concat(
              ringsRef.current.map((r) => ({
                ci: chapterIdxRef.current,
                hs: r,
                key: `auth:${r.id}`,
              })),
            )
          : flatHotspots;
      for (const { ci, hs, key } of liveHotspots) {
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
        let dist = 999;
        let opacity = 1;
        if (hs.keys && hs.keys.length && inChapter) {
          // Keyframed flight ring: track the amenity across its window, fading
          // in on approach and out as you pass — never persistent. Keys split
          // into separate windows for amenities flown past more than once.
          const ks = hs.keys;
          const win = ringWindow(ks, t);
          if (win) {
            let yk = ks[win.s].yaw;
            let pk = ks[win.s].pitch;
            for (let i = win.s; i < win.e; i++) {
              if (t >= ks[i].t && t <= ks[i + 1].t) {
                const span = ks[i + 1].t - ks[i].t;
                const f = span <= 0 ? 0 : (t - ks[i].t) / span;
                yk = ks[i].yaw + (((ks[i + 1].yaw - ks[i].yaw + 540) % 360) - 180) * f;
                pk = ks[i].pitch + (ks[i + 1].pitch - ks[i].pitch) * f;
                break;
              }
            }
            yawDeg = yk;
            pitchDeg = pk;
            const fd = hs.fade ?? 0.6;
            const fin = fd > 0 ? Math.min(1, (t - win.t0) / fd) : 1;
            const fout = fd > 0 ? Math.min(1, (win.tn - t) / fd) : 1;
            opacity = Math.max(0, Math.min(fin, fout));
            visible = opacity > 0.02;
            ringScale = 1;
            dist = 4;
          }
        } else if (hs.anchor && worldPose) {
          // World-anchored: direction + distance from the live camera pose —
          // the ring is wherever the amenity actually is, from wherever you are.
          const dx = hs.anchor.x - worldPose.x;
          const dyPlan = hs.anchor.y - worldPose.y;
          dist = Math.hypot(dx, dyPlan);
          const bearing = (Math.atan2(dx, -dyPlan) * 180) / Math.PI;
          yawDeg = norm180(bearing - worldPose.heading);
          // Camera height = the drone's altitude in flight (worldPose.alt), so
          // aerial rings look correctly DOWN at ground amenities; eye height indoors.
          const camH = worldPose.alt ?? CAMERA_HEIGHT_M;
          pitchDeg =
            (Math.atan2((hs.anchor.h ?? 0) - camH, Math.max(dist, 0.1)) * 180) / Math.PI;
          ringScale = Math.min(1.15, Math.max(0.62, 2.6 / Math.max(dist, 0.4)));
          if (hs.fadeFar !== undefined) {
            // distance-driven fade in/out — the automatic window from the flight
            // geometry, re-triggering on each pass (no keyframes).
            const near = hs.fadeNear ?? hs.fadeFar * 0.35;
            opacity = dist <= near ? 1 : dist >= hs.fadeFar ? 0 : (hs.fadeFar - dist) / (hs.fadeFar - near);
            visible = inChapter && gated && opacity > 0.02;
          } else {
            visible = inChapter && gated;
          }
        } else if (hs.yaw !== undefined && hs.pitch !== undefined) {
          // Legacy timed mode: fixed frame-relative direction in a window.
          yawDeg = hs.yaw;
          pitchDeg = hs.pitch;
          visible = inChapter && gated && hs.start !== undefined;
        }
        if (!visible) {
          node.style.opacity = "0";
          node.style.pointerEvents = "none";
          const sm = hsScreen.get(key);
          if (sm) sm.set = false; // re-snap cleanly next time it appears
          continue;
        }
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
        vis.push({
          node,
          key,
          tx: (nx * 0.5 + 0.5) * w,
          ty: (-ny * 0.5 + 0.5) * h,
          scale: clamped ? 0.7 : ringScale,
          dist,
          opacity,
        });
      }

      // Pass 2 — push apart any rings that would overlap, so each stays a
      // distinct, tappable target. A few relaxation passes over the handful of
      // on-screen rings is plenty; spreading is symmetric so it stays stable.
      const minSep = Math.max(70, Math.min(w, h) * 0.19);
      for (let pass = 0; pass < 4; pass++) {
        for (let p = 0; p < vis.length; p++) {
          for (let q = p + 1; q < vis.length; q++) {
            const A = vis[p];
            const B = vis[q];
            let ddx = B.tx - A.tx;
            let ddy = B.ty - A.ty;
            let d = Math.hypot(ddx, ddy);
            if (d < 0.01) {
              ddx = 0;
              ddy = 1;
              d = 1;
            }
            if (d < minSep) {
              const half = (minSep - d) / 2;
              const ux = (ddx / d) * half;
              const uy = (ddy / d) * half;
              A.tx -= ux;
              A.ty -= uy;
              B.tx += ux;
              B.ty += uy;
            }
          }
        }
      }

      // Pass 3 — glide toward the (separated) target and apply. Nearer rings
      // render on top so a cluster reads cleanly.
      const hits: { x: number; y: number; r: number; node: HTMLDivElement }[] = [];
      for (const v of vis) {
        v.tx = Math.max(w * 0.05, Math.min(w * 0.95, v.tx));
        v.ty = Math.max(h * 0.05, Math.min(h * 0.95, v.ty));
        let sm = hsScreen.get(v.key);
        if (!sm) {
          sm = { x: v.tx, y: v.ty, set: true };
          hsScreen.set(v.key, sm);
        } else if (!sm.set || Math.hypot(v.tx - sm.x, v.ty - sm.y) > Math.max(w, h) * 0.5) {
          sm.x = v.tx;
          sm.y = v.ty;
          sm.set = true;
        } else {
          sm.x += (v.tx - sm.x) * 0.3;
          sm.y += (v.ty - sm.y) * 0.3;
        }
        v.node.style.transform = `translate(-50%, -50%) translate(${sm.x}px, ${sm.y}px)`;
        v.node.style.setProperty("--rs", String(v.scale));
        v.node.style.zIndex = String(Math.round(1000 - Math.min(v.dist, 99) * 8));
        v.node.style.opacity = String(v.opacity);
        // Rings never capture pointer events — the canvas owns dragging, and a
        // tap is hit-tested against these positions below (a programmatic click
        // still fires the ring's handler through pointer-events:none).
        v.node.style.pointerEvents = "none";
        if (!authoring && v.opacity > 0.5) {
          hits.push({ x: sm.x, y: sm.y, r: Math.max(28, Math.min(60, w * 0.03)), node: v.node });
        }
      }
      ringHitsRef.current = hits;

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
      video.remove();
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

  // Track portrait/landscape for the immersive flight's rotate nudge.
  useEffect(() => {
    const update = () => setIsPortrait(window.innerHeight > window.innerWidth);
    update();
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
    };
  }, []);

  // Author transport helpers (used by the keyboard effect + the panel).
  const authSeek = useCallback((t: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = Math.max(0, Math.min(v.duration || t, t));
  }, []);
  const authStep = useCallback((n: number) => {
    const v = videoRef.current;
    if (!v) return;
    if (!v.paused) v.pause();
    const fps = 30; // flight is 30fps
    const idx = Math.round(v.currentTime * fps);
    v.currentTime = Math.max(0, Math.min(v.duration || 0, (idx + n) / fps + 0.001));
  }, []);

  // Load authored rings for this tour (author mode). Prefer an unsaved local
  // draft; otherwise seed from the tour's live hotspots — which the page has
  // already fetched from the backend — so you pick up exactly what's published.
  useEffect(() => {
    if (!author) return;
    let loaded: TourHotspot[] | null = null;
    try {
      const raw = localStorage.getItem(`lvx-rings:${tour.slug}`);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) loaded = parsed;
      }
    } catch {
      /* ignore */
    }
    if (!loaded) {
      loaded = (tour.chapters[chapterIdxRef.current]?.hotspots ?? []).filter(
        (h) => (h.keys?.length ?? 0) > 0,
      );
    }
    setRings(loaded);
    setActiveRing(loaded[0]?.id ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [author, tour.slug]);

  // Author transport: ←/→ or ,/. step a frame (Shift = 10), Space play/pause.
  useEffect(() => {
    if (!author) return;
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || el?.isContentEditable) return;
      const v = videoRef.current;
      if (!v) return;
      const fwd = e.key === "ArrowRight" || e.code === "Period";
      const back = e.key === "ArrowLeft" || e.code === "Comma";
      if (fwd || back) {
        e.preventDefault();
        authStep((fwd ? 1 : -1) * (e.shiftKey ? 10 : 1));
      } else if (e.code === "Space") {
        e.preventDefault();
        if (v.paused) void v.play();
        else v.pause();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [author, authStep]);

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
    async (panoId: string, resumeAt: { t: number; yaw: number } | null = null) => {
      const engine = engineRef.current;
      const target = tour.panos.find((p) => p.id === panoId);
      if (!engine || !target) return;
      resumeAtRef.current = resumeAt; // null for a ring tap; set for a map jump
      try {
        const texPromise = loadPano(target);
        setFading(true);
        const [tex] = await Promise.all([texPromise, sleep(350)]);
        // Remember where the flight was looking so Resume picks it back up.
        if (!panoRef.current) {
          flightLookRef.current = {
            lon: engine.look.lon,
            lat: engine.look.lat,
            mlon: engine.look.mlon,
            mlat: engine.look.mlat,
          };
        }
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
    // Map entry → resume at the amenity's keyframe time, facing it. Ring entry
    // → resume exactly where you left off (same time + camera angle).
    const jump = resumeAtRef.current;
    if (jump) {
      engine.video.currentTime = jump.t;
      engine.look.lon = FRONT_LON + jump.yaw;
      engine.look.lat = 0;
      engine.look.mlon = 0;
      engine.look.mlat = 0;
      engine.look.vLon = 0;
      engine.look.vLat = 0;
      resumeAtRef.current = null;
    } else if (flightLookRef.current) {
      const saved = flightLookRef.current;
      engine.look.lon = saved.lon;
      engine.look.lat = saved.lat;
      engine.look.mlon = saved.mlon;
      engine.look.mlat = saved.mlat;
      engine.look.vLon = 0;
      engine.look.vLat = 0;
    }
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
      // The static 360 for this amenity: explicit panoId, else match by name, so
      // a boxed + named zone "just works" with no manual linking.
      const panoId = zone.panoId ?? matchPanoByLabel(zone.label, tour.panos);
      const chId = zone.chapterId ?? tour.chapters[0]?.id ?? "";

      // GPS/VSLAM resume: the flight pass closest to this amenity NEAREST the
      // viewer's current moment — a room covered twice resumes on the pass they
      // just flew, not a later, globally-closer one. No hand-authored keyframe.
      // Falls back to a ring key, then videoTime.
      const nowT = engineRef.current?.video.currentTime ?? null;
      let resumeT: number | null = null;
      if (plan) {
        for (const s of plan.sheets) {
          const keys = s.paths?.[chId];
          if (keys?.length) {
            resumeT = closestApproachNearT(keys, centroidOf(zone.points), nowT);
            break;
          }
        }
      }
      if (resumeT == null) {
        for (const ch of tour.chapters) {
          const ring = ch.hotspots.find((h) => h.panoId === panoId && h.keys?.length);
          if (ring?.keys?.length) { resumeT = ring.keys[0].t; break; }
        }
      }
      if (resumeT == null && zone.videoTime !== undefined) resumeT = zone.videoTime;

      const startYaw = tour.chapters.find((c) => c.id === chId)?.startYaw ?? 0;
      const resumeAt = resumeT != null ? { t: resumeT, yaw: startYaw } : null;

      if (panoId) void enterPano(panoId, resumeAt);
      else if (resumeAt) void seekFlight(resumeAt.t, zone.chapterId);
    },
    [enterPano, seekFlight, tour.chapters, tour.panos, plan],
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
      try {
        host.requestFullscreen().then(
          () => {
            // Force landscape for the immersive flight. Android/Chrome honor this;
            // iOS has no lock and falls back to the rotate nudge.
            const so = screen.orientation as unknown as {
              lock?: (o: string) => Promise<void>;
            };
            so?.lock?.("landscape").catch(() => {});
          },
          () => setPseudoFs(true), // API rejected → fall back to the overlay
        );
      } catch {
        setPseudoFs(true); // some webviews throw synchronously
      }
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
    // If immersive doesn't take (blocked API, exited overlay), make sure the
    // player — controls included — is actually centered in the viewport:
    // on landscape phones the page prose pushes it below the fold.
    requestAnimationFrame(() =>
      mountRef.current?.parentElement?.scrollIntoView({ block: "center" }),
    );

    playP.then(
      () => {
        startedRef.current = true;
        setStarted(true);
        setLoading(false);
        setHint(true);
        setTimeout(() => setHint(false), 4500);
        // Mobile: surface the chrome briefly, then auto-hide for the immersive
        // flight (a tap brings it back).
        if (caps.isMobile) {
          setControlsVisible(true);
          if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
          hideTimerRef.current = window.setTimeout(() => setControlsVisible(false), 3500);
        }
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
      // In-app webviews and permission-restricted contexts reject (or throw)
      // — NEVER leave the user with a dead button: fall back to the overlay.
      try {
        host.requestFullscreen().catch(() => setPseudoFs(true));
      } catch {
        setPseudoFs(true);
      }
    } else {
      setPseudoFs(true);
    }
  };

  // ---------- ring authoring ----------
  const newRingId = () =>
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID().slice(0, 6)
      : String(Math.floor(performance.now()));
  // Persist on every mutation (so a reload/HMR doesn't lose authoring work);
  // load is the only path that sets state without saving, avoiding a clobber.
  const saveRings = (next: TourHotspot[]) => {
    try {
      localStorage.setItem(`lvx-rings:${tour.slug}`, JSON.stringify(next));
    } catch {
      /* storage unavailable */
    }
  };
  const mutateRings = (updater: (prev: TourHotspot[]) => TourHotspot[]) =>
    setRings((prev) => {
      const next = updater(prev);
      saveRings(next);
      return next;
    });
  const addRing = () => {
    const id = newRingId();
    mutateRings((prev) => [
      ...prev,
      { id, label: tour.panos[0]?.label ?? "Amenity", panoId: tour.panos[0]?.id ?? "", keys: [], fade: 0.6 },
    ]);
    setActiveRing(id);
  };
  const removeRing = (id: string) => {
    mutateRings((prev) => prev.filter((r) => r.id !== id));
    setActiveRing((cur) => (cur === id ? null : cur));
    hotspotEls.current.delete(`auth:${id}`);
  };
  const updateRing = (id: string, patch: Partial<TourHotspot>) =>
    mutateRings((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const removeRingKey = (id: string, kt: number) =>
    mutateRings((prev) =>
      prev.map((r) => (r.id === id ? { ...r, keys: (r.keys ?? []).filter((k) => k.t !== kt) } : r)),
    );
  const copyRings = async () => {
    // Clean hotspot JSON for data/tours.ts (only rings with keyframes).
    const out = rings
      .filter((r) => (r.keys?.length ?? 0) > 0)
      .map((r) => ({ id: `hs-${r.id}`, label: r.label, panoId: r.panoId, fade: r.fade ?? 0.6, keys: r.keys }));
    try {
      await navigator.clipboard.writeText(JSON.stringify(out, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };
  // ---------- publish to the live site (Zero Trust backend) ----------
  // The ring editor only edits hotspots; a Save publishes the WHOLE tour with
  // the authored rings merged into the current chapter, so the saved doc is
  // always complete and valid. Ids are kept idempotent so round-trips don't
  // stack the "hs-" prefix.
  const cleanRings = (): TourHotspot[] =>
    rings
      .filter((r) => (r.keys?.length ?? 0) > 0)
      .map((r) => ({
        id: r.id.startsWith("hs-") ? r.id : `hs-${r.id}`,
        label: r.label,
        panoId: r.panoId,
        fade: r.fade ?? 0.6,
        keys: r.keys,
      }));
  const buildTourDoc = (): Tour => {
    const ci = chapterIdxRef.current;
    const hotspots = cleanRings();
    return {
      ...tour,
      chapters: tour.chapters.map((c, i) => (i === ci ? { ...c, hotspots } : c)),
    };
  };
  const applyTourToRings = (t: Tour) => {
    const hs = (t.chapters[chapterIdxRef.current]?.hotspots ?? []).filter(
      (h) => (h.keys?.length ?? 0) > 0,
    );
    setRings(hs);
    saveRings(hs);
    setActiveRing(hs[0]?.id ?? null);
  };
  const saveToSite = async () => {
    setSaveState("saving");
    setSaveMsg("");
    try {
      await saveDoc("tour", tour.slug, buildTourDoc());
      setSaveState("saved");
      setTimeout(() => setSaveState("idle"), 2200);
    } catch (e) {
      setSaveState("error");
      setSaveMsg(e instanceof Error ? e.message : "Save failed");
    }
  };
  const revertToSaved = async () => {
    try {
      const doc = await loadDoc<Tour>("tour", tour.slug);
      if (doc) applyTourToRings(doc);
    } catch (e) {
      setSaveState("error");
      setSaveMsg(e instanceof Error ? e.message : "Load failed");
    }
  };
  const toggleRevisions = async () => {
    const next = !revsOpen;
    setRevsOpen(next);
    if (next) {
      try {
        setRevs(await listRevisions("tour", tour.slug));
      } catch {
        setRevs([]);
      }
    }
  };
  const restoreRev = async (id: number) => {
    try {
      const doc = await restoreRevision<Tour>("tour", tour.slug, id);
      if (doc) {
        applyTourToRings(doc);
        setRevsOpen(false);
        setSaveState("saved");
        setTimeout(() => setSaveState("idle"), 2200);
      }
    } catch (e) {
      setSaveState("error");
      setSaveMsg(e instanceof Error ? e.message : "Restore failed");
    }
  };

  const activeR = rings.find((r) => r.id === activeRing) ?? null;
  const fmtT = (s: number) =>
    `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}.${Math.floor((s % 1) * 10)}`;

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
  const clk = (s: number) =>
    `${Math.floor((s || 0) / 60)}:${String(Math.floor((s || 0) % 60)).padStart(2, "0")}`;

  return (
    <div
      className={cn(
        "relative overflow-hidden bg-ink [container-type:inline-size]",
        // iOS pseudo-fullscreen: fill the viewport above the page chrome.
        // The page passes aspect/width classes (e.g. aspect-video w-full) that
        // must not survive here: with a definite width, aspect-ratio computes
        // the height and the bottom inset is discarded, so a rotated phone got
        // a "fullscreen" taller than the screen. Force true viewport sizing.
        pseudoFs && "fixed inset-0 z-[60] !aspect-auto !h-dvh !w-screen !rounded-none",
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
          ch.hotspots.concat(autoRings[ch.id] ?? []).map((hs) => (
          <div
            key={`${ch.id}:${hs.id}`}
            ref={(node) => {
              const key = `${ch.id}:${hs.id}`;
              if (node) hotspotEls.current.set(key, node);
              else hotspotEls.current.delete(key);
            }}
            className="absolute left-0 top-0 flex flex-col items-center gap-[clamp(0.5rem,0.7cqw,1rem)] opacity-0 transition-opacity duration-150"
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
        {/* Live preview of the rings being authored (?author=1). */}
        {author &&
          rings.map((r) => (
            <div
              key={`auth:${r.id}`}
              ref={(node) => {
                const key = `auth:${r.id}`;
                if (node) hotspotEls.current.set(key, node);
                else hotspotEls.current.delete(key);
              }}
              className="absolute left-0 top-0 flex flex-col items-center gap-[clamp(0.5rem,0.7cqw,1rem)] opacity-0 transition-opacity duration-150"
              style={{ pointerEvents: "none" }}
            >
              <span className="relative flex h-[clamp(3.5rem,5cqw,7.5rem)] w-[clamp(3.5rem,5cqw,7.5rem)] items-center justify-center [scale:var(--rs,1)]">
                <span className="absolute inset-0 rounded-full border border-champagne/50" />
                <span className="relative flex h-[72%] w-[72%] items-center justify-center rounded-full border border-champagne bg-ink/40 backdrop-blur-sm">
                  <span className="h-[14%] w-[14%] rounded-full bg-champagne" />
                </span>
              </span>
              <span className="rounded-full bg-ink/60 px-[1.3em] py-[0.45em] font-sans text-[clamp(0.625rem,1cqw,1.25rem)] uppercase tracking-[0.18em] text-paper/90 backdrop-blur-sm">
                {r.label || "Ring"}
                {r.id === activeRing ? " ●" : ""}
              </span>
            </div>
          ))}
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
      {/* Compass HUD — captures with a known front→north offset (chapter.northYaw) */}
      {started && !pano && tour.chapters[0]?.northYaw != null && (
        <div
          aria-hidden
          className="pointer-events-none absolute bottom-[4.5rem] right-4 z-20 flex h-11 w-11 items-center justify-center rounded-full border border-champagne/50 bg-ink/50 backdrop-blur-sm"
        >
          <div
            ref={compassRef}
            className="relative flex h-full w-full items-center justify-center will-change-transform"
          >
            <svg viewBox="0 0 24 24" className="h-7 w-7">
              <path d="M12 3.5 L14.6 13 L12 11.4 L9.4 13 Z" className="fill-champagne" />
              <path d="M12 20.5 L9.4 13 L12 14.6 L14.6 13 Z" className="fill-paper/40" />
            </svg>
            <span className="absolute top-[2px] font-sans text-[8px] font-semibold tracking-widest text-champagne">
              N
            </span>
          </div>
        </div>
      )}

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
      {!started && showTutorial && !failed && (
        <TourTutorial
          isMobile={isMobileUi}
          hasMotion={motionAvail}
          onBegin={() => {
            try {
              localStorage.setItem("lvx-tutorial-seen", "1");
            } catch {
              /* storage unavailable */
            }
            setShowTutorial(false);
            void start();
          }}
          onSkip={() => {
            try {
              localStorage.setItem("lvx-tutorial-seen", "1");
            } catch {
              /* storage unavailable */
            }
            setShowTutorial(false);
          }}
        />
      )}

      {!started && (!showTutorial || failed) && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-5 bg-ink/60">
          <button
            type="button"
            onClick={start}
            disabled={loading || failed}
            className="group flex flex-col items-center justify-center gap-5"
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
          {!failed && (
            <button
              type="button"
              onClick={() => setShowTutorial(true)}
              className="font-sans text-[clamp(0.625rem,0.8cqw,0.95rem)] uppercase tracking-[0.2em] text-paper/45 transition-colors hover:text-champagne"
            >
              How to fly?
            </button>
          )}
        </div>
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

      {/* Rotate-to-landscape nudge for the immersive flight (iOS can't force it) */}
      {started && !pano && isPortrait && (pseudoFs || fsActive) && (
        <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center">
          <div className="flex flex-col items-center gap-3 rounded-2xl bg-ink/80 px-8 py-6 backdrop-blur-sm">
            <svg
              width="38"
              height="38"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#B7995C"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="motion-safe:animate-pulse"
              aria-hidden="true"
            >
              <rect x="8.5" y="2.5" width="7" height="13" rx="1.5" />
              <path d="M5 14a8 8 0 0 0 8 7.5" />
              <path d="M3 12l2 2 2-2" />
            </svg>
            <span className="font-sans text-[0.7rem] uppercase tracking-[0.22em] text-paper/90">
              Rotate to landscape
            </span>
          </div>
        </div>
      )}

      {/* Controls (auto-hide on mobile; tap the flight to bring them back) */}
      {started && (
        <div
          onPointerDown={() => {
            if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
            if (capsRef.current.isMobile)
              hideTimerRef.current = window.setTimeout(() => setControlsVisible(false), 4000);
          }}
          className={cn(
            // pb: keep the bar clear of the iPhone home indicator in fullscreen
            "absolute inset-x-0 bottom-0 flex flex-col gap-2.5 px-4 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))] transition-opacity duration-300",
            controlsVisible || author || pano ? "opacity-100" : "pointer-events-none opacity-0",
          )}
        >
          {/* Seek / scrub bar */}
          {!pano && (
            <div className="flex items-center gap-2.5">
              <span className="font-mono text-[clamp(0.6rem,0.78cqw,0.9rem)] tabular-nums text-paper/70">{clk(authTime)}</span>
              <input
                type="range"
                min={0}
                max={authDur || 0}
                step={0.05}
                value={Math.min(authTime, authDur || 0)}
                onChange={(e) => {
                  const v = engineRef.current?.video;
                  if (v) v.currentTime = parseFloat(e.target.value);
                }}
                className="h-1 flex-1 cursor-pointer accent-champagne"
                aria-label="Seek"
              />
              <span className="font-mono text-[clamp(0.6rem,0.78cqw,0.9rem)] tabular-nums text-paper/50">{clk(authDur || 0)}</span>
            </div>
          )}
          <div className="relative flex items-center justify-between">
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
          {/* wrap-safe: an extra button (VR on phones) or bigger cq text must never
              push Fullscreen — always rightmost — off the edge */}
          <div className="flex min-w-0 flex-wrap items-center justify-end gap-2 gap-y-1 sm:gap-3">
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
        </div>
      )}

      {/* Living minimap — pops out to a stage-filling plan on demand */}
      {plan && started && planOpen && (
        <div
          className={
            planExpanded
              ? "absolute inset-0 z-30 flex items-stretch justify-center bg-ink/55 p-[clamp(0.5rem,1.5cqw,1.25rem)] backdrop-blur-[2px]"
              : "absolute bottom-[clamp(4.5rem,6cqw,7rem)] right-4"
          }
          onClick={planExpanded ? () => setPlanExpanded(false) : undefined}
        >
          <div
            className={planExpanded ? "h-full w-full" : undefined}
            onClick={planExpanded ? (e) => e.stopPropagation() : undefined}
          >
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
              onClose={() => {
                setPlanExpanded(false);
                setPlanOpen(false);
              }}
              indicatorRef={planIndicatorRef}
              authorMode={author}
              onCanvasClick={author ? recordPathMark : undefined}
              expanded={planExpanded}
              onToggleExpand={() => setPlanExpanded((v) => !v)}
            />
          </div>
        </div>
      )}

      {/* Ring editor (?author=1) */}
      {author && started && (
        <div className="absolute right-3 top-3 flex max-h-[80vh] w-80 flex-col overflow-auto rounded-lg border border-champagne/40 bg-ink/90 p-3.5 font-sans text-xs text-paper backdrop-blur">
          <p className="font-display text-[0.6875rem] uppercase tracking-[0.2em] text-champagne">
            Ring Editor
          </p>

          {/* transport */}
          <div className="mt-2.5 flex items-center gap-1.5">
            <button type="button" onClick={togglePlay} aria-label={playing ? "Pause" : "Play"} className="rounded border border-paper/30 px-2 py-1 hover:border-champagne hover:text-champagne">
              {playing ? "❚❚" : "►"}
            </button>
            <button type="button" onClick={() => authStep(-1)} aria-label="Back a frame" className="rounded border border-paper/30 px-2 py-1 hover:border-champagne hover:text-champagne">‹</button>
            <button type="button" onClick={() => authStep(1)} aria-label="Forward a frame" className="rounded border border-paper/30 px-2 py-1 hover:border-champagne hover:text-champagne">›</button>
            <span className="ml-auto font-mono tabular-nums text-champagne/90">{fmtT(authTime)} / {fmtT(authDur || 0)}</span>
          </div>
          <div className="relative mt-1.5">
            <input
              type="range" min={0} max={authDur || 0} step={0.01} value={authTime}
              onChange={(e) => authSeek(parseFloat(e.target.value))}
              className="w-full accent-champagne" aria-label="Scrub"
            />
            {activeR && authDur > 0 && (
              <div className="pointer-events-none absolute inset-x-0 top-1/2">
                {(activeR.keys ?? []).map((k) => (
                  <span key={k.t} className="absolute h-2 w-0.5 -translate-y-1/2 bg-champagne" style={{ left: `${(k.t / authDur) * 100}%` }} />
                ))}
              </div>
            )}
          </div>
          <p className="mt-1 flex justify-between text-[0.65rem] text-paper/40">
            <span>← → or , . frame · Shift = 10 · Space play</span>
            <span ref={readoutRef} className="font-mono text-champagne/70" />
          </p>

          {/* rings */}
          <div className="mt-2.5 flex items-center justify-between border-t border-paper/15 pt-2.5">
            <span className="uppercase tracking-[0.16em] text-paper/50">Rings ({rings.length})</span>
            <button type="button" onClick={addRing} className="rounded border border-paper/30 px-2 py-1 uppercase tracking-[0.12em] hover:border-champagne hover:text-champagne">+ Add</button>
          </div>
          {rings.length === 0 && (
            <p className="mt-2 leading-relaxed text-paper/40">
              Add a ring, scrub to where its amenity appears, and click it in the 360. Click again as you
              pass — the ring tracks it and fades in/out across the window.
            </p>
          )}
          <div className="mt-2 flex flex-col gap-2">
            {rings.map((r) => {
              const isA = r.id === activeRing;
              const ks = r.keys ?? [];
              return (
                <div key={r.id} className={cn("rounded-lg border p-2", isA ? "border-champagne/60 bg-champagne/5" : "border-paper/15")}>
                  <div className="flex items-center gap-1.5">
                    <button type="button" onClick={() => setActiveRing(r.id)} aria-label="Select ring"
                      className={cn("h-3 w-3 shrink-0 rounded-full border", isA ? "border-champagne bg-champagne" : "border-paper/40")} />
                    <input
                      value={r.label}
                      onChange={(e) => updateRing(r.id, { label: e.target.value })}
                      onFocus={() => setActiveRing(r.id)}
                      placeholder="Ring name"
                      className="min-w-0 flex-1 rounded bg-ink/60 px-1.5 py-0.5 text-paper outline-none placeholder:text-paper/30"
                    />
                    <span className="font-mono text-[0.65rem] text-paper/40">{ks.length}k</span>
                    <button type="button" onClick={() => removeRing(r.id)} aria-label="Delete ring" className="text-paper/40 hover:text-red-400">✕</button>
                  </div>
                  {isA && (
                    <>
                      <p className="mt-1.5 text-[0.65rem] leading-relaxed text-champagne/80">
                        {ks.length === 0
                          ? "① Scrub to where it appears, then click it in the 360."
                          : ks.length === 1
                            ? "② Now scrub to where it leaves view and click it again."
                            : "③ Tracked. Add a mid-pass click if it drifts — it fades in/out automatically."}
                      </p>
                      {ks.length > 0 && (
                        <div className="mt-1.5 flex flex-wrap gap-1">
                          {ks.map((k) => (
                            <span key={k.t} className="inline-flex items-center overflow-hidden rounded border border-paper/20">
                              <button type="button" onClick={() => authSeek(k.t)} className="px-1 py-0.5 font-mono text-[0.65rem] hover:text-champagne" title={`yaw ${k.yaw}° · pitch ${k.pitch}°`}>{fmtT(k.t)}</button>
                              <button type="button" onClick={() => removeRingKey(r.id, k.t)} aria-label="Delete keyframe" className="border-l border-paper/20 px-1 py-0.5 text-[0.65rem] text-paper/40 hover:text-red-400">✕</button>
                            </span>
                          ))}
                        </div>
                      )}
                      <label className="mt-1.5 flex items-center gap-2 text-[0.65rem] text-paper/60">
                        Pano
                        <select
                          value={r.panoId}
                          onChange={(e) => updateRing(r.id, { panoId: e.target.value })}
                          className="min-w-0 flex-1 rounded bg-ink/60 px-1 py-0.5 text-paper outline-none"
                        >
                          {tour.panos.map((p) => (<option key={p.id} value={p.id}>{p.label}</option>))}
                        </select>
                      </label>
                      <label className="mt-1.5 flex items-center gap-2 text-[0.65rem] text-paper/60">
                        Fade
                        <input type="number" min={0} max={3} step={0.1} value={r.fade ?? 0.6}
                          onChange={(e) => updateRing(r.id, { fade: Math.max(0, parseFloat(e.target.value) || 0) })}
                          className="w-14 rounded bg-ink/60 px-1 py-0.5 text-paper outline-none" />
                        s
                      </label>
                    </>
                  )}
                </div>
              );
            })}
          </div>
          {/* publish to the live site */}
          <div className="mt-3 flex flex-col gap-1.5">
            <button
              type="button"
              onClick={() => void saveToSite()}
              disabled={saveState === "saving" || rings.every((r) => !(r.keys?.length))}
              className="rounded border border-champagne bg-champagne/90 px-2 py-1.5 font-semibold uppercase tracking-[0.14em] text-ink transition-colors hover:bg-champagne disabled:opacity-40"
            >
              {saveState === "saving" ? "Saving…" : saveState === "saved" ? "Saved ✓" : "Save to site"}
            </button>
            <div className="flex gap-1.5">
              <button
                type="button"
                onClick={() => void copyRings()}
                disabled={rings.every((r) => !(r.keys?.length))}
                className="flex-1 rounded border border-paper/30 px-2 py-1 uppercase tracking-[0.14em] text-paper/80 transition-colors hover:border-champagne hover:text-champagne disabled:opacity-40"
              >
                {copied ? "Copied ✓" : "Copy JSON"}
              </button>
              <button
                type="button"
                onClick={() => void revertToSaved()}
                className="flex-1 rounded border border-paper/30 px-2 py-1 uppercase tracking-[0.14em] text-paper/80 transition-colors hover:border-champagne hover:text-champagne"
              >
                Revert
              </button>
              <button
                type="button"
                onClick={() => void toggleRevisions()}
                className="rounded border border-paper/30 px-2 py-1 uppercase tracking-[0.14em] text-paper/80 transition-colors hover:border-champagne hover:text-champagne"
              >
                History
              </button>
            </div>
            {saveState === "error" && (
              <p className="text-[0.65rem] leading-snug text-red-400">{saveMsg}</p>
            )}
            {revsOpen && (
              <div className="mt-1 max-h-32 overflow-auto rounded border border-paper/15 bg-ink/60 p-1.5">
                {revs.length === 0 ? (
                  <p className="text-[0.65rem] text-paper/40">No saved versions yet.</p>
                ) : (
                  revs.map((rv) => (
                    <button
                      key={rv.id}
                      type="button"
                      onClick={() => void restoreRev(rv.id)}
                      className="flex w-full items-center justify-between gap-2 rounded px-1.5 py-1 text-left text-[0.65rem] text-paper/70 transition-colors hover:bg-champagne/10 hover:text-champagne"
                    >
                      <span className="font-mono">{new Date(rv.created_at).toLocaleString()}</span>
                      <span className="text-paper/40">restore</span>
                    </button>
                  ))
                )}
              </div>
            )}
          </div>

          {/* path keys (for the dot) */}
          <div className="mt-3 border-t border-paper/15 pt-2.5">
            <p className="text-paper/60">Path keys: <span className="tabular-nums text-champagne">{pathMarkCount}</span> <span className="text-paper/40">— Plan → fly → click your spot</span></p>
            <div className="mt-1.5 flex gap-2">
              <button type="button" onClick={() => void copyPathMarks()} disabled={pathMarkCount === 0}
                className="flex-1 rounded border border-champagne/60 px-2 py-1 uppercase tracking-[0.12em] text-champagne hover:bg-champagne hover:text-ink disabled:opacity-40">
                {copiedPaths ? "Copied" : "Copy paths"}
              </button>
              <button type="button" onClick={() => setPathMarks({})} disabled={pathMarkCount === 0}
                className="rounded border border-paper/30 px-2 py-1 uppercase tracking-[0.12em] text-paper/70 hover:border-paper/60 disabled:opacity-40">Clear</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
