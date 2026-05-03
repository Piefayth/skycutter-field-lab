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

// Rasterize a character to a CanvasTexture. White-on-transparent so
// the per-instance color tints it via fragment-shader multiply. Big
// enough that mip-mapped renderings look clean at typical zoom; the
// alphaTest discards the transparent surround.
function rasterizeGlyph(char) {
  if (typeof document === "undefined") return null;        // not in a browser
  const canvas = document.createElement("canvas");
  canvas.width = GLYPH_TEXTURE_SIZE;
  canvas.height = GLYPH_TEXTURE_SIZE;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, GLYPH_TEXTURE_SIZE, GLYPH_TEXTURE_SIZE);
  // Pick a font size that fills most of the canvas without clipping
  // wide characters. Bold weight makes thin characters readable at
  // small render scales.
  ctx.font = `bold ${Math.floor(GLYPH_TEXTURE_SIZE * 0.78)}px "Helvetica Neue", "Arial", sans-serif`;
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(char, GLYPH_TEXTURE_SIZE / 2, GLYPH_TEXTURE_SIZE / 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

function createGlyphLayer(scene, grid) {
  const cache = new Map();             // char → { texture, mesh, material, geometry }
  let activeChar = null;

  // Build a fresh InstancedMesh + texture for `char` and cache it.
  // Reused across refreshes; only the per-instance matrices and
  // colors change per tick.
  function ensureMeshFor(char) {
    if (cache.has(char)) return cache.get(char);
    const texture = rasterizeGlyph(char);
    const geometry = new THREE.PlaneGeometry(1, 1);
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
    const mesh = new THREE.InstancedMesh(geometry, material, grid.cellCount);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(grid.cellCount * 3), 3);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.visible = false;
    mesh.renderOrder = 5;
    mesh.name = `geodesic-glyph-${char}`;
    scene.add(mesh);
    const slot = { texture, geometry, material, mesh };
    cache.set(char, slot);
    return slot;
  }

  return {
    populate(args) {
      const glyph = args.viewSpec?.glyph;
      // Hide every cached mesh; we only show one at a time.
      for (const slot of cache.values()) slot.mesh.visible = false;
      activeChar = null;
      if (!glyph) return;
      const slot = ensureMeshFor(glyph.char);
      activeChar = glyph.char;
      populateGlyphMesh(slot, args);
    },
    dispose() {
      for (const { mesh, geometry, material, texture } of cache.values()) {
        scene.remove(mesh);
        geometry.dispose();
        material.dispose();
        texture?.dispose?.();
      }
      cache.clear();
    },
  };
}

// Visual scale: a cell on a freq-N icosphere has typical neighbor
// distance ≈ 2π / (5.5 × N) sphere-radians. Use that as the
// base unit; `length=1` produces glyphs ~ one neighbor-spacing big.
// Default length=0.5 → half a cell.
// Per-instance matrix scratch. Reused across cells/calls to avoid
// allocating fresh Matrix4s in the hot loop.
const _glyphMatrix = new THREE.Matrix4();
const _glyphColor = new THREE.Color();

function populateGlyphMesh(slot, { grid, tileGeometry, fields = {}, viewSpec }) {
  const glyph = viewSpec.glyph;
  const mesh = slot.mesh;

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

    // Build the per-instance transform. The PlaneGeometry is unit
    // sized in the local x/y plane; we want to map local x → "rotated
    // east", local y → "rotated north", local z → outward normal,
    // then translate to the cell position lifted to sphereR.
    //
    // Combined rotation+basis: the columns of the 3x3 rotation block
    // are the world-space basis vectors of local-x, local-y, local-z
    // respectively. We compute those directly:
    //   localX_world = (cosA*east + sinA*north) * scale
    //   localY_world = (-sinA*east + cosA*north) * scale
    //   localZ_world = center  (outward normal — quad faces outward)
    const lx_x = (cosA * ex + sinA * nx) * scale;
    const lx_y = (cosA * ey + sinA * ny) * scale;
    const lx_z = (cosA * ez + sinA * nz) * scale;
    const ly_x = (-sinA * ex + cosA * nx) * scale;
    const ly_y = (-sinA * ey + cosA * ny) * scale;
    const ly_z = (-sinA * ez + cosA * nz) * scale;
    const lz_x = cx;
    const lz_y = cy;
    const lz_z = cz;
    const px = cx * sphereR;
    const py = cy * sphereR;
    const pz = cz * sphereR;
    const m = _glyphMatrix.elements;
    m[0] = lx_x; m[4] = ly_x; m[8]  = lz_x; m[12] = px;
    m[1] = lx_y; m[5] = ly_y; m[9]  = lz_y; m[13] = py;
    m[2] = lx_z; m[6] = ly_z; m[10] = lz_z; m[14] = pz;
    m[3] = 0;    m[7] = 0;    m[11] = 0;    m[15] = 1;
    mesh.setMatrixAt(activeCount, _glyphMatrix);

    // Per-cell color: black on bright tiles, white on dark. Texture
    // alpha gates the visible pixels; this just tints them.
    let rT = 0, gT = 0, bT = 0;
    if (tileColors && tileStarts) {
      const v = tileStarts[cell] * 3;
      rT = tileColors[v]; gT = tileColors[v + 1]; bT = tileColors[v + 2];
    }
    const luma = 0.299 * rT + 0.587 * gT + 0.114 * bT;
    const c = luma > 0.55 ? 0.05 : 0.97;
    _glyphColor.setRGB(c, c, c);
    mesh.setColorAt(activeCount, _glyphColor);

    activeCount++;
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.count = activeCount;
  mesh.visible = activeCount > 0;
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
