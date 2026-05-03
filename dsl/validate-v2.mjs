// Field Lab DSL v2 validator.
//
import { MATH_FUNCTIONS, STENCIL_HELPERS, CLOCK_HELPERS } from "./dsl-spec.mjs";
import { typecheckV2 } from "./typecheck-v2.mjs";

// Set of function names callable from inside a metric expression. Math
// fns + stencil helpers + clock helpers (prev). Builtin identifier
// references (lon, dt, etc.) are checked separately against
// METRIC_BUILTIN_IDENTIFIERS.
const metricCallees = new Set([
  ...MATH_FUNCTIONS.map((m) => m.name),
  ...STENCIL_HELPERS.map((s) => s.name),
  ...CLOCK_HELPERS.map((h) => h.name),
]);

// Layered on top of the v1 validator (which compile-v2 already runs):
// the v1 layer covers field uniqueness, reads/writes wiring, history-field
// rules, and stamp/scenario action shapes. This module adds the rules that
// only apply to v2's new constructs:
//
//   - Derived fields must be written by ≥1 stage
//   - Derived fields cannot be written by scenarios
//   - Derived fields cannot be written by stamps
//   - Metric expressions are pure (no set/add/emit calls)
//   - Metric expressions produce a scalar
//
// See dsl/V2-SPEC.md "Validator rules summary" for the full list. Spec
// rules that overlap with v1's are deliberately left to v1's validator.

export function validateV2(schema) {
  const derivedFields = new Set(
    (schema.fields ?? [])
      .filter((decl) => decl?.derived)
      .map((decl) => decl.name),
  );
  if (derivedFields.size > 0) {
    validateDerivedFields(schema, derivedFields);
  }
  validateMetrics(schema);
  validateExplicitPreviousReads(schema);
  validateImportsOnSchema(schema);
  validateInitExpressions(schema);
  validateRenderDecls(schema);
  // Type checking runs last: it relies on identifier resolution
  // (declared fields, params, etc.) being well-formed, which the
  // earlier passes guarantee. Catches the assignment-mismatch /
  // wrong-shape errors that used to surface only at WGSL emit time
  // with cryptic shader compile messages.
  typecheckV2(schema);
}

// =============================================================================
// Render decls — palette, view, overlay
// =============================================================================
//
// Render-side validation. The render runtime consumes these
// declarations after the JS materialize step, so failures here surface
// at recipe-load time rather than during the first render frame.
//
// Rules:
//   - palette names unique; ≥ 2 stops; t in [0, 1]; stops in
//     ascending t order; rgb components in 0..255.
//   - view ids unique; labels are free strings.
//   - view.field references a declared field.
//   - ramp views: range [a, b] has a ≠ b; references a real palette
//     OR carries inline stops with the same shape rules.
//   - wheel views: range [a, b] has a ≠ b. (Field type is unrestricted
//     since wheel hue-rotates by t = (v - a) / (b - a) — works for
//     any scalar source even if it isn't strictly an "angle".)
//   - expr views: body uses the cell-grammar subset usable at render
//     time — no field writes, no @prev / @n / @upstream, no neighbor
//     reductions, no gradient/divergence. Must `set red`, `set green`,
//     `set blue` on every code path. No other targets allowed.
//   - overlay names are in the registered set (`grid` for now).
const REGISTERED_OVERLAYS = new Set(["grid"]);
const VIEW_EXPR_OUTPUTS = new Set(["red", "green", "blue"]);

function validateRenderDecls(schema) {
  const palettes = schema.palettes ?? [];
  const views = schema.views ?? [];
  const overlays = schema.overlays ?? [];
  const fieldNames = new Set((schema.fields ?? []).map((d) => d.name));

  // Palettes — uniqueness + stop shape.
  const paletteSet = new Set();
  for (const p of palettes) {
    if (paletteSet.has(p.name)) throw new Error(`palette "${p.name}" declared more than once`);
    paletteSet.add(p.name);
    validateStops(p.stops, `palette "${p.name}"`);
  }

  // Views — uniqueness + per-kind validation.
  const viewSet = new Set();
  for (const v of views) {
    if (viewSet.has(v.id)) throw new Error(`view "${v.id}" declared more than once`);
    viewSet.add(v.id);
    if (v.kind === "ramp" || v.kind === "wheel") {
      if (!fieldNames.has(v.field)) {
        throw new Error(`view "${v.id}": references unknown field "${v.field}"`);
      }
      validateRange(v.range, `view "${v.id}" range`);
    }
    if (v.kind === "ramp") {
      if (v.paletteName) {
        if (!paletteSet.has(v.paletteName)) {
          throw new Error(`view "${v.id}": references undefined palette "${v.paletteName}"`);
        }
      } else if (v.stops) {
        validateStops(v.stops, `view "${v.id}" inline stops`);
      } else {
        throw new Error(`view "${v.id}": ramp requires either \`palette NAME\` or inline \`stops { ... }\``);
      }
    }
    if (v.kind === "expr") {
      validateExprViewBody(v.actions ?? [], `view "${v.id}" expr`);
    }
  }

  // Overlays — registered names only.
  const overlaySet = new Set();
  for (const o of overlays) {
    if (!REGISTERED_OVERLAYS.has(o.name)) {
      throw new Error(`overlay "${o.name}" is not a registered overlay (allowed: ${[...REGISTERED_OVERLAYS].join(", ")})`);
    }
    if (overlaySet.has(o.name)) throw new Error(`overlay "${o.name}" declared more than once`);
    overlaySet.add(o.name);
  }
}

function validateStops(stops, label) {
  if (!Array.isArray(stops) || stops.length < 2) {
    throw new Error(`${label}: needs at least 2 stops`);
  }
  let prevT = -Infinity;
  for (const s of stops) {
    if (typeof s.t !== "number" || s.t < 0 || s.t > 1) {
      throw new Error(`${label}: stop t=${s.t} out of [0, 1]`);
    }
    if (s.t < prevT) {
      throw new Error(`${label}: stops must be in ascending t order (got ${s.t} after ${prevT})`);
    }
    prevT = s.t;
    if (!Array.isArray(s.color) || s.color.length !== 3) {
      throw new Error(`${label}: stop at t=${s.t} must have a 3-component color`);
    }
    for (const c of s.color) {
      if (typeof c !== "number" || c < 0 || c > 255) {
        throw new Error(`${label}: stop at t=${s.t}: color component ${c} out of [0, 255]`);
      }
    }
  }
}

function validateRange(range, label) {
  if (!Array.isArray(range) || range.length !== 2) {
    throw new Error(`${label}: range must be [a, b]`);
  }
  if (range[0] === range[1]) {
    throw new Error(`${label}: range [${range[0]}, ${range[1]}] is empty (a must differ from b)`);
  }
}

// view's `color expr { ... }` body has tighter restrictions than a
// stage cell. View bodies run at render time on the JS side (no GPU
// stencil topology), so neighbor reductions, history reads, and
// stencil ops are all out. The body's only legal effects are setting
// the three color outputs.
function validateExprViewBody(actions, label, seenOutputs = null) {
  const isRoot = seenOutputs === null;
  const outputs = seenOutputs ?? new Set();
  for (const action of actions ?? []) {
    if (!action) continue;
    if (action.type === "let") {
      if (action.expr) walkViewExprForBannedOps(action.expr, label);
      continue;
    }
    if (action.type === "set" || action.type === "add") {
      if (!VIEW_EXPR_OUTPUTS.has(action.field)) {
        throw new Error(`${label}: only \`red\` / \`green\` / \`blue\` are valid \`set\` targets in a view body — saw "${action.field}"`);
      }
      if (action.type === "add") {
        throw new Error(`${label}: use \`set ${action.field} = ...\`, not \`add\` (view bodies are pure render expressions, no per-tick accumulation)`);
      }
      outputs.add(action.field);
      if (action.expr) walkViewExprForBannedOps(action.expr, label);
      continue;
    }
    if (action.type === "when") {
      if (action.condition) walkViewExprForBannedOps(action.condition, label);
      validateExprViewBody(action.actions ?? [], `${label} when`, outputs);
      continue;
    }
    throw new Error(`${label}: unsupported action "${action.type}" in view body`);
  }
  if (isRoot) {
    for (const channel of VIEW_EXPR_OUTPUTS) {
      if (!outputs.has(channel)) {
        throw new Error(`${label}: missing \`set ${channel} = ...\` (every code path must assign red, green, and blue)`);
      }
    }
  }
}

function walkViewExprForBannedOps(ast, label) {
  if (!ast || typeof ast !== "object") return;
  if (ast.type === "CoordRead") {
    const kind = ast.coord?.kind ?? "?";
    throw new Error(
      `${label}: \`${ast.field}@${kind}\` is not allowed in a view body. ` +
      `Views are evaluated at render time without GPU stencil topology — ` +
      `read the field at the cell directly with bare \`${ast.field}\`.`,
    );
  }
  if (ast.type === "NeighborReduce") {
    throw new Error(
      `${label}: neighbor reductions aren't allowed in a view body. ` +
      `Promote the reduction to a derived field, then read the derived ` +
      `field at this cell.`,
    );
  }
  if (ast.type === "Call" && ast.callee?.type === "Identifier") {
    const name = ast.callee.name;
    if (name === "gradient" || name === "divergence") {
      throw new Error(
        `${label}: \`${name}(...)\` is a tangent-frame stencil and only ` +
        `works inside a stage cell. Compute it there into a derived ` +
        `field and read the derived field here.`,
      );
    }
  }
  for (const k of Object.keys(ast)) {
    const v = ast[k];
    if (Array.isArray(v)) v.forEach((c) => walkViewExprForBannedOps(c, label));
    else if (v && typeof v === "object") walkViewExprForBannedOps(v, label);
  }
}

// =============================================================================
// Init-context expression subset
// =============================================================================
//
// Scenario and stamp bodies (top-level + `for each cell`) execute on
// the JS-side init evaluator, not on the GPU. The init evaluator
// implements only the cell-local subset of the cell-stage grammar:
// scalar / vec2 reads of a cell's own field values, math functions,
// vec2 / length / cellNoise / cellRand. It does NOT implement
// neighbor reductions, coordinate queries (`@prev` / `@n` /
// `@upstream`), or the tangent-frame stencil builtins
// (`gradient` / `divergence`) — those need GPU-side neighbor topology.
//
// Without this pass, a recipe like `scenario init { for each cell {
// set wind = gradient(u) } }` would compile clean and only fail when
// the user picked the scenario, with an opaque "unknown init function"
// error. Catch the unsupported constructs at recipe load with a
// pointer at the cell-stage form that does work.
const INIT_REJECTED_CALLEES = new Set(["gradient", "divergence"]);

function validateInitExpressions(schema) {
  for (const scenario of schema.presets ?? []) {
    walkInitActionsForExpressionSubset(
      scenario.actions ?? [],
      `scenario "${scenario.id}"`,
    );
  }
  for (const stamp of schema.stamps ?? []) {
    walkInitActionsForExpressionSubset(
      stamp.actions ?? [],
      `stamp "${stamp.id}"`,
    );
  }
}

function walkInitActionsForExpressionSubset(actions, label) {
  for (const action of actions) {
    if (!action) continue;
    // `predicate` covers the `for each cell where PRED { ... }` filter
    // expression, which lives at the iteration boundary rather than
    // inside the body. The runtime evaluates it for every cell to
    // decide whether to run the body, so it sees the same in-scope
    // identifiers and is subject to the same init-context subset.
    for (const key of ["lon", "lat", "radius", "amount", "value", "rx", "ry",
                       "angle", "lonMin", "lonMax", "latMin", "latMax",
                       "expr", "condition", "predicate"]) {
      if (action[key]) walkExprForInitSubset(action[key], label);
    }
    if (action.actions) {
      walkInitActionsForExpressionSubset(action.actions, `${label} ${action.type ?? "block"}`);
    }
  }
}

function walkExprForInitSubset(ast, label) {
  if (!ast || typeof ast !== "object") return;
  if (ast.type === "CoordRead") {
    const kind = ast.coord?.kind ?? "?";
    let hint;
    if (kind === "prev") {
      hint = "Scenarios run once at start-of-simulation; there's no `previous tick` to read from.";
    } else if (kind === "neighbor") {
      hint = "Use bare `${ast.field}` (current cell's value); neighbor reads only work in stage cells, where the GPU has the neighbor topology bound.";
    } else if (kind === "upstream") {
      hint = "Continuous-position sampling needs the GPU stencil; express the seeding pattern with bare-field reads + math, or move the logic into a stage cell.";
    } else {
      hint = "This coordinate query is GPU-only.";
    }
    throw new Error(`${label}: \`${ast.field}@${kind}\` is not supported in scenario / stamp bodies — ${hint}`);
  }
  if (ast.type === "NeighborReduce") {
    throw new Error(
      `${label}: neighbor reductions (\`<op> n in neighbors { ... }\`) are not supported in scenario / stamp bodies. ` +
      `Move the logic into a stage cell, or use bare-field math here.`,
    );
  }
  if (ast.type === "Call" && ast.callee?.type === "Identifier"
      && INIT_REJECTED_CALLEES.has(ast.callee.name)) {
    throw new Error(
      `${label}: \`${ast.callee.name}(...)\` is a tangent-frame stencil builtin and only works inside a stage cell. ` +
      `Compute it there and read the result here, or seed with a closed-form expression.`,
    );
  }
  for (const k of Object.keys(ast)) {
    const v = ast[k];
    if (Array.isArray(v)) v.forEach((c) => walkExprForInitSubset(c, label));
    else if (v && typeof v === "object") walkExprForInitSubset(v, label);
  }
}

// V2 import constraint. When the recipe declares no `import` line,
// every builtin is in scope (importedNames is null). When it does
// declare one, ONLY the listed names are accessible — using anything
// else errors with `<namespace>.<name> is not imported`. The check
// runs after the v1 shape validators so structural errors surface
// first; this layer adds the import-restriction errors on top.
//
// Replaces v1's per-namespace requireImport gating (which compile-v2
// no longer plumbs in for v2 recipes — see the permitAll sentinel
// in compile-v2.mjs). Implements the same constraint via a single
// flat-list lookup, which matches v2's user-facing import shape.
function validateImportsOnSchema(schema) {
  const imports = schema.importedNames;
  if (!imports) return;
  // Every imported name must be a recognized builtin. Catches typos
  // ("import xin") at the recipe-load boundary, not later when the
  // walker happens to find usage of the misspelled name.
  for (const name of imports) {
    if (!BUILTIN_NAMESPACE.has(name)) {
      throw new Error(
        `v2 import "${name}" is not a recognized builtin — drop it or check the spelling`,
      );
    }
  }
  const allowed = new Set(imports);
  // Names that shadow builtin identifiers — recipe-declared fields,
  // params, consts. A field named `u` shadows the geo-builtin `u`
  // (alias for projection x), so the walker must NOT flag `u` as a
  // missing import in expressions. Mirrors the WGSL compiler's
  // resolution-order: field/param/const wins, then builtin.
  const shadowed = new Set();
  for (const decl of schema.fields ?? []) shadowed.add(decl.name);
  for (const decl of schema.parameters ?? []) shadowed.add(decl.name);
  for (const decl of schema.constants ?? []) shadowed.add(decl.name);
  for (const name of Object.keys(schema.planet ?? {})) shadowed.add(name);
  const ctx = { allowed, shadowed };

  for (const scenario of schema.presets ?? []) {
    walkInitActionsForImports(scenario.actions ?? [], ctx, `scenario "${scenario.id}"`);
  }
  for (const stamp of schema.stamps ?? []) {
    walkInitActionsForImports(stamp.actions ?? [], ctx, `stamp "${stamp.id}"`);
  }
  for (const stage of schema.stages ?? []) {
    for (const stmt of stage.body?.statements ?? []) {
      if (stmt.type === "cell") {
        for (const action of stmt.actions ?? []) {
          walkActionForImports(action, ctx, `stage "${stage.id}" cell`);
        }
        continue;
      }
      if (stmt.type === "advect" && stmt.dt) {
        walkExprForImports(stmt.dt, ctx, `stage "${stage.id}" advect dt`);
      }
      if (stmt.type === "wind" && stmt.strength) {
        walkExprForImports(stmt.strength, ctx, `stage "${stage.id}" wind strength`);
      }
    }
  }
  // Metric body + predicate get richer identifier resolution in
  // validateMetricIdentifiers (which knows about scenario/stamp/stage
  // bindings too); the import check there covers the same cases.
}

function walkActionForImports(action, ctx, label) {
  if (!action) return;
  if (action.expr) walkExprForImports(action.expr, ctx, label);
  if (action.condition) walkExprForImports(action.condition, ctx, label);
  if (action.actions) for (const a of action.actions) walkActionForImports(a, ctx, label);
}

function walkInitActionsForImports(actions, ctx, label) {
  for (const action of actions) {
    if (!action) continue;
    for (const key of ["lon", "lat", "radius", "amount", "value", "rx", "ry", "angle",
                       "lonMin", "lonMax", "latMin", "latMax", "expr", "condition"]) {
      if (action[key]) walkExprForImports(action[key], ctx, label);
    }
    if (action.actions) walkInitActionsForImports(action.actions, ctx, label);
  }
}

function walkExprForImports(ast, ctx, label) {
  if (!ast || typeof ast !== "object") return;
  const { allowed, shadowed } = ctx;
  if (ast.type === "Identifier" && BUILTIN_NAMESPACE.has(ast.name) && !shadowed.has(ast.name)) {
    if (!allowed.has(ast.name)) {
      const ns = BUILTIN_NAMESPACE.get(ast.name);
      throw new Error(`${label}: ${ns}.${ast.name} is not imported`);
    }
  }
  if (ast.type === "Call" && ast.callee?.type === "Identifier") {
    const fnName = ast.callee.name;
    if (BUILTIN_NAMESPACE.has(fnName) && !shadowed.has(fnName) && !allowed.has(fnName)) {
      const ns = BUILTIN_NAMESPACE.get(fnName);
      throw new Error(`${label}: ${ns}.${fnName} is not imported`);
    }
  }
  if (ast.type === "NeighborReduce" && !allowed.has("neighbor")) {
    throw new Error(`${label}: core.neighbor is not imported`);
  }
  if (ast.type === "CoordRead" && ast.coord?.kind === "prev" && !allowed.has("prev")) {
    throw new Error(`${label}: clock.prev is not imported`);
  }
  for (const k of Object.keys(ast)) {
    const v = ast[k];
    if (Array.isArray(v)) v.forEach((c) => walkExprForImports(c, ctx, label));
    else if (v && typeof v === "object") walkExprForImports(v, ctx, label);
  }
}

// BUILTIN_NAMESPACE is declared further down — its IIFE references
// METRIC_BUILTIN_NAMESPACE which is initialized later in this file. The
// reference resolution happens at function-call time (TDZ for IIFE
// at top would crash); placing the IIFE after METRIC_BUILTIN_NAMESPACE
// keeps both available without circular import.

// Per V2-SPEC.md "Stage I/O": history depth is inferred from `@prev`
// usage by default, but a stage can also declare explicitly via
// `reads u previous`. When the explicit form is used, the declared
// set must match the inferred set bidirectionally — otherwise the
// declaration is misleading documentation.
//
// Rule:
//   - If a stage declares ANY field as `previous`, then:
//     - every declared-previous field must actually be read with @prev
//       in the cell body (else: "declared but never used")
//     - every field read with @prev in the cell body must be declared
//       (else: "used but not declared")
//   - If a stage declares no explicit previous, the inference is
//     silent — recipe authors don't have to opt in.
function validateExplicitPreviousReads(schema) {
  for (const stage of schema.stages ?? []) {
    const declared = new Set(stage.previousReads ?? []);
    if (declared.size === 0) continue;
    const inferred = collectStagePrevReads(stage);
    for (const name of declared) {
      if (!inferred.has(name)) {
        throw new Error(
          `stage "${stage.id}": declares \`reads ${name} previous\` but the cell body never reads ${name}@prev — ` +
          `drop the \`previous\` annotation or use ${name}@prev in the body`,
        );
      }
    }
    for (const name of inferred) {
      if (!declared.has(name)) {
        throw new Error(
          `stage "${stage.id}": cell body reads ${name}@prev but the stage's reads clause doesn't list \`${name} previous\` — ` +
          `add \`${name} previous\` to reads, or remove all \`<field> previous\` annotations to fall back to inference`,
        );
      }
    }
  }
}

function collectStagePrevReads(stage) {
  const out = new Set();
  function walk(ast) {
    if (!ast || typeof ast !== "object") return;
    if (ast.type === "CoordRead" && ast.coord?.kind === "prev") {
      out.add(ast.field);
    }
    if (ast.type === "Call" && ast.callee?.type === "Identifier" && ast.callee.name === "prev") {
      const arg = ast.args?.[0];
      if (arg?.type === "Identifier") out.add(arg.name);
    }
    for (const k of Object.keys(ast)) {
      const v = ast[k];
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") walk(v);
    }
  }
  for (const stmt of stage.body?.statements ?? []) {
    if (stmt.type === "cell") {
      for (const action of stmt.actions ?? []) walk(action);
    }
  }
  return out;
}

// =============================================================================
// Derived field rules
// =============================================================================

function validateDerivedFields(schema, derivedFields) {
  // Rule: every derived field must appear in `writes` of at least one stage.
  const stageWriters = new Map();   // field → set of stage ids
  for (const stage of schema.stages ?? []) {
    for (const f of stage.writes ?? []) {
      if (!stageWriters.has(f)) stageWriters.set(f, new Set());
      stageWriters.get(f).add(stage.id);
    }
  }
  for (const name of derivedFields) {
    if (!stageWriters.has(name)) {
      throw new Error(
        `derived field "${name}" has no writing stage — either declare a stage that writes ` +
        `${name} (commonly via \`set ${name} = <expr>\` in a cell { } block), or drop the ` +
        `\`derived\` modifier so the field can be set from scenarios/stamps directly`,
      );
    }
  }

  // Rule: scenarios cannot write derived fields. Walk every action looking
  // for the field being targeted. `fill`/`spot`/`ellipse`/`region` carry a
  // `field` property; `eachCell` actions recurse into `set`/`add` actions.
  for (const scenario of schema.presets ?? []) {
    walkInitActions(scenario.actions ?? [], (field) => {
      if (derivedFields.has(field)) {
        throw new Error(
          `scenario "${scenario.id}" writes derived field "${field}" — derived fields are ` +
          `computed by stages, not initialized by scenarios. Drop the \`derived\` modifier ` +
          `if you want to seed the field, or move the initialization into the writing stage.`,
        );
      }
    });
  }

  // Rule: stamps cannot write derived fields.
  for (const stamp of schema.stamps ?? []) {
    walkInitActions(stamp.actions ?? [], (field) => {
      if (derivedFields.has(field)) {
        throw new Error(
          `stamp "${stamp.id}" writes derived field "${field}" — derived fields are ` +
          `computed by stages, not painted directly. The user can paint a non-derived ` +
          `source field, and the derivation stage updates the dependent derived field next tick.`,
        );
      }
    });
  }
}

// Walk init-action tree (preset/stamp body), invoking `onField(name)` for
// every action that writes a field. Covers the v2 lowered shape:
//   fill/spot/ellipse/region → top-level field write
//   eachCell.actions          → per-cell set/add (and nested when)
function walkInitActions(actions, onField) {
  for (const a of actions) {
    if (!a) continue;
    if (a.type === "fill" || a.type === "spot" || a.type === "ellipse" || a.type === "region") {
      if (a.field) onField(a.field);
      continue;
    }
    if (a.type === "eachCell") {
      walkCellActions(a.actions ?? [], onField);
      continue;
    }
  }
}

function walkCellActions(actions, onField) {
  for (const a of actions) {
    if (!a) continue;
    if (a.type === "set" || a.type === "add") {
      if (a.field) onField(a.field);
      continue;
    }
    if (a.type === "when") {
      walkCellActions(a.actions ?? [], onField);
    }
  }
}

// =============================================================================
// Metric rules
// =============================================================================

function validateMetrics(schema) {
  const metrics = schema.metrics ?? [];
  if (metrics.length === 0) return;

  // Name uniqueness: metrics share the global namespace with fields/params/etc.
  const allNames = new Set();
  for (const decl of schema.fields ?? []) allNames.add(decl.name);
  for (const decl of schema.parameters ?? []) allNames.add(decl.name);
  for (const decl of schema.constants ?? []) allNames.add(decl.name);
  for (const decl of schema.presets ?? []) allNames.add(decl.id);
  for (const decl of schema.stamps ?? []) allNames.add(decl.id);
  for (const decl of schema.stages ?? []) allNames.add(decl.id);

  for (const metric of metrics) {
    if (allNames.has(metric.id)) {
      throw new Error(
        `metric "${metric.id}" name collides with another declaration in the recipe`,
      );
    }
    allNames.add(metric.id);

    // Reduction op must be one of the five.
    if (!["sum", "max", "min", "mean", "count"].includes(metric.op)) {
      throw new Error(`metric "${metric.id}": unknown reduction "${metric.op}"`);
    }

    // count has NO body. The body is implicitly the constant 1; the
    // `where` clause is the predicate. Other reductions REQUIRE a body.
    if (metric.op === "count" && metric.body) {
      throw new Error(
        `metric "${metric.id}": count cells does not take a body — the cell contributes 1 ` +
        `if the \`where\` clause matches. Drop the \`{ ... }\`, or use \`sum cells where ${"{"} ... ${"}"}\` ` +
        `if you want to count weighted by an expression`,
      );
    }
    if (metric.op !== "count" && !metric.body) {
      throw new Error(`metric "${metric.id}": ${metric.op} requires a body \`{ ... }\``);
    }

    // Body must be numeric. WGSL distinguishes bool from f32; mixing
    // them silently is a footgun (`mean cells { u > 0.1 }` compiles to
    // a shader that errors at GPU upload time with a confusing
    // type-mismatch message). Catch the common cases here — top-level
    // comparison / logical / negation — and redirect to the right form.
    if (metric.body && metric.op !== "count" && expressionTopLevelIsBool(metric.body)) {
      throw new Error(
        `metric "${metric.id}": ${metric.op} body produces a boolean (comparison / logical / not). ` +
        `Use \`count cells where <pred>\` for "fraction of cells matching", or \`mean cells { <pred> ? 1 : 0 }\` ` +
        `if you really want to average a boolean as 0/1.`,
      );
    }

    // Body must be pure: no set/add/spot/etc. (`emit` can't appear; the
    // parser already rejects it inside cell actions and metric bodies
    // are parsed as expressions, not action lists.)
    if (metric.body) ensureNoSideEffects(metric.body, `metric "${metric.id}"`);
    if (metric.predicate) ensureNoSideEffects(metric.predicate, `metric "${metric.id}" where`);

    // Metric expressions cannot themselves contain a metric reduction —
    // grid-level reductions only at the top level. Cell-level neighbor
    // reductions inside the metric expression are allowed.
    if (metric.body) ensureNoNestedMetricReduce(metric.body, `metric "${metric.id}"`);
    if (metric.predicate) ensureNoNestedMetricReduce(metric.predicate, `metric "${metric.id}" where`);

    // Identifier resolution: every bare name in the body / predicate must
    // resolve to a declared field, param, const, planet constant, or a
    // known builtin. Unknown names produce a clear error here instead of
    // failing later at WGSL compile time with a cryptic shader error.
    validateMetricIdentifiers(metric, schema);
  }
}

// Builtins that resolve as bare identifiers in metric expressions.
// Tagged with namespace so the import check can route to the right v1
// namespace when the recipe declares explicit imports.
const METRIC_BUILTIN_NAMESPACE = new Map([
  ["true", null], ["false", null], ["null", null], ["undefined", null],
  ["dt", "clock"], ["frame", "clock"],
  ["PI", "geo"], ["TAU", "geo"], ["N", "geo"],
  ["lon", "geo"], ["lat", "geo"], ["x", "geo"], ["y", "geo"],
  ["z", "geo"], ["u", "geo"], ["v", "geo"],
  ["px", "geo"], ["py", "geo"], ["pz", "geo"], ["i", "geo"],
]);
const METRIC_BUILTIN_IDENTIFIERS = new Set(METRIC_BUILTIN_NAMESPACE.keys());

// Flat lookup: builtin name → namespace, used by walkExprForImports
// for the "<namespace>.<name> is not imported" error message. Covers
// every callable + identifier-shape builtin v2 expressions can
// reference. Declared here (not at the top) because its IIFE merges
// in entries from METRIC_BUILTIN_NAMESPACE which is declared just
// above.
const BUILTIN_NAMESPACE = (() => {
  const map = new Map();
  for (const m of MATH_FUNCTIONS) map.set(m.name, "core");
  for (const s of STENCIL_HELPERS) map.set(s.name, "core");
  for (const h of CLOCK_HELPERS) map.set(h.name, "clock");
  for (const [name, ns] of METRIC_BUILTIN_NAMESPACE.entries()) {
    if (ns) map.set(name, ns);
  }
  return map;
})();

function metricImportError(name, namespace, label) {
  if (!namespace) return null;
  return new Error(`${label}: ${namespace}.${name} is not imported`);
}

function validateMetricIdentifiers(metric, schema) {
  const fieldNames = new Set((schema.fields ?? []).map((d) => d.name).filter(Boolean));
  const paramNames = new Set((schema.parameters ?? []).map((d) => d.name).filter(Boolean));
  const constNames = new Set((schema.constants ?? []).map((d) => d.name).filter(Boolean));
  const planetNames = new Set(Object.keys(schema.planet ?? {}));
  const importedNames = schema.importedNames; // null = no constraint
  const label = `metric "${metric.id}"`;
  function visitExpr(ast, locals) {
    if (!ast || typeof ast !== "object") return;
    switch (ast.type) {
      case "Number":
        return;
      case "Identifier": {
        const name = ast.name;
        if (locals.has(name)) return;
        if (fieldNames.has(name)) return;
        if (paramNames.has(name)) return;
        if (constNames.has(name)) return;
        if (planetNames.has(name)) return;
        if (METRIC_BUILTIN_IDENTIFIERS.has(name)) {
          // Explicit imports constrain ALL builtins (geo position
          // helpers, clock, math constants), not just clock — using
          // `lon`, `TAU`, `PI`, `frame`, `dt`, etc. without importing
          // them is an error when an `import` line is declared.
          if (importedNames && !importedNames.includes(name)) {
            const ns = METRIC_BUILTIN_NAMESPACE.get(name);
            const err = metricImportError(name, ns, label);
            if (err) throw err;
          }
          return;
        }
        throw new Error(`${label}: unknown identifier "${name}" — not a field, param, const, planet, or builtin`);
      }
      case "Member":
        visitExpr(ast.object, locals);
        return;
      case "Unary":
        visitExpr(ast.expr, locals);
        return;
      case "Binary":
        visitExpr(ast.left, locals);
        visitExpr(ast.right, locals);
        return;
      case "Conditional":
        visitExpr(ast.test, locals);
        visitExpr(ast.consequent, locals);
        visitExpr(ast.alternate, locals);
        return;
      case "Call": {
        // The callee is a math function name, not a regular identifier.
        // Resolve it against the function table — metricCallees covers
        // math fns + helpers + clock helpers (prev). Unknown function
        // names are an error here, before WGSL compilation gets a
        // mystery identifier.
        if (ast.callee?.type === "Identifier") {
          const fnName = ast.callee.name;
          if (!metricCallees.has(fnName)) {
            throw new Error(`${label}: unknown function "${fnName}"`);
          }
          if (importedNames && !importedNames.includes(fnName)) {
            // prev / dt / frame are clock; math fns are core. With
            // explicit imports the callee must be listed.
            throw new Error(`${label}: function "${fnName}" used but not imported`);
          }
          for (const arg of ast.args ?? []) visitExpr(arg, locals);
          return;
        }
        // Member-callee or other shape — defer to v1 (rare; recipes
        // don't currently emit it).
        visitExpr(ast.callee, locals);
        for (const arg of ast.args ?? []) visitExpr(arg, locals);
        return;
      }
      case "NeighborReduce": {
        // Cell-level reduction inside a metric expression — needs the
        // `neighbor` core helper to be imported when imports are
        // explicit. The body opens a new local scope for the binding.
        if (importedNames && !importedNames.includes("neighbor")) {
          throw new Error(`${label}: core.neighbor is not imported (required for \`<op> n in neighbors { ... }\`)`);
        }
        const bodyLocals = new Set(locals);
        for (const b of ast.bindings ?? []) {
          if (b.name) bodyLocals.add(b.name);
          if (b.field && !fieldNames.has(b.field)) {
            throw new Error(`${label}: neighbor reduction binds unknown field "${b.field}"`);
          }
        }
        visitExpr(ast.body, bodyLocals);
        return;
      }
      case "CoordRead": {
        // `field@<coord>` reads `field`. Verify field exists; coord
        // shape was enforced by the parser.
        if (!fieldNames.has(ast.field)) {
          throw new Error(`${label}: ${ast.field}@${ast.coord?.kind ?? "?"} — unknown field "${ast.field}"`);
        }
        // `field@prev` requires the `prev` clock helper to be imported
        // when imports are explicit (mirrors the cell-stage rule).
        if (ast.coord?.kind === "prev" && importedNames && !importedNames.includes("prev")) {
          throw new Error(`${label}: clock.prev is not imported (required for \`field@prev\`)`);
        }
        // `field@upstream(velX, velY, dt)` carries arbitrary expressions
        // for the velocity components and dt. Walk them through the same
        // identifier visitor so unknown identifiers + missing imports
        // surface at recipe load. Without this, `metric m = max cells {
        // u@upstream(undeclared, 0, dt) }` compiled clean and emitted
        // invalid WGSL referencing `undeclared`.
        if (ast.coord?.kind === "upstream") {
          visitExpr(ast.coord.velX, locals);
          visitExpr(ast.coord.velY, locals);
          visitExpr(ast.coord.dt, locals);
        }
        return;
      }
      default:
        for (const k of Object.keys(ast)) {
          const v = ast[k];
          if (Array.isArray(v)) v.forEach((c) => visitExpr(c, locals));
          else if (v && typeof v === "object") visitExpr(v, locals);
        }
    }
  }
  if (metric.body) visitExpr(metric.body, new Set());
  if (metric.predicate) visitExpr(metric.predicate, new Set());
}

function ensureNoSideEffects(ast, label) {
  if (!ast || typeof ast !== "object") return;
  // Action types should never appear inside an expression AST, but if a
  // future grammar tweak lifts one in by accident this catches it.
  // v2 doesn't have `emit` — the v1 event-emission action was retired
  // when we collapsed events into metrics — so it isn't listed.
  if (ast.type === "set" || ast.type === "add"
      || ast.type === "fill" || ast.type === "spot" || ast.type === "ellipse"
      || ast.type === "region" || ast.type === "eachCell") {
    throw new Error(`${label}: pure expressions only — found "${ast.type}"`);
  }
  for (const key of Object.keys(ast)) {
    const v = ast[key];
    if (Array.isArray(v)) v.forEach((c) => ensureNoSideEffects(c, label));
    else if (v && typeof v === "object") ensureNoSideEffects(v, label);
  }
}

// Heuristic: does the top-level node of EXPR produce a boolean? We
// don't have a real typer, but the common gotcha is recipe authors
// writing `mean cells { u > 0 }` expecting a fraction. Catch top-level
// comparison ops, logical and/or, and unary not. Conditionals are
// allowed (they may evaluate to numerics in their branches); deeply
// nested booleans inside arithmetic are not flagged here because by
// then the user has typically wrapped them in a conditional.
const COMPARISON_OPS = new Set([">", ">=", "<", "<=", "==", "!=", "===", "!=="]);
const LOGICAL_OPS = new Set(["&&", "||"]);
function expressionTopLevelIsBool(ast) {
  if (!ast || typeof ast !== "object") return false;
  if (ast.type === "Binary" && (COMPARISON_OPS.has(ast.op) || LOGICAL_OPS.has(ast.op))) return true;
  if (ast.type === "Unary" && ast.op === "!") return true;
  return false;
}

function ensureNoNestedMetricReduce(ast, label) {
  if (!ast || typeof ast !== "object") return;
  if (ast.type === "MetricReduce") {
    throw new Error(
      `${label}: nested grid-level reduction — \`<op> cells { ... }\` only allowed at ` +
      `the top of a metric declaration, not inside another expression`,
    );
  }
  for (const key of Object.keys(ast)) {
    const v = ast[key];
    if (Array.isArray(v)) v.forEach((c) => ensureNoNestedMetricReduce(c, label));
    else if (v && typeof v === "object") ensureNoNestedMetricReduce(v, label);
  }
}
