// Smoke test for the strict CST-to-AST v2 front-end. Each test is a small
// standalone case that exercises one shape of the compiler-facing projection.
// Tests are sequential so an earlier failure does not drown out later output.

import { recipeCstToAst } from "./cst-to-ast-v2.mjs";
import { parseDslCst } from "./cst-v2.mjs";

function parseStrict(source) {
  return recipeCstToAst(parseDslCst(source), { strict: true });
}

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
  const out = parseStrict(`
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
  const out = parseStrict(`
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
  const out = parseStrict(`
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
  assertEq(params[0].kind, "param");      // matches v1 control-decl shape
  assertEq(params[0].type, "number");
  assertEq(params[0].control, "slider");
  assertEq(params[0].min, 0);
  assertEq(params[0].max, 0.29);
  assertEq(params[0].default, 0.25);
  assertEq(params[0].label, "WAVE SPEED");
  assertEq(params[1].step, 0.001);
  // Toggle = boolean control. controls.mjs renders this as a checkbox
  // by gating on type === "boolean".
  assertEq(params[2].type, "boolean");
  assertEq(params[2].default, true);
});

// -----------------------------------------------------------------------------
// Scenario with set + spot
// -----------------------------------------------------------------------------

test("scenario with set and spot", () => {
  const out = parseStrict(`
recipe "S"
substrate geodesic frequency 16
field u: f32

scenarios {
  scenario droplet "Single droplet" {
    set u = 0
    spot u at lon=0, lat=0, radius=0.08, amount=1
  }
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
// Scenario param overrides — `param NAME = VALUE` inside a scenario body
// captures into `paramOverrides` on the lowered preset.
// -----------------------------------------------------------------------------

test("scenario param overrides land on the preset AST", () => {
  const out = parseStrict(`
recipe "S"
substrate geodesic frequency 16
field u: f32
param A slider 0..4 step 0.1 default 2.0 label "A"
param B slider 0..8 step 0.1 default 3.0 label "B"

scenarios {
  scenario hopf "Hopf regime" {
    param A = 2.0
    param B = 5.5
    set u = 0
  }
  scenario plain "No overrides" {
    set u = 0
  }
}

step { stage s { reads u; writes u; cell { set u = u } } }
`);
  assert(out.presets.length === 2);
  const hopf = out.presets.find((p) => p.id === "hopf");
  const plain = out.presets.find((p) => p.id === "plain");
  assertEq(hopf.paramOverrides.A, 2.0);
  assertEq(hopf.paramOverrides.B, 5.5);
  assert(Object.keys(plain.paramOverrides).length === 0, "scenario without overrides has empty paramOverrides");
  // The `param` lines don't show up in actions — only `set u = 0` does.
  assert(hopf.actions.length === 1, `hopf has 1 action, got ${hopf.actions.length}`);
});

test("scenario param override accepts negative literals", () => {
  const out = parseStrict(`
recipe "S"
substrate geodesic frequency 16
field u: f32
param threshold slider -1..1 step 0.05 default 0 label "T"

scenarios {
  scenario neg "negative" {
    param threshold = -0.25
    set u = 0
  }
}

step { stage s { reads u; writes u; cell { set u = u } } }
`);
  assertEq(out.presets[0].paramOverrides.threshold, -0.25);
});

// -----------------------------------------------------------------------------
// Stamp with brush.pos shorthand
// -----------------------------------------------------------------------------

test("stamp with brush.pos shorthand", () => {
  const out = parseStrict(`
recipe "S"
substrate geodesic frequency 16
field u: f32

stamps {
  stamp ripple "Drop ripple" {
    spot u at brush.pos, radius=brush.r, amount=1
  }
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

test("grouped views, stamps, and scenarios sections", () => {
  const out = parseStrict(`
recipe "Sections"
substrate geodesic frequency 16
field u: f32

views {
  palette MONO {
    stop 0 color [0, 0, 0]
    stop 1 color [255, 255, 255]
  }
  view u "U" {
    color ramp u palette MONO
  }
}

stamps {
  stamp pulse {
    spot u at brush.pos, radius=brush.r, amount=1
  }
}

scenarios {
  scenario blank {
    set u = 0
  }
}

step { stage s { reads u; writes u; cell { set u = u } } }
`);
  assertEq(out.palettes.length, 1);
  assertEq(out.views.length, 1);
  assertEq(out.stamps.length, 1);
  assertEq(out.presets.length, 1);
});

test("top-level view/stamp/scenario blocks are rejected", () => {
  for (const [source, message] of [
    [`view u "U" { color wheel u }`, "`view` blocks must live inside `views"],
    [`palette P { stop 0 color [0,0,0] stop 1 color [1,1,1] }`, "`palette` blocks must live inside `views"],
    [`overlay grid`, "`overlay` declarations must live inside `views"],
    [`stamp paint { spot u at brush.pos, radius=brush.r, amount=1 }`, "`stamp` blocks must live inside `stamps"],
    [`scenario init { set u = 0 }`, "`scenario` blocks must live inside `scenarios"],
  ]) {
    let threw = "";
    try {
      parseStrict(`
recipe "Reject"
substrate geodesic frequency 16
field u: f32
${source}
step { stage s { reads u; writes u; cell { set u = u } } }
`);
    } catch (error) {
      threw = error.message;
    }
    assert(threw.includes(message), `expected ${message}, got ${threw}`);
  }
});

// -----------------------------------------------------------------------------
// Cell-body @prev
// -----------------------------------------------------------------------------

test("u@prev produces a CoordRead with coord.kind = prev", () => {
  // V2 coordinate-query model: u@prev is a first-class CoordRead AST
  // node, not a Call(prev, [u]) lowering. The compiler dispatches on
  // coord.kind to emit f_u_prev[cell] in WGSL.
  const out = parseStrict(`
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
  // expr is Binary(-, Identifier(u), CoordRead{ field: u, coord: { kind: prev } })
  assertEq(action.expr.type, "Binary");
  assertEq(action.expr.right.type, "CoordRead");
  assertEq(action.expr.right.field, "u");
  assertEq(action.expr.right.coord, { kind: "prev", depth: 1 });
});

// -----------------------------------------------------------------------------
// Cell-centered neighbor reduction (single field)
// -----------------------------------------------------------------------------

test("sum n in neighbors { u@n - u } produces NeighborReduce with CoordRead body", () => {
  const out = parseStrict(`
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
  // The reduction carries `coord: "n"` — the binding name. The body
  // emits CoordRead nodes; the compiler walks them to derive bindings,
  // there is no pre-rewriting at parse time.
  assertEq(reduce.type, "NeighborReduce");
  assertEq(reduce.op, "sum");
  assertEq(reduce.coord, "n");
  // Body: Binary(-, CoordRead{u@n}, Identifier(u))
  assertEq(reduce.body.type, "Binary");
  assertEq(reduce.body.left.type, "CoordRead");
  assertEq(reduce.body.left.field, "u");
  assertEq(reduce.body.left.coord, { kind: "neighbor", binding: "n" });
  assertEq(reduce.body.right, { type: "Identifier", name: "u" });
});

// -----------------------------------------------------------------------------
// Multi-field neighbor reduction (the cell-centered win)
// -----------------------------------------------------------------------------

test("sum n in neighbors { u@n + v@n } body has CoordRead per field", () => {
  const out = parseStrict(`
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
  assertEq(reduce.coord, "n");
  // Walk the body for CoordRead nodes — should find u@n and v@n.
  const fieldsRead = new Set();
  function walk(ast) {
    if (!ast || typeof ast !== "object") return;
    if (ast.type === "CoordRead" && ast.coord?.kind === "neighbor" && ast.coord.binding === "n") {
      fieldsRead.add(ast.field);
    }
    for (const k of Object.keys(ast)) {
      const v = ast[k];
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") walk(v);
    }
  }
  walk(reduce.body);
  assert(fieldsRead.has("u") && fieldsRead.has("v"), `expected u and v read; got ${[...fieldsRead].join(',')}`);
});

// -----------------------------------------------------------------------------
// Metric reductions
// -----------------------------------------------------------------------------

test("metric max cells { abs(u) }", () => {
  const out = parseStrict(`
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
  const out = parseStrict(`
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

metric peak    = max cells { abs(u) }
metric active  = count cells where abs(u) > 0.1
`;
  const out = parseStrict(source);
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
  // The final set has u@prev — walk the AST for CoordRead nodes with
  // coord.kind === "prev" (the v2 representation, replacing v1's
  // Call(prev, [u]) lowering).
  function findCoordReads(ast, kind, acc = []) {
    if (!ast || typeof ast !== "object") return acc;
    if (ast.type === "CoordRead" && ast.coord?.kind === kind) acc.push(ast);
    for (const k of Object.keys(ast)) {
      if (Array.isArray(ast[k])) ast[k].forEach((c) => findCoordReads(c, kind, acc));
      else if (typeof ast[k] === "object") findCoordReads(ast[k], kind, acc);
    }
    return acc;
  }
  // The wave-equation cell body contains u@prev twice (once in `damp`,
  // once in `raw`). Both are inside the final `set u = ...` action's
  // expression tree.
  const prevReads = findCoordReads(cell.actions[2].expr, "prev");
  assert(prevReads.length >= 1, `expected at least 1 u@prev read; got ${prevReads.length}`);
  for (const r of prevReads) assertEq(r.field, "u");
});
