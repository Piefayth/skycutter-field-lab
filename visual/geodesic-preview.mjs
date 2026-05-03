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

  // Optional `arrows` overlay — rendered as solid triangle glyphs
  // (NOT lines: WebGL line widths are clamped to 1 px on Chrome and
  // Safari, so a true LineSegments mesh is essentially invisible).
  // Each arrow is a single isoceles triangle: a wide base at the
  // cell center, a tip in the direction of the vec2 field. Three
  // vertices per arrow, nine floats per cell. Pre-allocated for the
  // max-density case (one arrow per cell); setDrawRange() crops to
  // the stride-decimated count.
  const arrowsBuffer = new Float32Array(grid.cellCount * 9);
  // Per-vertex colors: each arrow is shaded by the luminance of the
  // tile underneath it. Bright tile → black arrow, dark tile → white
  // arrow. Per-vertex (rather than per-arrow) so a future shading
  // change (e.g. gradient from base to tip) drops in cleanly.
  const arrowsColorsBuffer = new Float32Array(grid.cellCount * 9);
  const arrowsGeometry = new THREE.BufferGeometry();
  arrowsGeometry.setAttribute("position", new THREE.BufferAttribute(arrowsBuffer, 3));
  arrowsGeometry.setAttribute("color", new THREE.BufferAttribute(arrowsColorsBuffer, 3));
  arrowsGeometry.setDrawRange(0, 0);
  const arrowsMaterial = new THREE.MeshBasicMaterial({
    vertexColors: true,
    side: THREE.DoubleSide,
    transparent: false,
    depthTest: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const arrowsMesh = new THREE.Mesh(arrowsGeometry, arrowsMaterial);
  arrowsMesh.name = "geodesic-arrow-overlay";
  arrowsMesh.visible = false;
  arrowsMesh.renderOrder = 5;
  scene.add(arrowsMesh);

  const globeMaterialSnapshot = muteGlobeMaterial(globe);

  let disposed = false;
  let lastRefreshKey = "";

  return {
    ok: true,
    reason: "ok",
    grid,
    mesh,
    arrowsMesh,
    refresh({ fields, viewSpec, frame = 0, force = false } = {}) {
      if (disposed) return;
      const arrowsKey = viewSpec?.arrows ? `${viewSpec.arrows.field}:${viewSpec.arrows.length}:${viewSpec.arrows.stride}` : "";
      const key = `${frame}:${viewSpec?.id ?? ""}:${arrowsKey}`;
      if (!force && key === lastRefreshKey) return;
      lastRefreshKey = key;
      refreshColors({ grid, geometry, fields, viewSpec });
      populateArrows({ grid, geometry, fields, viewSpec, arrowsBuffer, arrowsColorsBuffer, arrowsGeometry, arrowsMesh });
    },
    update() {},
    dispose() {
      disposed = true;
      restoreGlobeMaterial(globeMaterialSnapshot);
      scene.remove(mesh);
      scene.remove(arrowsMesh);
      geometry.dispose();
      material.dispose();
      arrowsGeometry.dispose();
      arrowsMaterial.dispose();
    },
  };
}

// Per-refresh: project the active view's vec2 field onto each cell's
// east/north tangent basis and write triangle vertices into the
// arrows mesh. Each arrow is an isoceles triangle: base at the cell
// center, tip in the field's direction. Hides the mesh entirely when
// the view has no arrows clause or the field isn't allocated yet.
//
// Layout per arrow: 9 floats (3 verts × xyz). DrawRange caps the
// vertex count so subsampling via `stride` is just a count
// reduction, not a buffer realloc.
//
// Visual scale: a cell on a freq-N icosphere has typical neighbor
// distance ≈ 2π / (5.5 × N) sphere-radians. Use that as the
// base unit; `length=1` should produce arrows ~ one neighbor-spacing
// long. Default length=0.5 → half a cell. Width is 30% of length
// — makes the triangle pointy enough that direction reads clearly,
// not so thin it disappears at small sizes.
function populateArrows({ grid, geometry, fields = {}, viewSpec, arrowsBuffer, arrowsColorsBuffer, arrowsGeometry, arrowsMesh }) {
  const arrows = viewSpec?.arrows;
  if (!arrows) {
    arrowsMesh.visible = false;
    return;
  }
  const fieldVal = fields[arrows.field];
  if (!fieldVal || fieldVal.length < grid.cellCount * 2) {
    arrowsMesh.visible = false;
    return;
  }
  // Tile-mesh color buffer (just written by refreshColors). Sampled
  // per cell to compute the contrasting arrow color — bright tile →
  // black arrow, dark tile → white arrow.
  const tileColors = geometry.getAttribute("color")?.array;
  const tileStarts = geometry.userData.tileStarts;
  // Sphere-radius offset so arrows sit just above the tile mesh
  // (tiles at 1.006 + polygonOffset). Bumping arrows to 1.020 keeps
  // them visually atop the tiles even at extreme camera angles.
  const r = 1.020;
  const baseScale = (2 * Math.PI) / (5.5 * Math.max(1, grid.frequency ?? 32));
  const length = baseScale * arrows.length;
  const halfWidth = length * 0.18;
  const stride = Math.max(1, arrows.stride | 0);
  let writeIdx = 0;
  let arrowCount = 0;
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

    const vx = fieldVal[cell * 2];
    const vy = fieldVal[cell * 2 + 1];
    if (!Number.isFinite(vx) || !Number.isFinite(vy)) continue;
    const mag = Math.hypot(vx, vy);
    if (mag < 1e-6) continue;
    // Normalize the field direction so arrow length is set by
    // the `length=N` knob, not by the underlying field's magnitude.
    // (Magnitude could feed visual scaling later, but uniform
    // length keeps the direction lattice readable.)
    const ux = vx / mag, uy = vy / mag;
    const dx = ux * ex + uy * nx;
    const dy = ux * ey + uy * ny;
    const dz = ux * ez + uy * nz;
    // Perpendicular in tangent plane: rotate (ux, uy) by 90°.
    const px = -uy * ex + ux * nx;
    const py = -uy * ey + ux * ny;
    const pz = -uy * ez + ux * nz;

    const cxr = cx * r, cyr = cy * r, czr = cz * r;
    // base-left, base-right, tip
    const blx = cxr - px * halfWidth, bly = cyr - py * halfWidth, blz = czr - pz * halfWidth;
    const brx = cxr + px * halfWidth, bry = cyr + py * halfWidth, brz = czr + pz * halfWidth;
    const tipx = cxr + dx * length, tipy = cyr + dy * length, tipz = czr + dz * length;

    arrowsBuffer[writeIdx++] = blx;
    arrowsBuffer[writeIdx++] = bly;
    arrowsBuffer[writeIdx++] = blz;
    arrowsBuffer[writeIdx++] = brx;
    arrowsBuffer[writeIdx++] = bry;
    arrowsBuffer[writeIdx++] = brz;
    arrowsBuffer[writeIdx++] = tipx;
    arrowsBuffer[writeIdx++] = tipy;
    arrowsBuffer[writeIdx++] = tipz;

    // Pick contrasting color from the tile's luminance. tileColors is
    // 0..1 per channel; tileStarts[cell] gives the first vertex of
    // that cell's fan. Rec.601 luma weights — gives ~white on cold
    // blue (matches lab convention) and ~black on warm yellow.
    // (Variable names suffixed `T` to avoid shadowing the outer
    // `r` that's already in scope as the sphere-radius offset —
    // shadowing puts the outer `r` in TDZ for this whole block,
    // and earlier expressions like `cx * r` would crash.)
    let rT = 0, gT = 0, bT = 0;
    if (tileColors && tileStarts) {
      const v = tileStarts[cell] * 3;
      rT = tileColors[v]; gT = tileColors[v + 1]; bT = tileColors[v + 2];
    }
    const luma = 0.299 * rT + 0.587 * gT + 0.114 * bT;
    const c = luma > 0.55 ? 0 : 1;
    const colorIdx = arrowCount * 9;
    arrowsColorsBuffer[colorIdx + 0] = c;
    arrowsColorsBuffer[colorIdx + 1] = c;
    arrowsColorsBuffer[colorIdx + 2] = c;
    arrowsColorsBuffer[colorIdx + 3] = c;
    arrowsColorsBuffer[colorIdx + 4] = c;
    arrowsColorsBuffer[colorIdx + 5] = c;
    arrowsColorsBuffer[colorIdx + 6] = c;
    arrowsColorsBuffer[colorIdx + 7] = c;
    arrowsColorsBuffer[colorIdx + 8] = c;
    arrowCount++;
  }
  arrowsGeometry.attributes.position.needsUpdate = true;
  arrowsGeometry.attributes.color.needsUpdate = true;
  arrowsGeometry.setDrawRange(0, arrowCount * 3);
  arrowsMesh.visible = arrowCount > 0;
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
