// End-to-end smoke test: v2 wave-equation source → compileV2 → existing v1
// WebGPU geodesic compiler → WGSL output. If this passes, v2 wave equation is
// runnable in the browser.

import { compileV2, diagnoseV2 } from "./compile-v2.mjs";
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
function assertThrows(fn, pattern, msg = "expected throw") {
  try {
    fn();
  } catch (error) {
    if (pattern && !pattern.test(String(error?.message ?? error))) {
      throw new Error(`${msg}: wrong error\n  expected: ${pattern}\n  actual:   ${error?.message ?? error}`);
    }
    return;
  }
  throw new Error(msg);
}

const WAVE_V2 = `
recipe "Wave equation"
summary "Hyperbolic wave on a sphere — leapfrog integration."

substrate geodesic frequency 64

field u: f32

param speed   slider 0..0.29 default 0.25 label "WAVE SPEED"
param damping slider 0..0.05 default 0    label "DAMPING γ"

stamps {
  stamp ripple "Drop ripple" {
    spot u at brush.pos, radius=brush.r, amount=1
  }
}

scenarios {
  scenario droplet "Single droplet" {
    set u = 0
    spot u at lon=0, lat=0, radius=0.08, amount=1
  }
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
  assert(Array.isArray(cellPass.prevReads) && cellPass.prevReads.some((e) => e.field === "u" && e.depth === 1),
    `cell pass should declare prevReads with {field:"u",depth:1}, got ${JSON.stringify(cellPass.prevReads)}`);
  assert(cellPass.source.includes("f_u_prev_1"),
    "WGSL should bind f_u_prev_1 for u@prev reads");
  assert(cellPass.source.includes("var<storage, read> f_u"),
    "WGSL should bind f_u for current reads");
});

test("relax wraps existing stages in a bounded schedule item", () => {
  const source = `
recipe "Relax"
substrate geodesic frequency 4
field h: f32
step {
  stage seed {
    reads h
    writes h
    cell { set h = h + 1 }
  }

  relax settle max_iters 3 {
    stage drain {
      reads h
      writes h
      cell { set h = max(0, h - 1) }
    }
  }
}`;
  const r = compileV2(source);
  assertEq(r.dsl.stepItems, [
    { type: "stage", stageId: "seed" },
    { type: "relax", id: "settle", name: "settle", maxIters: 3, stages: ["drain"] },
  ]);
  const compiled = compileWebGpuGeodesicPipeline(r.dsl);
  assertEq(compiled.steps.map((item) => item.type), ["stage", "relax"]);
  assert(compiled.steps[1].stages[0].id === "drain", "relax should reference the compiled stage");
});

test("relax rejects history-field writers", () => {
  assertThrows(() => compileV2(`
recipe "Relax History"
substrate geodesic frequency 4
field u: f32
step {
  relax settle max_iters 3 {
    stage wave {
      reads u previous
      writes u
      cell { set u = u@prev }
    }
  }
}`), /history field u/, "history writes inside relax should be rejected");
});

test("diagnoseV2 includes a source range for editor diagnostics", () => {
  const source = `
recipe "Bad"
substrate geodesic frequency 16
field u: f32
scenarios {
  scenario init { set u = 0 }
}
step {
  stage broken {
    reads u
    writes u
    cell { set u = nope }
  }
}`;
  const result = diagnoseV2(source);
  assert(!result.ok, "expected diagnostic failure");
  const [error] = result.errors;
  assert(error.message.includes("nope"), `expected message to mention nope, got ${error.message}`);
  assertEq(source.slice(error.from, error.to), "nope", "diagnostic should target the bad identifier");
  assert(error.line > 0 && error.column > 0, "diagnostic should include line/column");
});

test("diagnoseV2 locates parse errors at the quoted tail", () => {
  const source = `recipe "Blank"
summary "Empty starter recipe. Replace step body with your own simulation."
recommendedPreset blank

substrate geodesic frequency 64

field a: f32

scenarios {
  scenario blank "Blank canvas" {
    set a f 0
  }
}

step {
  stage hold "No-op hold (replace with real physics)" {
    reads a
    writes a
    cell { set a = clamp(a, 0, 1) }
  }
}`;
  const result = diagnoseV2(source);
  assert(!result.ok, "expected diagnostic failure");
  const [error] = result.errors;
  assert(error.message.includes('expected "="'), `expected parse error, got ${error.message}`);
  assertEq(source.slice(error.from, error.to), "f", "diagnostic should point at the unexpected token");
  assertEq(error.line, 11, "diagnostic should report the scenario action line");
});

test("diagnoseV2 prefers CST expression references over declarations", () => {
  const source = `
recipe "Bad"
substrate geodesic frequency 16
field nope: f32
field u: f32
step {
  stage broken {
    reads u
    writes u
    cell { set u = nope }
  }
}`;
  const result = diagnoseV2(source);
  assert(!result.ok, "expected diagnostic failure");
  const [error] = result.errors;
  assert(error.message.includes("nope"), `expected message to mention nope, got ${error.message}`);
  assertEq(source.slice(error.from, error.to), "nope", "diagnostic should target expression reference");
  assert(error.line > 8, "diagnostic should not point at the field declaration");
});

test("diagnoseV2 targets the action field for assignment type errors", () => {
  const source = `
recipe "Bad"
substrate geodesic frequency 16
field u: f32
field wind: vec2
step {
  stage broken {
    reads wind
    writes u
    cell { set u = wind }
  }
}`;
  const result = diagnoseV2(source);
  assert(!result.ok, "expected diagnostic failure");
  const [error] = result.errors;
  assert(error.message.includes("type mismatch"), `expected type mismatch, got ${error.message}`);
  assertEq(source.slice(error.from, error.to), "u", "diagnostic should target assignment field");
  assert(error.line > 8, "diagnostic should not point at the field declaration");
});
