import { createGeodesicGrid } from "./geodesic-grid.mjs";

test("frequency 1 is an icosahedron graph", () => {
  const grid = createGeodesicGrid({ frequency: 1 });
  assert(grid.cellCount === 12, `expected 12 cells, got ${grid.cellCount}`);
  assert(grid.triangleCount === 20, `expected 20 triangles, got ${grid.triangleCount}`);
  for (let i = 0; i < grid.neighborCounts.length; i++) {
    assert(grid.neighborCounts[i] === 5, `base vertex ${i} should have 5 neighbors`);
  }
});

test("subdivision graph has only five and six neighbor cells", () => {
  const grid = createGeodesicGrid({ frequency: 8 });
  assert(grid.cellCount === 10 * 8 * 8 + 2, `unexpected cell count ${grid.cellCount}`);
  assert(grid.triangleCount === 20 * 8 * 8, `unexpected triangle count ${grid.triangleCount}`);
  let pentagons = 0;
  let hexagons = 0;
  for (const count of grid.neighborCounts) {
    if (count === 5) pentagons++;
    else if (count === 6) hexagons++;
    else throw new Error(`unexpected neighbor count ${count}`);
  }
  assert(pentagons === 12, `expected 12 pentagons, got ${pentagons}`);
  assert(hexagons === grid.cellCount - 12, "all non-pentagon cells should have six neighbors");
});

test("neighbors are symmetric", () => {
  const grid = createGeodesicGrid({ frequency: 5 });
  for (let cell = 0; cell < grid.cellCount; cell++) {
    for (let slot = 0; slot < grid.neighborCounts[cell]; slot++) {
      const other = grid.neighbors[cell * grid.maxNeighbors + slot];
      assert(hasNeighbor(grid, other, cell), `${cell} -> ${other} is not symmetric`);
    }
  }
});

test("production frequency has stable welded neighbors", () => {
  const grid = createGeodesicGrid({ frequency: 64 });
  assert(grid.cellCount === 10 * 64 * 64 + 2, `unexpected cell count ${grid.cellCount}`);
  let pentagons = 0;
  let hexagons = 0;
  for (let cell = 0; cell < grid.cellCount; cell++) {
    const count = grid.neighborCounts[cell];
    if (count === 5) pentagons++;
    else if (count === 6) hexagons++;
    else throw new Error(`cell ${cell} has ${count} neighbors`);
    for (let slot = 0; slot < count; slot++) {
      const other = grid.neighbors[cell * grid.maxNeighbors + slot];
      assert(hasNeighbor(grid, other, cell), `${cell} -> ${other} is not symmetric`);
    }
  }
  assert(pentagons === 12, `expected 12 pentagons, got ${pentagons}`);
  assert(hexagons === grid.cellCount - 12, "all non-pentagon cells should have six neighbors");
});

function hasNeighbor(grid, cell, target) {
  for (let slot = 0; slot < grid.neighborCounts[cell]; slot++) {
    if (grid.neighbors[cell * grid.maxNeighbors + slot] === target) return true;
  }
  return false;
}

function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
