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

test("cellNoise lowers to spatial geodesic noise", () => {
  const recipe = compileDsl(`
recipe "Noise"
use sim cell
use clock dt, frame
use geo px, py, pz
use core cellNoise
field A

stage push "Push" {
  reads A
  writes A
  cell {
    add A = cellNoise(7) * dt
  }
}
`);
  const [pass] = compileWebGpuGeodesicCellStage(recipe.dsl.stages[0], recipe.dsl);
  assert(pass.source.includes("fn spatialNoise"), "spatial noise helper missing");
  assert(pass.source.includes("spatialNoise(vec3<f32>(px, py, pz), 7.0)"), "cellNoise call did not use position");
});

test("cellNoise(seed, scale) emits scaled sphere coords", () => {
  const recipe = compileDsl(`
recipe "Scaled noise"
use sim cell
use clock dt
use geo px, py, pz
use core cellNoise
field A

stage push "Push" {
  reads A
  writes A
  cell {
    add A = cellNoise(11, 2.5) * dt
  }
}
`);
  const [pass] = compileWebGpuGeodesicCellStage(recipe.dsl.stages[0], recipe.dsl);
  assert(pass.source.includes("spatialNoise((vec3<f32>(px, py, pz) * (2.5"), "scale arg not multiplied into coords");
});

test("neighbor sum lifts to a per-cell loop", () => {
  const recipe = compileDsl(`
recipe "Sum"
use sim cell
use clock dt
use geo px, py, pz
use core neighbor
field A

stage sum "Sum" {
  reads A
  writes A
  cell {
    let lap = neighbor sum n in A { n - A }
    add A = lap * dt
  }
}
`);
  const [pass] = compileWebGpuGeodesicCellStage(recipe.dsl.stages[0], recipe.dsl);
  assert(pass.needsNeighbors === true, "stage should bind neighbor arrays");
  assert(pass.source.includes("var nr_0: f32 = 0.0;"), "sum accumulator initialized to 0");
  assert(pass.source.includes("for (var nr_0_slot: u32 = 0u"), "loop emitted");
  assert(pass.source.includes("let nr_0_n: u32 = u32(neighbors[cell * 6u + nr_0_slot]);"), "neighbor index resolved once per slot");
  assert(pass.source.includes("let n: f32 = f_A[nr_0_n];"), "binding read from neighbor index");
  assert(pass.source.includes("nr_0 = nr_0 + ((n - v_A))"), "sum body accumulated");
});

test("neighbor mean divides by neighbor count", () => {
  const recipe = compileDsl(`
recipe "Mean"
use sim cell
use clock dt
use geo px, py, pz
use core neighbor
field A

stage avg "Avg" {
  reads A
  writes A
  cell {
    let lap = neighbor mean n in A { n }
    add A = (lap - A) * dt
  }
}
`);
  const [pass] = compileWebGpuGeodesicCellStage(recipe.dsl.stages[0], recipe.dsl);
  assert(pass.source.includes("var nr_0_sum: f32 = 0.0;"), "mean uses a sum accumulator");
  assert(pass.source.includes("nr_0 = select(0.0, nr_0_sum / f32(nr_0_count)"), "mean divides by count");
});

test("neighbor max uses -infinity sentinel", () => {
  const recipe = compileDsl(`
recipe "Max"
use sim cell
use clock dt
use geo px, py, pz
use core neighbor
field A

stage hi "Hi" {
  reads A
  writes A
  cell {
    let m = neighbor max n in A { n }
    set A = m
  }
}
`);
  const [pass] = compileWebGpuGeodesicCellStage(recipe.dsl.stages[0], recipe.dsl);
  assert(pass.source.includes("var nr_0: f32 = -1.0e38;"), "max seeded with -infinity");
  assert(pass.source.includes("nr_0 = max(nr_0, (n))"), "max body uses WGSL max");
});

test("validator rejects nested neighbor reductions", () => {
  let threw = null;
  try {
    compileDsl(`
recipe "Nested"
use sim cell
use clock dt
use geo px, py, pz
use core neighbor
field A

stage bad "Bad" {
  reads A
  writes A
  cell {
    add A = neighbor sum n in A { neighbor sum m in A { m } } * dt
  }
}
`);
  } catch (error) {
    threw = error.message;
  }
  assert(threw && threw.includes("nested neighbor reductions"), `expected nested-rejection, got: ${threw}`);
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

test("compiles neighbor reduction inside each stage", () => {
  const recipe = compileDsl(`
recipe "Neighbor"
use sim each
use geo x, y, i, lon, lat, u, v, px, py, pz, N, PI, TAU
use core neighbor
field W, R, spreadMask
param threshold slider min 0 max 1 step 0.01 default 0.5

stage mark "Mark" {
  reads W, R
  writes spreadMask
  each {
    when W < threshold and R <= 0.1 and neighbor max n in W { n } > 0.5 {
      set spreadMask = 1
    }
  }
}
`);
  const passes = compileWebGpuGeodesicEachStage(recipe.dsl.stages[0], recipe.dsl);
  const pass = passes.find((item) => item.field === "spreadMask");
  assert(pass, "spreadMask pass missing");
  assert(pass.needsNeighbors === true, "stage did not request neighbor buffers");
  assert(pass.source.includes("var<storage, read> neighbors"), "neighbor storage binding missing");
  assert(pass.source.includes("var nr_0: f32 = -1.0e38;"), "max accumulator initialized to -infinity");
  assert(pass.source.includes("let nr_0_n: u32 = u32(neighbors[cell * 6u + nr_0_slot]);"), "neighbor index resolved once per slot");
  assert(pass.source.includes("let n: f32 = f_W[nr_0_n];"), "binding read from neighbor index");
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

test("history field declaration carries history count", () => {
  const recipe = compileDsl(`
recipe "Hist"
use sim cell
use clock dt, frame, prev
use geo px, py, pz
field u history 1

stage step "Step" {
  reads u
  writes u
  cell {
    add u = (u - prev(u)) * dt
  }
}
`);
  const decl = recipe.dsl.fields.find((d) => d.name === "u");
  assert(decl?.history === 1, "u should carry history=1 on its declaration");
});

test("validator rejects prev() on a non-history field", () => {
  let threw = null;
  try {
    compileDsl(`
recipe "NoHist"
use sim cell
use clock dt, frame, prev
field u

stage step "Step" {
  reads u
  writes u
  cell {
    add u = prev(u) * dt
  }
}
`);
  } catch (error) { threw = error.message; }
  assert(threw && threw.includes("history"), `expected history-required error; got: ${threw}`);
});

test("validator rejects prev() of an expression", () => {
  let threw = null;
  try {
    compileDsl(`
recipe "PrevExpr"
use sim cell
use clock dt, frame, prev
field u history 1

stage step "Step" {
  reads u
  writes u
  cell {
    add u = prev(u + 1) * dt
  }
}
`);
  } catch (error) { threw = error.message; }
  assert(threw && threw.includes("bare field identifier"), `expected bare-id error; got: ${threw}`);
});

test("history field declaration with multi-name field rejects", () => {
  let threw = null;
  try {
    compileDsl(`
recipe "BadList"
use sim cell
field a, b history 1
`);
  } catch (error) { threw = error.message; }
  assert(threw && threw.includes("single-name"), `expected single-name error; got: ${threw}`);
});

test("history is rejected on `source` declarations", () => {
  let threw = null;
  try {
    compileDsl(`
recipe "BadSrc"
use sim cell
source w history 1
`);
  } catch (error) { threw = error.message; }
  assert(threw && threw.includes("history is only valid on"), `expected source-rejection error; got: ${threw}`);
});

test("parser rejects history > 1", () => {
  let threw = null;
  try {
    compileDsl(`
recipe "Hist"
use sim cell
use clock dt, frame, prev
use geo px, py, pz
field u history 2

stage step "Step" {
  reads u
  writes u
  cell {
    add u = (u - prev(u)) * dt
  }
}
`);
  } catch (error) {
    threw = error.message;
  }
  assert(
    threw && threw.includes("not yet supported"),
    `expected history>1 rejection; got: ${threw}`,
  );
});

test("validator rejects history field with no writer", () => {
  let threw = null;
  try {
    compileDsl(`
recipe "Hist"
use sim cell
use clock dt, frame, prev
use geo px, py, pz
field u history 1

stage observe "Observe" {
  reads u
  writes u
  cell {
    set u = u
  }
}
`);
  } catch (error) {
    threw = error.message;
  }
  // Sanity: this one DOES have a writer, should NOT throw.
  assert(threw === null, `expected no error for present writer; got: ${threw}`);

  // Now the actual no-writer case.
  threw = null;
  try {
    compileDsl(`
recipe "Hist"
use sim cell
use clock dt, frame, prev
use geo px, py, pz
field u history 1
field v

stage step "Step" {
  reads u, v
  writes v
  cell {
    set v = prev(u)
  }
}
`);
  } catch (error) {
    threw = error.message;
  }
  assert(
    threw && threw.includes("no writing stage"),
    `expected no-writer error; got: ${threw}`,
  );
});

test("validator rejects read of history field after its writer", () => {
  let threw = null;
  try {
    compileDsl(`
recipe "Hist"
use sim cell
use clock dt, frame, prev
use geo px, py, pz
field u history 1
field v

stage step "Step" {
  reads u
  writes u
  cell {
    set u = u + prev(u)
  }
}

stage echo "Echo" {
  reads u, v
  writes v
  cell {
    set v = u
  }
}
`);
  } catch (error) {
    threw = error.message;
  }
  assert(
    threw && threw.includes("after its writer"),
    `expected post-writer-read error; got: ${threw}`,
  );
});

test("validator rejects history field written by multiple stages", () => {
  let threw = null;
  try {
    compileDsl(`
recipe "Hist"
use sim cell, clamp
use clock dt, frame, prev
use geo px, py, pz
field u history 1

stage step "Step" {
  reads u
  writes u
  cell {
    add u = (u - prev(u)) * dt
  }
}

stage clip "Clip" {
  reads u
  writes u
  clamp u -1 1
}
`);
  } catch (error) {
    threw = error.message;
  }
  assert(
    threw && threw.includes("written by multiple stages"),
    `expected multi-writer error; got: ${threw}`,
  );
});

test("validator rejects history field written by non-cell primitive", () => {
  let threw = null;
  try {
    compileDsl(`
recipe "Hist"
use sim cell, clamp
use clock dt, frame, prev
use geo px, py, pz
field u history 1

stage step "Step" {
  reads u
  writes u
  cell {
    add u = (u - prev(u)) * dt
  }
  clamp u -1 1
}
`);
  } catch (error) {
    threw = error.message;
  }
  assert(
    threw && threw.includes("cannot be written by clamp"),
    `expected non-cell-write error; got: ${threw}`,
  );
});

test("WGSL compiler emits f_<name>_prev binding for prev() reads", () => {
  const recipe = compileDsl(`
recipe "Hist"
use sim cell
use clock dt, frame, prev
use geo px, py, pz
field u history 1

stage step "Step" {
  reads u
  writes u
  cell {
    add u = (u - prev(u)) * dt
  }
}
`);
  const [pass] = compileWebGpuGeodesicCellStage(recipe.dsl.stages[0], recipe.dsl);
  assert(Array.isArray(pass.prevReads) && pass.prevReads.includes("u"), "pass.prevReads must include u");
  assert(pass.source.includes("var<storage, read> f_u_prev"), "WGSL must declare the prev binding");
  assert(pass.source.includes("f_u_prev[cell]"), "WGSL must read prev from f_u_prev");
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
