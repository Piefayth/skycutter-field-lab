import { compileDsl } from "./compiler.mjs";
import {
  buildWebGpuGeodesicUniforms,
  compileWebGpuGeodesicCellStage,
  compileWebGpuGeodesicEachStage,
  compileWebGpuGeodesicEventStage,
  compileWebGpuGeodesicPipeline,
} from "./webgpu-geodesic-compiler.mjs";
import { pipelineDsl as weatherDsl } from "../recipes/weather.mjs";

test("compiles a DSL cell stage to WGSL storage-buffer passes", () => {
  const recipe = compileDsl(`
recipe "Tiny"
use sim cell
use clock dt, frame
use geo px, py, pz
field A, B
param gain slider min 0 max 2 step 0.1 default 1
param enabled boolean default true
const bias 0.25
planet gravity 9.81

stage push "Push" {
  reads A, B
  writes A
  cell {
    when enabled {
      let boost = gain + bias + gravity * 0
      add A = (B - A) * boost * dt
    }
  }
}
`);
  const stage = recipe.dsl.stages[0];
  const passes = compileWebGpuGeodesicCellStage(stage, recipe.dsl);
  assert(passes.length === 1, `expected one pass, got ${passes.length}`);
  assert(passes[0].field === "A", `expected A pass, got ${passes[0].field}`);
  assert(passes[0].source.includes("@compute @workgroup_size(128)"), "WGSL compute entry missing");
  assert(passes[0].source.includes("var<storage, read> f_A"), "read binding A missing");
  assert(passes[0].source.includes("var<storage, read_write> outputField"), "output binding missing");
  assert(passes[0].source.includes("params.p_enabled != 0.0"), "boolean param was not lowered");
});

test("builds packed f32 uniforms from params, consts, and planet values", () => {
  const recipe = compileDsl(`
recipe "Tiny"
use sim cell
use clock dt, frame
field A
param gain slider min 0 max 2 step 0.1 default 1
const bias 0.25
planet gravity 9.81

stage push "Push" {
  reads A
  writes A
  cell {
    add A = gain + bias + gravity + dt + frame
  }
}
`);
  const stage = recipe.dsl.stages[0];
  const [pass] = compileWebGpuGeodesicCellStage(stage, recipe.dsl);
  const uniforms = buildWebGpuGeodesicUniforms(pass.layout, {
    dt: 0.5,
    frame: 7,
    cellCount: 42,
    params: { gain: 1.5 },
    consts: { bias: 0.75 },
    planet: { gravity: 3.25 },
  });
  assert(uniforms.length === 7, `unexpected uniform length ${uniforms.length}`);
  assert(uniforms[0] === 0.5, "dt not packed");
  assert(uniforms[1] === 7, "frame not packed");
  assert(uniforms[2] === 42, "cellCount not packed");
  assert(uniforms[4] === 1.5, "param not packed");
  assert(uniforms[5] === 0.75, "const not packed");
  assert(uniforms[6] === 3.25, "planet not packed");
});

test("nullish coalescing keeps the fallback in generated WGSL", () => {
  const recipe = compileDsl(`
recipe "Fallback"
use sim cell
use clock dt, frame
field A
param gain slider min 0 max 2 step 0.1 default 1

stage push "Push" {
  reads A
  writes A
  cell {
    let gain = gain ?? 0.75
    add A = gain * dt
  }
}
`);
  const [pass] = compileWebGpuGeodesicCellStage(recipe.dsl.stages[0], recipe.dsl);
  assert(pass.source.includes("select(0.75, params.p_gain, params.p_gain == params.p_gain)"), "fallback was dropped");
});

test("noise lowers to spatial geodesic noise", () => {
  const recipe = compileDsl(`
recipe "Noise"
use sim cell
use clock dt, frame
use geo px, py, pz
use core noise
field A

stage push "Push" {
  reads A
  writes A
  cell {
    add A = noise(7) * dt
  }
}
`);
  const [pass] = compileWebGpuGeodesicCellStage(recipe.dsl.stages[0], recipe.dsl);
  assert(pass.source.includes("fn spatialNoise"), "spatial noise helper missing");
  assert(pass.source.includes("spatialNoise(vec3<f32>(px, py, pz), 7.0)"), "noise call did not use position");
});

test("compiles a local event stage to per-field WGSL passes", () => {
  const recipe = compileDsl(`
recipe "Event"
use sim event
use clock dt, frame
field A, B, R
param threshold slider min 0 max 2 step 0.1 default 1
param amount slider min 0 max 2 step 0.1 default 0.5

stage discharge "Discharge" {
  reads A, B, R
  writes A, B, R
  event when A > threshold and R < 0.05 {
    add B = amount
    set A = 0
    set R = 1
  }
}
`);
  const passes = compileWebGpuGeodesicEventStage(recipe.dsl.stages[0], recipe.dsl);
  assert(passes.length === 3, `expected three passes, got ${passes.length}`);
  assert(passes.some((pass) => pass.field === "B" && pass.source.includes("outValue = outValue + params.p_amount")), "B add action missing");
  assert(passes.some((pass) => pass.field === "A" && pass.source.includes("outValue = 0.0")), "A set action missing");
  assert(passes.some((pass) => pass.field === "R" && pass.source.includes("outValue = 1.0")), "R set action missing");
  assert(passes.filter((pass) => pass.eventCounter).length === 1, "expected one event counter pass");
  assert(passes.some((pass) => pass.source.includes("atomicAdd(&eventCounter.value, 1u);")), "event counter increment missing");
});

test("compiles geodesic neighborMax in each stages", () => {
  const recipe = compileDsl(`
recipe "Neighbor"
use sim each
use geo x, y, i, lon, lat, u, v, px, py, pz, N, PI, TAU
use core neighborMax
field W, R, spreadMask
param threshold slider min 0 max 1 step 0.01 default 0.5

stage mark "Mark" {
  reads W, R
  writes spreadMask
  each {
    when W < threshold and R <= 0.1 and neighborMax(W) > 0.5 {
      set spreadMask = 1
    }
  }
}
`);
  const passes = compileWebGpuGeodesicEachStage(recipe.dsl.stages[0], recipe.dsl);
  const pass = passes.find((item) => item.field === "spreadMask");
  assert(pass, "spreadMask pass missing");
  assert(pass.needsNeighbors === true, "neighborMax pass did not request neighbor buffers");
  assert(pass.source.includes("var<storage, read> neighbors"), "neighbor storage binding missing");
  assert(pass.source.includes("fn neighborMax_W"), "neighborMax helper missing");
  assert(pass.source.includes("let v_W = f_W[cell];"), "read variable should avoid W constant collision");
});

test("weather cell stages compile to WebGPU geodesic WGSL", () => {
  const recipe = compileDsl(weatherDsl);
  const cellStages = recipe.dsl.stages.filter((stage) => stage.body.statements[0]?.type === "cell");
  assert(cellStages.length >= 3, `expected weather cell stages, got ${cellStages.length}`);
  for (const stage of cellStages) {
    const passes = compileWebGpuGeodesicCellStage(stage, recipe.dsl);
    assert(passes.length > 0, `${stage.id} did not emit passes`);
    for (const pass of passes) {
      assert(pass.source.includes("outputField[cell] = outValue;"), `${stage.id}:${pass.field} missing writeback`);
    }
  }
});

test("compiles a full DSL pipeline into stage passes and event counters", () => {
  const recipe = compileDsl(weatherDsl);
  const compiled = compileWebGpuGeodesicPipeline(recipe.dsl);
  assert(compiled.stages.length === recipe.dsl.stages.length, "stage count mismatch");
  assert(compiled.stages.every((stage) => Array.isArray(stage.passes)), "stage passes missing");
  assert(Array.isArray(compiled.eventCounters), "event counters missing");
});

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
