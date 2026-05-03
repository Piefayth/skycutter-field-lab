// V2 metric compiler tests — covers compileWebGpuMetric output shape,
// the per-cell shader's WGSL bindings, the reduce shader's combine op
// per primitive, and mean's decomposition into [sum, count].

import { compileV2 } from "./compile-v2.mjs";
import { compileWebGpuMetric, metricReduceShader, expandMetricPrimitives } from "./webgpu-geodesic-compiler.mjs";

function test(name, fn) {
  try { fn(); console.log(`ok - ${name}`); }
  catch (error) { console.error(`not ok - ${name}`); console.error(error.stack ?? error.message); process.exitCode = 1; }
}
function assert(cond, msg = "assertion failed") { if (!cond) throw new Error(msg); }
function assertEq(a, b, msg = "") {
  const x = JSON.stringify(a), y = JSON.stringify(b);
  if (x !== y) throw new Error(`${msg}\n  expected: ${y}\n  actual:   ${x}`);
}

function compileMetricFromRecipe(source, metricId) {
  const r = compileV2(source);
  const m = r.dsl.metrics.find((x) => x.id === metricId);
  assert(m, `metric "${metricId}" not found in recipe`);
  return compileWebGpuMetric(m, r.dsl);
}

// -----------------------------------------------------------------------------
// Primitive decomposition
// -----------------------------------------------------------------------------

test("sum/max/min/count expand to 1 primitive each", () => {
  for (const op of ["sum", "max", "min", "count"]) {
    const prims = expandMetricPrimitives(op);
    assertEq(prims, [op], `${op} should expand to single primitive`);
  }
});

test("mean expands to [sum, count]", () => {
  const prims = expandMetricPrimitives("mean");
  assertEq(prims, ["sum", "count"], "mean should decompose into sum + count");
});

// -----------------------------------------------------------------------------
// Per-cell shader shape
// -----------------------------------------------------------------------------

test("max cells { abs(u) } per-cell shader binds f_u and writes outputField", () => {
  const compiled = compileMetricFromRecipe(`
recipe "X"
substrate geodesic frequency 16
field u: f32
step { stage s { reads u; writes u; cell { set u = u } } }
metric peak = max cells { abs(u) }
`, "peak");
  assert(compiled.primitives.length === 1, "max produces 1 primitive");
  const prim = compiled.primitives[0];
  assertEq(prim.primOp, "max");
  assertEq(prim.reads, ["u"]);
  assert(prim.perCellSource.includes("var<storage, read> f_u: array<f32>"),
    "per-cell shader binds f_u for read");
  assert(prim.perCellSource.includes("var<storage, read_write> outputField: array<f32>"),
    "per-cell shader binds outputField for the scratch buffer");
  // The body lowers `pred ? expr : -1.0e38` for max with no predicate.
  assert(prim.perCellSource.includes("-1.0e38"),
    "max sentinel (-1e38) appears for predicate-skipped cells");
});

test("count cells where abs(u) > 0.1 per-cell shader writes 0/1 with sentinel 0", () => {
  const compiled = compileMetricFromRecipe(`
recipe "X"
substrate geodesic frequency 16
field u: f32
step { stage s { reads u; writes u; cell { set u = u } } }
metric active = count cells where abs(u) > 0.1
`, "active");
  const prim = compiled.primitives[0];
  assertEq(prim.primOp, "count");
  // count's body is implicitly 1.0 (the literal); predicate guards it.
  assert(prim.perCellSource.includes("1.0"),
    "count contributes 1.0 when predicate matches");
});

test("sum cells { u*v } per-cell shader binds both fields", () => {
  const compiled = compileMetricFromRecipe(`
recipe "X"
substrate geodesic frequency 16
field u: f32
field v: f32
step { stage s { reads u, v; writes u, v; cell { set u = u; set v = v } } }
metric mass = sum cells { u * v }
`, "mass");
  const prim = compiled.primitives[0];
  assertEq(prim.primOp, "sum");
  assert(prim.reads.includes("u"));
  assert(prim.reads.includes("v"));
  assert(prim.perCellSource.includes("var<storage, read> f_u"));
  assert(prim.perCellSource.includes("var<storage, read> f_v"));
});

test("metric body with neighbor reduction sets needsNeighbors", () => {
  const compiled = compileMetricFromRecipe(`
recipe "X"
substrate geodesic frequency 16
field u: f32
step { stage s { reads u; writes u; cell { set u = u } } }
metric grad = max cells { sum n in neighbors { u@n - u } }
`, "grad");
  const prim = compiled.primitives[0];
  assertEq(prim.needsNeighbors, true, "neighbor reduction triggers neighbor topology binding");
  assert(prim.perCellSource.includes("var<storage, read> neighbors"),
    "WGSL binds neighbor topology");
});

test("metric body with @prev sets prevReads", () => {
  const compiled = compileMetricFromRecipe(`
recipe "X"
substrate geodesic frequency 16
field u: f32
step {
  stage propagate { reads u; writes u; cell { set u = u + u@prev } }
}
metric drift = max cells { abs(u@prev - u) }
`, "drift");
  const prim = compiled.primitives[0];
  assertEq(prim.prevReads, [{ field: "u", depth: 1 }], "metric @prev surfaces in prevReads");
  assert(prim.perCellSource.includes("var<storage, read> f_u_prev_1"),
    "WGSL binds f_u_prev_1 for prev coord query");
});

// -----------------------------------------------------------------------------
// Mean decomposition
// -----------------------------------------------------------------------------

test("mean produces 2 primitives (sum + count) with shared body shape", () => {
  const compiled = compileMetricFromRecipe(`
recipe "X"
substrate geodesic frequency 16
field u: f32
step { stage s { reads u; writes u; cell { set u = u } } }
metric avg = mean cells where u > 0 { u }
`, "avg");
  assert(compiled.primitives.length === 2, "mean produces 2 primitives");
  const ops = compiled.primitives.map((p) => p.primOp).sort();
  assertEq(ops, ["count", "sum"]);
  // Both primitives share the predicate (`u > 0`) — the count is
  // "cells matching predicate", the sum is "u summed over those".
  for (const prim of compiled.primitives) {
    assert(prim.perCellSource.includes("var<storage, read> f_u"),
      `${prim.primOp} primitive reads u`);
  }
});

// -----------------------------------------------------------------------------
// Reduce shader shape
// -----------------------------------------------------------------------------

test("metricReduceShader emits the right combine op per primitive", () => {
  const sumShader = metricReduceShader("sum");
  assert(sumShader.includes("a + b"), "sum reduce uses + combine");
  assert(sumShader.includes("0.0"), "sum identity is 0.0");

  const maxShader = metricReduceShader("max");
  assert(maxShader.includes("max(a, b)"), "max reduce uses max combine");
  assert(maxShader.includes("-1.0e38"), "max identity is -1e38");

  const minShader = metricReduceShader("min");
  assert(minShader.includes("min(a, b)"), "min reduce uses min combine");
  assert(minShader.includes("1.0e38"), "min identity is 1e38");

  const countShader = metricReduceShader("count");
  // count uses sum-style accumulation (each cell contributes 0 or 1).
  assert(countShader.includes("a + b"), "count reduce uses + combine (sums 0/1 contributions)");
  assert(countShader.includes("0.0"), "count identity is 0.0");
});

test("metricReduceShader has workgroup_size 128 + tree-reduce structure", () => {
  const shader = metricReduceShader("sum");
  assert(shader.includes("@compute @workgroup_size(128)"),
    "reduce kernel uses 128-wide workgroups");
  assert(shader.includes("workgroupBarrier()"),
    "reduce kernel uses workgroup barriers between tree levels");
  assert(shader.includes("var<workgroup> shared_data"),
    "reduce kernel uses workgroup-shared memory");
  assert(shader.includes("for (var stride: u32 = 64u"),
    "reduce kernel halves stride from 64 down");
});

test("metricReduceShader rejects unknown primitive op", () => {
  let threw = null;
  try { metricReduceShader("median"); }
  catch (e) { threw = e.message; }
  assert(threw && threw.includes("unknown primitive op"),
    `expected unknown-op error; got: ${threw}`);
});
