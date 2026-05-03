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

test("duplicate field declaration is rejected", () => {
  // Surfaced by negative-fuzz-v2.mjs: the v1-shape name-uniqueness
  // check only fired on prior-kind != current-kind, so two `field`
  // declarations of the same name passed silently and the recipe
  // ended up with a duplicate `fields` entry the runtime couldn't
  // resolve cleanly. claim() now rejects same-name same-kind too.
  expectThrow(() => compileV2(`
recipe "X"
substrate geodesic frequency 16
field u: f32
field u: f32
step { stage s { reads u; writes u; cell { set u = u } } }
`), `field "u" is declared more than once`);
});

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
  expectThrow(() => compileV2(`recipe "X"
substrate geodesic frequency 16
field u: f32
field abs_u: f32 derived

scenarios {
  scenario init "init" {
    spot abs_u at lon=0, lat=0, radius=0.1, amount=1
  }
}

step {
  stage step1 { reads u; writes u; cell { set u = u } }
  stage derive { reads u; writes abs_u; cell { set abs_u = abs(u) } }
}`), "writes derived field");
});

test("scenario for-each-cell setting a derived field is rejected", () => {
  expectThrow(() => compileV2(`recipe "X"
substrate geodesic frequency 16
field u: f32
field abs_u: f32 derived

scenarios {
  scenario init "init" {
    for each cell {
      set abs_u = 0
    }
  }
}

step {
  stage step1 { reads u; writes u; cell { set u = u } }
  stage derive { reads u; writes abs_u; cell { set abs_u = abs(u) } }
}`), "writes derived field");
});

// -----------------------------------------------------------------------------
// Derived fields: not writable from stamps
// -----------------------------------------------------------------------------

test("stamp writing a derived field is rejected", () => {
  expectThrow(() => compileV2(`recipe "X"
substrate geodesic frequency 16
field u: f32
field abs_u: f32 derived

stamps {
  stamp paint "paint" {
    spot abs_u at brush.pos, radius=brush.r, amount=1
  }
}

step {
  stage step1 { reads u; writes u; cell { set u = u } }
  stage derive { reads u; writes abs_u; cell { set abs_u = abs(u) } }
}`), "writes derived field");
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

test("local name collides with WGSL reserved word", () => {
  // The WGSL emit drops the local's name straight into the shader,
  // so a name like `target` (which is a WGSL reserved word) blew up
  // with "name `target` is a reserved keyword" at GPU pipeline
  // creation. Now caught at recipe load with the standard
  // builtin-collision error.
  expectThrow(() => compileV2(`
recipe "X"
substrate geodesic frequency 16
field state: u32
step {
  stage s "S" {
    reads state
    writes state
    cell {
      let target = state + 1
      set state = target
    }
  }
}
`), "shadows a builtin/reserved identifier");
});

test("local name collides with WGSL type keyword", () => {
  expectThrow(() => compileV2(`
recipe "X"
substrate geodesic frequency 16
field u: f32
step {
  stage s "S" {
    reads u
    writes u
    cell {
      let f32 = u
      set u = f32
    }
  }
}
`), "shadows a builtin/reserved identifier");
});

// -----------------------------------------------------------------------------
// Render DSL — palette / view / overlay
// -----------------------------------------------------------------------------

test("render DSL: palette + ramp view compiles", () => {
  const out = compileV2(`recipe "X"
substrate geodesic frequency 16
field h: f32

views {
  palette WAVE {
    stop 0.0 color [40, 90, 200]
    stop 0.5 color [240, 240, 240]
    stop 1.0 color [200, 50, 30]
  }

  view height "Height" {
    color ramp h range [-1, 1] palette WAVE
  }
}

step { stage s { reads h; writes h; cell { set h = h } } }`);
  assert(out.dsl.palettes.length === 1, "palette in output");
  assert(out.dsl.views.length === 1, "view in output");
  assert(out.dsl.views[0].kind === "ramp" && out.dsl.views[0].paletteName === "WAVE",
    "ramp view should reference palette WAVE");
});

test("render DSL: wheel view", () => {
  const out = compileV2(`recipe "X"
substrate geodesic frequency 16
field theta: f32

views {
  view phase "Phase" {
    color wheel theta range [0, 6.283]
  }
}

step { stage s { reads theta; writes theta; cell { set theta = theta } } }`);
  const v = out.dsl.views[0];
  assert(v.kind === "wheel" && v.field === "theta", "wheel view shape");
});

test("render DSL: expr view requires red+green+blue assignments", () => {
  expectThrow(() => compileV2(`recipe "X"
substrate geodesic frequency 16
field h: f32

views {
  view custom "Custom" {
    color expr {
      set red = 100
      set green = 200
    }
  }
}

step { stage s { reads h; writes h; cell { set h = h } } }`), "missing top-level `set blue");
});

test("render DSL: expr view rejects red/green/blue assigned only inside when", () => {
  // Default-black silently masking a missing assignment was the
  // pre-fix bug — the validator counted assignments inside any branch.
  expectThrow(() => compileV2(`recipe "X"
substrate geodesic frequency 16
field h: f32

views {
  view custom "Custom" {
    color expr {
      set red = 100
      set green = 200
      when h > 0 {
        set blue = 250
      }
    }
  }
}

step { stage s { reads h; writes h; cell { set h = h } } }`), "missing top-level `set blue");
});

test("render DSL: expr view rejects unknown identifier", () => {
  expectThrow(() => compileV2(`recipe "X"
substrate geodesic frequency 16
field h: f32

views {
  view custom "Custom" {
    color expr {
      set red   = nope
      set green = 0
      set blue  = 0
    }
  }
}

step { stage s { reads h; writes h; cell { set h = h } } }`), 'unknown identifier "nope"');
});

test("render DSL: expr view rejects vec2 field used as scalar", () => {
  expectThrow(() => compileV2(`recipe "X"
substrate geodesic frequency 16
field h: f32
field wind: vec2

views {
  view custom "Custom" {
    color expr {
      set red   = wind * 100
      set green = 0
      set blue  = 0
    }
  }
}

step { stage s { reads h, wind; writes h; cell { set h = h + wind.x } } }`), "vec2 field `wind` can't be used as a scalar");
});

test("render DSL: expr view rejects unsupported call", () => {
  expectThrow(() => compileV2(`recipe "X"
substrate geodesic frequency 16
field h: f32

views {
  view custom "Custom" {
    color expr {
      set red   = cellNoise(7)
      set green = 0
      set blue  = 0
    }
  }
}

step { stage s { reads h; writes h; cell { set h = h } } }`), "unsupported call `cellNoise");
});

test("render DSL: expr view accepts allowed math + length(vec2)", () => {
  // Positive case: every legal feature exercised in one body.
  const out = compileV2(`recipe "X"
substrate geodesic frequency 16
const SCALE = 2.5
field h: f32
field wind: vec2
param k slider 0..1 step 0.01 default 0.5 label "K"

views {
  view custom "Custom" {
    color expr {
      let mag = length(wind)
      let lit = clamp(h * SCALE * k, 0, 1)
      set red   = sin(lit * PI) * 200 + 40
      set green = mag * 100 + wind.x * 5
      set blue  = sqrt(max(lit, 0)) * 255
    }
  }
}

step { stage s { reads h, wind; writes h; cell { set h = h + wind.x } } }`);
  assert(out.dsl.views[0].kind === "expr", "expr view present");
});

test("render DSL: range accepts const identifiers + PI / TAU", () => {
  const out = compileV2(`recipe "X"
substrate geodesic frequency 16
const HOT = 1.5
field theta: f32
field h: f32

views {
  view phaseV "Phase" {
    color wheel theta range [0, TAU]
  }

  view heatV "Heat" {
    color ramp h range [0, HOT] stops {
      stop 0 color [0, 0, 0]
      stop 1 color [255, 80, 0]
    }
  }
}

step { stage s { reads h, theta; writes h; cell { set h = h } } }`);
  assert(out.dsl.views[0].range[1] > 6 && out.dsl.views[0].range[1] < 7, "TAU resolved");
  assert(out.dsl.views[1].range[1] === 1.5, "HOT resolved");
});

test("render DSL: range rejects unknown const identifier", () => {
  expectThrow(() => compileV2(`recipe "X"
substrate geodesic frequency 16
field theta: f32

views {
  view phaseV "Phase" {
    color wheel theta range [0, NOPE]
  }
}

step { stage s { reads theta; writes theta; cell { set theta = theta } } }`), 'unknown constant "NOPE"');
});

test("render DSL: expr view rejects non-channel set targets", () => {
  expectThrow(() => compileV2(`recipe "X"
substrate geodesic frequency 16
field h: f32

views {
  view custom "Custom" {
    color expr {
      set h     = 1
      set red   = 100
      set green = 200
      set blue  = 50
    }
  }
}

step { stage s { reads h; writes h; cell { set h = h } } }`), "only `red` / `green` / `blue` are valid `set` targets");
});

test("render DSL: expr view rejects neighbor reductions", () => {
  expectThrow(() => compileV2(`recipe "X"
substrate geodesic frequency 16
field h: f32

views {
  view custom "Custom" {
    color expr {
      let avg = mean n in neighbors { h@n }
      set red   = avg * 255
      set green = avg * 255
      set blue  = avg * 255
    }
  }
}

step { stage s { reads h; writes h; cell { set h = h } } }`), "neighbor reductions aren't allowed");
});

test("render DSL: ramp range must have a != b", () => {
  expectThrow(() => compileV2(`recipe "X"
substrate geodesic frequency 16
field h: f32

views {
  palette P {
    stop 0 color [0, 0, 0]
    stop 1 color [255, 255, 255]
  }

  view bad "Bad" { color ramp h range [0.5, 0.5] palette P }
}

step { stage s { reads h; writes h; cell { set h = h } } }`), "empty");
});

test("render DSL: ramp references undeclared palette", () => {
  expectThrow(() => compileV2(`recipe "X"
substrate geodesic frequency 16
field h: f32

views {
  view bad "Bad" { color ramp h range [0, 1] palette MISSING }
}

step { stage s { reads h; writes h; cell { set h = h } } }`), "references undefined palette \"MISSING\"");
});

test("render DSL: overlay grid", () => {
  const out = compileV2(`recipe "X"
substrate geodesic frequency 16
field h: f32

views {
  overlay grid

  view h "H" {
    color ramp h range [0, 1] stops {
      stop 0 color [0, 0, 0]
      stop 1 color [255, 255, 255]
    }
  }
}

step { stage s { reads h; writes h; cell { set h = h } } }`);
  assert(out.dsl.overlays.length === 1 && out.dsl.overlays[0].name === "grid");
});

test("render DSL: inline stops form (no named palette)", () => {
  const out = compileV2(`recipe "X"
substrate geodesic frequency 16
field h: f32

views {
  view h "Heat" {
    color ramp h range [0, 1] stops {
      stop 0 color [20, 22, 18]
      stop 1 color [80, 220, 90]
    }
  }
}

step { stage s { reads h; writes h; cell { set h = h } } }`);
  const v = out.dsl.views[0];
  assert(v.kind === "ramp" && Array.isArray(v.stops) && v.stops.length === 2,
    "inline stops should land on the view");
});

test("type-check rejects let-local inside gradient(...) arg", () => {
  // gradient(local) silently produced wrong WGSL (the local
  // resolved to its cell-uniform value at every neighbor in the
  // emit). Validator now catches at recipe load.
  expectThrow(() => compileV2(`
recipe "X"
substrate geodesic frequency 16
field c: f32
field grad_out: vec2
step {
  stage s "S" {
    reads c
    writes grad_out
    cell {
      let mu = c * c - c
      set grad_out = gradient(mu)
    }
  }
}
`), "references local \"mu\"");
});

test("type-check rejects let-local inside divergence(...) arg", () => {
  expectThrow(() => compileV2(`
recipe "X"
substrate geodesic frequency 16
field wind: vec2
field d: f32
step {
  stage s "S" {
    reads wind
    writes d
    cell {
      let local_w = wind
      set d = divergence(local_w)
    }
  }
}
`), "references local \"local_w\"");
});

test("type-check accepts inline expression in gradient (no locals)", () => {
  // The non-local form of the same intent — inlining the local —
  // compiles fine. This is the suggested workaround in the error
  // message.
  compileV2(`
recipe "X"
substrate geodesic frequency 16
field c: f32
field grad_out: vec2
step {
  stage s "S" {
    reads c
    writes grad_out
    cell {
      set grad_out = gradient(c * c - c)
    }
  }
}
`);
});

test("for-each-cell where filter parses + type-checks as bool", () => {
  // Sanity: bool predicate compiles. Body runs only on the matching
  // cells; the runtime test for that semantics is at the integration
  // layer (state changes), this just verifies the parser + validators
  // accept the shape.
  compileV2(`recipe "X"
substrate geodesic frequency 16
field u: f32

scenarios {
  scenario polar "Polar init" {
    for each cell where lat > 1.0 {
      set u = 1
    }
  }
}

step { stage s { reads u; writes u; cell { set u = u } } }`);
});

test("for-each-cell where rejects non-bool predicate", () => {
  expectThrow(() => compileV2(`recipe "X"
substrate geodesic frequency 16
field u: f32

scenarios {
  scenario init "init" {
    for each cell where lat {
      set u = 1
    }
  }
}

step { stage s { reads u; writes u; cell { set u = u } } }`), "expected bool predicate");
});

test("for-each-cell where predicate is subject to init-context subset", () => {
  // Same restrictions as the body — no neighbor reductions, no
  // CoordRead, etc.
  expectThrow(() => compileV2(`recipe "X"
substrate geodesic frequency 16
field u: f32

scenarios {
  scenario init "init" {
    for each cell where u@prev > 0.5 {
      set u = 1
    }
  }
}

step { stage s { reads u; writes u; cell { set u = u } } }`), "u@prev");
});

test("scenario for-each-cell rejects gradient(...)", () => {
  expectThrow(() => compileV2(`recipe "X"
substrate geodesic frequency 16
field u: f32
field wind: vec2

scenarios {
  scenario init "init" {
    for each cell {
      set wind = gradient(u)
    }
  }
}

step { stage s { reads u, wind; writes u, wind; cell { set u = u; set wind = wind } } }`), "tangent-frame stencil builtin");
});

test("scenario for-each-cell rejects neighbor reductions", () => {
  expectThrow(() => compileV2(`recipe "X"
substrate geodesic frequency 16
field u: f32

scenarios {
  scenario init "init" {
    for each cell {
      set u = sum n in neighbors { u@n }
    }
  }
}

step { stage s { reads u; writes u; cell { set u = u } } }`), "neighbor reductions");
});

test("scenario for-each-cell rejects @upstream", () => {
  expectThrow(() => compileV2(`recipe "X"
substrate geodesic frequency 16
field u: f32
field slope: vec2

scenarios {
  scenario init "init" {
    for each cell {
      set u = u@upstream(slope.x, slope.y, dt)
    }
  }
}

step { stage s { reads u; writes u; cell { set u = u } } }`), "u@upstream");
});

test("scenario for-each-cell rejects @prev (no previous tick at start)", () => {
  expectThrow(() => compileV2(`recipe "X"
substrate geodesic frequency 16
field u: f32

scenarios {
  scenario init "init" {
    for each cell {
      set u = u@prev
    }
  }
}

step { stage s { reads u; writes u; cell { set u = u } } }`), "u@prev");
});

test("stamp body rejects gradient(...) too", () => {
  expectThrow(() => compileV2(`recipe "X"
substrate geodesic frequency 16
field u: f32
field wind: vec2

stamps {
  stamp paint "paint" {
    spot wind at brush.pos, radius=brush.r, amount=vec2(0, 0)
    spot u at brush.pos, radius=brush.r, amount=length(gradient(u))
  }
}

step { stage s { reads u, wind; writes u, wind; cell { set u = u; set wind = wind } } }`), "tangent-frame stencil builtin");
});

test("scenario for-each-cell accepts the cell-local subset", () => {
  // Sanity: the stuff scenarios CAN do (math, conditionals, locals,
  // bare-field reads, cellNoise / cellRand) compiles fine.
  compileV2(`recipe "X"
substrate geodesic frequency 16
field u: f32
field wind: vec2

scenarios {
  scenario init "init" {
    for each cell {
      let phase = lon * 2 + cellNoise(31, 1.5) * 0.1
      when phase > 0 {
        set u = sin(phase) * 0.5 + 0.5
      }
      set wind = vec2(cos(phase), sin(phase))
    }
  }
}

step { stage s { reads u, wind; writes u, wind; cell { set u = u; set wind = wind } } }`);
});

test("type-check rejects scalar amount on vec2 stamp", () => {
  // Reviewer-flagged: typecheck used to allow scalar `amount` for a
  // vec2 field, claiming "broadcast." The runtime does not broadcast;
  // it errors mid-paint. Catch at recipe load.
  expectThrow(() => compileV2(`recipe "X"
substrate geodesic frequency 16
field wind: vec2

stamps {
  stamp blow "blow" {
    spot wind at brush.pos, radius=brush.r, amount=1
  }
}

step { stage s { reads wind; writes wind; cell { set wind = wind } } }`), "assigning f32 to vec2 field");
});

test("type-check accepts vec2 amount on vec2 stamp", () => {
  compileV2(`recipe "X"
substrate geodesic frequency 16
field wind: vec2

stamps {
  stamp blow "blow" {
    spot wind at brush.pos, radius=brush.r, amount=vec2(1, 0)
  }
}

step { stage s { reads wind; writes wind; cell { set wind = wind } } }`);
});

test("type-check rejects vec2 amount on scalar stamp", () => {
  expectThrow(() => compileV2(`recipe "X"
substrate geodesic frequency 16
field u: f32

stamps {
  stamp drop "drop" {
    spot u at brush.pos, radius=brush.r, amount=vec2(1, 0)
  }
}

step { stage s { reads u; writes u; cell { set u = u } } }`), "assigning vec2 to f32 field");
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
