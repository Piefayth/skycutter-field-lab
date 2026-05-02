import { DEFAULT_CELL_COUNT, createState, hashNoise, reallocateState } from "./kernel.mjs";
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

test("weather stamps mutate geodesic fields", () => {
  const state = makeGeodesicWeatherState(16);
  const before = sum(state.fields.pressure);
  const stamp = weatherRecipe.stamps.find((s) => s.id === "stormSeed");
  stamp.run(state, 128, 64, 10, { lon: 0, lat: 0, u: 0.5, v: 0.5, px: 1, py: 0, pz: 0 });
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
    width: 256,
    height: 128,
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
