import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import WebGPURenderer from "three/addons/renderers/webgpu/WebGPURenderer.js";

import { TAU } from "../kernel/kernel.mjs";

export async function createThreeSetup({ gpuSurface = false, skipGpuDevice = false } = {}) {
  const canvas = document.querySelector("#viewport");
  let surfaceCanvas = null;
  let surfaceDevice = null;
  let gpuSurfaceActive = false;
  if (gpuSurface && !skipGpuDevice) {
    try {
      surfaceDevice = await createDevice();
      surfaceCanvas = createSurfaceCanvas(canvas);
      gpuSurfaceActive = true;
    } catch (error) {
      console.warn("GPU surface renderer disabled:", error);
    }
  }
  const inputCanvas = surfaceCanvas ?? canvas;
  let renderer = null;
  if (!gpuSurfaceActive) {
    try {
      renderer = await createRenderer(canvas);
    } catch (error) {
      console.warn("Three WebGPU renderer disabled:", error);
    }
  }
  renderer?.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer?.setClearColor(0x090b0f, 1);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
  camera.position.set(0, 0.15, 3.0);

  const orbitControls = new OrbitControls(camera, inputCanvas);
  orbitControls.enableDamping = true;
  orbitControls.minDistance = 1.35;
  orbitControls.maxDistance = 5.0;
  // Mouse contract: left button is for paint (handled by paint.mjs),
  // right button rotates the camera, no panning. Middle button keeps
  // dolly so users can wheel-or-drag to zoom.
  orbitControls.enablePan = false;
  orbitControls.mouseButtons = {
    LEFT: null,
    MIDDLE: THREE.MOUSE.DOLLY,
    RIGHT: THREE.MOUSE.ROTATE,
  };

  scene.add(new THREE.AmbientLight(0x91a7bd, 1.8));
  const sun = new THREE.DirectionalLight(0xffffff, 2.4);
  sun.position.set(2.5, 1.3, 2.0);
  scene.add(sun);

  const globe = new THREE.Mesh(
    new THREE.SphereGeometry(1, 160, 80),
    createRaycastGlobeMaterial(),
  );
  scene.add(globe);

  const starGeometry = new THREE.BufferGeometry();
  const starCount = 900;
  const starPositions = new Float32Array(starCount * 3);
  for (let i = 0; i < starCount; i++) {
    const r = 20 + Math.random() * 40;
    const u = Math.random() * 2 - 1;
    const a = Math.random() * TAU;
    const s = Math.sqrt(1 - u * u);
    starPositions[i * 3 + 0] = Math.cos(a) * s * r;
    starPositions[i * 3 + 1] = u * r;
    starPositions[i * 3 + 2] = Math.sin(a) * s * r;
  }
  starGeometry.setAttribute("position", new THREE.BufferAttribute(starPositions, 3));
  scene.add(
    new THREE.Points(
      starGeometry,
      new THREE.PointsMaterial({ color: 0x93a4b8, size: 0.035 }),
    ),
  );

  return {
    canvas,
    inputCanvas,
    surfaceCanvas,
    gpuSurfaceActive,
    device: surfaceDevice ?? renderer?.backend?.device ?? null,
    renderer,
    scene,
    camera,
    orbitControls,
    globe,
  };
}

async function createDevice() {
  if (!globalThis.navigator?.gpu) {
    throw new Error("WebGPU is required for Field Lab's geodesic renderer.");
  }
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error("WebGPU unavailable: no adapter");
  const device = await adapter.requestDevice();
  device.addEventListener?.("uncapturederror", (event) => {
    globalThis.__FIELD_LAB_GPU_ERRORS__ ??= [];
    globalThis.__FIELD_LAB_GPU_ERRORS__.push({
      message: event.error?.message ?? String(event.error),
      stack: event.error?.stack ?? "",
      t: performance.now(),
    });
    if (globalThis.__FIELD_LAB_GPU_ERRORS__.length > 20) {
      globalThis.__FIELD_LAB_GPU_ERRORS__.shift();
    }
    console.warn("Uncaptured WebGPU error:", event.error);
  });
  return device;
}

async function createRenderer(canvas) {
  if (!globalThis.navigator?.gpu) {
    throw new Error("WebGPU is required for Field Lab's geodesic renderer.");
  }
  const renderer = new WebGPURenderer({ canvas, antialias: true });
  await renderer.init();
  renderer.fieldLabBackend = "webgpu";
  return renderer;
}

function createSurfaceCanvas(canvas) {
  const surface = document.createElement("canvas");
  surface.id = "viewportSurface";
  surface.className = "viewport-surface";
  canvas.parentElement?.insertBefore(surface, canvas);
  canvas.classList.add("viewport-overlay");
  return surface;
}

function createRaycastGlobeMaterial() {
  return new THREE.MeshBasicMaterial({
    color: 0x05070a,
    depthWrite: false,
  });
}
