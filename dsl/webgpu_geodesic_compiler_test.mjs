// Tests for the WebGPU geodesic compiler — both the cell-stage WGSL
// emit path and the @upstream / vec2 / type-checker paths it shares
// with the v2 frontend. Every test drives the compiler via compileV2,
// since v1 (`compileDsl`) is gone.

import { compileV2 } from "./compile-v2.mjs";
import {
  buildWebGpuGeodesicUniforms,
  compileWebGpuGeodesicCellStage,
  compileWebGpuGeodesicPipeline,
} from "./webgpu-geodesic-compiler.mjs";
import { pipeline as klausmeierPipeline } from "../recipes/klausmeier.mjs";

test("compiles a DSL cell stage to WGSL storage-buffer passes", () => {
  const recipe = compileV2(`
recipe "Tiny"
substrate geodesic frequency 16
field A: f32
field B: f32
param gain slider 0..2 step 0.1 default 1
param enabled toggle default true
const bias = 0.25

step {
  stage push "Push" {
    reads A, B
    writes A
    cell {
      when enabled {
        let boost = gain + bias
        add A = (B - A) * boost * dt
      }
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

test("builds packed f32 uniforms from params and consts", () => {
  // V2 dropped the v1 `planet GRAVITY 9.81` directive; only params and
  // consts contribute to the packed uniforms now.
  const recipe = compileV2(`
recipe "Tiny"
substrate geodesic frequency 16
field A: f32
param gain slider 0..2 step 0.1 default 1
const bias = 0.25

step {
  stage push "Push" {
    reads A
    writes A
    cell {
      add A = gain + bias + dt + frame
    }
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
  });
  // Layout: [dt, frame, cellCount, pad0, p_gain, c_bias].
  assert(uniforms.length === 6, `unexpected uniform length ${uniforms.length}`);
  assert(uniforms[0] === 0.5, "dt not packed");
  assert(uniforms[1] === 7, "frame not packed");
  assert(uniforms[2] === 42, "cellCount not packed");
  assert(uniforms[4] === 1.5, "param not packed");
  assert(uniforms[5] === 0.75, "const not packed");
});

test("nullish coalescing keeps the fallback in generated WGSL", () => {
  const recipe = compileV2(`
recipe "Fallback"
substrate geodesic frequency 16
field A: f32
param gain slider 0..2 step 0.1 default 1

step {
  stage push "Push" {
    reads A
    writes A
    cell {
      let g = gain ?? 0.75
      add A = g * dt
    }
  }
}
`);
  const [pass] = compileWebGpuGeodesicCellStage(recipe.dsl.stages[0], recipe.dsl);
  assert(pass.source.includes("select(0.75, params.p_gain, params.p_gain == params.p_gain)"), "fallback was dropped");
});

test("cellNoise lowers to spatial geodesic noise", () => {
  const recipe = compileV2(`
recipe "Noise"
substrate geodesic frequency 16
field A: f32

step {
  stage push "Push" {
    reads A
    writes A
    cell {
      add A = cellNoise(7) * dt
    }
  }
}
`);
  const [pass] = compileWebGpuGeodesicCellStage(recipe.dsl.stages[0], recipe.dsl);
  assert(pass.source.includes("fn spatialNoise"), "spatial noise helper missing");
  assert(pass.source.includes("spatialNoise(vec3<f32>(px, py, pz), 7.0)"), "cellNoise call did not use position");
});

test("cellNoise(seed, scale) emits scaled sphere coords", () => {
  const recipe = compileV2(`
recipe "Scaled noise"
substrate geodesic frequency 16
field A: f32

step {
  stage push "Push" {
    reads A
    writes A
    cell {
      add A = cellNoise(11, 2.5) * dt
    }
  }
}
`);
  const [pass] = compileWebGpuGeodesicCellStage(recipe.dsl.stages[0], recipe.dsl);
  assert(pass.source.includes("spatialNoise((vec3<f32>(px, py, pz) * (2.5"), "scale arg not multiplied into coords");
});

test("neighbor sum lifts to a per-cell loop", () => {
  const recipe = compileV2(`
recipe "Sum"
substrate geodesic frequency 16
field A: f32

step {
  stage sum "Sum" {
    reads A
    writes A
    cell {
      let lap = sum n in neighbors { A@n - A }
      add A = lap * dt
    }
  }
}
`);
  const [pass] = compileWebGpuGeodesicCellStage(recipe.dsl.stages[0], recipe.dsl);
  assert(pass.needsNeighbors === true, "stage should bind neighbor arrays");
  assert(pass.source.includes("var nr_0: f32 = 0.0;"), "sum accumulator initialized to 0");
  assert(pass.source.includes("for (var nr_0_slot: u32 = 0u"), "loop emitted");
  assert(pass.source.includes("let nr_0_n: u32 = u32(neighbors[cell * 6u + nr_0_slot]);"), "neighbor index resolved once per slot");
  // V2 hoists each `field@n` to a `_n_<field>` local; the body
  // accumulates from those locals. Confirm both the local emit and
  // the accumulator pull from it.
  assert(pass.source.includes("let _n_A: f32 = f_A[nr_0_n];"),
    "per-neighbor field read must be hoisted to _n_A");
  assert(/nr_0\s*=\s*nr_0\s*\+\s*\(\(_n_A - v_A\)\)/.test(pass.source),
    "sum body must accumulate (A@n - A)");
});

test("neighbor mean divides by neighbor count", () => {
  const recipe = compileV2(`
recipe "Mean"
substrate geodesic frequency 16
field A: f32

step {
  stage avg "Avg" {
    reads A
    writes A
    cell {
      let lap = mean n in neighbors { A@n }
      add A = (lap - A) * dt
    }
  }
}
`);
  const [pass] = compileWebGpuGeodesicCellStage(recipe.dsl.stages[0], recipe.dsl);
  assert(pass.source.includes("var nr_0_sum: f32 = 0.0;"), "mean uses a sum accumulator");
  assert(pass.source.includes("nr_0 = select(0.0, nr_0_sum / f32(nr_0_count)"), "mean divides by count");
});

test("neighbor max uses -infinity sentinel", () => {
  const recipe = compileV2(`
recipe "Max"
substrate geodesic frequency 16
field A: f32

step {
  stage hi "Hi" {
    reads A
    writes A
    cell {
      let m = max n in neighbors { A@n }
      set A = m
    }
  }
}
`);
  const [pass] = compileWebGpuGeodesicCellStage(recipe.dsl.stages[0], recipe.dsl);
  assert(pass.source.includes("var nr_0: f32 = -1.0e38;"), "max seeded with -infinity");
  assert(pass.source.includes("let _n_A: f32 = f_A[nr_0_n];"),
    "per-neighbor field read must be hoisted to _n_A");
  assert(/nr_0\s*=\s*max\(nr_0,\s*\(_n_A\)\)/.test(pass.source),
    "max body must use WGSL max with the per-neighbor field read");
});

test("validator rejects nested neighbor reductions", () => {
  // The outer reduction body must reference `field@n` (otherwise the
  // parser flags the empty body before the validator gets to nesting).
  // Embedding `A@n` plus a nested `sum m in neighbors { A@m }` lets us
  // trigger the no-neighbor-of-neighbor rule.
  let threw = null;
  try {
    compileV2(`
recipe "Nested"
substrate geodesic frequency 16
field A: f32

step {
  stage bad "Bad" {
    reads A
    writes A
    cell {
      add A = sum n in neighbors { A@n + sum m in neighbors { A@m } } * dt
    }
  }
}
`);
  } catch (error) { threw = error.message; }
  assert(threw && threw.includes("nested neighbor reductions"), `expected nested-rejection, got: ${threw}`);
});

test("compiles a multi-stage v2 pipeline into stage passes", () => {
  // Replaces the v1 weather-fixture full-pipeline test. Klausmeier has
  // a representative mix of stages: continuous-position CoordRead,
  // neighbor-mean diffusion, plain reaction kinetics, and a clamp pass.
  const compiled = compileWebGpuGeodesicPipeline(klausmeierPipeline.dsl);
  assert(compiled.stages.length === klausmeierPipeline.dsl.stages.length, "stage count mismatch");
  assert(compiled.stages.every((stage) => Array.isArray(stage.passes)), "stage passes missing");
});

test("validator rejects history field with no writing stage", () => {
  // V2 infers history from `@prev` usage. If a field is referenced
  // with @prev but no stage writes it, the inferred-history rule
  // surfaces as a "no writing stage" error — the v2 analogue of the
  // v1 explicit `field u history 1` no-writer check.
  let threw = null;
  try {
    compileV2(`
recipe "Hist"
substrate geodesic frequency 16
field u: f32
field v: f32

step {
  stage step1 "Step" {
    reads u, v
    writes v
    cell {
      set v = u@prev
    }
  }
}
`);
  } catch (error) { threw = error.message; }
  assert(threw && threw.includes("no writing stage"), `expected no-writer error; got: ${threw}`);
});

// =============================================================================
// V2-only paths (vec2, gradient/divergence, @upstream, type checker).
// =============================================================================

test("vec2 field emits array<vec2<f32>> bindings + typed read locals", () => {
  const recipe = compileV2(`
recipe "Vec"
substrate geodesic frequency 16
field pressure: f32
field wind: vec2

step {
  stage compute "Compute wind" {
    reads pressure
    writes wind
    cell {
      set wind = vec2(pressure, pressure)
    }
  }
}
`);
  const [pass] = compileWebGpuGeodesicCellStage(recipe.dsl.stages[0], recipe.dsl);
  assert(pass.source.includes("var<storage, read> f_pressure: array<f32>"),
    "pressure binding stays array<f32>");
  assert(pass.source.includes("var<storage, read_write> outputField: array<vec2<f32>>"),
    "wind output binding becomes array<vec2<f32>>");
  assert(pass.source.includes("var outValue = vec2<f32>(0.0, 0.0)"),
    "outValue inits as vec2<f32>(0.0, 0.0) for vec2 fields not in reads");
  assert(pass.source.includes("vec2<f32>(v_pressure, v_pressure)"),
    "vec2(...) call lowers to WGSL native constructor");
});

test("neighbor reduction over vec2 field component emits per-neighbor vec2 local", () => {
  // Regression: emitReduction hardcoded the per-neighbor binding's
  // WGSL type as f32, so a body like `mean n in neighbors {
  // heading@n.x }` over a vec2 field produced
  // `let _n_heading: f32 = f_heading[idx]` where `f_heading` is
  // actually `array<vec2<f32>>` — WGSL parse error at member access.
  const recipe = compileV2(`
recipe "Vicsek"
substrate geodesic frequency 16
field heading: vec2

step {
  stage align "Align" {
    reads heading
    writes heading
    cell {
      let mx = mean n in neighbors { heading@n.x }
      let my = mean n in neighbors { heading@n.y }
      set heading = vec2(mx, my)
    }
  }
}
`);
  const [pass] = compileWebGpuGeodesicCellStage(recipe.dsl.stages[0], recipe.dsl);
  assert(pass.source.includes("let _n_heading: vec2<f32> = f_heading["),
    "per-neighbor binding for a vec2 field must be typed as vec2<f32>");
  assert(pass.source.includes("_n_heading.x"),
    "WGSL must access .x on the typed local for the .x component reduction");
  assert(pass.source.includes("_n_heading.y"),
    "WGSL must access .y on the typed local for the .y component reduction");
});

test("gradient(scalarField) emits a per-field tangent-frame helper + stencil helpers", () => {
  const recipe = compileV2(`
recipe "WindCell"
substrate geodesic frequency 16
field pressure: f32
field wind: vec2

step {
  stage compute "Compute wind" {
    reads pressure
    writes wind
    cell {
      let grad = gradient(pressure)
      set wind = vec2(-grad.x, -grad.y)
    }
  }
}
`);
  const [pass] = compileWebGpuGeodesicCellStage(recipe.dsl.stages[0], recipe.dsl);
  assert(pass.needsNeighbors === true, "gradient triggers neighbor topology binding");
  assert(pass.source.includes("fn _stencil_position(cell: u32) -> vec3<f32>"),
    "stencil position helper emitted");
  assert(pass.source.includes("fn _stencil_eastBasis(p: vec3<f32>) -> vec3<f32>"),
    "stencil east-basis helper emitted");
  assert(pass.source.includes("fn _gradient_pressure(cell: u32) -> vec2<f32>"),
    "per-field gradient helper emitted");
  assert(pass.source.includes("_gradient_pressure(cell)"),
    "gradient call lowered to helper invocation");
});

test("divergence(vec2Field) emits the divergence helper", () => {
  const recipe = compileV2(`
recipe "LiftCell"
substrate geodesic frequency 16
field wind: vec2
field lift: f32 derived

step {
  stage compute "Compute lift" {
    reads wind
    writes lift
    cell {
      set lift = -divergence(wind)
    }
  }
}
`);
  const [pass] = compileWebGpuGeodesicCellStage(recipe.dsl.stages[0], recipe.dsl);
  assert(pass.needsNeighbors === true, "divergence triggers neighbor topology binding");
  assert(pass.source.includes("fn _divergence_wind(cell: u32) -> f32"),
    "per-vec2-field divergence helper emitted");
  assert(pass.source.includes("_divergence_wind(cell)"),
    "divergence call lowered to helper invocation");
});

test("gradient on a vec2 field is rejected by the type checker", () => {
  // The v2 type checker (typecheck-v2.mjs) catches this at recipe
  // load with a clearer message than the WGSL emit-layer fallback.
  let threw = null;
  try {
    compileV2(`
recipe "BadGrad"
substrate geodesic frequency 16
field wind: vec2
field x: f32

step {
  stage s "S" {
    reads wind
    writes x
    cell {
      let g = gradient(wind)
      set x = g.x
    }
  }
}
`);
  } catch (e) { threw = e.message; }
  assert(threw && /gradient.*only defined on scalar/.test(threw),
    `expected gradient-on-vec2 type-check error; got: ${threw}`);
});

test("@upstream coord-arg field references add the field to pass.reads", () => {
  // Regression: a stage that reads field `slope` only via the velocity
  // arguments of `field@upstream(velX, velY, dt)` would silently drop
  // `slope` from pass.reads, leaving the WGSL referencing an unbound
  // identifier. The compiler must walk velX/velY/dt expressions when
  // collecting per-target dependencies.
  const recipe = compileV2(`
recipe "Upstream args"
substrate geodesic frequency 16
field w: f32
field slope: vec2

step {
  stage flow "Flow downhill" {
    reads w, slope
    writes w
    cell {
      set w = w@upstream(slope.x, slope.y, dt)
    }
  }
}
`);
  const [pass] = compileWebGpuGeodesicCellStage(recipe.dsl.stages[0], recipe.dsl);
  assert(pass.reads.includes("slope"), `pass.reads must include slope (got ${JSON.stringify(pass.reads)})`);
  assert(pass.source.includes("var<storage, read> f_slope: array<vec2<f32>>"),
    "slope must be bound as array<vec2<f32>>");
  assert(pass.source.includes("v_slope.x") && pass.source.includes("v_slope.y"),
    "@upstream args must reference the typed v_slope local");
});

test("validator rejects unknown identifier in @upstream coord arguments", () => {
  let threw = null;
  try {
    compileV2(`
recipe "Bad upstream"
substrate geodesic frequency 16
field w: f32

step {
  stage flow "Flow downhill" {
    reads w
    writes w
    cell {
      set w = w@upstream(notDeclared, 0, dt)
    }
  }
}
`);
  } catch (e) { threw = e; }
  assert(threw, "expected validation error for unknown identifier in @upstream args");
  assert(/notDeclared/.test(threw.message), `expected error to mention notDeclared, got: ${threw.message}`);
});

test("WGSL compiler emits f_<name>_prev binding for @prev reads", () => {
  // V2 history is auto-inferred: a `@prev` reference makes the field
  // a history field, the compiler allocates a prev binding, and the
  // WGSL reads from it. Any stage reading u@prev must also write u.
  const recipe = compileV2(`
recipe "Hist"
substrate geodesic frequency 16
field u: f32

step {
  stage propagate "Step" {
    reads u
    writes u
    cell {
      add u = (u - u@prev) * dt
    }
  }
}
`);
  const [pass] = compileWebGpuGeodesicCellStage(recipe.dsl.stages[0], recipe.dsl);
  assert(Array.isArray(pass.prevReads) && pass.prevReads.includes("u"), "pass.prevReads must include u");
  assert(pass.source.includes("var<storage, read> f_u_prev"), "WGSL must declare the prev binding");
  assert(pass.source.includes("f_u_prev[cell]"), "WGSL must read prev from f_u_prev");
});

// =============================================================================
// Test harness (this file is invoked via `node --test`; the helpers
// below print TAP-shaped output the runner picks up).
// =============================================================================

function test(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === "function") {
      // If a test returns a promise, the runner picks up unhandled
      // rejections via process.exitCode — chain to surface failures.
      result.then(
        () => console.log(`ok - ${name}`),
        (error) => {
          console.error(`not ok - ${name}`);
          console.error(error.stack ?? error.message);
          process.exitCode = 1;
        },
      );
      return;
    }
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
