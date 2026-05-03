// Field Lab DSL v2 validator.
//
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

    // count: no body required (the body is implicitly 1). Others require body.
    if (metric.op !== "count" && !metric.body) {
      throw new Error(`metric "${metric.id}": ${metric.op} requires a body \`{ ... }\``);
    }

    // Body must be pure: no set/add/emit/spot/etc. The body is parsed as an
    // expression already, so the only way an action could appear is via a
    // grammar bug — but check defensively.
    if (metric.body) ensureNoSideEffects(metric.body, `metric "${metric.id}"`);
    if (metric.predicate) ensureNoSideEffects(metric.predicate, `metric "${metric.id}" where`);

    // Metric expressions cannot themselves contain a metric reduction —
    // grid-level reductions only at the top level. Cell-level neighbor
    // reductions inside the metric expression are allowed.
    if (metric.body) ensureNoNestedMetricReduce(metric.body, `metric "${metric.id}"`);
    if (metric.predicate) ensureNoNestedMetricReduce(metric.predicate, `metric "${metric.id}" where`);
  }
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
