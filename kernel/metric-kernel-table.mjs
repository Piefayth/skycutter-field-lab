// Precomputed weighted metric kernel tables for geodesic grids.
//
// Author-facing semantics are great-circle distance on the unit sphere.
// The GPU-facing representation is a packed gather table:
//   offsets[cell]..offsets[cell+1] are entries for that cell,
//   indices[entry] is the sampled cell,
//   weights[entry] is the raw bell weight.

export const KERNEL_SIGMA_CUTOFF = 3;
export const MAX_KERNEL_RADIUS = 0.35;
export const MAX_KERNEL_ENTRIES_PER_CELL = 128;

export function resolveMetricKernelSpec(spec, params = {}) {
  if (!spec || spec.kind !== "kernel" || spec.kernel !== "bell") {
    throw new Error(`unsupported metric kernel spec: ${spec?.kind ?? "unknown"}`);
  }
  const center = resolveKernelArg(spec.center, params);
  const width = resolveKernelArg(spec.width, params);
  validateResolvedBellKernel({ center, width });
  return {
    kind: "kernel",
    kernel: "bell",
    center,
    width,
    cutoff: center + KERNEL_SIGMA_CUTOFF * width,
  };
}

export function metricKernelCacheKey(resolved) {
  return `bell:${resolved.center.toPrecision(8)}:${resolved.width.toPrecision(8)}`;
}

export function buildMetricKernelTable(grid, resolved) {
  if (!grid?.positions || !grid?.cellCount) {
    throw new Error("buildMetricKernelTable: geodesic grid with positions is required");
  }
  validateResolvedBellKernel(resolved);

  const cellCount = grid.cellCount;
  const cutoff = resolved.cutoff;
  const chordCutoff = 2 * Math.sin(cutoff * 0.5);
  const bins = buildSpatialBins(grid.positions, cellCount, chordCutoff);
  const offsets = new Uint32Array(cellCount + 1);
  const indices = [];
  const weights = [];

  for (let cell = 0; cell < cellCount; cell++) {
    const candidates = candidateCellsFor(cell, grid.positions, bins);
    let entriesForCell = 0;
    const px = grid.positions[cell * 3];
    const py = grid.positions[cell * 3 + 1];
    const pz = grid.positions[cell * 3 + 2];
    const local = [];
    for (const other of candidates) {
      const qx = grid.positions[other * 3];
      const qy = grid.positions[other * 3 + 1];
      const qz = grid.positions[other * 3 + 2];
      const chord2 = squaredDistance(px, py, pz, qx, qy, qz);
      if (chord2 > chordCutoff * chordCutoff + 1e-10) continue;
      const dot = clamp(px * qx + py * qy + pz * qz, -1, 1);
      const distance = Math.acos(dot);
      if (distance > cutoff + 1e-10) continue;
      const offset = (distance - resolved.center) / resolved.width;
      const weight = Math.exp(-0.5 * offset * offset);
      if (weight <= 0) continue;
      local.push({ other, weight });
    }
    local.sort((a, b) => a.other - b.other);
    entriesForCell = local.length;
    if (entriesForCell > MAX_KERNEL_ENTRIES_PER_CELL) {
      throw new Error(
        `kernel bell(${resolved.center}, ${resolved.width}) covers ${entriesForCell} cells at cell ${cell}; ` +
        `limit is ${MAX_KERNEL_ENTRIES_PER_CELL}. Reduce center/width or grid frequency.`,
      );
    }
    for (const entry of local) {
      indices.push(entry.other);
      weights.push(entry.weight);
    }
    offsets[cell + 1] = indices.length;
  }

  return {
    offsets,
    indices: new Uint32Array(indices),
    weights: new Float32Array(weights),
  };
}

function resolveKernelArg(arg, params) {
  if (!arg) return NaN;
  if (arg.kind === "literal") return Number(arg.value);
  if (arg.kind === "param") return Number(params[arg.name] ?? arg.default ?? NaN);
  return NaN;
}

function validateResolvedBellKernel({ center, width }) {
  if (!Number.isFinite(center) || center < 0) {
    throw new Error(`kernel bell center must be >= 0, got ${center}`);
  }
  if (!Number.isFinite(width) || width <= 0) {
    throw new Error(`kernel bell width must be > 0, got ${width}`);
  }
  const cutoff = center + KERNEL_SIGMA_CUTOFF * width;
  if (cutoff > MAX_KERNEL_RADIUS) {
    throw new Error(
      `kernel bell(${center}, ${width}) cutoff ${cutoff.toFixed(4)} exceeds max ${MAX_KERNEL_RADIUS}`,
    );
  }
}

function buildSpatialBins(positions, cellCount, cellSize) {
  const bins = new Map();
  const inv = 1 / Math.max(cellSize, 1e-6);
  for (let cell = 0; cell < cellCount; cell++) {
    const ix = Math.floor((positions[cell * 3] + 1) * inv);
    const iy = Math.floor((positions[cell * 3 + 1] + 1) * inv);
    const iz = Math.floor((positions[cell * 3 + 2] + 1) * inv);
    const key = binKey(ix, iy, iz);
    let list = bins.get(key);
    if (!list) {
      list = [];
      bins.set(key, list);
    }
    list.push(cell);
  }
  return { bins, inv };
}

function candidateCellsFor(cell, positions, index) {
  const ix = Math.floor((positions[cell * 3] + 1) * index.inv);
  const iy = Math.floor((positions[cell * 3 + 1] + 1) * index.inv);
  const iz = Math.floor((positions[cell * 3 + 2] + 1) * index.inv);
  const out = [];
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dz = -1; dz <= 1; dz++) {
        const list = index.bins.get(binKey(ix + dx, iy + dy, iz + dz));
        if (list) out.push(...list);
      }
    }
  }
  return out;
}

function squaredDistance(ax, ay, az, bx, by, bz) {
  const dx = ax - bx;
  const dy = ay - by;
  const dz = az - bz;
  return dx * dx + dy * dy + dz * dz;
}

function binKey(x, y, z) {
  return `${x},${y},${z}`;
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}
