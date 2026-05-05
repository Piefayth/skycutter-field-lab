import * as THREE from "three";
import {
  MeshBasicNodeMaterial,
  attribute,
  uv,
  wgslFn,
} from "three/addons/nodes/Nodes.js";

import { createGeodesicGrid } from "../kernel/geodesic-grid.mjs";

// Geodesic display mesh for recipe state. It renders one tile per state cell
// and keeps the hidden globe alive underneath for existing raycasts.
export async function createGeodesicPreview({ scene, globe, frequency = 48, grid: providedGrid = null } = {}) {
  const grid = providedGrid ?? createGeodesicGrid({ frequency });

  const geometry = createTileGeometry(grid, { radius: 1.006, inset: 0 });

  const material = new THREE.MeshBasicMaterial({
    vertexColors: true,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = "geodesic-state-preview";
  scene.add(mesh);

  // Optional `glyph` overlay — per-cell shapes (arrow / dot / ring /
  // square / plus) drawn on top of the colored sphere, with optional
  // rotation and scale driven by recipe fields.
  //
  // Architecture: one Mesh per glyph kind. Each is a BufferGeometry
  // sized for the max-density case; populateGlyph() fills only the
  // active kind's vertex buffer per refresh and toggles meshes via
  // visibility. Vertex counts vary per kind (arrow = 3, dot = 8 fan,
  // square = 6, ring = 16, plus = 12) so each kind gets its own
  // buffer rather than packing into one giant array.
  //
  // Lines aren't an option (WebGL clamps line widths to 1px on Chrome
  // and Safari) so even "ring" and "plus" are built from triangles.
  const glyphLayer = createGlyphLayer(scene, grid);
  const particleLayer = createParticleLayer(scene, grid);

  const globeMaterialSnapshot = muteGlobeMaterial(globe);

  let disposed = false;
  let lastColorKey = "";
  let lastGlyphKey = "";
  let lastParticleKey = "";

  return {
    ok: true,
    reason: "ok",
    grid,
    mesh,
    glyphLayer,
    particleLayer,
    refresh({ fields, viewSpec, frame = 0, fieldRevision = 0, force = false } = {}) {
      if (disposed) return;
      const g = viewSpec?.glyph;
      const p = viewSpec?.particles;
      const glyphKey = g ? `${g.kind}:${g.rotate ?? "_"}:${g.size ?? "_"}:${g.length}:${g.stride}` : "";
      const particleKey = p ? `${p.advect}:${p.count}:${p.length}:${p.speed}:${p.fade}:${p.size}:${p.color?.join(",")}` : "";
      const viewId = viewSpec?.id ?? "";
      const colorKey = `${viewId}:${fieldRevision}`;
      if (force || colorKey !== lastColorKey) {
        lastColorKey = colorKey;
        refreshColors({ grid, geometry, fields, viewSpec });
      }
      const nextGlyphKey = `${viewId}:${glyphKey}:${fieldRevision}`;
      if (force || nextGlyphKey !== lastGlyphKey) {
        lastGlyphKey = nextGlyphKey;
        glyphLayer.populate({ grid, tileGeometry: geometry, fields, viewSpec });
      }
      const nextParticleKey = `${viewId}:${particleKey}:${frame}`;
      if (force || nextParticleKey !== lastParticleKey) {
        lastParticleKey = nextParticleKey;
        particleLayer.populate({ fields, viewSpec, frame });
      }
    },
    update() {},
    dispose() {
      disposed = true;
      restoreGlobeMaterial(globeMaterialSnapshot);
      scene.remove(mesh);
      glyphLayer.dispose();
      particleLayer.dispose();
      geometry.dispose();
      material.dispose();
    },
  };
}

// =============================================================================
// Glyph overlay layer.
//
// Each cell can render an arbitrary font character — "→", "★", "●",
// "X", emoji, anything the system font can draw. The character is
// rasterized to a Canvas2D texture once per recipe load (cached by
// character, so repeated views of the same glyph share a texture)
// and rendered as a textured quad per cell via InstancedMesh.
//
// Per-cell matrix: scale × in-plane rotation × tangent-basis →
// position. Per-cell color: black on bright tiles, white on dark
// tiles, modulated by the texture's alpha mask.
// =============================================================================

const GLYPH_TEXTURE_SIZE = 128;
const GLYPH_FONT = `bold ${Math.floor(GLYPH_TEXTURE_SIZE * 0.78)}px "Helvetica Neue", "Arial", sans-serif`;
const GLYPH_OUTLINE_WIDTH = Math.floor(GLYPH_TEXTURE_SIZE * 0.10);  // ~13 px halo

// Rasterize a character to two CanvasTextures — fill (solid character)
// and outline (stroked-only character with a wider line). Rendering
// the outline behind the fill produces a "text with halo" effect
// that reads cleanly against any tile color: outline provides
// separation from the tile, fill provides the main visible character.
//
// Both textures are white-on-transparent so the per-instance color
// tints them via the fragment-shader multiply.
function rasterizeGlyphPair(char) {
  if (typeof document === "undefined") return null;
  return {
    fill: rasterizeOne(char, { mode: "fill" }),
    outline: rasterizeOne(char, { mode: "stroke" }),
  };
}

function rasterizeOne(char, { mode }) {
  const canvas = document.createElement("canvas");
  canvas.width = GLYPH_TEXTURE_SIZE;
  canvas.height = GLYPH_TEXTURE_SIZE;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, GLYPH_TEXTURE_SIZE, GLYPH_TEXTURE_SIZE);
  ctx.font = GLYPH_FONT;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  if (mode === "stroke") {
    ctx.lineWidth = GLYPH_OUTLINE_WIDTH;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.strokeStyle = "#ffffff";
    ctx.strokeText(char, GLYPH_TEXTURE_SIZE / 2, GLYPH_TEXTURE_SIZE / 2);
  } else {
    ctx.fillStyle = "#ffffff";
    ctx.fillText(char, GLYPH_TEXTURE_SIZE / 2, GLYPH_TEXTURE_SIZE / 2);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

function createGlyphLayer(scene, grid) {
  // Cache per character: { textures, outline, fill }. Each of
  // outline/fill is a regular Mesh with a BufferGeometry holding
  // cellCount × 4 quad vertices (positions + uvs + colors) and
  // cellCount × 6 indices. Per-vertex colors tint the texture via
  // MeshBasicMaterial({ map, vertexColors: true }) — works because
  // the geometry has a real `color` attribute, unlike the previous
  // PlaneGeometry+InstancedMesh approach where Three.js silently
  // bypassed both vertex- and instance-color paths.
  const cache = new Map();

  function buildMesh(texture, label, renderOrder) {
    const N = grid.cellCount;
    const positions = new Float32Array(N * 4 * 3);
    const colors = new Float32Array(N * 4 * 3);
    const uvs = new Float32Array(N * 4 * 2);
    const indices = new Uint32Array(N * 6);
    // UVs and indices are static. Each quad's 4 verts use
    // (0,0),(1,0),(1,1),(0,1); the 6 indices form two triangles.
    for (let i = 0; i < N; i++) {
      const v = i * 4;
      uvs[v * 2 + 0] = 0; uvs[v * 2 + 1] = 0;
      uvs[v * 2 + 2] = 1; uvs[v * 2 + 3] = 0;
      uvs[v * 2 + 4] = 1; uvs[v * 2 + 5] = 1;
      uvs[v * 2 + 6] = 0; uvs[v * 2 + 7] = 1;
      const idx = i * 6;
      indices[idx + 0] = v + 0; indices[idx + 1] = v + 1; indices[idx + 2] = v + 2;
      indices[idx + 3] = v + 0; indices[idx + 4] = v + 2; indices[idx + 5] = v + 3;
    }
    const geometry = new THREE.BufferGeometry();
    const positionAttr = new THREE.BufferAttribute(positions, 3);
    const colorAttr = new THREE.BufferAttribute(colors, 3);
    positionAttr.setUsage(THREE.DynamicDrawUsage);
    colorAttr.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("position", positionAttr);
    geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
    geometry.setAttribute("color", colorAttr);
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.setDrawRange(0, 0);
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      vertexColors: true,
      transparent: true,
      alphaTest: 0.05,
      side: THREE.DoubleSide,
      depthTest: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.visible = false;
    mesh.renderOrder = renderOrder;
    mesh.name = `geodesic-glyph-${label}`;
    scene.add(mesh);
    return { mesh, geometry, material, positions, colors };
  }

  function ensureMeshFor(char) {
    if (cache.has(char)) return cache.get(char);
    const textures = rasterizeGlyphPair(char);
    const outline = buildMesh(textures.outline, `${char}-outline`, 5);
    const fill = buildMesh(textures.fill, `${char}-fill`, 6);
    const slot = { char, textures, outline, fill };
    cache.set(char, slot);
    return slot;
  }

  return {
    populate(args) {
      const glyph = args.viewSpec?.glyph;
      for (const slot of cache.values()) {
        slot.outline.mesh.visible = false;
        slot.fill.mesh.visible = false;
      }
      if (!glyph) return;
      const slot = ensureMeshFor(glyph.char);
      populateGlyphMesh(slot, args);
    },
    dispose() {
      for (const slot of cache.values()) {
        for (const sub of [slot.outline, slot.fill]) {
          scene.remove(sub.mesh);
          sub.geometry.dispose();
          sub.material.dispose();
        }
        slot.textures?.fill?.dispose?.();
        slot.textures?.outline?.dispose?.();
      }
      cache.clear();
    },
  };
}

// Visual scale: a cell on a freq-N icosphere has typical neighbor
// distance ≈ 2π / (5.5 × N) sphere-radians. Use that as the
// base unit; `length=1` produces glyphs ~ one neighbor-spacing big.
// Default length=0.5 → half a cell.
function populateGlyphMesh(slot, { grid, tileGeometry, fields = {}, viewSpec }) {
  const glyph = viewSpec.glyph;
  const fillMesh = slot.fill.mesh;
  const outlineMesh = slot.outline.mesh;
  const fillPositions = slot.fill.positions;
  const fillColors = slot.fill.colors;
  const outlinePositions = slot.outline.positions;
  const outlineColors = slot.outline.colors;

  const tileColors = tileGeometry.getAttribute("color")?.array;
  const tileStarts = tileGeometry.userData.tileStarts;
  const sphereR = 1.020;
  const baseScale = (2 * Math.PI) / (5.5 * Math.max(1, grid.frequency ?? 32));
  const stride = Math.max(1, glyph.stride | 0);
  const length = glyph.length;

  // Optional source fields. rotate is vec2 (interleaved); size is
  // scalar. When unset, glyph has fixed orientation (faces +x =
  // east) and uniform size.
  const rotateField = glyph.rotate ? fields[glyph.rotate] : null;
  const sizeField   = glyph.size   ? fields[glyph.size]   : null;

  let activeCount = 0;
  for (let cell = 0; cell < grid.cellCount; cell += stride) {
    const cx = grid.positions[cell * 3 + 0];
    const cy = grid.positions[cell * 3 + 1];
    const cz = grid.positions[cell * 3 + 2];

    // East / north tangent basis at this cell.
    let ex = -cz, ey = 0, ez = cx;
    let elen = Math.hypot(ex, ey, ez);
    if (elen < 1e-6) { ex = 1; ey = 0; ez = 0; elen = 1; }
    ex /= elen; ey /= elen; ez /= elen;
    const nx = ey * cz - ez * cy;
    const ny = ez * cx - ex * cz;
    const nz = ex * cy - ey * cx;

    // Glyph orientation. atan2(field.y, field.x) gives the in-plane
    // rotation; cos/sin of that angle is just (vx/mag, vy/mag).
    let cosA = 1, sinA = 0;
    if (rotateField) {
      const vx = rotateField[cell * 2];
      const vy = rotateField[cell * 2 + 1];
      const mag = Math.hypot(vx, vy);
      if (!Number.isFinite(mag) || mag < 1e-6) continue;
      cosA = vx / mag;
      sinA = vy / mag;
    }

    let scale = length * baseScale;
    if (sizeField) {
      const s = sizeField[cell];
      if (!Number.isFinite(s) || Math.abs(s) < 1e-6) continue;
      scale *= Math.abs(s);
    }

    // Per-cell quad vertex layout (in the tangent plane, before
    // rotation): unit square centered at origin, corner 0 at
    // (-0.5, -0.5), wound CCW. UVs are static (set at construction);
    // positions are written here per-frame.
    //   c0 = (-0.5, -0.5)   c1 = (0.5, -0.5)
    //   c3 = (-0.5,  0.5)   c2 = (0.5,  0.5)
    //
    // Per corner: scale, in-plane rotate, lift to 3D via tangent
    // basis, translate to cell position × sphereR.
    const half = 0.5 * scale;
    const cxr = cx * sphereR, cyr = cy * sphereR, czr = cz * sphereR;
    const vBase = activeCount * 4 * 3;
    for (let corner = 0; corner < 4; corner++) {
      const cornerX = (corner === 1 || corner === 2) ? half : -half;
      const cornerY = (corner === 2 || corner === 3) ? half : -half;
      const rx = cornerX * cosA - cornerY * sinA;
      const ry = cornerX * sinA + cornerY * cosA;
      const wx = cxr + rx * ex + ry * nx;
      const wy = cyr + rx * ey + ry * ny;
      const wz = czr + rx * ez + ry * nz;
      const off = vBase + corner * 3;
      fillPositions[off + 0] = wx;
      fillPositions[off + 1] = wy;
      fillPositions[off + 2] = wz;
      outlinePositions[off + 0] = wx;
      outlinePositions[off + 1] = wy;
      outlinePositions[off + 2] = wz;
    }

    // Color scheme: outline + fill, picked so glyphs read clearly
    // against any tile color while picking up a chromatic
    // family-resemblance to the cell.
    //   Bright tile (luma > 0.55):
    //     fill    = tile × 0.15   (very dark version of the tile hue)
    //     outline = white         (provides separation around the dark fill)
    //   Dark tile (luma <= 0.55):
    //     fill    = tile × 0.5 + 0.5  (light version of tile hue)
    //     outline = black             (separation under the bright fill)
    let rT = 0, gT = 0, bT = 0;
    if (tileColors && tileStarts) {
      const v = tileStarts[cell] * 3;
      rT = tileColors[v]; gT = tileColors[v + 1]; bT = tileColors[v + 2];
    }
    const luma = 0.299 * rT + 0.587 * gT + 0.114 * bT;
    let fr, fg, fb, oc;
    if (luma > 0.55) {
      fr = rT * 0.15; fg = gT * 0.15; fb = bT * 0.15;
      oc = 0.97;
    } else {
      fr = rT * 0.5 + 0.5; fg = gT * 0.5 + 0.5; fb = bT * 0.5 + 0.5;
      oc = 0.03;
    }
    // Write the same color to all 4 verts of this cell's quad.
    for (let corner = 0; corner < 4; corner++) {
      const off = vBase + corner * 3;
      fillColors[off + 0] = fr;
      fillColors[off + 1] = fg;
      fillColors[off + 2] = fb;
      outlineColors[off + 0] = oc;
      outlineColors[off + 1] = oc;
      outlineColors[off + 2] = oc;
    }
    activeCount++;
  }
  for (const sub of [slot.fill, slot.outline]) {
    sub.geometry.attributes.position.needsUpdate = true;
    sub.geometry.attributes.color.needsUpdate = true;
    sub.geometry.setDrawRange(0, activeCount * 6);
    sub.mesh.visible = activeCount > 0;
  }
}

// =============================================================================
// Particle trail overlay layer.
//
// A `particles advect=wind ...` view clause renders sparse tracers that move
// through a vec2 tangent field. This is render-only: particles never write back
// into recipe state. Browser/GPU point-size caps make THREE.Points unreliable
// for readable tracers, so each trail sample is a small textured quad made from
// triangles.
// =============================================================================

const particleGlowColor = wgslFn(`
  fn particleGlowColor(localUv: vec2<f32>, tint: vec3<f32>) -> vec3<f32> {
    let p = localUv * 2.0 - vec2<f32>(1.0, 1.0);
    let r2 = dot(p, p);
    let core = exp(-r2 * 18.0);
    let halo = exp(-r2 * 3.2);
    return tint * (0.20 * halo + 1.10 * core);
  }
`);

const particleGlowAlpha = wgslFn(`
  fn particleGlowAlpha(localUv: vec2<f32>, strength: f32) -> f32 {
    let p = localUv * 2.0 - vec2<f32>(1.0, 1.0);
    let r2 = dot(p, p);
    let core = exp(-r2 * 18.0);
    let halo = exp(-r2 * 3.2);
    let rim = smoothstep(0.92, 0.25, sqrt(r2));
    return clamp(0.07 * halo + 0.78 * core, 0.0, 1.0) * rim * strength;
  }
`);

function createParticleLayer(scene, grid) {
  let geometry = null;
  let material = null;
  let mesh = null;
  let positions = null;
  let colors = null;
  let alphas = null;
  let cells = null;
  let history = null;
  let heads = null;
  let ages = null;
  let rng = seededRng(0x9e3779b9);
  let activeKey = "";
  let lastParticleFrame = -Infinity;
  const sampleScratch = { x: 0, y: 0 };
  const basisScratch = { ex: 1, ey: 0, ez: 0, nx: 0, ny: 1, nz: 0 };

  function ensure(spec) {
    const count = Math.max(1, Math.min(20000, spec.count | 0));
    const trailLength = Math.max(2, Math.min(128, spec.length | 0));
    const size = Number.isFinite(spec.size) ? Math.max(0.5, Math.min(32, spec.size)) : 4;
    const fade = Math.max(0, Math.min(1, Number.isFinite(spec.fade) ? spec.fade : 0.86));
    const key = `${count}:${trailLength}:${size}:${fade}:${spec.color.join(",")}`;
    if (key === activeKey && geometry) return { count, trailLength };
    disposeMesh();

    const pointCount = count * trailLength;
    positions = new Float32Array(pointCount * 4 * 3);
    colors = new Float32Array(pointCount * 4 * 3);
    alphas = new Float32Array(pointCount * 4);
    const uvs = new Float32Array(pointCount * 4 * 2);
    const indices = new Uint32Array(pointCount * 6);
    for (let i = 0; i < pointCount; i++) {
      const v = i * 4;
      uvs[v * 2 + 0] = 0; uvs[v * 2 + 1] = 0;
      uvs[v * 2 + 2] = 1; uvs[v * 2 + 3] = 0;
      uvs[v * 2 + 4] = 1; uvs[v * 2 + 5] = 1;
      uvs[v * 2 + 6] = 0; uvs[v * 2 + 7] = 1;
      const idx = i * 6;
      indices[idx + 0] = v + 0; indices[idx + 1] = v + 1; indices[idx + 2] = v + 2;
      indices[idx + 3] = v + 0; indices[idx + 4] = v + 2; indices[idx + 5] = v + 3;
    }
    cells = new Uint32Array(count);
    history = new Float32Array(count * trailLength * 3);
    heads = new Uint16Array(count);
    ages = new Uint16Array(count);

    geometry = new THREE.BufferGeometry();
    const positionAttr = new THREE.BufferAttribute(positions, 3);
    const colorAttr = new THREE.BufferAttribute(colors, 3);
    const alphaAttr = new THREE.BufferAttribute(alphas, 1);
    positionAttr.setUsage(THREE.DynamicDrawUsage);
    alphaAttr.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("position", positionAttr);
    geometry.setAttribute("color", colorAttr);
    geometry.setAttribute("particleAlpha", alphaAttr);
    geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.setDrawRange(0, pointCount * 6);

    material = new MeshBasicNodeMaterial();
    material.colorNode = particleGlowColor({ localUv: uv(), tint: attribute("color", "vec3") });
    material.opacityNode = particleGlowAlpha({ localUv: uv(), strength: attribute("particleAlpha", "float") });
    material.transparent = true;
    material.depthTest = true;
    material.depthWrite = false;
    material.side = THREE.DoubleSide;
    material.blending = THREE.AdditiveBlending;
    mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = 4;
    mesh.name = "geodesic-particles";
    scene.add(mesh);

    activeKey = key;
    lastParticleFrame = -Infinity;
    rng = seededRng(hashString(key));
    resetParticles({ count, trailLength });
    fillParticleStyle({ spec, count, trailLength });
    return { count, trailLength };
  }

  function resetParticles({ count, trailLength }) {
    for (let i = 0; i < count; i++) {
      respawnParticle(i, trailLength);
      ages[i] = 90 + Math.floor(rng() * 240);
    }
  }

  function respawnParticle(i, trailLength) {
    const cell = Math.floor(rng() * grid.cellCount) % grid.cellCount;
    cells[i] = cell;
    const px = grid.positions[cell * 3 + 0];
    const py = grid.positions[cell * 3 + 1];
    const pz = grid.positions[cell * 3 + 2];
    const base = i * trailLength * 3;
    heads[i] = 0;
    for (let t = 0; t < trailLength; t++) {
      const off = base + t * 3;
      history[off + 0] = px;
      history[off + 1] = py;
      history[off + 2] = pz;
    }
  }

  function disposeMesh() {
    if (mesh) scene.remove(mesh);
    geometry?.dispose?.();
    material?.dispose?.();
    geometry = null;
    material = null;
    mesh = null;
    positions = null;
    colors = null;
    alphas = null;
    cells = null;
    history = null;
    heads = null;
    ages = null;
    activeKey = "";
    lastParticleFrame = -Infinity;
  }

  return {
    populate({ fields = {}, viewSpec = null, frame = 0 } = {}) {
      const spec = viewSpec?.particles;
      if (!spec) {
        if (mesh) mesh.visible = false;
        return;
      }
      const vectorField = fields[spec.advect];
      if (!vectorField) {
        if (mesh) mesh.visible = false;
        return;
      }
      const layout = ensure(spec);
      mesh.visible = true;
      const pointCount = layout.count * layout.trailLength;
      const cadence = pointCount > 12000 ? 2 : 1;
      const frameNumber = Number.isFinite(frame) ? frame : 0;
      if (lastParticleFrame !== -Infinity && cadence > 1 && frameNumber % cadence !== 0) return;
      lastParticleFrame = frameNumber;
      stepParticles({ spec, vectorField, count: layout.count, trailLength: layout.trailLength });
      writeParticleGeometry({ spec, count: layout.count, trailLength: layout.trailLength });
    },
    dispose() {
      disposeMesh();
    },
  };

  function stepParticles({ spec, vectorField, count, trailLength }) {
    const baseScale = (2 * Math.PI) / (5.5 * Math.max(1, grid.frequency ?? 32));
    const stepScale = baseScale * spec.speed * 0.22;
    for (let i = 0; i < count; i++) {
      if (ages[i]-- === 0) {
        respawnParticle(i, trailLength);
        ages[i] = 90 + Math.floor(rng() * 240);
      }
      const cell = cells[i];
      const base = i * trailLength * 3;
      const head = heads[i];
      const src = base + head * 3;
      const px = history[src + 0];
      const py = history[src + 1];
      const pz = history[src + 2];
      sampleVectorField(sampleScratch, vectorField, cell, px, py, pz);
      let vx = sampleScratch.x;
      let vy = sampleScratch.y;
      let mag = Math.hypot(vx, vy);
      if (!Number.isFinite(mag) || mag < 1e-6) {
        if (rng() < 0.02) respawnParticle(i, trailLength);
        continue;
      }

      const speedNorm = Math.max(0, Math.min(1, mag / 6));
      const jitter = (rng() - 0.5) * (0.10 + 0.22 * speedNorm);
      const invMag = 1 / Math.max(1e-6, mag);
      const oldVx = vx;
      const oldVy = vy;
      vx = oldVx - oldVy * invMag * jitter;
      vy = oldVy + oldVx * invMag * jitter;
      mag = Math.hypot(vx, vy);
      const basis = setTangentBasis(basisScratch, px, py, pz);
      const move = Math.min(baseScale * 1.6, mag * stepScale);
      const nx = px + (basis.ex * vx + basis.nx * vy) * move;
      const ny = py + (basis.ey * vx + basis.ny * vy) * move;
      const nz = pz + (basis.ez * vx + basis.nz * vy) * move;
      const len = Math.hypot(nx, ny, nz) || 1;
      const nextX = nx / len;
      const nextY = ny / len;
      const nextZ = nz / len;
      const nextHead = head === 0 ? trailLength - 1 : head - 1;
      heads[i] = nextHead;
      const dst = base + nextHead * 3;
      history[dst + 0] = nextX;
      history[dst + 1] = nextY;
      history[dst + 2] = nextZ;
      cells[i] = nearestNeighborCell(cells[i], nextX, nextY, nextZ);
      const dropRate = 0.0015 + 0.0045 * speedNorm;
      if (rng() < dropRate) {
        respawnParticle(i, trailLength);
        ages[i] = 90 + Math.floor(rng() * 240);
      }
    }
  }

  function writeParticleGeometry({ spec, count, trailLength }) {
    const sphereR = 1.032;
    const sizeWorld = Math.max(0.004, Math.min(0.12, (Number.isFinite(spec.size) ? spec.size : 4) * 0.0027));
    let quad = 0;
    for (let i = 0; i < count; i++) {
      const base = i * trailLength * 3;
      const head = heads[i] ?? 0;
      for (let t = 0; t < trailLength; t++) {
        let slot = head + t;
        if (slot >= trailLength) slot -= trailLength;
        const src = base + slot * 3;
        const px = history[src + 0];
        const py = history[src + 1];
        const pz = history[src + 2];
        const basis = setTangentBasis(basisScratch, px, py, pz);
        const half = sizeWorld * (t === 0 ? 0.58 : 0.52);
        const cx = px * sphereR;
        const cy = py * sphereR;
        const cz = pz * sphereR;
        const vBase = quad * 4 * 3;
        for (let corner = 0; corner < 4; corner++) {
          const cornerX = (corner === 1 || corner === 2) ? half : -half;
          const cornerY = (corner === 2 || corner === 3) ? half : -half;
          const dst = vBase + corner * 3;
          positions[dst + 0] = cx + cornerX * basis.ex + cornerY * basis.nx;
          positions[dst + 1] = cy + cornerX * basis.ey + cornerY * basis.ny;
          positions[dst + 2] = cz + cornerX * basis.ez + cornerY * basis.nz;
        }
        quad++;
      }
    }
    geometry.attributes.position.needsUpdate = true;
  }

  function fillParticleStyle({ spec, count, trailLength }) {
    const cr = (spec.color[0] ?? 235) / 255;
    const cg = (spec.color[1] ?? 245) / 255;
    const cb = (spec.color[2] ?? 255) / 255;
    const fade = Math.max(0, Math.min(1, spec.fade));
    const trailFade = 0.50 + fade * 0.50;
    let quad = 0;
    for (let i = 0; i < count; i++) {
      let ageT = 1;
      for (let t = 0; t < trailLength; t++) {
        const brightness = t === 0 ? 1.06 : 0.94;
        const r = cr * brightness;
        const g = cg * brightness;
        const b = cb * brightness;
        const alpha = Math.max(0.04, Math.min(1, (t === 0 ? 0.78 : 0.64) * ageT * 0.84));
        const vBase = quad * 4 * 3;
        for (let corner = 0; corner < 4; corner++) {
          const dst = vBase + corner * 3;
          colors[dst + 0] = r;
          colors[dst + 1] = g;
          colors[dst + 2] = b;
          alphas[quad * 4 + corner] = alpha;
        }
        quad++;
        ageT *= trailFade;
      }
    }
    geometry.attributes.color.needsUpdate = true;
    geometry.attributes.particleAlpha.needsUpdate = true;
  }

  function sampleVectorField(out, vectorField, cell, px, py, pz) {
    let sx = 0;
    let sy = 0;
    let sw = 0;
    const addCell = (c) => {
      if (c < 0) return;
      const off = c * 3;
      const d = grid.positions[off + 0] * px + grid.positions[off + 1] * py + grid.positions[off + 2] * pz;
      const w = Math.max(0.0001, d - 0.992);
      sx += (vectorField[c * 2 + 0] ?? 0) * w;
      sy += (vectorField[c * 2 + 1] ?? 0) * w;
      sw += w;
    };
    addCell(cell);
    const count = grid.neighborCounts[cell] ?? 0;
    const start = cell * grid.maxNeighbors;
    for (let k = 0; k < count; k++) addCell(grid.neighbors[start + k]);
    if (sw > 0) {
      out.x = sx / sw;
      out.y = sy / sw;
    } else {
      out.x = 0;
      out.y = 0;
    }
    return out;
  }

  function nearestNeighborCell(cell, px, py, pz) {
    let best = cell;
    let bestDot = cellDot(cell, px, py, pz);
    const count = grid.neighborCounts[cell] ?? 0;
    const start = cell * grid.maxNeighbors;
    for (let k = 0; k < count; k++) {
      const n = grid.neighbors[start + k];
      if (n < 0) continue;
      const d = cellDot(n, px, py, pz);
      if (d > bestDot) {
        best = n;
        bestDot = d;
      }
    }
    return best;
  }

  function cellDot(cell, px, py, pz) {
    const off = cell * 3;
    return grid.positions[off + 0] * px
      + grid.positions[off + 1] * py
      + grid.positions[off + 2] * pz;
  }
}

function setTangentBasis(out, x, y, z) {
  let ex = -z, ey = 0, ez = x;
  let elen = Math.hypot(ex, ey, ez);
  if (elen < 1e-6) { ex = 1; ey = 0; ez = 0; elen = 1; }
  ex /= elen; ey /= elen; ez /= elen;
  out.ex = ex;
  out.ey = ey;
  out.ez = ez;
  out.nx = y * ez - z * ey;
  out.ny = z * ex - x * ez;
  out.nz = x * ey - y * ex;
  return out;
}

function seededRng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function hashString(value) {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function muteGlobeMaterial(globe) {
  if (!globe?.material) return null;
  const materials = Array.isArray(globe.material) ? globe.material : [globe.material];
  const snapshot = materials.map((material) => ({
    material,
    transparent: material.transparent,
    opacity: material.opacity,
    depthWrite: material.depthWrite,
  }));
  for (const material of materials) {
    material.transparent = true;
    material.opacity = 0;
    material.depthWrite = false;
    material.needsUpdate = true;
  }
  return snapshot;
}

function restoreGlobeMaterial(snapshot) {
  for (const item of snapshot ?? []) {
    item.material.transparent = item.transparent;
    item.material.opacity = item.opacity;
    item.material.depthWrite = item.depthWrite;
    item.material.needsUpdate = true;
  }
}

function refreshColors({ grid, geometry, fields = {}, viewSpec = null }) {
  const colors = geometry.getAttribute("color");
  const colorValues = colors.array;
  const tileStarts = geometry.userData.tileStarts;
  const tileColorCache = geometry.userData.tileColorCache;
  const color = typeof viewSpec?.color === "function" ? viewSpec.color : null;
  const writeColor = typeof color?.write === "function" ? color.write : null;
  const scratch = new Uint8ClampedArray(4);
  let changed = false;

  for (let cell = 0; cell < grid.cellCount; cell++) {
    let r = 0;
    let g = 0;
    let b = 0;
    if (writeColor) {
      writeColor(cell, fields, scratch, 0);
      r = scratch[0]; g = scratch[1]; b = scratch[2];
    } else if (color) {
      const c = color(cell, fields);
      r = c?.[0] ?? 0; g = c?.[1] ?? 0; b = c?.[2] ?? 0;
    }
    const packed = ((r & 255) << 16) | ((g & 255) << 8) | (b & 255);
    if (tileColorCache && tileColorCache[cell] === packed) continue;
    if (tileColorCache) tileColorCache[cell] = packed;
    const start = tileStarts?.[cell] ?? cell;
    const end = tileStarts?.[cell + 1] ?? start + 1;
    const rr = r / 255;
    const gg = g / 255;
    const bb = b / 255;
    for (let vertex = start; vertex < end; vertex++) {
      const out = vertex * 3;
      colorValues[out + 0] = rr;
      colorValues[out + 1] = gg;
      colorValues[out + 2] = bb;
    }
    changed = true;
  }
  if (changed) colors.needsUpdate = true;
}

function createTileGeometry(grid, { radius = 1, inset = 0 } = {}) {
  const adjacentCorners = buildAdjacentTriangleCenters(grid);
  const positions = [];
  const colors = [];
  const tileStarts = new Uint32Array(grid.cellCount + 1);

  for (let cell = 0; cell < grid.cellCount; cell++) {
    tileStarts[cell] = positions.length / 3;
    const center = positionAt(grid.positions, cell);
    const corners = sortCornersAroundCell(center, adjacentCorners[cell])
      .map((corner) => scaled(normalize(mix(corner, center, inset)), radius));
    const tileCenter = scaled(center, radius);
    for (let i = 0; i < corners.length; i++) {
      const a = corners[i];
      const b = corners[(i + 1) % corners.length];
      pushVec(positions, tileCenter);
      pushVec(positions, a);
      pushVec(positions, b);
      colors.push(0, 0, 0, 0, 0, 0, 0, 0, 0);
    }
  }
  tileStarts[grid.cellCount] = positions.length / 3;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(colors), 3));
  geometry.userData.tileStarts = tileStarts;
  geometry.userData.tileColorCache = new Uint32Array(grid.cellCount);
  geometry.userData.tileColorCache.fill(0xffffffff);
  geometry.computeVertexNormals();
  return geometry;
}

function buildAdjacentTriangleCenters(grid) {
  const adjacent = Array.from({ length: grid.cellCount }, () => []);
  for (let i = 0; i < grid.triangles.length; i += 3) {
    const a = grid.triangles[i];
    const b = grid.triangles[i + 1];
    const c = grid.triangles[i + 2];
    const center = normalize(add(add(positionAt(grid.positions, a), positionAt(grid.positions, b)), positionAt(grid.positions, c)));
    adjacent[a].push(center);
    adjacent[b].push(center);
    adjacent[c].push(center);
  }
  return adjacent;
}

function sortCornersAroundCell(center, corners) {
  const ref = Math.abs(center[1]) > 0.92 ? [1, 0, 0] : [0, 1, 0];
  const u = normalize(cross(ref, center));
  const v = normalize(cross(center, u));
  return [...corners].sort((lhs, rhs) => cornerAngle(lhs, center, u, v) - cornerAngle(rhs, center, u, v));
}

function cornerAngle(corner, center, u, v) {
  const tangent = normalize(sub(corner, scaled(center, dot(corner, center))));
  return Math.atan2(dot(tangent, v), dot(tangent, u));
}

function positionAt(positions, cell) {
  const offset = cell * 3;
  return [positions[offset], positions[offset + 1], positions[offset + 2]];
}

function pushVec(out, v) {
  out.push(v[0], v[1], v[2]);
}

function mix(a, b, t) {
  return [
    a[0] * (1 - t) + b[0] * t,
    a[1] * (1 - t) + b[1] * t,
    a[2] * (1 - t) + b[2] * t,
  ];
}

function add(a, b) {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function sub(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function scaled(v, scale) {
  return [v[0] * scale, v[1] * scale, v[2] * scale];
}

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function normalize(v) {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}
