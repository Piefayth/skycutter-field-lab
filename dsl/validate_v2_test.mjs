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

test("`advect` as a stage primitive is accepted (kept until continuous-pos CoordRead lands)", () => {
  // klausmeier still uses advect; it stays a real v2 primitive.
  compileV2(`
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
