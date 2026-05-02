import { H, N, W, createState, hashNoise, reallocateState, setGridResolution } from "./kernel.mjs";
import { createGeodesicGrid } from "./geodesic-grid.mjs";
import { materializeRecipe } from "../visual/recipes.mjs";
import * as weather from "../recipes/weather.mjs";

const weatherRecipe = materializeRecipe(weather);

const tests = [];

test("hashNoise is deterministic and bounded", () => {
  const a = hashNoise(1234, 7);
  const b = hashNoise(1234, 7);
  const c = hashNoise(1234, 8);
  assert(a === b, "same index/seed should match");
  assert(a !== c, "different seed should differ");
  assert(a >= -1 && a <= 1, "noise should be in [-1, 1]");
});

test("state allocation creates fields and tmp buffers", () => {
  const state = createState({
    fields: [
      { name: "moisture" },
      { name: "windU" },
      { name: "windV" },
    ],
  });
  assert(state.fields.moisture.length === N, "field allocation should use current grid size");
  assert(state.tmp.moisture.length === N, "tmp allocation should mirror field size");
  assert(state.fields.windU.length === N && state.fields.windV.length === N, "all declared fields should allocate");
});

test("grid resolution can be changed before allocation", () => {
  try {
    setGridResolution(64, 32);
    const state = createState({ fields: [{ name: "A" }] });
    assert(W === 64 && H === 32 && N === 2048, "grid constants should update");
    assert(state.fields.A.length === 2048, "field allocation should follow grid resolution");
  } finally {
    setGridResolution(256, 128);
  }
});

test("weather stamps mutate geodesic fields", () => {
  const state = makeGeodesicWeatherState(16);
  const before = sum(state.fields.pressure);
  const stamp = weatherRecipe.stamps.find((s) => s.id === "stormSeed");
  stamp.run(state, W / 2, H / 2, 10, { lon: 0, lat: 0, u: 0.5, v: 0.5, px: 1, py: 0, pz: 0 });
  const after = sum(state.fields.pressure);
  assert(Math.abs(after - before) > 1e-5, "stormSeed should change pressure on a geodesic grid");
});

function makeGeodesicWeatherState(frequency) {
  const topology = createGeodesicGrid({ frequency });
  const state = createState();
  state.grid = {
    kind: "geodesic",
    frequency: topology.frequency,
    cells: topology.cellCount,
    topology,
    width: W,
    height: H,
  };
  reallocateState(state, { fields: weatherRecipe.fields });
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
