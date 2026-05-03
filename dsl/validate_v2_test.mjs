// V2 validator tests — covers the rules in validate-v2.mjs that aren't
// reachable through v1's validator (derived field rules, metric purity).

import { compileV2 } from "./compile-v2.mjs";

function test(name, fn) {
  try { fn(); console.log(`ok - ${name}`); }
  catch (error) { console.error(`not ok - ${name}`); console.error(error.stack ?? error.message); process.exitCode = 1; }
}
function assert(cond, msg = "assertion failed") { if (!cond) throw new Error(msg); }
function expectThrow(fn, snippet) {
  let threw = null;
  try { fn(); } catch (e) { threw = e.message; }
  assert(threw && threw.includes(snippet), `expected error containing "${snippet}"; got: ${threw}`);
}

// -----------------------------------------------------------------------------
// Derived fields: must have ≥1 stage writer
// -----------------------------------------------------------------------------

test("derived field with no writer is rejected", () => {
  expectThrow(() => compileV2(`
recipe "X"
substrate geodesic frequency 16
field u: f32
field abs_u: f32 derived
step {
  stage step1 { reads u; writes u; cell { set u = u } }
}
`), "no writing stage");
});

test("derived field with a writer is accepted", () => {
  // Sanity: shouldn't throw.
  compileV2(`
recipe "X"
substrate geodesic frequency 16
field u: f32
field abs_u: f32 derived
step {
  stage step1 { reads u; writes u; cell { set u = u } }
  stage derive { reads u; writes abs_u; cell { set abs_u = abs(u) } }
}
`);
});

// -----------------------------------------------------------------------------
// Derived fields: not writable from scenarios
// -----------------------------------------------------------------------------

test("scenario writing a derived field is rejected", () => {
  expectThrow(() => compileV2(`
recipe "X"
substrate geodesic frequency 16
field u: f32
field abs_u: f32 derived
scenario init "init" {
  spot abs_u at lon=0, lat=0, radius=0.1, amount=1
}
step {
  stage step1 { reads u; writes u; cell { set u = u } }
  stage derive { reads u; writes abs_u; cell { set abs_u = abs(u) } }
}
`), "writes derived field");
});

test("scenario for-each-cell setting a derived field is rejected", () => {
  expectThrow(() => compileV2(`
recipe "X"
substrate geodesic frequency 16
field u: f32
field abs_u: f32 derived
scenario init "init" {
  for each cell {
    set abs_u = 0
  }
}
step {
  stage step1 { reads u; writes u; cell { set u = u } }
  stage derive { reads u; writes abs_u; cell { set abs_u = abs(u) } }
}
`), "writes derived field");
});

// -----------------------------------------------------------------------------
// Derived fields: not writable from stamps
// -----------------------------------------------------------------------------

test("stamp writing a derived field is rejected", () => {
  expectThrow(() => compileV2(`
recipe "X"
substrate geodesic frequency 16
field u: f32
field abs_u: f32 derived
stamp paint "paint" {
  spot abs_u at brush.pos, radius=brush.r, amount=1
}
step {
  stage step1 { reads u; writes u; cell { set u = u } }
  stage derive { reads u; writes abs_u; cell { set abs_u = abs(u) } }
}
`), "writes derived field");
});

// -----------------------------------------------------------------------------
// Metric purity (only triggers when metric body has hostile shape; current
// parser doesn't allow set/add inside metric expressions, but the validator
// is the safety net)
// -----------------------------------------------------------------------------

// -----------------------------------------------------------------------------
// Explicit `reads u previous` declarations must match inferred set.
// -----------------------------------------------------------------------------

test("explicit `reads u previous` matching the cell body's @prev usage compiles", () => {
  compileV2(`
recipe "Wave"
substrate geodesic frequency 16
field u: f32
step {
  stage propagate {
    reads u, u previous
    writes u
    cell { set u = 2*u - u@prev }
  }
}
`);
});

test("explicit `reads u previous` declared but never used in the body errors", () => {
  expectThrow(() => compileV2(`
recipe "Wave"
substrate geodesic frequency 16
field u: f32
step {
  stage propagate {
    reads u, u previous
    writes u
    cell { set u = u + 1 }
  }
}
`), "but the cell body never reads u@prev");
});

test("cell body uses @prev but explicit-previous list omits it errors", () => {
  expectThrow(() => compileV2(`
recipe "Wave"
substrate geodesic frequency 16
field u: f32
field v: f32
step {
  stage propagate {
    reads u, u previous, v
    writes u, v
    cell { set u = u - u@prev - v@prev; set v = v }
  }
}
`), "doesn't list `v previous`");
});

test("no explicit `previous` declarations falls back to silent inference", () => {
  // No `<field> previous` mentioned anywhere — the inference path
  // takes over silently. This is what every shipped recipe does.
  compileV2(`
recipe "Wave"
substrate geodesic frequency 16
field u: f32
step {
  stage propagate {
    reads u
    writes u
    cell { set u = 2*u - u@prev }
  }
}
`);
});

// -----------------------------------------------------------------------------
// Retired stage primitives — diffuse / clamp / normalize have to be
// expressed as cell expressions in v2.
// -----------------------------------------------------------------------------

test("`diffuse` as a stage primitive is rejected (use cell expression)", () => {
  expectThrow(() => compileV2(`
recipe "X"
substrate geodesic frequency 16
field u: f32
step {
  stage step1 {
    reads u
    writes u
    diffuse u amount 0.1
  }
}
`), "no longer a stage primitive");
});

test("`clamp` as a stage primitive is rejected (use cell expression)", () => {
  expectThrow(() => compileV2(`
recipe "X"
substrate geodesic frequency 16
field u: f32
step {
  stage step1 {
    reads u
    writes u
    clamp u 0 1
  }
}
`), "no longer a stage primitive");
});

test("`wind` as a stage primitive is rejected (use gradient/divergence cell stage)", () => {
  expectThrow(() => compileV2(`
recipe "X"
substrate geodesic frequency 16
field pressure: f32
field windU: f32
field windV: f32
field lift: f32
step {
  stage compute {
    reads pressure
    writes windU, windV, lift
    wind pressure -> windU, windV, lift strength 1
  }
}
`), "no longer a stage primitive in v2");
});

test("wind cell pattern (gradient + divergence) compiles", () => {
  // Replacement for the wind primitive: a cell stage that uses
  // gradient(scalar) → vec2 + divergence(vec2) → scalar to compute
  // pressure-driven wind + lift as plain cell expressions.
  compileV2(`
recipe "X"
substrate geodesic frequency 16
field pressure: f32
field wind: vec2
field lift: f32 derived
param strength slider 0..2 default 1 label "WIND"
step {
  stage compute_wind {
    reads pressure, wind
    writes wind, lift
    cell {
      let grad = gradient(pressure)
      let cor = clamp(py, -1, 1) * 0.65
      set wind = vec2(-grad.x + cor*grad.y, -grad.y - cor*grad.x) * strength
      set lift = -divergence(wind) * 0.7
    }
  }
}
`);
});

test("`advect` as a stage primitive is rejected (use @upstream cell stage)", () => {
  expectThrow(() => compileV2(`
recipe "X"
substrate geodesic frequency 16
field u: f32
field windU: f32
field windV: f32
step {
  stage flow {
    reads u, windU, windV
    writes u
    advect u by windU, windV dt 0.1
  }
}
`), "no longer a stage primitive in v2");
});

test("@upstream coord query compiles and emits the per-field sample helper", () => {
  // Replacement for the advect primitive: cell stage that samples a
  // field at the back-position computed from velocity*dt.
  compileV2(`
recipe "X"
substrate geodesic frequency 16
field u: f32
field slope: vec2
step {
  stage flow {
    reads u, slope
    writes u
    cell {
      set u = u@upstream(slope.x, slope.y, 0.1)
    }
  }
}
`);
});

test("count cells with a body is rejected (count's body is implicitly 1)", () => {
  expectThrow(() => compileV2(`
recipe "X"
substrate geodesic frequency 16
field u: f32
step { stage s { reads u; writes u; cell { set u = u } } }
metric bad = count cells where u > 0 { u }
`), "count cells does not take a body");
});

test("metric body referencing an undeclared field is rejected", () => {
  expectThrow(() => compileV2(`
recipe "X"
substrate geodesic frequency 16
field u: f32
step { stage s { reads u; writes u; cell { set u = u } } }
metric bad = max cells { missing_field }
`), "unknown identifier");
});

test("metric where-predicate referencing an undeclared field is rejected", () => {
  expectThrow(() => compileV2(`
recipe "X"
substrate geodesic frequency 16
field u: f32
step { stage s { reads u; writes u; cell { set u = u } } }
metric bad = sum cells where missing > 0 { u }
`), "unknown identifier");
});

// -----------------------------------------------------------------------------
// Metric expression validation — bool body, import constraint coverage
// -----------------------------------------------------------------------------

test("mean cells { u > 0 } rejected (bool body)", () => {
  expectThrow(() => compileV2(`
recipe "X"
substrate geodesic frequency 16
field u: f32
step { stage s { reads u; writes u; cell { set u = u } } }
metric frac = mean cells { u > 0 }
`), "boolean (comparison");
});

test("sum cells { u && u } rejected (logical body)", () => {
  expectThrow(() => compileV2(`
recipe "X"
substrate geodesic frequency 16
field u: f32
step { stage s { reads u; writes u; cell { set u = u } } }
metric weird = sum cells { u && u }
`), "boolean (comparison");
});

test("mean cells { u > 0 ? 1 : 0 } accepted (conditional → numeric)", () => {
  // The bool happens INSIDE a conditional, so the top-level expression
  // is a Conditional that produces a numeric. Allowed.
  compileV2(`
recipe "X"
substrate geodesic frequency 16
field u: f32
step { stage s { reads u; writes u; cell { set u = u } } }
metric active_frac = mean cells { u > 0 ? 1 : 0 }
`);
});

test("explicit imports — metric body using lon without import errors", () => {
  expectThrow(() => compileV2(`
recipe "X"
substrate geodesic frequency 16
import sin
field u: f32
step { stage s { reads u; writes u; cell { set u = u } } }
metric weighted = sum cells { sin(u) * lon }
`), "geo.lon is not imported");
});

test("explicit imports — metric body using TAU without import errors", () => {
  expectThrow(() => compileV2(`
recipe "X"
substrate geodesic frequency 16
import abs
field u: f32
step { stage s { reads u; writes u; cell { set u = u } } }
metric scaled = sum cells { abs(u) * TAU }
`), "geo.TAU is not imported");
});

test("explicit imports — metric body using neighbor reduction without import errors", () => {
  expectThrow(() => compileV2(`
recipe "X"
substrate geodesic frequency 16
import abs
field u: f32
step { stage s { reads u; writes u; cell { set u = u } } }
metric grad = max cells { sum n in neighbors { u@n - u } }
`), "core.neighbor is not imported");
});

test("explicit imports — metric body using @prev without import errors", () => {
  expectThrow(() => compileV2(`
recipe "X"
substrate geodesic frequency 16
import abs
field u: f32
step {
  stage s { reads u; writes u; cell { set u = u + u@prev } }
}
metric drift = max cells { abs(u@prev - u) }
`), "clock.prev is not imported");
});

test("explicit imports — metric body using only imported names compiles", () => {
  compileV2(`
recipe "X"
substrate geodesic frequency 16
import abs, sin, lon
field u: f32
step { stage s { reads u; writes u; cell { set u = u } } }
metric weighted = sum cells { abs(u) * sin(lon) }
`);
});

test("metric reduction op must be one of the five", () => {
  expectThrow(() => compileV2(`
recipe "X"
substrate geodesic frequency 16
field u: f32
step { stage s { reads u; writes u; cell { set u = u } } }
metric weird = median cells { u }
`), "unknown reduction");
});

// -----------------------------------------------------------------------------
// Imports — when present, validation-only constraint. When absent, all
// builtins in scope.
// -----------------------------------------------------------------------------

test("recipe with no `import` line accepts every builtin", () => {
  // Sanity: the converted recipes don't declare imports and use lots of
  // builtins; this just confirms the no-import path keeps working.
  compileV2(`
recipe "X"
substrate geodesic frequency 16
field u: f32
step {
  stage s {
    reads u
    writes u
    cell {
      let avg = mean n in neighbors { u@n }
      set u = clamp(sin(u) * cos(u) + avg, -1, 1)
    }
  }
}
`);
});

test("explicit imports constrain — using a builtin not imported is rejected", () => {
  expectThrow(() => compileV2(`
recipe "X"
substrate geodesic frequency 16
import sin
field u: f32
step {
  stage s {
    reads u
    writes u
    cell { set u = cos(u) }
  }
}
`), "core.cos is not imported");
});

test("explicit imports — listing the right names compiles", () => {
  compileV2(`
recipe "X"
substrate geodesic frequency 16
import sin, cos, clamp
field u: f32
step {
  stage s {
    reads u
    writes u
    cell { set u = clamp(sin(u) + cos(u), -1, 1) }
  }
}
`);
});

test("import of an unknown name fails fast", () => {
  expectThrow(() => compileV2(`
recipe "X"
substrate geodesic frequency 16
import sin, totallyMadeUpFunction
field u: f32
step {
  stage s { reads u; writes u; cell { set u = sin(u) } }
}
`), "is not a recognized builtin");
});

test("import constrains clock builtins (e.g. `dt` requires import)", () => {
  expectThrow(() => compileV2(`
recipe "X"
substrate geodesic frequency 16
import sin
field u: f32
step {
  stage s {
    reads u
    writes u
    cell { set u = sin(u) * dt }
  }
}
`), "clock.dt is not imported");
});

test("metric name collision with field is rejected", () => {
  expectThrow(() => compileV2(`
recipe "X"
substrate geodesic frequency 16
field peak: f32
step { stage s { reads peak; writes peak; cell { set peak = peak } } }
metric peak = max cells { peak }
`), "name collides");
});

// -----------------------------------------------------------------------------
// Type checker — `typecheck-v2.mjs`. Catches the assignment-mismatch /
// wrong-shape errors that used to surface only at WGSL emit time.
// -----------------------------------------------------------------------------

test("type-check rejects assigning vec2 to f32 field", () => {
  expectThrow(() => compileV2(`
recipe "X"
substrate geodesic frequency 16
field u: f32
field wind: vec2
step {
  stage s { reads wind; writes u; cell { set u = wind } }
}
`), "assigning vec2 to f32 field");
});

test("type-check rejects assigning f32 to vec2 field", () => {
  expectThrow(() => compileV2(`
recipe "X"
substrate geodesic frequency 16
field u: f32
field wind: vec2
step {
  stage s { reads u; writes wind; cell { set wind = u } }
}
`), "assigning f32 to vec2 field");
});

test("type-check rejects vec2 in scalar metric body", () => {
  expectThrow(() => compileV2(`
recipe "X"
substrate geodesic frequency 16
field wind: vec2
step { stage s { reads wind; writes wind; cell { set wind = wind } } }
metric bad = sum cells { wind }
`), "produces a vec2");
});

test("type-check accepts length(wind) in scalar metric body", () => {
  // length(vec2) → f32, so the reduction is well-typed.
  compileV2(`
recipe "X"
substrate geodesic frequency 16
field wind: vec2
step { stage s { reads wind; writes wind; cell { set wind = wind } } }
metric speed = mean cells { length(wind) }
`);
});

test("type-check accepts vec2 component access in metric body", () => {
  compileV2(`
recipe "X"
substrate geodesic frequency 16
field wind: vec2
step { stage s { reads wind; writes wind; cell { set wind = wind } } }
metric ux = mean cells { wind.x }
`);
});

test("type-check rejects gradient on vec2 field", () => {
  // `gradient` is a tangent-frame stencil only defined on scalar fields.
  expectThrow(() => compileV2(`
recipe "X"
substrate geodesic frequency 16
field wind: vec2
field other: vec2
step {
  stage s { reads wind; writes other; cell { set other = gradient(wind) } }
}
`), "only defined on scalar");
});

test("type-check rejects divergence on f32 field", () => {
  expectThrow(() => compileV2(`
recipe "X"
substrate geodesic frequency 16
field u: f32
field d: f32
step {
  stage s { reads u; writes d; cell { set d = divergence(u) } }
}
`), "only defined on vec2");
});

test("type-check accepts well-typed vec2 wiring", () => {
  // wind is built from gradient(pressure); length(wind) flows into a
  // scalar field. All assignments shape-match.
  compileV2(`
recipe "X"
substrate geodesic frequency 16
field pressure: f32
field wind: vec2
field speed: f32
step {
  stage build { reads pressure; writes wind; cell { set wind = gradient(pressure) } }
  stage measure { reads wind; writes speed; cell { set speed = length(wind) } }
}
`);
});

test("type-check rejects non-bool when condition", () => {
  expectThrow(() => compileV2(`
recipe "X"
substrate geodesic frequency 16
field u: f32
field wind: vec2
step {
  stage s { reads wind; writes u; cell {
    when wind { set u = 0 }
  } }
}
`), "expected bool");
});

test("vec2 sum reduction is well-typed (result is vec2)", () => {
  // sum n in neighbors { wind@n } now returns vec2 directly (no
  // need to component-split). Assign to a vec2 field — clean.
  compileV2(`
recipe "X"
substrate geodesic frequency 16
field wind: vec2
field windSum: vec2
step {
  stage s { reads wind; writes windSum; cell {
    set windSum = sum n in neighbors { wind@n }
  } }
}
`);
});

test("vec2 mean reduction is well-typed (result is vec2)", () => {
  compileV2(`
recipe "X"
substrate geodesic frequency 16
field wind: vec2
field windMean: vec2
step {
  stage s { reads wind; writes windMean; cell {
    set windMean = mean n in neighbors { wind@n }
  } }
}
`);
});

test("vec2 sum reduction result must match assignment field type", () => {
  // Result of vec2 reduction is vec2; assigning to f32 field is
  // caught by the type checker via checkFieldAssignment.
  expectThrow(() => compileV2(`
recipe "X"
substrate geodesic frequency 16
field wind: vec2
field u: f32
step {
  stage s { reads wind; writes u; cell {
    set u = sum n in neighbors { wind@n }
  } }
}
`), "assigning vec2 to f32 field");
});

test("vec2 max reduction is rejected (no clean componentwise meaning)", () => {
  expectThrow(() => compileV2(`
recipe "X"
substrate geodesic frequency 16
field wind: vec2
field windMax: vec2
step {
  stage s { reads wind; writes windMax; cell {
    set windMax = max n in neighbors { wind@n }
  } }
}
`), "max over a vec2 isn't well-defined");
});

// -----------------------------------------------------------------------------
// Init-context expression subset (scenarios + stamps run on the JS init
// evaluator; some cell-stage grammar constructs aren't implemented there).
// -----------------------------------------------------------------------------

test("for-each-cell where filter parses + type-checks as bool", () => {
  // Sanity: bool predicate compiles. Body runs only on the matching
  // cells; the runtime test for that semantics is at the integration
  // layer (state changes), this just verifies the parser + validators
  // accept the shape.
  compileV2(`
recipe "X"
substrate geodesic frequency 16
field u: f32
scenario polar "Polar init" {
  for each cell where lat > 1.0 {
    set u = 1
  }
}
step { stage s { reads u; writes u; cell { set u = u } } }
`);
});

test("for-each-cell where rejects non-bool predicate", () => {
  expectThrow(() => compileV2(`
recipe "X"
substrate geodesic frequency 16
field u: f32
scenario init "init" {
  for each cell where lat {
    set u = 1
  }
}
step { stage s { reads u; writes u; cell { set u = u } } }
`), "expected bool predicate");
});

test("for-each-cell where predicate is subject to init-context subset", () => {
  // Same restrictions as the body — no neighbor reductions, no
  // CoordRead, etc.
  expectThrow(() => compileV2(`
recipe "X"
substrate geodesic frequency 16
field u: f32
scenario init "init" {
  for each cell where u@prev > 0.5 {
    set u = 1
  }
}
step { stage s { reads u; writes u; cell { set u = u } } }
`), "u@prev");
});

test("scenario for-each-cell rejects gradient(...)", () => {
  expectThrow(() => compileV2(`
recipe "X"
substrate geodesic frequency 16
field u: f32
field wind: vec2
scenario init "init" {
  for each cell {
    set wind = gradient(u)
  }
}
step { stage s { reads u, wind; writes u, wind; cell { set u = u; set wind = wind } } }
`), "tangent-frame stencil builtin");
});

test("scenario for-each-cell rejects neighbor reductions", () => {
  expectThrow(() => compileV2(`
recipe "X"
substrate geodesic frequency 16
field u: f32
scenario init "init" {
  for each cell {
    set u = sum n in neighbors { u@n }
  }
}
step { stage s { reads u; writes u; cell { set u = u } } }
`), "neighbor reductions");
});

test("scenario for-each-cell rejects @upstream", () => {
  expectThrow(() => compileV2(`
recipe "X"
substrate geodesic frequency 16
field u: f32
field slope: vec2
scenario init "init" {
  for each cell {
    set u = u@upstream(slope.x, slope.y, dt)
  }
}
step { stage s { reads u; writes u; cell { set u = u } } }
`), "u@upstream");
});

test("scenario for-each-cell rejects @prev (no previous tick at start)", () => {
  expectThrow(() => compileV2(`
recipe "X"
substrate geodesic frequency 16
field u: f32
scenario init "init" {
  for each cell {
    set u = u@prev
  }
}
step { stage s { reads u; writes u; cell { set u = u } } }
`), "u@prev");
});

test("stamp body rejects gradient(...) too", () => {
  expectThrow(() => compileV2(`
recipe "X"
substrate geodesic frequency 16
field u: f32
field wind: vec2
stamp paint "paint" {
  spot wind at brush.pos, radius=brush.r, amount=vec2(0, 0)
  spot u at brush.pos, radius=brush.r, amount=length(gradient(u))
}
step { stage s { reads u, wind; writes u, wind; cell { set u = u; set wind = wind } } }
`), "tangent-frame stencil builtin");
});

test("scenario for-each-cell accepts the cell-local subset", () => {
  // Sanity: the stuff scenarios CAN do (math, conditionals, locals,
  // bare-field reads, cellNoise / cellRand) compiles fine.
  compileV2(`
recipe "X"
substrate geodesic frequency 16
field u: f32
field wind: vec2
scenario init "init" {
  for each cell {
    let phase = lon * 2 + cellNoise(31, 1.5) * 0.1
    when phase > 0 {
      set u = sin(phase) * 0.5 + 0.5
    }
    set wind = vec2(cos(phase), sin(phase))
  }
}
step { stage s { reads u, wind; writes u, wind; cell { set u = u; set wind = wind } } }
`);
});

test("type-check rejects scalar amount on vec2 stamp", () => {
  // Reviewer-flagged: typecheck used to allow scalar `amount` for a
  // vec2 field, claiming "broadcast." The runtime does not broadcast;
  // it errors mid-paint. Catch at recipe load.
  expectThrow(() => compileV2(`
recipe "X"
substrate geodesic frequency 16
field wind: vec2
stamp blow "blow" {
  spot wind at brush.pos, radius=brush.r, amount=1
}
step { stage s { reads wind; writes wind; cell { set wind = wind } } }
`), "assigning f32 to vec2 field");
});

test("type-check accepts vec2 amount on vec2 stamp", () => {
  compileV2(`
recipe "X"
substrate geodesic frequency 16
field wind: vec2
stamp blow "blow" {
  spot wind at brush.pos, radius=brush.r, amount=vec2(1, 0)
}
step { stage s { reads wind; writes wind; cell { set wind = wind } } }
`);
});

test("type-check rejects vec2 amount on scalar stamp", () => {
  expectThrow(() => compileV2(`
recipe "X"
substrate geodesic frequency 16
field u: f32
stamp drop "drop" {
  spot u at brush.pos, radius=brush.r, amount=vec2(1, 0)
}
step { stage s { reads u; writes u; cell { set u = u } } }
`), "assigning vec2 to f32 field");
});

test("metric body @upstream rejects unknown identifier in coord args", () => {
  // Reviewer-flagged: validateMetricIdentifiers' CoordRead branch used
  // to check the sampled field but skip velX/velY/dt, so a typo in a
  // metric body emitted invalid WGSL.
  expectThrow(() => compileV2(`
recipe "X"
substrate geodesic frequency 16
field u: f32
step { stage s { reads u; writes u; cell { set u = u } } }
metric bad = max cells { u@upstream(nope, 0, dt) }
`), "nope");
});

test("metric body @upstream rejects vec2 in coord args (type check)", () => {
  expectThrow(() => compileV2(`
recipe "X"
substrate geodesic frequency 16
field u: f32
field slope: vec2
step { stage s { reads u; writes u; cell { set u = u } } }
metric bad = max cells { u@upstream(slope, 0, dt) }
`), "must be a scalar, got vec2");
});

test("type-check accepts @upstream coord-arg expressions on vec2 fields", () => {
  // Regression: the reviewer-flagged @upstream bug already covered the
  // dependency / validator paths; this confirms the new type checker
  // doesn't false-fire on the legitimate vec2-component coord-args.
  compileV2(`
recipe "X"
substrate geodesic frequency 16
field w: f32
field slope: vec2
step {
  stage flow { reads w, slope; writes w; cell {
    set w = w@upstream(slope.x, slope.y, dt)
  } }
}
`);
});
