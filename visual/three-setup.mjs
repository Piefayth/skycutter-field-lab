import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

import { H, TAU, W } from "../kernel/kernel.mjs";

export async function createThreeSetup() {
  const canvas = document.querySelector("#viewport");
  const renderer = await createRenderer(canvas);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setClearColor(0x090b0f, 1);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
  camera.position.set(0, 0.15, 3.0);

  const orbitControls = new OrbitControls(camera, canvas);
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

  const textureCanvas = document.createElement("canvas");
  textureCanvas.width = W;
  textureCanvas.height = H;
  const texCtx = textureCanvas.getContext("2d", { willReadFrequently: true });
  const imageData = texCtx.createImageData(W, H);
  const fieldTexture = new THREE.CanvasTexture(textureCanvas);
  fieldTexture.colorSpace = THREE.SRGBColorSpace;
  fieldTexture.wrapS = THREE.RepeatWrapping;
  fieldTexture.wrapT = THREE.ClampToEdgeWrapping;
  // The globe shader samples this canvas with equal-area latitude
  // projection. Keep mipmaps for minification; magnification stays nearest
  // so cells read as a grid instead of a smeared image.
  fieldTexture.minFilter = THREE.LinearMipmapLinearFilter;
  fieldTexture.magFilter = THREE.NearestFilter;
  fieldTexture.generateMipmaps = true;
  fieldTexture.anisotropy = renderer.capabilities?.getMaxAnisotropy?.() ?? 1;

  const globe = new THREE.Mesh(
    new THREE.SphereGeometry(1, 160, 80),
    createWebGpuGlobeMaterial(fieldTexture),
  );
  scene.add(globe);

  const arrowMaterial = new THREE.LineBasicMaterial({
    color: 0xd9f99d,
    transparent: true,
    opacity: 0.8,
    depthWrite: false,
  });
  const arrowGeometry = new THREE.BufferGeometry();
  arrowGeometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(0), 3));
  const arrows = new THREE.LineSegments(arrowGeometry, arrowMaterial);

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
    renderer,
    scene,
    camera,
    orbitControls,
    textureCanvas,
    texCtx,
    imageData,
    fieldTexture,
    globe,
    arrows,
    arrowGeometry,
  };
}

async function createRenderer(canvas) {
  if (!globalThis.navigator?.gpu) {
    throw new Error("WebGPU is required for Field Lab's geodesic renderer.");
  }
  const { default: WebGPURenderer } = await import("https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/renderers/webgpu/WebGPURenderer.js");
  const renderer = new WebGPURenderer({ canvas, antialias: true });
  await renderer.init();
  renderer.fieldLabBackend = "webgpu";
  return renderer;
}

function createWebGpuGlobeMaterial(fieldTexture) {
  return new THREE.MeshStandardMaterial({
    map: fieldTexture,
    roughness: 0.86,
    metalness: 0,
  });
}
