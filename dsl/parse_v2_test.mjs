// Smoke test for the v2 parser. Each test is a small standalone case that
// exercises one shape of the v2 grammar. Tests are sequential so that a
// failure in an earlier shape doesn't drown out later output.

import { parseV2 } from "./parse-v2.mjs";

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

function assert(cond, msg = "assertion failed") {
  if (!cond) throw new Error(msg);
}

function assertEq(actual, expected, msg = "") {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg}\n  expected: ${b}\n  actual:   ${a}`);
}

// -----------------------------------------------------------------------------
// Top-level directives
// -----------------------------------------------------------------------------

test("recipe + summary + substrate + one field + step with one stage", () => {
  const out = parseV2(`
recipe "Tiny"
summary "smoke test"
substrate geodesic frequency 16

field u: f32

step {
  stage step_u {
    reads u
    writes u
    cell { set u = u }
  }
}
`);
  assertEq(out.recipe, { name: "Tiny", summary: "smoke test" });
  assertEq(out.grid, { kind: "geodesic", frequency: 16, tiles: 16 });
  assert(out.fields.length === 1, "one field");
  assertEq(out.fields[0].name, "u");
  assertEq(out.fields[0].kind, "field");
  assertEq(out.fields[0].derived, false);
  assert(out.stages.length === 1, "one stage");
  assertEq(out.stages[0].id, "step_u");
  assertEq(out.stages[0].reads, ["u"]);
  assertEq(out.stages[0].writes, ["u"]);
});

// -----------------------------------------------------------------------------
// Field with `derived` annotation
// -----------------------------------------------------------------------------

test("field type and derived annotation", () => {
  const out = parseV2(`
recipe "Derived"
substrate geodesic frequency 16
field u: f32
field abs_u: f32 derived
step {
  stage step1 { reads u; writes u; cell { set u = u } }
  stage derive_abs { reads u; writes abs_u; cell { set abs_u = abs(u) } }
}
`);
  const u = out.fields.find(f => f.name === "u");
  const abs_u = out.fields.find(f => f.name === "abs_u");
  assertEq(u.derived, false);
  assertEq(abs_u.derived, true);
});

// -----------------------------------------------------------------------------
// Param sliders, toggles, defaults
// -----------------------------------------------------------------------------

test("param slider and toggle", () => {
  const out = parseV2(`
recipe "P"
substrate geodesic frequency 16
field u: f32
param speed slider 0..0.29 default 0.25 label "WAVE SPEED"
param damping slider 0..0.05 step 0.001 default 0 label "DAMPING"
param flag toggle default true label "FLAG"
step { stage s { reads u; writes u; cell { set u = u } } }
`);
  const params = out.parameters;
  assert(params.length === 3, `expected 3 params, got ${params.length}`);
  assertEq(params[0].name, "speed");
  assertEq(params[0].kind, "slider");
  assertEq(params[0].min, 0);
  assertEq(params[0].max, 0.29);
  assertEq(params[0].default, 0.25);
  assertEq(params[0].label, "WAVE SPEED");
  assertEq(params[1].step, 0.001);
  assertEq(params[2].kind, "toggle");
  assertEq(params[2].default, true);
});

// -----------------------------------------------------------------------------
// Scenario with set + spot
// -----------------------------------------------------------------------------

test("scenario with set and spot", () => {
  const out = parseV2(`
recipe "S"
substrate geodesic frequency 16
field u: f32

scenario droplet "Single droplet" {
  set u = 0
  spot u at lon=0, lat=0, radius=0.08, amount=1
}

step { stage s { reads u; writes u; cell { set u = u } } }
`);
  assert(out.presets.length === 1, "one scenario lowered to preset");
  const sc = out.presets[0];
  assertEq(sc.id, "droplet");
  assertEq(sc.label, "Single droplet");
  assert(sc.actions.length === 2, `2 actions, got ${sc.actions.length}`);
  assertEq(sc.actions[0].type, "fill");
  assertEq(sc.actions[0].field, "u");
  assertEq(sc.actions[1].type, "spot");
  assertEq(sc.actions[1].field, "u");
  // lon/lat/radius/amount are AST nodes
  assertEq(sc.actions[1].lon.type, "Number");
});

// -----------------------------------------------------------------------------
// Stamp with brush.pos shorthand
// -----------------------------------------------------------------------------

test("stamp with brush.pos shorthand", () => {
  const out = parseV2(`
recipe "S"
substrate geodesic frequency 16
field u: f32

stamp ripple "Drop ripple" {
  spot u at brush.pos, radius=brush.r, amount=1
}

step { stage s { reads u; writes u; cell { set u = u } } }
`);
  assert(out.stamps.length === 1, "one stamp");
  const st = out.stamps[0];
  assertEq(st.id, "ripple");
  assertEq(st.actions[0].type, "spot");
  // brush.pos lowered to bare lon/lat identifiers (matches v1's stamp environment)
  assertEq(st.actions[0].lon, { type: "Identifier", name: "lon" });
  assertEq(st.actions[0].lat, { type: "Identifier", name: "lat" });
});

// -----------------------------------------------------------------------------
// Cell-body @prev
// -----------------------------------------------------------------------------

test("u@prev lowers to Call(prev, [u])", () => {
  const out = parseV2(`
recipe "P"
substrate geodesic frequency 16
field u: f32
step {
  stage propagate {
    reads u
    writes u
    cell { set u = u - u@prev }
  }
}
`);
  const cell = out.stages[0].body.statements[0];
  assertEq(cell.type, "cell");
  const action = cell.actions[0];
  assertEq(action.type, "set");
  // expr should be Binary(-, Identifier(u), Call(prev, [Identifier(u)]))
  assertEq(action.expr.type, "Binary");
  assertEq(action.expr.right.type, "Call");
  assertEq(action.expr.right.callee, { type: "Identifier", name: "prev" });
  assertEq(action.expr.right.args[0], { type: "Identifier", name: "u" });
});

// -----------------------------------------------------------------------------
// Cell-centered neighbor reduction (single field)
// -----------------------------------------------------------------------------

test("sum n in neighbors { u@n - u } lowers to NeighborReduce", () => {
  const out = parseV2(`
recipe "L"
substrate geodesic frequency 16
field u: f32
step {
  stage diffuse_u {
    reads u
    writes u
    cell {
      let lap = sum n in neighbors { u@n - u }
      add u = lap * 0.05
    }
  }
}
`);
  const cell = out.stages[0].body.statements[0];
  const letAction = cell.actions[0];
  assertEq(letAction.type, "let");
  assertEq(letAction.name, "lap");
  const reduce = letAction.expr;
  assertEq(reduce.type, "NeighborReduce");
  assertEq(reduce.op, "sum");
  // Single field bound under the synthetic name `_n_u`
  assert(reduce.bindings.length === 1, `1 binding, got ${reduce.bindings.length}`);
  assertEq(reduce.bindings[0].field, "u");
  assertEq(reduce.bindings[0].name, "_n_u");
  // Body: Binary(-, Identifier(_n_u), Identifier(u))
  assertEq(reduce.body.type, "Binary");
  assertEq(reduce.body.left, { type: "Identifier", name: "_n_u" });
  assertEq(reduce.body.right, { type: "Identifier", name: "u" });
});

// -----------------------------------------------------------------------------
// Multi-field neighbor reduction (the cell-centered win)
// -----------------------------------------------------------------------------

test("sum n in neighbors { u@n + v@n } emits multi-binding reduction", () => {
  const out = parseV2(`
recipe "M"
substrate geodesic frequency 16
field u: f32
field v: f32
step {
  stage couple {
    reads u, v
    writes u
    cell {
      let coupling = sum n in neighbors { u@n + v@n - u - v }
      add u = coupling * 0.01
    }
  }
}
`);
  const reduce = out.stages[0].body.statements[0].actions[0].expr;
  assertEq(reduce.type, "NeighborReduce");
  // Two bindings: one per coord-bound field
  assert(reduce.bindings.length === 2, `2 bindings, got ${reduce.bindings.length}`);
  const fieldsBound = new Set(reduce.bindings.map(b => b.field));
  assert(fieldsBound.has("u") && fieldsBound.has("v"));
});

// -----------------------------------------------------------------------------
// Metric reductions
// -----------------------------------------------------------------------------

test("metric max cells { abs(u) }", () => {
  const out = parseV2(`
recipe "M"
substrate geodesic frequency 16
field u: f32
step { stage s { reads u; writes u; cell { set u = u } } }

metric peak = max cells { abs(u) }
`);
  assert(out.metrics.length === 1, "one metric");
  assertEq(out.metrics[0].id, "peak");
  assertEq(out.metrics[0].op, "max");
  assert(out.metrics[0].body !== null, "body parsed");
  assertEq(out.metrics[0].body.type, "Call");
});

test("metric count cells where abs(u) > 0.1 (no body)", () => {
  const out = parseV2(`
recipe "M"
substrate geodesic frequency 16
field u: f32
step { stage s { reads u; writes u; cell { set u = u } } }

metric active = count cells where abs(u) > 0.1
`);
  const m = out.metrics[0];
  assertEq(m.id, "active");
  assertEq(m.op, "count");
  assert(m.predicate !== null, "predicate present");
  assert(m.body === null, "no body for count");
});

// -----------------------------------------------------------------------------
// Full wave equation in v2 syntax (the milestone smoke test)
// -----------------------------------------------------------------------------

test("full wave-equation recipe parses end-to-end", () => {
  const source = `
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

metric peak    = max cells { abs(u) }
metric active  = count cells where abs(u) > 0.1
`;
  const out = parseV2(source);
  assertEq(out.recipe.name, "Wave equation");
  assert(out.stages.length === 1, "one stage");
  assert(out.metrics.length === 2, `2 metrics, got ${out.metrics.length}`);

  const cell = out.stages[0].body.statements[0];
  assert(cell.type === "cell", "stage body is a cell statement");
  assert(cell.actions.length === 3, `3 actions in cell, got ${cell.actions.length}`);
  assertEq(cell.actions[0].type, "let");
  assertEq(cell.actions[1].type, "let");
  assertEq(cell.actions[2].type, "set");

  // The `lap` let-binding is a NeighborReduce
  assertEq(cell.actions[0].expr.type, "NeighborReduce");
  // The final set has both u@prev calls in it
  function findCalls(ast, name, acc = []) {
    if (!ast || typeof ast !== "object") return acc;
    if (ast.type === "Call" && ast.callee?.name === name) acc.push(ast);
    for (const k of Object.keys(ast)) {
      if (Array.isArray(ast[k])) ast[k].forEach((c) => findCalls(c, name, acc));
      else if (typeof ast[k] === "object") findCalls(ast[k], name, acc);
    }
    return acc;
  }
  const prevCalls = findCalls(cell.actions[2].expr, "prev");
  assert(prevCalls.length === 1, `expected 1 prev() call in set, got ${prevCalls.length}`);
});
