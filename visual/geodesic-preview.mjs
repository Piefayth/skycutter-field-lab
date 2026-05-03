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
// Each glyph kind is a 2D shape — a list of triangles in the unit
// tangent plane (x = east, y = north). Per cell, we transform the
// shape: scale by the glyph's `length` × optional size-field, rotate
// by the glyph's optional vec2 rotate-field angle, then map the 2D
// plane to 3D via the cell's east/north basis and translate to the
// cell position lifted slightly off the sphere.
//
// One Mesh per kind. populate() fills the active kind's buffer and
// hides the others. Vertex counts vary by kind so they need
// separate buffers; pre-allocated for cellCount-many glyphs each.
// =============================================================================

// 2D triangle list per glyph kind, in tangent-plane coords. Conventions:
//   - x = east, y = north
//   - shapes oriented "forward" along +y (so an arrow rotated by
//     angle=0 points north)
//   - base size 1 unit; populate() multiplies by glyph.length × baseScale
const GLYPH_GEOMETRIES = {
  // Isoceles triangle, base in -y, tip in +y. 1 triangle = 3 verts.
  arrow: [
    [-0.18, 0.0], [0.18, 0.0], [0.0, 1.0],
  ],
  // Square, side 1, centered at origin. 2 triangles = 6 verts.
  square: [
    [-0.5, -0.5], [0.5, -0.5], [0.5, 0.5],
    [-0.5, -0.5], [0.5, 0.5], [-0.5, 0.5],
  ],
  // 8-sided regular polygon (octagon), approximating a disc. Triangle
  // fan from origin, 8 wedges = 24 verts.
  dot: (() => {
    const verts = [];
    const N = 8;
    const r = 0.5;
    for (let i = 0; i < N; i++) {
      const a0 = (i / N) * Math.PI * 2;
      const a1 = ((i + 1) / N) * Math.PI * 2;
      verts.push([0, 0]);
      verts.push([Math.cos(a0) * r, Math.sin(a0) * r]);
      verts.push([Math.cos(a1) * r, Math.sin(a1) * r]);
    }
    return verts;
  })(),
  // Hollow circle / annulus, 8 segments. Outer radius 0.5, inner 0.32.
  // Each segment is 2 triangles = 6 verts. 8 × 6 = 48 verts.
  ring: (() => {
    const verts = [];
    const N = 8;
    const ro = 0.5, ri = 0.32;
    for (let i = 0; i < N; i++) {
      const a0 = (i / N) * Math.PI * 2;
      const a1 = ((i + 1) / N) * Math.PI * 2;
      const o0 = [Math.cos(a0) * ro, Math.sin(a0) * ro];
      const o1 = [Math.cos(a1) * ro, Math.sin(a1) * ro];
      const i0 = [Math.cos(a0) * ri, Math.sin(a0) * ri];
      const i1 = [Math.cos(a1) * ri, Math.sin(a1) * ri];
      verts.push(o0, o1, i1);
      verts.push(o0, i1, i0);
    }
    return verts;
  })(),
  // Plus sign — two thin rectangles overlapping at origin. 4 triangles = 12 verts.
  plus: (() => {
    const w = 0.14;
    const r = 0.5;
    const verts = [];
    // Vertical bar
    verts.push([-w, -r], [w, -r], [w, r]);
    verts.push([-w, -r], [w, r], [-w, r]);
    // Horizontal bar
    verts.push([-r, -w], [r, -w], [r, w]);
    verts.push([-r, -w], [r, w], [-r, w]);
    return verts;
  })(),
};

function createGlyphLayer(scene, grid) {
  const meshes = {};
  for (const [kind, points] of Object.entries(GLYPH_GEOMETRIES)) {
    const vertCount = points.length;
    const positions = new Float32Array(grid.cellCount * vertCount * 3);
    const colors = new Float32Array(grid.cellCount * vertCount * 3);
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geom.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geom.setDrawRange(0, 0);
    const mat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
      depthTest: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.name = `geodesic-glyph-${kind}`;
    mesh.visible = false;
    mesh.renderOrder = 5;
    scene.add(mesh);
    meshes[kind] = { mesh, geom, mat, points, vertCount };
  }
  return {
    populate(args) { populateGlyph(meshes, args); },
    dispose() {
      for (const { mesh, geom, mat } of Object.values(meshes)) {
        scene.remove(mesh);
        geom.dispose();
        mat.dispose();
      }
    },
  };
}

// Visual scale: a cell on a freq-N icosphere has typical neighbor
// distance ≈ 2π / (5.5 × N) sphere-radians. Use that as the
// base unit; `length=1` produces glyphs ~ one neighbor-spacing big.
// Default length=0.5 → half a cell.
function populateGlyph(meshes, { grid, tileGeometry, fields = {}, viewSpec }) {
  const glyph = viewSpec?.glyph;
  // Hide every kind first; show only the active one (if any).
  for (const { mesh } of Object.values(meshes)) mesh.visible = false;
  if (!glyph) return;
  const slot = meshes[glyph.kind];
  if (!slot) return;     // unknown kind (validator should catch upstream)

  const tileColors = tileGeometry.getAttribute("color")?.array;
  const tileStarts = tileGeometry.userData.tileStarts;
  const sphereR = 1.020;
  const baseScale = (2 * Math.PI) / (5.5 * Math.max(1, grid.frequency ?? 32));
  const stride = Math.max(1, glyph.stride | 0);
  const length = glyph.length;

  // Optional source fields for rotation (vec2) and size (scalar).
  // Both are by name; absence means the glyph has uniform rotation
  // (0 = pointing north) and uniform size.
  const rotateField = glyph.rotate ? fields[glyph.rotate] : null;
  const sizeField = glyph.size ? fields[glyph.size] : null;

  const positions = slot.geom.getAttribute("position").array;
  const colors = slot.geom.getAttribute("color").array;
  const points = slot.points;
  const vertCount = slot.vertCount;
  const stridePerCell = vertCount * 3;

  let writeIdx = 0;
  let activeCount = 0;
  for (let cell = 0; cell < grid.cellCount; cell += stride) {
    const cx = grid.positions[cell * 3 + 0];
    const cy = grid.positions[cell * 3 + 1];
    const cz = grid.positions[cell * 3 + 2];

    // East / north tangent basis. Same construction as
    // dsl-init-runtime's tangentBasis() — east = horizontal-only
    // tangent, north = center × east.
    let ex = -cz, ey = 0, ez = cx;
    let elen = Math.hypot(ex, ey, ez);
    if (elen < 1e-6) { ex = 1; ey = 0; ez = 0; elen = 1; }
    ex /= elen; ey /= elen; ez /= elen;
    const nx = ey * cz - ez * cy;
    const ny = ez * cx - ex * cz;
    const nz = ex * cy - ey * cx;

    // Glyph orientation. If a vec2 field is supplied for rotation,
    // its (x, y) components are interpreted as east/north components
    // and the angle = atan2(y, x). Otherwise glyph faces north (0).
    let cosA = 1, sinA = 0;
    if (rotateField) {
      const vx = rotateField[cell * 2];
      const vy = rotateField[cell * 2 + 1];
      const mag = Math.hypot(vx, vy);
      if (!Number.isFinite(mag) || mag < 1e-6) continue;
      cosA = vx / mag;
      sinA = vy / mag;
    }

    // Glyph size. `length` × baseScale × optional size-field
    // magnitude. size-field of 0 skips the glyph entirely.
    let scale = length * baseScale;
    if (sizeField) {
      const s = sizeField[cell];
      if (!Number.isFinite(s) || Math.abs(s) < 1e-6) continue;
      scale *= Math.abs(s);
    }

    // Tile-tinted gradient coloring (same comet-tail trick as before
    // but generalised: the "tip" is the maximum-y vertex of the local
    // 2D shape, the "base" is everything else).
    let rT = 0, gT = 0, bT = 0;
    if (tileColors && tileStarts) {
      const v = tileStarts[cell] * 3;
      rT = tileColors[v]; gT = tileColors[v + 1]; bT = tileColors[v + 2];
    }
    const luma = 0.299 * rT + 0.587 * gT + 0.114 * bT;
    const tipC = luma > 0.55 ? 0.04 : 0.96;
    const baseR = rT * 0.35 + tipC * 0.30;
    const baseG = gT * 0.35 + tipC * 0.30;
    const baseB = bT * 0.35 + tipC * 0.30;

    // Find the shape's maximum-y point so we can color it as the
    // gradient endpoint (only matters for arrow; for symmetric shapes
    // the gradient just becomes a slight tint shift).
    let maxY = -Infinity;
    for (const p of points) if (p[1] > maxY) maxY = p[1];

    const cxr = cx * sphereR, cyr = cy * sphereR, czr = cz * sphereR;
    for (let i = 0; i < vertCount; i++) {
      const px2 = points[i][0];
      const py2 = points[i][1];
      // 1) scale, 2) rotate by glyph angle in tangent plane, 3) lift
      //    via east/north basis to 3D, 4) translate to cell.
      const sx = px2 * scale;
      const sy = py2 * scale;
      const rx = sx * cosA - sy * sinA;
      const ry = sx * sinA + sy * cosA;
      const wx = cxr + rx * ex + ry * nx;
      const wy = cyr + rx * ey + ry * ny;
      const wz = czr + rx * ez + ry * nz;
      positions[writeIdx + i * 3 + 0] = wx;
      positions[writeIdx + i * 3 + 1] = wy;
      positions[writeIdx + i * 3 + 2] = wz;
      // Color: linear blend from base (at y=0 or below) to tip (at maxY).
      const t = maxY > 0 ? Math.max(0, Math.min(1, py2 / maxY)) : 0;
      const cR = baseR + (tipC - baseR) * t;
      const cG = baseG + (tipC - baseG) * t;
      const cB = baseB + (tipC - baseB) * t;
      colors[writeIdx + i * 3 + 0] = cR;
      colors[writeIdx + i * 3 + 1] = cG;
      colors[writeIdx + i * 3 + 2] = cB;
    }
    writeIdx += stridePerCell;
    activeCount++;
  }
  slot.geom.attributes.position.needsUpdate = true;
  slot.geom.attributes.color.needsUpdate = true;
  slot.geom.setDrawRange(0, activeCount * vertCount);
  slot.mesh.visible = activeCount > 0;
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
