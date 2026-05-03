// End-to-end smoke test: v2 wave-equation source → compileV2 → existing v1
// WebGPU geodesic compiler → WGSL output. If this passes, v2 wave equation is
// runnable in the browser.

import { compileV2 } from "./compile-v2.mjs";
import { compileWebGpuGeodesicPipeline } from "./webgpu-geodesic-compiler.mjs";

function test(name, fn) {
  try { fn(); console.log(`ok - ${name}`); }
  catch (error) { console.error(`not ok - ${name}`); console.error(error.stack ?? error.message); process.exitCode = 1; }
}

function assert(cond, msg = "assertion failed") { if (!cond) throw new Error(msg); }
function assertEq(a, b, msg = "") {
  const x = JSON.stringify(a), y = JSON.stringify(b);
  if (x !== y) throw new Error(`${msg}\n  expected: ${y}\n  actual:   ${x}`);
}

const WAVE_V2 = `
recipe "Wave equation"
summary "Hyperbolic wave on a sphere — leapfrog integration."

substrate geodesic frequency 64

field u: f32

param speed   slider 0..0.29 default 0.25 label "WAVE SPEED"
param damping slider 0..0.05 default 0    label "DAMPING γ"

scenario droplet "Single droplet" {
  set u = 0
  spot u at lon=0, lat=0, radius=0.08, amount=1
}

stamp ripple "Drop ripple" {
  spot u at brush.pos, radius=brush.r, amount=1
}

step {
  stage propagate {
    reads u
    writes u
    cell {
      let lap  = sum n in neighbors { u@n - u }
      let damp = damping * (u - u@prev)
      set u = clamp(2*u - u@prev + speed*speed*lap - damp, -2, 2)
    }
  }
}

metric peak   = max cells { abs(u) }
metric active = count cells where abs(u) > 0.1
`;

test("compileV2 produces a v1-shaped recipe", () => {
  const r = compileV2(WAVE_V2);
  assertEq(r.dsl.recipe.name, "Wave equation");
  assertEq(r.dsl.grid.kind, "geodesic");
  assert(r.dsl.fields.length === 1);
  assert(r.dsl.parameters.length === 2);
  assert(r.dsl.presets.length === 1);
  assert(r.dsl.stamps.length === 1);
  assert(r.dsl.stages.length === 1);
  assert(r.dsl.metrics.length === 2);
});

test("v2 wave-equation lowers + compiles to WGSL", () => {
  const r = compileV2(WAVE_V2);
  // The webgpu-geodesic-compiler reads r.dsl directly.
  const compiled = compileWebGpuGeodesicPipeline(r.dsl);
  assert(compiled.stages.length === 1, `expected 1 stage, got ${compiled.stages.length}`);
  const stage = compiled.stages[0];
  assert(stage.passes.length >= 1, "stage has at least one pass");
  const cellPass = stage.passes.find((p) => p.kind === "cell");
  assert(cellPass, "expected a cell pass");
  assert(Array.isArray(cellPass.prevReads) && cellPass.prevReads.includes("u"),
    `cell pass should declare prevReads=[u], got ${JSON.stringify(cellPass.prevReads)}`);
  assert(cellPass.source.includes("f_u_prev"),
    "WGSL should bind f_u_prev for u@prev reads");
  assert(cellPass.source.includes("var<storage, read> f_u"),
    "WGSL should bind f_u for current reads");
});
