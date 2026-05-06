import { DEFAULT_CELL_COUNT, createState, hashNoise, reallocateState } from "./kernel.mjs";
import { createGeodesicGrid } from "./geodesic-grid.mjs";
import { materializeRecipe } from "../visual/recipes.mjs";
import { compileV2 } from "../dsl/compile-v2.mjs";
import * as klausmeier from "../recipes/klausmeier.mjs";

// Klausmeier is the v2 stamp fixture: it has `stamp seed "Plant patch"` /
// `stamp clearcut` / `stamp irrigate`, all `spot FIELD at brush.pos`
// — enough surface to verify that materialized stamps mutate geodesic
// state when invoked.
const stampRecipe = materializeRecipe(klausmeier);

const tests = [];

test("hashNoise is deterministic and bounded", () => {
  const a = hashNoise(1234, 7);
  const b = hashNoise(1234, 7);
  const c = hashNoise(1234, 8);
  assert(a === b, "same index/seed should match");
  assert(a !== c, "different seed should differ");
  assert(a >= -1 && a <= 1, "noise should be in [-1, 1]");
});

test("state allocation creates fields", () => {
  const state = createState({
    fields: [
      { name: "moisture" },
      { name: "windU" },
      { name: "windV" },
    ],
  });
  assert(state.grid === null, "fresh state should not default to a rectangular grid");
  assert(state.fields.moisture.length === DEFAULT_CELL_COUNT, "field allocation should use default cell count without a grid");
  assert(state.fields.windU.length === DEFAULT_CELL_COUNT && state.fields.windV.length === DEFAULT_CELL_COUNT, "all declared fields should allocate");
});

test("state allocation follows an installed geodesic grid", () => {
  const topology = createGeodesicGrid({ frequency: 8 });
  const state = createState();
  state.grid = {
    kind: "geodesic",
    frequency: topology.frequency,
    cells: topology.cellCount,
    topology,
  };
  reallocateState(state, { fields: [{ name: "A" }] });
  assert(state.fields.A.length === topology.cellCount, "field allocation should follow geodesic cell count");
});

test("v2 stamps mutate geodesic fields", () => {
  // Pick a stamp the v2 klausmeier recipe ships with and confirm it
  // actually modifies the field it targets. The previous version of
  // this test exercised the v1 weather recipe's `stormSeed`; the
  // v2 path goes through the same materialized-stamp shape.
  const state = makeGeodesicStampState(16);
  const before = sum(state.fields.n);
  const stamp = stampRecipe.stamps.find((s) => s.id === "seed");
  assert(stamp, "stamp `seed` must exist on klausmeier");
  stamp.run(state, 128, 64, 10, { lon: 0, lat: 0, u: 0.5, v: 0.5, px: 1, py: 0, pz: 0 });
  const after = sum(state.fields.n);
  assert(Math.abs(after - before) > 1e-5, "`seed` stamp should change biomass field n on a geodesic grid");
});

test("source stamps can target exactly one geodesic cell", () => {
  const recipe = materializeRecipe({
    pipeline: compileV2(`
recipe "Source stamp"
substrate geodesic frequency 8
source mask: f32
field u: f32
stamps {
  stamp mark "Mark source cell" {
    spot mask at brush.pos, radius=0, amount=1
  }
  stamp erase "Erase source cell" {
    set mask at brush.pos, radius=0, value=0
  }
}
step { stage s { reads u, mask; writes u; cell { set u = u + mask } } }
`),
  });
  const state = makeGeodesicStampState(8, recipe);
  const hit = { lon: 0, lat: 0, u: 0.5, v: 0.5, px: 1, py: 0, pz: 0 };
  const mark = recipe.stamps.find((s) => s.id === "mark");
  const erase = recipe.stamps.find((s) => s.id === "erase");
  assert(mark && erase, "source stamps must materialize");
  assert(mark.gpuDelta === true, "additive spot stamps should advertise GPU-delta support");
  assert(erase.gpuDelta === false, "exact set stamps should stay on the conservative paint path");
  mark.run(state, 128, 64, 10, hit);
  assert(nonZeroCount(state.fields.mask) === 1, "radius=0 source stamp should affect exactly one cell");
  erase.run(state, 128, 64, 10, hit);
  assert(nonZeroCount(state.fields.mask) === 0, "set-at radius=0 source stamp should erase exactly that cell");
});

test("stamp phase blocks distinguish press from drag", () => {
  const recipe = materializeRecipe({
    pipeline: compileV2(`
recipe "Phased stamp"
substrate geodesic frequency 8
field u: f32
field v: f32
stamps {
  stamp ripple "Ripple" {
    on press {
      spot u at brush.pos, radius=0, amount=1
    }
    on drag {
      spot v at brush.pos, radius=0, amount=2
    }
  }
}
step { stage s { reads u, v; writes u; cell { set u = u + v } } }
`),
  });
  const hit = { lon: 0, lat: 0, u: 0.5, v: 0.5, px: 1, py: 0, pz: 0 };
  const stamp = recipe.stamps.find((s) => s.id === "ripple");
  assert(stamp, "phased stamp must materialize");
  assert(stamp.writes?.join(",") === "u,v", "stamp should expose its written fields");
  assert(stamp.gpuDelta === true, "all-spot phased stamps should advertise GPU-delta support");

  const dragState = makeGeodesicStampState(8, recipe);
  stamp.run(dragState, 128, 64, 0, hit, "drag");
  assert(nonZeroCount(dragState.fields.u) === 0, "drag phase must not run press-only u action");
  assert(nonZeroCount(dragState.fields.v) === 1, "drag phase should run v action");

  const pressState = makeGeodesicStampState(8, recipe);
  stamp.run(pressState, 128, 64, 0, hit, "press");
  assert(nonZeroCount(pressState.fields.u) === 1, "press phase should run u action");
  assert(nonZeroCount(pressState.fields.v) === 1, "press phase should also run drag action for immediate impulse");
});

function makeGeodesicStampState(frequency, recipe = stampRecipe) {
  const topology = createGeodesicGrid({ frequency });
  const state = createState();
  state.grid = {
    kind: "geodesic",
    frequency: topology.frequency,
    cells: topology.cellCount,
    topology,
    width: 256,
    height: 128,
  };
  reallocateState(state, { fields: recipe.fields });
  return state;
}

let failed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failed++;
    console.error(`not ok - ${name}`);
    console.error(error.stack ?? error.message);
  }
}

if (failed > 0) process.exit(1);

function test(name, fn) {
  tests.push({ name, fn });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sum(field) {
  let total = 0;
  for (const value of field) total += value;
  return total;
}

function nonZeroCount(field) {
  let count = 0;
  for (const value of field) {
    if (Math.abs(value) > 1e-9) count++;
  }
  return count;
}
