import * as THREE from "three";

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

  const globeMaterialSnapshot = muteGlobeMaterial(globe);

  let disposed = false;
  let lastRefreshKey = "";

  return {
    ok: true,
    reason: "ok",
    grid,
    mesh,
    glyphLayer,
    refresh({ fields, viewSpec, frame = 0, force = false } = {}) {
      if (disposed) return;
      const g = viewSpec?.glyph;
      const glyphKey = g ? `${g.kind}:${g.rotate ?? "_"}:${g.size ?? "_"}:${g.length}:${g.stride}` : "";
      const key = `${frame}:${viewSpec?.id ?? ""}:${glyphKey}`;
      if (!force && key === lastRefreshKey) return;
      lastRefreshKey = key;
      refreshColors({ grid, geometry, fields, viewSpec });
      glyphLayer.populate({ grid, tileGeometry: geometry, fields, viewSpec });
    },
    update() {},
    dispose() {
      disposed = true;
      restoreGlobeMaterial(globeMaterialSnapshot);
      scene.remove(mesh);
      glyphLayer.dispose();
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
  const color = typeof viewSpec?.color === "function" ? viewSpec.color : null;
  const writeColor = typeof color?.write === "function" ? color.write : null;
  const scratch = new Uint8ClampedArray(4);

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
  }
  colors.needsUpdate = true;
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
