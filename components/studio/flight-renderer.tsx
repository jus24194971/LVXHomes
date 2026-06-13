"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";

/**
 * Synthetic flight renderer — dev-only tooling (/studio/render?go=1).
 *
 * Builds a small 3D house (kitchen → hallway → primary suite), flies a camera
 * along a spline at drone height, and captures every frame as a true 360
 * equirectangular image: a world-aligned cube camera renders the scene, and a
 * fullscreen shader reprojects the cubemap to equirect, rotated so the frame
 * center (the viewer's FRONT) is always the direction of travel — which is
 * exactly the heading model the plan's view cone assumes.
 *
 * Frames POST to scripts/render-receiver.cjs (localhost:4599); ffmpeg
 * assembles them into the demo flight afterward.
 */

const RECEIVER = "http://localhost:4599";
const W = 3072;
const H = 1536;
const FPS = 30;
const SECONDS = 22;
const FRAMES = FPS * SECONDS;
const CAM_Y = 1.35;

type Status = {
  status: string;
  frame: number;
  total: number;
  pathKeys: { t: number; x: number; y: number }[];
  suggestions: Record<string, { t: number; yaw: number; pitch: number }>;
};

declare global {
  interface Window {
    __fr?: Status;
    __frStarted?: boolean;
  }
}

function buildHouse(scene: THREE.Scene) {
  const mat = (color: number, rough = 0.85, metal = 0, emissive = 0) =>
    new THREE.MeshStandardMaterial({
      color,
      roughness: rough,
      metalness: metal,
      emissive: emissive ? color : 0x000000,
      emissiveIntensity: emissive,
    });
  const box = (
    w: number, h: number, d: number,
    x: number, y: number, z: number,
    m: THREE.Material, cast = true, receive = true,
  ) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
    mesh.position.set(x, y, z);
    mesh.castShadow = cast;
    mesh.receiveShadow = receive;
    scene.add(mesh);
    return mesh;
  };

  const cream = mat(0xefe8d8);
  const paper = mat(0xf5f0e6);
  const espresso = mat(0x3a3026, 0.7);
  const champagne = mat(0xb7995c, 0.5, 0.35);
  const counter = mat(0xfbf8f1, 0.35);
  const plankA = mat(0x8a6f52, 0.8);
  const plankB = mat(0x7c6248, 0.8);
  const slate = mat(0x6f7a82, 0.9);
  const linen = mat(0xf1ead9, 0.95);

  // ---- floors: planks (the lines sell the motion) ----
  const plankRegion = (x0: number, x1: number, z0: number, z1: number) => {
    for (let z = z0; z < z1 - 0.001; z += 0.5) {
      const m = Math.round(z * 2) % 2 === 0 ? plankA : plankB;
      box(x1 - x0, 0.05, 0.48, (x0 + x1) / 2, -0.025, z + 0.25, m, false, true);
    }
  };
  plankRegion(0, 7, 0, 6); // kitchen
  plankRegion(7, 9.5, 2, 4); // hall
  plankRegion(9.5, 16, 0, 7); // suite
  plankRegion(1.5, 7, 6, 10); // grand foyer
  // master bath: stone tile laid over the planks
  const tile = mat(0xb9bfba, 0.6);
  const tileB = mat(0xaab0ab, 0.6);
  for (let tx = 9.5; tx < 12; tx += 0.625) {
    for (let tz = 0; tz < 2.5; tz += 0.625) {
      box(0.6, 0.04, 0.6, tx + 0.3125, 0.005, tz + 0.3125, ((tx + tz) * 1.6) % 2 < 1 ? tile : tileB, false, true);
    }
  }

  // ---- ceilings ----
  box(16, 0.1, 7.2, 8, 2.85, 3.5, paper, false, false); // main
  box(5.5, 0.1, 4.2, 4.25, 3.65, 8, paper, false, false); // foyer (taller)
  box(5.5, 0.95, 0.15, 4.25, 3.27, 6, cream, false, false); // clerestory band
  box(0.15, 0.95, 4, 1.5, 3.27, 8, cream, false, false);
  box(0.15, 0.95, 4, 7, 3.27, 8, cream, false, false);

  // ---- walls (h 2.8, t .15) ----
  const wall = (w: number, d: number, x: number, z: number) =>
    box(w, 2.8, d, x, 1.4, z, cream, true, true);
  wall(16.3, 0.15, 8, -0.075); // north z=0
  wall(0.15, 6.3, -0.075, 3); // west x=0
  // kitchen south z=6 with foyer door gap x 3..4.6
  wall(3, 0.15, 1.5, 6.075);
  wall(2.4, 0.15, 5.8, 6.075);
  box(1.9, 0.1, 0.22, 3.8, 2.45, 6.075, champagne, false, false); // door header
  wall(0.15, 7.3, 16.075, 3.5); // east x=16
  wall(6.65, 0.15, 12.75, 7.075); // suite south z=7
  // grand foyer shell (taller walls h 3.6)
  box(0.15, 4.15, 3.6, 1.5, 1.8, 8.075, cream); // west
  box(0.15, 4.15, 3.6, 7, 1.8, 8.075, cream); // east
  box(2.05, 3.6, 0.15, 2.475, 1.8, 10.075, cream); // south, left of entry
  box(2.05, 3.6, 0.15, 6.025, 1.8, 10.075, cream); // south, right of entry
  box(2.1, 0.7, 0.15, 4.25, 3.25, 10.075, cream); // above entry
  // master bath partition (inside the suite, x 9.5..12 z 0..2.5)
  wall(0.7, 0.15, 9.85, 2.5); // south wall, west of door
  wall(0.8, 0.15, 11.6, 2.5); // south wall, east of door
  wall(0.15, 2.5, 12, 1.25); // east wall
  box(0.22, 0.1, 1, 10.7, 2.45, 2.5, champagne, false, false); // bath door header
  // kitchen/hall wall x=7 with door gap z 2..4
  wall(0.15, 2, 7, 1); wall(0.15, 2, 7, 5);
  // hall sides
  wall(2.5, 0.15, 8.25, 2); wall(2.5, 0.15, 8.25, 4);
  // hall/suite wall x=9.5 with door gap z 2..4
  wall(0.15, 2, 9.5, 1); wall(0.15, 2.95, 9.5, 5.525);
  // door frames (champagne)
  for (const dx of [7, 9.5]) {
    box(0.22, 0.1, 2.1, dx, 2.45, 3, champagne, false, false);
    box(0.22, 2.4, 0.1, dx, 1.2, 1.95, champagne, false, false);
    box(0.22, 2.4, 0.1, dx, 1.2, 4.05, champagne, false, false);
  }

  // ---- kitchen ----
  box(2.4, 0.9, 1.1, 3.5, 0.45, 3, espresso); // island base
  box(2.7, 0.09, 1.35, 3.5, 0.945, 3, counter); // island top
  for (let i = -1; i <= 1; i++) {
    box(0.02, 0.85, 0.02, 3.5 + i, 2.35, 3, espresso, false, false); // cords
    const bulb = new THREE.Mesh(
      new THREE.SphereGeometry(0.09, 16, 12),
      new THREE.MeshStandardMaterial({ color: 0xffd9a0, emissive: 0xffc070, emissiveIntensity: 2.2 }),
    );
    bulb.position.set(3.5 + i, 1.9, 3);
    scene.add(bulb);
    const pl = new THREE.PointLight(0xffd2a0, 4, 7, 2);
    pl.position.set(3.5 + i, 1.78, 3);
    scene.add(pl);
  }
  box(6.6, 0.9, 0.65, 3.4, 0.45, 0.43, espresso); // perimeter lower
  box(6.6, 0.07, 0.75, 3.4, 0.935, 0.45, counter);
  box(2.2, 0.7, 0.35, 1.6, 1.85, 0.28, espresso); // uppers
  box(1.6, 0.7, 0.35, 5.6, 1.85, 0.28, espresso);
  box(1.1, 0.5, 0.5, 3.5, 2.1, 0.33, mat(0x9aa0a6, 0.4, 0.8)); // hood
  box(0.95, 1.9, 0.72, 6.5, 0.95, 5.5, mat(0xb8bcc0, 0.35, 0.9)); // fridge
  for (const sx of [2.7, 4.3]) {
    const stool = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.16, 0.62, 18), espresso);
    stool.position.set(sx, 0.31, 4.0);
    stool.castShadow = true;
    scene.add(stool);
  }
  // kitchen window (north wall) — emissive pane + frame
  box(2.3, 1.35, 0.06, 3.5, 1.55, 0.04, mat(0xfff0d0, 1, 0, 1.6), false, false);
  box(2.5, 0.08, 0.1, 3.5, 2.27, 0.06, champagne, false, false);
  box(2.5, 0.08, 0.1, 3.5, 0.83, 0.06, champagne, false, false);

  // ---- hallway ----
  box(1.3, 0.8, 0.32, 8.25, 0.4, 2.2, espresso); // console
  box(0.9, 0.7, 0.05, 8.25, 1.7, 2.06, champagne, false, false); // art
  const sconce = new THREE.PointLight(0xffd9b0, 3, 5, 2);
  sconce.position.set(8.25, 2.2, 3.8);
  scene.add(sconce);

  // ---- primary suite ----
  box(2.3, 0.35, 1.95, 13, 0.175, 5.6, espresso); // platform
  box(2.1, 0.28, 1.75, 13, 0.49, 5.55, linen); // mattress
  box(2.3, 1.15, 0.12, 13, 1.2, 6.55, espresso); // headboard
  box(0.85, 0.18, 0.5, 12.5, 0.72, 6.2, paper, false); // pillows
  box(0.85, 0.18, 0.5, 13.5, 0.72, 6.2, paper, false);
  box(2.1, 0.1, 0.7, 13, 0.62, 4.95, champagne, false); // throw
  for (const nx of [11.6, 14.4]) {
    box(0.52, 0.55, 0.45, nx, 0.275, 6.3, espresso);
    const lamp = new THREE.Mesh(
      new THREE.SphereGeometry(0.11, 16, 12),
      new THREE.MeshStandardMaterial({ color: 0xffe2b8, emissive: 0xffd090, emissiveIntensity: 1.8 }),
    );
    lamp.position.set(nx, 0.78, 6.3);
    scene.add(lamp);
    const pl = new THREE.PointLight(0xffd9b0, 3.4, 6, 2);
    pl.position.set(nx, 0.85, 6.3);
    scene.add(pl);
  }
  box(3.4, 0.03, 2.4, 13, 0.015, 3.6, slate, false, true); // rug
  box(1.7, 0.95, 0.5, 15.6, 0.475, 1.6, espresso); // dresser
  box(1.5, 0.45, 0.45, 13, 0.225, 4.35, linen); // bench
  box(1.2, 0.9, 0.05, 11.5, 1.7, 6.95, champagne, false, false); // art
  // suite windows: east + north
  box(0.06, 1.45, 2.5, 15.96, 1.55, 3.2, mat(0xeae4ff, 1, 0, 1.35), false, false);
  box(0.1, 0.08, 2.7, 15.94, 2.32, 3.2, champagne, false, false);
  box(2.1, 1.3, 0.06, 12.6, 1.55, 0.04, mat(0xfff0d8, 1, 0, 1.3), false, false);

  // ---- grand foyer ----
  {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.55, 0.045, 10, 36), champagne);
    ring.rotation.x = Math.PI / 2;
    ring.position.set(4.25, 2.75, 8);
    scene.add(ring);
    box(0.025, 0.85, 0.025, 4.25, 3.2, 8, espresso, false, false); // stem
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      const bulb = new THREE.Mesh(
        new THREE.SphereGeometry(0.07, 14, 10),
        new THREE.MeshStandardMaterial({ color: 0xffe0b0, emissive: 0xffcf8a, emissiveIntensity: 2.4 }),
      );
      bulb.position.set(4.25 + Math.cos(a) * 0.55, 2.72, 8 + Math.sin(a) * 0.55);
      scene.add(bulb);
    }
    const chand = new THREE.PointLight(0xffd9a8, 9, 11, 2);
    chand.position.set(4.25, 2.6, 8);
    scene.add(chand);
    const rug = new THREE.Mesh(new THREE.CylinderGeometry(1.35, 1.35, 0.025, 40), mat(0x6f7a82, 0.95));
    rug.position.set(4.25, 0.0125, 8);
    rug.receiveShadow = true;
    scene.add(rug);
    box(1.5, 0.85, 0.4, 2.0, 0.425, 9.7, espresso); // console
    box(1.0, 0.8, 0.05, 2.0, 1.95, 10.0, champagne, false, false); // art
    box(1.0, 0.8, 0.05, 1.56, 1.7, 8.0, champagne, false, false); // art west
    // entry doors + glowing transom/sidelites
    box(0.7, 2.2, 0.1, 3.9, 1.1, 10.04, espresso, false, false);
    box(0.7, 2.2, 0.1, 4.6, 1.1, 10.04, espresso, false, false);
    box(2.1, 0.5, 0.06, 4.25, 2.6, 10.03, mat(0xfff0d0, 1, 0, 1.5), false, false); // transom
    box(0.28, 1.9, 0.06, 3.4, 1.15, 10.03, mat(0xfff0d0, 1, 0, 1.2), false, false);
    box(0.28, 1.9, 0.06, 5.1, 1.15, 10.03, mat(0xfff0d0, 1, 0, 1.2), false, false);
  }

  // ---- master bath ----
  {
    box(1.9, 0.82, 0.55, 10.6, 0.41, 0.36, espresso); // vanity
    box(2.05, 0.06, 0.62, 10.6, 0.85, 0.37, counter);
    box(0.5, 0.1, 0.36, 10.15, 0.91, 0.34, mat(0xfbf8f1, 0.25)); // sinks
    box(0.5, 0.1, 0.36, 11.05, 0.91, 0.34, mat(0xfbf8f1, 0.25));
    box(1.7, 0.95, 0.04, 10.6, 1.62, 0.1, mat(0xbcc4c8, 0.06, 0.95), false, false); // mirror
    box(1.85, 0.06, 0.08, 10.6, 2.14, 0.11, champagne, false, false);
    // freestanding tub
    box(1.6, 0.55, 0.78, 11.1, 0.275, 1.85, mat(0xfbf8f1, 0.2));
    box(1.44, 0.06, 0.62, 11.1, 0.52, 1.85, mat(0x8d959b, 0.4), false, false); // water line
    // glass shower
    const glass = new THREE.MeshStandardMaterial({ color: 0xcfe2e8, roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.22 });
    box(0.05, 2.1, 0.9, 9.95, 1.05, 1.95, glass, false, false);
    box(0.7, 2.1, 0.05, 10.28, 1.05, 1.52, glass, false, false);
    box(0.06, 2.15, 0.06, 9.95, 1.075, 1.51, champagne, false, false);
    const sconceA = new THREE.PointLight(0xffe2c0, 3.2, 6, 2);
    sconceA.position.set(10.1, 1.9, 0.4);
    scene.add(sconceA);
    const sconceB = new THREE.PointLight(0xffe2c0, 3.2, 6, 2);
    sconceB.position.set(11.1, 1.9, 0.4);
    scene.add(sconceB);
  }

  // ---- lights ----
  scene.add(new THREE.AmbientLight(0xfff2e2, 0.6));
  scene.add(new THREE.HemisphereLight(0xfff6e8, 0x5a4a38, 0.55));
  const sun = new THREE.DirectionalLight(0xffe6c4, 1.4);
  sun.position.set(3.5, 5.2, -4);
  sun.target.position.set(4.5, 0, 3.5);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.left = -10; sun.shadow.camera.right = 14;
  sun.shadow.camera.top = 10; sun.shadow.camera.bottom = -10;
  scene.add(sun, sun.target);
  const dusk = new THREE.DirectionalLight(0xdfe4ff, 0.45);
  dusk.position.set(20, 4, 3.5);
  scene.add(dusk);
}

export function FlightRenderer() {
  const mountRef = useRef<HTMLDivElement>(null);
  const [label, setLabel] = useState("idle — add ?go=1 to run");

  useEffect(() => {
    if (!new URLSearchParams(window.location.search).has("go")) return;
    if (window.__frStarted) return; // StrictMode double-mount guard
    window.__frStarted = true;

    const run = async () => {
      const state: Status = {
        status: "building scene",
        frame: 0,
        total: FRAMES,
        pathKeys: [],
        suggestions: {},
      };
      window.__fr = state;
      const set = (s: string) => { state.status = s; setLabel(s); };

      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0x211c16);
      buildHouse(scene);

      const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
      renderer.setSize(W, H);
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFShadowMap;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.22;
      mountRef.current?.appendChild(renderer.domElement);
      renderer.domElement.style.width = "100%";
      renderer.domElement.style.height = "auto";

      const cubeRT = new THREE.WebGLCubeRenderTarget(1024);
      const cubeCam = new THREE.CubeCamera(0.05, 60, cubeRT);
      scene.add(cubeCam);

      // cube → equirect pass (frame center = direction of travel)
      const quadScene = new THREE.Scene();
      const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
      const quadMat = new THREE.ShaderMaterial({
        uniforms: { tCube: { value: cubeRT.texture }, uYaw: { value: 0 } },
        vertexShader:
          "varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }",
        fragmentShader: `
          varying vec2 vUv;
          uniform samplerCube tCube;
          uniform float uYaw;
          void main(){
            float lon = (vUv.x - 0.5) * 6.28318530718;
            float lat = (vUv.y - 0.5) * 3.14159265359;
            vec3 d = vec3(sin(lon) * cos(lat), sin(lat), -cos(lon) * cos(lat));
            float c = cos(uYaw), s = sin(uYaw);
            vec3 w = vec3(c * d.x + s * d.z, d.y, -s * d.x + c * d.z);
            gl_FragColor = textureCube(tCube, w);
          }`,
        depthTest: false,
        depthWrite: false,
      });
      quadScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), quadMat));

      // flight path — grand foyer → kitchen door → island loop → hall →
      // master bath (vanity + tub) → primary suite → bed arc → settle
      const pts = [
        [4.2, 9.2], [4.0, 7.6], [3.7, 6.2], [2.8, 4.7], [2.4, 3.0],
        [3.4, 1.9], [5.1, 2.5], [6.4, 3.0], [8.3, 3.0], [10.3, 3.0],
        [10.7, 2.2], [10.4, 1.2], [11.3, 1.4], [11.0, 2.2], [12.4, 3.0],
        [13.9, 3.7], [14.2, 4.7], [13.0, 5.1], [12.0, 4.0],
      ].map(([x, z]) => new THREE.Vector3(x, CAM_Y, z));
      const curve = new THREE.CatmullRomCurve3(pts, false, "centripetal", 0.5);

      // exact plan-path keyframes (plan x = world x, plan y = world z)
      for (let t = 0; t <= SECONDS; t++) {
        const p = curve.getPointAt(t / SECONDS);
        state.pathKeys.push({ t, x: Math.round(p.x * 10) / 10, y: Math.round(p.z * 10) / 10 });
      }
      // (Hotspots are world-anchored now — no per-time yaw suggestions needed;
      // anchors in data/tours.ts use these same scene coordinates.)

      const blob = () =>
        new Promise<Blob>((res, rej) =>
          renderer.domElement.toBlob((b) => (b ? res(b) : rej(new Error("toBlob"))), "image/jpeg", 0.9),
        );

      set("rendering");
      const PANO_FRAMES: Record<number, string> = {
        45: "pano-foyer.jpg", // t 1.5 — under the chandelier
        165: "pano-kitchen-3d.jpg", // t 5.5 — by the island
        480: "pano-bath.jpg", // t 16 — vanity + tub
        585: "pano-suite-3d.jpg", // t 19.5 — over the bed
      };
      for (let f = 0; f < FRAMES; f++) {
        const u = f / (FRAMES - 1);
        const pos = curve.getPointAt(u);
        const tan = curve.getTangentAt(u);
        cubeCam.position.copy(pos);
        cubeCam.update(renderer, scene);
        quadMat.uniforms.uYaw.value = Math.atan2(-tan.x, -tan.z);
        renderer.setRenderTarget(null);
        renderer.render(quadScene, quadCam);
        const b = await blob();
        await fetch(`${RECEIVER}/frame?n=${f}`, { method: "POST", body: b });
        if (PANO_FRAMES[f]) {
          await fetch(`${RECEIVER}/frame?name=${PANO_FRAMES[f]}`, { method: "POST", body: b });
        }
        state.frame = f + 1;
        if (f % 30 === 0) setLabel(`rendering ${f + 1}/${FRAMES}`);
      }
      set("done");
    };

    run().catch((e) => {
      if (window.__fr) window.__fr.status = `error: ${String(e)}`;
      setLabel(`error: ${String(e)}`);
    });
  }, []);

  return (
    <div>
      <p className="mb-3 font-sans text-xs uppercase tracking-[0.16em] text-champagne">{label}</p>
      <div ref={mountRef} className="overflow-hidden border border-paper/15" />
    </div>
  );
}
