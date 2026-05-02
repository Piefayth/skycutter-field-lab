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
  const globeMaterialSnapshot = muteGlobeMaterial(globe);

  let disposed = false;
  let lastRefreshKey = "";

  return {
    ok: true,
    reason: "ok",
    grid,
    mesh,
    refresh({ fields, viewSpec, frame = 0, force = false } = {}) {
      if (disposed) return;
      const key = `${frame}:${viewSpec?.id ?? ""}`;
      if (!force && key === lastRefreshKey) return;
      lastRefreshKey = key;
      refreshColors({ grid, geometry, fields, viewSpec });
    },
    update() {},
    dispose() {
      disposed = true;
      restoreGlobeMaterial(globeMaterialSnapshot);
      scene.remove(mesh);
      geometry.dispose();
      material.dispose();
    },
  };
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
