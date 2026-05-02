// =============================================================================
// Geodesic grid topology.
//
// Cells are vertices of a subdivided icosahedron projected to the unit sphere.
// Most cells have six neighbors; the twelve original icosahedron vertices have
// five. The GPU runtime stores neighbors in fixed-width slots so kernels can
// avoid pointer chasing through variable-length lists.
// =============================================================================

const PHI = (1 + Math.sqrt(5)) * 0.5;
const MAX_NEIGHBORS = 6;

export function createGeodesicGrid({ frequency = 32 } = {}) {
  const f = Number(frequency);
  if (!Number.isInteger(f) || f < 1 || f > 512) {
    throw new Error(`geodesic frequency must be integer 1..512, got ${frequency}`);
  }

  const base = baseIcosahedron();
  const vertices = [];
  const vertexMap = new Map();
  const triangles = [];

  function intern(v) {
    const n = normalize(v);
    const key = `${Math.round(n[0] * 1e10)},${Math.round(n[1] * 1e10)},${Math.round(n[2] * 1e10)}`;
    const existing = vertexMap.get(key);
    if (existing !== undefined) return existing;
    const index = vertices.length / 3;
    vertices.push(n[0], n[1], n[2]);
    vertexMap.set(key, index);
    return index;
  }

  for (const [ia, ib, ic] of base.faces) {
    const a = getVec(base.vertices, ia);
    const b = getVec(base.vertices, ib);
    const c = getVec(base.vertices, ic);
    const grid = [];
    for (let i = 0; i <= f; i++) {
      grid[i] = [];
      for (let j = 0; j <= f - i; j++) {
        const k = f - i - j;
        grid[i][j] = intern([
          (a[0] * k + b[0] * i + c[0] * j) / f,
          (a[1] * k + b[1] * i + c[1] * j) / f,
          (a[2] * k + b[2] * i + c[2] * j) / f,
        ]);
      }
    }
    for (let i = 0; i < f; i++) {
      for (let j = 0; j < f - i; j++) {
        const v0 = grid[i][j];
        const v1 = grid[i + 1][j];
        const v2 = grid[i][j + 1];
        triangles.push(v0, v1, v2);
        if (j < f - i - 1) {
          const v3 = grid[i + 1][j + 1];
          triangles.push(v1, v3, v2);
        }
      }
    }
  }

  const cellCount = vertices.length / 3;
  const neighborSets = Array.from({ length: cellCount }, () => new Set());
  for (let i = 0; i < triangles.length; i += 3) {
    const a = triangles[i];
    const b = triangles[i + 1];
    const c = triangles[i + 2];
    neighborSets[a].add(b); neighborSets[a].add(c);
    neighborSets[b].add(a); neighborSets[b].add(c);
    neighborSets[c].add(a); neighborSets[c].add(b);
  }

  const neighbors = new Int32Array(cellCount * MAX_NEIGHBORS);
  const neighborCounts = new Uint32Array(cellCount);
  neighbors.fill(-1);
  for (let cell = 0; cell < cellCount; cell++) {
    const sorted = [...neighborSets[cell]].sort((lhs, rhs) => lhs - rhs);
    if (sorted.length > MAX_NEIGHBORS) {
      throw new Error(`geodesic cell ${cell} has ${sorted.length} neighbors`);
    }
    neighborCounts[cell] = sorted.length;
    for (let slot = 0; slot < sorted.length; slot++) {
      neighbors[cell * MAX_NEIGHBORS + slot] = sorted[slot];
    }
  }

  return {
    kind: "geodesic",
    frequency: f,
    maxNeighbors: MAX_NEIGHBORS,
    cellCount,
    triangleCount: triangles.length / 3,
    positions: new Float32Array(vertices),
    triangles: new Uint32Array(triangles),
    neighbors,
    neighborCounts,
  };
}

function baseIcosahedron() {
  const raw = [
    [-1, PHI, 0], [1, PHI, 0], [-1, -PHI, 0], [1, -PHI, 0],
    [0, -1, PHI], [0, 1, PHI], [0, -1, -PHI], [0, 1, -PHI],
    [PHI, 0, -1], [PHI, 0, 1], [-PHI, 0, -1], [-PHI, 0, 1],
  ];
  const vertices = new Float32Array(raw.flatMap((v) => normalize(v)));
  const faces = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];
  return { vertices, faces };
}

function normalize(v) {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}

function getVec(vertices, index) {
  const offset = index * 3;
  return [vertices[offset], vertices[offset + 1], vertices[offset + 2]];
}
