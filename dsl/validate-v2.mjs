// Field Lab DSL v2 validator.
//
import { MATH_FUNCTIONS, STENCIL_HELPERS, CLOCK_HELPERS } from "./dsl-spec.mjs";

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
}

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
  if (ast.type === "set" || ast.type === "add" || ast.type === "emit"
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
