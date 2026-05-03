// Field Lab DSL shape / structural validators.
//
// History: this module started life as the v1 validator. After v1 was
// retired its v1-specific bits (namespaced import gating, the
// `use NAMESPACE name` shape) were excised, and the rest survives as a
// reusable shape-validator suite that compile-v2.mjs calls into:
// reads/writes wiring, name uniqueness, history-field rules,
// scenario / stamp / metric structural shape, edge derivation.
//
// The exported entry points (validateNameUniqueness, validateStages,
// validatePresets, validateStamps, annotateStageParamRefs,
// buildDeclaredPipelineSummary, deriveEdges) take a parsed schema in
// the v1-shaped form (which v2 still emits — same `stages[].body`,
// `presets`, `stamps`, etc.).
//
// Internal helpers retain an `imports` parameter (now always
// `{ permitAll: true, historyFields: ... }` from compile-v2). The
// permitAll sentinel disables the legacy namespace gating in
// requireImport; the historyFields side-channel is read by
// validateCoordRead / validateCall when checking @prev usage. The
// flat v2 import constraint is enforced by validate-v2.mjs.

import {
  CLOCK_IDENTIFIERS,
  EXPR_FUNC_ARITY,
  EXPR_FUNC_TARGETS,
  GEO_IDENTIFIERS,
  STAMP_IDENTIFIERS,
  formatCallee,
} from "./expr-parser.mjs";
import { RESERVED_NAMES } from "./dsl-spec.mjs";

export function buildDeclaredPipelineSummary(stages) {
  return stages.flatMap((stage) => (stage.declares ?? []).map((name) => ({
    name,
    kind: "declared",
    scope: "pipeline",
    stage: stage.id,
  })));
}

export function annotateStageParamRefs(stages, schema) {
  const declaredParams = new Set((schema.parameters ?? []).map((decl) => decl.name).filter(Boolean));
  for (const stage of stages) {
    stage.params = collectParamRefs(stage.body, declaredParams);
  }
}

function collectParamRefs(body, declaredParams) {
  const refs = [];
  const seen = new Set();
  function add(name) {
    if (!declaredParams.has(name) || seen.has(name)) return;
    seen.add(name);
    refs.push(name);
  }
  for (const statement of body.statements ?? []) collectParamRefsFromStatement(statement, add);
  return refs;
}

function collectParamRefsFromStatement(statement, add) {
  if (statement.type === "cell" || statement.type === "each") {
    for (const action of statement.actions ?? []) collectParamRefsFromAction(action, add);
  } else if (statement.type === "event") {
    collectParamRefsFromExpr(statement.condition, add);
    for (const action of statement.actions ?? []) collectParamRefsFromAction(action, add);
  } else if (statement.type === "wind") {
    collectParamRefsFromExpr(statement.strength, add);
  } else if (statement.type === "advect") {
    collectParamRefsFromExpr(statement.dt, add);
  } else if (statement.type === "diffuse") {
    collectParamRefsFromExpr(statement.amount, add);
  } else if (statement.type === "clamp") {
    collectParamRefsFromExpr(statement.lo, add);
    collectParamRefsFromExpr(statement.hi, add);
  } else if (statement.type === "normalize") {
    collectParamRefsFromExpr(statement.damping, add);
    collectParamRefsFromExpr(statement.condition, add);
  }
}

function collectParamRefsFromAction(action, add) {
  if (action.type === "let") {
    collectParamRefsFromExpr(action.expr, add);
  } else if (action.type === "add" || action.type === "set") {
    collectParamRefsFromExpr(action.expr, add);
  } else if (action.type === "when") {
    collectParamRefsFromExpr(action.condition, add);
    for (const child of action.actions ?? []) collectParamRefsFromAction(child, add);
  }
}

function collectParamRefsFromExpr(ast, add) {
  if (!ast) return;
  switch (ast.type) {
    case "Identifier":
      add(ast.name);
      return;
    case "Member":
      collectParamRefsFromExpr(ast.object, add);
      return;
    case "Unary":
      collectParamRefsFromExpr(ast.expr, add);
      return;
    case "Binary":
      collectParamRefsFromExpr(ast.left, add);
      collectParamRefsFromExpr(ast.right, add);
      return;
    case "Conditional":
      collectParamRefsFromExpr(ast.test, add);
      collectParamRefsFromExpr(ast.consequent, add);
      collectParamRefsFromExpr(ast.alternate, add);
      return;
    case "Call":
      collectParamRefsFromExpr(ast.callee, add);
      for (const arg of ast.args ?? []) collectParamRefsFromExpr(arg, add);
      return;
    case "NeighborReduce":
      // Bindings introduce locals, but the body itself can still
      // reference params freely. Recurse — `add` will skip non-params.
      collectParamRefsFromExpr(ast.body, add);
      return;
    case "CoordRead":
      // `field@upstream(velX, velY, dt)` carries arbitrary expressions
      // for the velocity components and dt; walk them so a recipe
      // like `set w = w@upstream(0, 0, dt * speed)` correctly surfaces
      // `speed` in stage.params (the pipeline graph metadata uses it).
      // `@prev` and `@n` carry no sub-expressions; nothing to walk.
      if (ast.coord?.kind === "upstream") {
        collectParamRefsFromExpr(ast.coord.velX, add);
        collectParamRefsFromExpr(ast.coord.velY, add);
        collectParamRefsFromExpr(ast.coord.dt, add);
      }
      return;
    default:
      return;
  }
}
export function validateNameUniqueness(schema, stages = []) {
  const declaredBy = new Map();
  function claim(name, kind) {
    if (!name) return;
    const prior = declaredBy.get(name);
    if (prior) {
      // Same-kind duplicates were previously accepted because the
      // mismatch check only fired on prior !== kind. The recipe
      // ended up with two entries for the same name, which the
      // runtime lookups can't resolve cleanly (every site that
      // searches by name finds the first; the second is a quiet
      // shadow). Reject explicitly.
      if (prior === kind) {
        throw new Error(`${kind} "${name}" is declared more than once`);
      }
      throw new Error(`Name "${name}" is declared as both ${prior} and ${kind}; the DSL has one global namespace, rename one`);
    }
    declaredBy.set(name, kind);
  }
  // schema.fields is the union (`field` decls + `source` decls). Only
  // claim true field decls here so sources don't get claimed twice
  // (once as field, once below as source).
  for (const decl of schema.fields ?? []) {
    if (decl?.kind === "source") continue;
    claim(decl?.name, "field");
  }
  for (const decl of schema.sources ?? []) claim(decl?.name, "source");
  for (const decl of schema.settings ?? []) claim(decl?.name, "setting");
  for (const decl of schema.parameters ?? []) claim(decl?.name, "param");
  for (const decl of schema.constants ?? []) claim(decl?.name, "const");
  for (const name of Object.keys(schema.planet ?? {})) claim(name, "planet");
  for (const stage of stages ?? []) {
    for (const name of stage.declares ?? []) claim(name, "declared");
  }
  // Builtin names that recipe declarations can never shadow without
  // breaking semantics: literals (true/false), math fns, and stencil
  // helpers (neighborMax, ...) that DSL bodies invoke as function
  // calls. Driven by `RESERVED_NAMES` in dsl-spec — adding a math fn
  // or stencil helper automatically reserves its name.
  //
  // Geodesic position coordinates (x, y, lon, lat, u, v, px, py, pz, i)
  // and projection constants (PI, TAU, N) are deliberately NOT in the
  // reserved set — recipes can declare e.g. `field u, v` (FitzHugh-
  // Nagumo's two scalars), in which case a bare reference resolves to
  // the field. The position coord is then unreachable inside that
  // recipe's stages, which is the recipe author's choice.
  for (const [name, kind] of declaredBy) {
    if (RESERVED_NAMES.has(name)) {
      throw new Error(`Name "${name}" (${kind}) collides with a builtin/reserved identifier; rename it`);
    }
  }
}

export function validateStages(stages, schema = {}) {
  const ids = new Set();
  const declaredFields = new Set((schema.fields ?? []).map((decl) => decl.name).filter(Boolean));
  const sourceFields = new Set((schema.sources ?? []).map((decl) => decl.name).filter(Boolean));
  const declaredParams = new Set((schema.parameters ?? []).map((decl) => decl.name).filter(Boolean));
  const declaredConstants = new Set((schema.constants ?? []).map((decl) => decl.name).filter(Boolean));
  const declaredPlanet = new Set(Object.keys(schema.planet ?? {}));
  const declaredPipelineFields = new Set();
  for (const stage of stages) {
    for (const name of stage.declares ?? []) {
      if (declaredPipelineFields.has(name)) throw new Error(`Duplicate declared field: ${name}`);
      if (declaredFields.has(name)) throw new Error(`${stage.id}: declared field ${name} conflicts with recipe field`);
      declaredPipelineFields.add(name);
    }
  }
  const imports = buildImportSets(schema.imports ?? []);
  // Side-channel: stash the per-field history counts on the imports
  // object so `validateCall` can verify `prev(u)` references a field
  // declared with `history >= 1` without threading another positional
  // arg through the entire validate-* recursion.
  imports.historyFields = new Map(
    (schema.fields ?? [])
      .filter((decl) => (decl?.history ?? 0) > 0)
      .map((decl) => [decl.name, decl.history]),
  );
  // History fields rotate through three buffers ({prev, current, next})
  // exactly once per tick at the tick boundary. Any mid-tick swap
  // would scramble that rotation; therefore a history field can be
  // written by at most one stage per tick, and that stage may only
  // write it via cell statements (diffuse / clamp / advect / wind /
  // normalize all swap their target's buffers). Detect violations
  // here so recipe authors get a clean error rather than an
  // "Cannot swap history field" runtime explosion.
  const historyWriters = new Map();
  for (const stage of stages) {
    for (const field of stage.writes ?? []) {
      if (!imports.historyFields.has(field)) continue;
      const prior = historyWriters.get(field);
      if (prior) {
        throw new Error(
          `${stage.id}: history field "${field}" is written by multiple stages ` +
          `("${prior}" and "${stage.id}") — fold the writes into a single stage so ` +
          `the {prev, current, next} rotation stays consistent`,
        );
      }
      historyWriters.set(field, stage.id);
    }
  }
  for (const stage of stages) {
    const stageHistoryWrites = (stage.writes ?? []).filter((field) => imports.historyFields.has(field));
    if (stageHistoryWrites.length === 0) continue;
    for (const statement of stage.body.statements ?? []) {
      if (statement.type === "cell" || statement.type === "each" || statement.type === "event") continue;
      // Any statement that targets a history field with a non-cell
      // primitive (the ones that buffer-swap their write) breaks the
      // single-write-per-tick rotation invariant.
      const target = statement.field;
      if (target && stageHistoryWrites.includes(target)) {
        throw new Error(
          `${stage.id}: history field "${target}" cannot be written by ${statement.type} ` +
          `(history fields rotate at the tick boundary; mid-tick swaps from diffuse/clamp/` +
          `advect/wind/normalize would scramble the rotation). Fold the operation into the ` +
          `cell { ... } that produces the new value.`,
        );
      }
    }
  }
  // Every history field must have exactly one writer. Without one, the
  // pipeline runtime still rotates indices each tick — `next` (which is
  // uninitialized scratch) becomes `current` after the first tick,
  // poisoning the field with garbage. Catch it here rather than letting
  // the user see uninitialized GPU memory render to screen.
  for (const fieldName of imports.historyFields.keys()) {
    if (!historyWriters.has(fieldName)) {
      throw new Error(
        `history field "${fieldName}" has no writing stage — declare a stage that ` +
        `writes ${fieldName} via cell { set ${fieldName} = ... } or drop the \`history\` ` +
        `modifier. Without a writer, the {prev, current, next} rotation cycles ` +
        `uninitialized scratch into current after the first tick.`,
      );
    }
  }
  // History-field reads outside the writer stage break ordering: stages
  // BEFORE the writer correctly see u_N (the current view), but stages
  // AFTER the writer would expect u_{N+1} (just-written) and instead
  // get u_N (because the rotation only happens at end-of-tick — the
  // newly-written value sits in `next` until then, invisible to other
  // stages reading the bare identifier). Restrict reads to the writer's
  // stage and stages declared before it.
  const stageIndex = new Map(stages.map((stage, idx) => [stage.id, idx]));
  for (const stage of stages) {
    for (const field of stage.reads ?? []) {
      if (!imports.historyFields.has(field)) continue;
      const writerStage = historyWriters.get(field);
      if (!writerStage) continue; // already errored above
      if (stageIndex.get(stage.id) > stageIndex.get(writerStage)) {
        throw new Error(
          `${stage.id}: reads history field "${field}" after its writer "${writerStage}" — ` +
          `the new value sits in the rotation's "next" slot until end of tick, so this ` +
          `read sees the OLD value (pre-write). Move the read to a stage at-or-before ` +
          `"${writerStage}", or fold the dependent computation into "${writerStage}".`,
        );
      }
    }
  }
  const availableDeclaredFields = new Set();
  for (const stage of stages) {
    if (ids.has(stage.id)) throw new Error(`Duplicate stage id: ${stage.id}`);
    ids.add(stage.id);

    const reads = new Set(stage.reads);
    const writes = new Set(stage.writes);
    const declares = new Set(stage.declares);
    for (const name of declares) {
      if (reads.has(name)) throw new Error(`${stage.id}: declared field ${name} cannot also be read`);
      if (writes.has(name)) throw new Error(`${stage.id}: declared field ${name} cannot also be written`);
    }
    if (declaredFields.size > 0) {
      for (const field of reads) {
        if (!declaredFields.has(field) && !availableDeclaredFields.has(field)) {
          throw new Error(`${stage.id}: field ${field} is not declared`);
        }
      }
      for (const field of writes) {
        if (!declaredFields.has(field)) throw new Error(`${stage.id}: field ${field} is not declared`);
      }
    }
    for (const field of declares) {
      if (declaredFields.has(field)) throw new Error(`${stage.id}: declared field ${field} conflicts with recipe field`);
    }
    for (const field of writes) {
      if (sourceFields.has(field)) throw new Error(`${stage.id}: source ${field} is immutable and cannot be written`);
    }
    if (declaredParams.size > 0) {
      for (const param of stage.params ?? []) {
        if (!declaredParams.has(param)) throw new Error(`${stage.id}: param ${param} is not declared`);
      }
    }
    const readableFields = new Set(reads);
    for (const statement of stage.body.statements) {
      validateStatement(statement, stage, reads, writes, declares, readableFields, declaredParams, declaredConstants, declaredPlanet, imports);
    }
    for (const field of declares) availableDeclaredFields.add(field);
  }
}

export function validatePresets(presets, schema = {}) {
  const declaredFields = new Set((schema.fields ?? []).map((decl) => decl.name).filter(Boolean));
  const declaredParams = new Set((schema.parameters ?? []).map((decl) => decl.name).filter(Boolean));
  const declaredConstants = new Set((schema.constants ?? []).map((decl) => decl.name).filter(Boolean));
  const declaredPlanet = new Set(Object.keys(schema.planet ?? {}));
  const imports = buildImportSets(schema.imports ?? []);
  for (const preset of presets) {
    validatePresetActions(preset.actions, declaredFields, declaredParams, declaredConstants, declaredPlanet, imports, preset.id);
  }
}

export function validateStamps(stamps, schema = {}) {
  const ids = new Set();
  const declaredFields = new Set((schema.fields ?? []).map((decl) => decl.name).filter(Boolean));
  const sourceFields = new Set((schema.sources ?? []).map((decl) => decl.name).filter(Boolean));
  const declaredParams = new Set((schema.parameters ?? []).map((decl) => decl.name).filter(Boolean));
  const declaredConstants = new Set((schema.constants ?? []).map((decl) => decl.name).filter(Boolean));
  const declaredPlanet = new Set(Object.keys(schema.planet ?? {}));
  const imports = buildImportSets(schema.imports ?? []);
  for (const stamp of stamps) {
    if (ids.has(stamp.id)) throw new Error(`Duplicate stamp id: ${stamp.id}`);
    ids.add(stamp.id);
    validateStampActions(stamp.actions, declaredFields, sourceFields, declaredParams, declaredConstants, declaredPlanet, imports, stamp.id);
  }
}

function validateStampActions(actions, declaredFields, sourceFields, declaredParams, declaredConstants, declaredPlanet, imports, label, locals = new Set()) {
  const allFieldsVisible = declaredFields.size === 0 ? null : declaredFields;
  const extra = STAMP_IDENTIFIERS;
  for (const action of actions) {
    if (action.type === "spot") {
      requireImport(imports, "init", "spot", label);
      requireDeclaredField(action.field, declaredFields, label, "spot");
      requireMutableField(action.field, sourceFields, label, "spot");
      validateExpr(action.lon, allFieldsVisible ?? new Set(), locals, `${label} spot lon`, declaredParams, declaredConstants, declaredPlanet, imports, extra);
      validateExpr(action.lat, allFieldsVisible ?? new Set(), locals, `${label} spot lat`, declaredParams, declaredConstants, declaredPlanet, imports, extra);
      validateExpr(action.radius, allFieldsVisible ?? new Set(), locals, `${label} spot radius`, declaredParams, declaredConstants, declaredPlanet, imports, extra);
      validateExpr(action.amount, allFieldsVisible ?? new Set(), locals, `${label} spot amount`, declaredParams, declaredConstants, declaredPlanet, imports, extra);
    } else if (action.type === "ellipse") {
      requireImport(imports, "init", "ellipse", label);
      requireDeclaredField(action.field, declaredFields, label, "ellipse");
      requireMutableField(action.field, sourceFields, label, "ellipse");
      validateExpr(action.lon, allFieldsVisible ?? new Set(), locals, `${label} ellipse lon`, declaredParams, declaredConstants, declaredPlanet, imports, extra);
      validateExpr(action.lat, allFieldsVisible ?? new Set(), locals, `${label} ellipse lat`, declaredParams, declaredConstants, declaredPlanet, imports, extra);
      validateExpr(action.rx, allFieldsVisible ?? new Set(), locals, `${label} ellipse rx`, declaredParams, declaredConstants, declaredPlanet, imports, extra);
      validateExpr(action.ry, allFieldsVisible ?? new Set(), locals, `${label} ellipse ry`, declaredParams, declaredConstants, declaredPlanet, imports, extra);
      validateExpr(action.amount, allFieldsVisible ?? new Set(), locals, `${label} ellipse amount`, declaredParams, declaredConstants, declaredPlanet, imports, extra);
      validateExpr(action.angle, allFieldsVisible ?? new Set(), locals, `${label} ellipse angle`, declaredParams, declaredConstants, declaredPlanet, imports, extra);
    } else if (action.type === "region") {
      throw new Error(`${label}: stamp action region is not supported`);
    } else {
      throw new Error(`${label}: stamp action ${action.type} is not supported`);
    }
  }
}

function validatePresetActions(actions, declaredFields, declaredParams, declaredConstants, declaredPlanet, imports, label, locals = new Set()) {
  const allFieldsVisible = declaredFields.size === 0 ? null : declaredFields;
  const extra = GEO_IDENTIFIERS;
  for (const action of actions) {
    if (action.type === "fill") {
      requireImport(imports, "init", "fill", label);
      requireDeclaredField(action.field, declaredFields, label, "fill");
      validateExpr(action.value, allFieldsVisible ?? new Set(), locals, `${label} fill ${action.field}`, declaredParams, declaredConstants, declaredPlanet, imports, extra);
    } else if (action.type === "spot") {
      requireImport(imports, "init", "spot", label);
      requireDeclaredField(action.field, declaredFields, label, "spot");
      validateExpr(action.lon, allFieldsVisible ?? new Set(), locals, `${label} spot lon`, declaredParams, declaredConstants, declaredPlanet, imports, extra);
      validateExpr(action.lat, allFieldsVisible ?? new Set(), locals, `${label} spot lat`, declaredParams, declaredConstants, declaredPlanet, imports, extra);
      validateExpr(action.radius, allFieldsVisible ?? new Set(), locals, `${label} spot radius`, declaredParams, declaredConstants, declaredPlanet, imports, extra);
      validateExpr(action.amount, allFieldsVisible ?? new Set(), locals, `${label} spot amount`, declaredParams, declaredConstants, declaredPlanet, imports, extra);
    } else if (action.type === "ellipse") {
      requireImport(imports, "init", "ellipse", label);
      requireDeclaredField(action.field, declaredFields, label, "ellipse");
      validateExpr(action.lon, allFieldsVisible ?? new Set(), locals, `${label} ellipse lon`, declaredParams, declaredConstants, declaredPlanet, imports, extra);
      validateExpr(action.lat, allFieldsVisible ?? new Set(), locals, `${label} ellipse lat`, declaredParams, declaredConstants, declaredPlanet, imports, extra);
      validateExpr(action.rx, allFieldsVisible ?? new Set(), locals, `${label} ellipse rx`, declaredParams, declaredConstants, declaredPlanet, imports, extra);
      validateExpr(action.ry, allFieldsVisible ?? new Set(), locals, `${label} ellipse ry`, declaredParams, declaredConstants, declaredPlanet, imports, extra);
      validateExpr(action.amount, allFieldsVisible ?? new Set(), locals, `${label} ellipse amount`, declaredParams, declaredConstants, declaredPlanet, imports, extra);
      validateExpr(action.angle, allFieldsVisible ?? new Set(), locals, `${label} ellipse angle`, declaredParams, declaredConstants, declaredPlanet, imports, extra);
    } else if (action.type === "region") {
      requireImport(imports, "init", "region", label);
      requireDeclaredField(action.field, declaredFields, label, "region");
      validateExpr(action.lonMin, allFieldsVisible ?? new Set(), locals, `${label} region lon min`, declaredParams, declaredConstants, declaredPlanet, imports, extra);
      validateExpr(action.lonMax, allFieldsVisible ?? new Set(), locals, `${label} region lon max`, declaredParams, declaredConstants, declaredPlanet, imports, extra);
      validateExpr(action.latMin, allFieldsVisible ?? new Set(), locals, `${label} region lat min`, declaredParams, declaredConstants, declaredPlanet, imports, extra);
      validateExpr(action.latMax, allFieldsVisible ?? new Set(), locals, `${label} region lat max`, declaredParams, declaredConstants, declaredPlanet, imports, extra);
      validateExpr(action.amount, allFieldsVisible ?? new Set(), locals, `${label} region amount`, declaredParams, declaredConstants, declaredPlanet, imports, extra);
    } else if (action.type === "eachCell") {
      requireImport(imports, "init", "eachCell", label);
      validatePresetCellActions(action.actions, declaredFields, declaredParams, declaredConstants, declaredPlanet, imports, label, new Set(locals));
    } else {
      throw new Error(`${label}: unknown preset action ${action.type}`);
    }
  }
}

function validatePresetCellActions(actions, declaredFields, declaredParams, declaredConstants, declaredPlanet, imports, label, locals = new Set()) {
  const visibleFields = declaredFields.size === 0 ? new Set() : declaredFields;
  const extra = GEO_IDENTIFIERS;
  for (const action of actions) {
    if (action.type === "let") {
      validateExpr(action.expr, visibleFields, locals, `${label} let ${action.name}`, declaredParams, declaredConstants, declaredPlanet, imports, extra);
      locals.add(action.name);
    } else if (action.type === "add" || action.type === "set") {
      requireDeclaredField(action.field, declaredFields, label, action.type);
      validateExpr(action.expr, visibleFields, locals, `${label} ${action.type} ${action.field}`, declaredParams, declaredConstants, declaredPlanet, imports, extra);
    } else if (action.type === "when") {
      validateExpr(action.condition, visibleFields, locals, `${label} when`, declaredParams, declaredConstants, declaredPlanet, imports, extra);
      validatePresetCellActions(action.actions, declaredFields, declaredParams, declaredConstants, declaredPlanet, imports, label, new Set(locals));
    } else {
      throw new Error(`${label}: unknown preset cell action ${action.type}`);
    }
  }
}

// V2 stages emit exactly one statement per stage: a `cell` block. The
// v1-era `event` / `each` / `wind` / `advect` / `diffuse` / `clamp` /
// `normalize` statement shapes are rejected upstream by strict CST projection
// with redirect messages.
function validateStatement(statement, stage, reads, writes, declares, visibleFields, declaredParams, declaredConstants, declaredPlanet, imports) {
  if (statement.type !== "cell") {
    throw new Error(`Unknown statement in ${stage.id}: ${statement.type}`);
  }
  validateActions(statement.actions, stage, reads, writes, declares, visibleFields, declaredParams, declaredConstants, declaredPlanet, imports);
}

function validateActions(actions, stage, reads, writes, declares, visibleFields, declaredParams, declaredConstants, declaredPlanet, imports, locals = new Set()) {
  for (const action of actions) {
    if (action.type === "let") {
      validateLocalName(
        action.name,
        `${stage.id} let ${action.name}`,
        new Set([...visibleFields, ...writes, ...declares]),
        locals,
      );
      validateExpr(action.expr, visibleFields, locals, `${stage.id} let ${action.name}`, declaredParams, declaredConstants, declaredPlanet, imports, GEO_IDENTIFIERS);
      locals.add(action.name);
    } else if (action.type === "add" || action.type === "set") {
      requireOutput(action.field, writes, declares, stage.id);
      if (action.type === "add") requireRead(action.field, reads, stage.id);
      validateExpr(action.expr, visibleFields, locals, `${stage.id} ${action.type} ${action.field}`, declaredParams, declaredConstants, declaredPlanet, imports, GEO_IDENTIFIERS);
    } else if (action.type === "when") {
      validateExpr(action.condition, visibleFields, locals, `${stage.id} cell when`, declaredParams, declaredConstants, declaredPlanet, imports, GEO_IDENTIFIERS);
      validateActions(action.actions, stage, reads, writes, declares, visibleFields, declaredParams, declaredConstants, declaredPlanet, imports, new Set(locals));
    } else {
      throw new Error(`Unknown cell action in ${stage.id}: ${action.type}`);
    }
  }
}

function validateExpr(
  ast,
  visibleFields,
  locals,
  label,
  declaredParams = new Set(),
  declaredConstants = new Set(),
  declaredPlanet = new Set(),
  imports = null,
  extraIdentifiers = new Set(),
  allowImplicitGeo = true,
) {
  switch (ast.type) {
    case "Number":
      return;
    case "Identifier":
      if (ast.name === "true" || ast.name === "false" || ast.name === "null" || ast.name === "undefined") return;
      if (locals.has(ast.name)) return;
      if (visibleFields.has(ast.name)) return;
      if (declaredParams.has(ast.name)) return;
      if (declaredConstants.has(ast.name)) return;
      if (declaredPlanet.has(ast.name)) return;
      if (CLOCK_IDENTIFIERS.has(ast.name)) {
        requireImport(imports, "clock", ast.name, label);
        return;
      }
      if (extraIdentifiers.has(ast.name)) {
        if (GEO_IDENTIFIERS.has(ast.name)) requireImport(imports, "geo", ast.name, label);
        return;
      }
      if (allowImplicitGeo && GEO_IDENTIFIERS.has(ast.name)) {
        requireImport(imports, "geo", ast.name, label);
        return;
      }
      if (ast.name === "r" && extraIdentifiers === STAMP_IDENTIFIERS) return;
      throw new Error(`${label}: unknown identifier ${ast.name}`);
    case "Member":
      // Namespaced refs (`params.X`, `consts.X`, `planet.X`) used to be
      // the way to reach param/const/planet values from a DSL body.
      // The DSL now uses bare names with a single global scope, and
      // recipe-level uniqueness is enforced — these prefixes are no
      // longer recognised. The error message names the new form.
      if (ast.object.type === "Identifier"
        && (ast.object.name === "params"
          || ast.object.name === "consts"
          || ast.object.name === "planet")) {
        throw new Error(`${label}: ${ast.object.name}.${ast.prop} is no longer supported — drop the \`${ast.object.name}.\` prefix and use bare \`${ast.prop}\``);
      }
      validateExpr(ast.object, visibleFields, locals, label, declaredParams, declaredConstants, declaredPlanet, imports, extraIdentifiers, allowImplicitGeo);
      return;
    case "Unary":
      validateExpr(ast.expr, visibleFields, locals, label, declaredParams, declaredConstants, declaredPlanet, imports, extraIdentifiers, allowImplicitGeo);
      return;
    case "Binary":
      validateExpr(ast.left, visibleFields, locals, label, declaredParams, declaredConstants, declaredPlanet, imports, extraIdentifiers, allowImplicitGeo);
      validateExpr(ast.right, visibleFields, locals, label, declaredParams, declaredConstants, declaredPlanet, imports, extraIdentifiers, allowImplicitGeo);
      return;
    case "Conditional":
      validateExpr(ast.test, visibleFields, locals, label, declaredParams, declaredConstants, declaredPlanet, imports, extraIdentifiers, allowImplicitGeo);
      validateExpr(ast.consequent, visibleFields, locals, label, declaredParams, declaredConstants, declaredPlanet, imports, extraIdentifiers, allowImplicitGeo);
      validateExpr(ast.alternate, visibleFields, locals, label, declaredParams, declaredConstants, declaredPlanet, imports, extraIdentifiers, allowImplicitGeo);
      return;
    case "Call":
      validateCall(ast, visibleFields, locals, label, declaredParams, declaredConstants, declaredPlanet, imports, extraIdentifiers, allowImplicitGeo);
      return;
    case "NeighborReduce":
      validateNeighborReduce(ast, visibleFields, locals, label, declaredParams, declaredConstants, declaredPlanet, imports, extraIdentifiers, allowImplicitGeo);
      return;
    case "CoordRead":
      validateCoordRead(ast, visibleFields, locals, label, imports, declaredParams, declaredConstants, declaredPlanet, extraIdentifiers, allowImplicitGeo);
      return;
    default:
      throw new Error(`${label}: unknown expression node ${ast.type}`);
  }
}

// V2 CoordRead = `field@<coord>`. Two flavors today:
//   - coord.kind === "prev"      → temporal read of last tick
//   - coord.kind === "neighbor"  → spatial read at the bound neighbor cell
// Both require the field to be visible to the surrounding stage; the
// `prev` flavor additionally requires the field to be declared as a
// history-eligible source (validated in the wider validateStages pass
// via imports.historyFields, mirroring the legacy `prev()` Call check).
function validateCoordRead(ast, visibleFields, locals, label, imports, declaredParams = new Set(), declaredConstants = new Set(), declaredPlanet = new Set(), extraIdentifiers = new Set(), allowImplicitGeo = true) {
  if (!ast.field || !ast.coord?.kind) {
    throw new Error(`${label}: malformed CoordRead`);
  }
  if (!visibleFields.has(ast.field)) {
    throw new Error(`${label}: ${ast.field}@${ast.coord.kind} — field not visible to this stage; add it to reads`);
  }
  if (ast.coord.kind === "prev") {
    requireImport(imports, "clock", "prev", label);
    const historyFields = imports?.historyFields;
    if (!historyFields || !historyFields.has(ast.field)) {
      throw new Error(
        `${label}: ${ast.field}@prev requires the field to be used with @prev somewhere — ` +
        `history depth is inferred from @prev usage`,
      );
    }
    return;
  }
  if (ast.coord.kind === "neighbor") {
    // Neighbor coord is a parser-time scope check; if we got here the
    // CoordRead is inside its enclosing reduction frame.
    requireImport(imports, "core", "neighbor", label);
    return;
  }
  if (ast.coord.kind === "upstream") {
    // Continuous-position semi-Lagrangian sample. Self + neighbors are
    // gathered with inverse-distance weighting (see emitStencilHelpers
    // in webgpu-geodesic-compiler.mjs). Needs the same neighbor
    // topology binding NeighborReduce uses.
    requireImport(imports, "core", "neighbor", label);
    // The velocity components and dt are arbitrary expressions — they
    // commonly reference other fields (e.g. `slope.x` / `slope.y`),
    // params, or locals. Walk them through the full expression
    // validator so unknown identifiers fail at validation time rather
    // than emerging as unbound symbols in WGSL.
    const argLabel = `${label} (${ast.field}@upstream args)`;
    validateExpr(ast.coord.velX, visibleFields, locals, argLabel, declaredParams, declaredConstants, declaredPlanet, imports, extraIdentifiers, allowImplicitGeo);
    validateExpr(ast.coord.velY, visibleFields, locals, argLabel, declaredParams, declaredConstants, declaredPlanet, imports, extraIdentifiers, allowImplicitGeo);
    validateExpr(ast.coord.dt,   visibleFields, locals, argLabel, declaredParams, declaredConstants, declaredPlanet, imports, extraIdentifiers, allowImplicitGeo);
    return;
  }
  throw new Error(`${label}: unsupported coord kind "${ast.coord.kind}"`);
}

const NEIGHBOR_REDUCTION_OPS = new Set(["sum", "max", "min", "mean"]);

function validateNeighborReduce(ast, visibleFields, locals, label, declaredParams, declaredConstants, declaredPlanet, imports, extraIdentifiers, allowImplicitGeo) {
  if (!NEIGHBOR_REDUCTION_OPS.has(ast.op)) {
    throw new Error(`${label}: neighbor reduction has unknown op '${ast.op}'`);
  }
  requireImport(imports, "core", "neighbor", label);
  validateNeighborReductionSource(ast.source, label);

  // Two AST shapes:
  //   v2 CoordRead: ast carries `coord` (the binding name); the body
  //     contains CoordRead nodes that reference the coord. Bindings
  //     are derived during compilation, not pre-built.
  //   legacy v1: ast carries `bindings: [{ name, field }]` and the body
  //     uses bare Identifier references to the synthetic names.
  // Both forms are accepted here.
  const isV2 = typeof ast.coord === "string";
  if (!isV2 && (!Array.isArray(ast.bindings) || ast.bindings.length === 0)) {
    throw new Error(`${label}: neighbor ${ast.op} requires at least one binding`);
  }
  if (containsNeighborReduce(ast.body)) {
    throw new Error(`${label}: nested neighbor reductions aren't supported; use ring(k) or disk(k) for bounded topological neighborhoods`);
  }
  const bodyLocals = new Set(locals);
  if (isV2) {
    // For v2 reductions, `coord` is the binding name; CoordRead nodes
    // inside the body resolve it via the parser's scope frame. The
    // expression validator checks fields against visibleFields and
    // walks every CoordRead via the validateCoordRead case.
  } else {
    for (const binding of ast.bindings) {
      requireVisibleField(binding.field, visibleFields, label, `neighbor ${ast.op} field`);
      validateLocalName(
        binding.name,
        `${label} neighbor ${ast.op} binding`,
        visibleFields,
        bodyLocals,
      );
      bodyLocals.add(binding.name);
    }
  }
  validateExpr(ast.body, visibleFields, bodyLocals, label, declaredParams, declaredConstants, declaredPlanet, imports, extraIdentifiers, allowImplicitGeo);
}

function validateLocalName(name, label, visibleFields, locals) {
  if (!name) throw new Error(`${label}: local name is required`);
  if (locals.has(name)) throw new Error(`${label}: local '${name}' is already declared in this scope`);
  if (visibleFields.has(name)) throw new Error(`${label}: local '${name}' shadows a field`);
  if (CLOCK_IDENTIFIERS.has(name) || GEO_IDENTIFIERS.has(name) || RESERVED_NAMES.has(name)) {
    throw new Error(`${label}: local '${name}' shadows a builtin/reserved identifier`);
  }
}

function validateNeighborReductionSource(source, label) {
  if (!source || source.kind === "neighbors") return;
  if (source.kind !== "ring" && source.kind !== "disk") {
    throw new Error(`${label}: neighbor reduction source must be neighbors, ring(k), or disk(k)`);
  }
  if (!Number.isInteger(source.radius)) {
    throw new Error(`${label}: ${source.kind}(k) requires a literal integer radius`);
  }
  if (source.radius < 1 || source.radius > 3) {
    throw new Error(`${label}: ${source.kind}(${source.radius}) is outside the supported radius range 1..3`);
  }
}

function containsNeighborReduce(expr) {
  if (!expr) return false;
  if (expr.type === "NeighborReduce") return true;
  if (expr.type === "Binary") return containsNeighborReduce(expr.left) || containsNeighborReduce(expr.right);
  if (expr.type === "Unary") return containsNeighborReduce(expr.expr);
  if (expr.type === "Conditional") {
    return containsNeighborReduce(expr.test) || containsNeighborReduce(expr.consequent) || containsNeighborReduce(expr.alternate);
  }
  if (expr.type === "Call") return (expr.args ?? []).some(containsNeighborReduce);
  if (expr.type === "Member") return containsNeighborReduce(expr.object);
  return false;
}

function validateCall(ast, visibleFields, locals, label, declaredParams, declaredConstants, declaredPlanet, imports, extraIdentifiers, allowImplicitGeo = true) {
  // Special case: prev() is a temporal-state lookup, not a regular
  // function call. The argument MUST be a bare field identifier — we
  // intercept here so generic call-arg compilation never touches it
  // (otherwise the inner Identifier would lower to current-tick read).
  if (ast.callee.type === "Identifier" && ast.callee.name === "prev") {
    requireImport(imports, "clock", "prev", label);
    if (ast.args.length !== 1) {
      throw new Error(`${label}: prev expects 1 argument, got ${ast.args.length}`);
    }
    const arg = ast.args[0];
    if (arg.type !== "Identifier") {
      throw new Error(
        `${label}: prev argument must be a bare field identifier ` +
        `(prev(field), not prev(expression))`,
      );
    }
    if (!visibleFields.has(arg.name)) {
      throw new Error(
        `${label}: prev(${arg.name}) — field is not visible to this stage; ` +
        `add ${arg.name} to the stage's reads`,
      );
    }
    const historyFields = imports?.historyFields;
    if (!historyFields || !historyFields.has(arg.name)) {
      throw new Error(
        `${label}: prev(${arg.name}) requires the field to be declared with ` +
        `\`history N\` (e.g. \`field ${arg.name} history 1\`)`,
      );
    }
    return;
  }

  if (ast.callee.type !== "Identifier" || !EXPR_FUNC_TARGETS.has(ast.callee.name)) {
    throw new Error(`${label}: unknown function ${formatCallee(ast.callee)}`);
  }
  requireImport(imports, "core", ast.callee.name, label);

  const arity = EXPR_FUNC_ARITY.get(ast.callee.name);
  if (arity && !arity.includes(ast.args.length)) {
    throw new Error(`${label}: ${ast.callee.name} expects ${arity.join(" or ")} args, got ${ast.args.length}`);
  }
  for (const arg of ast.args) validateExpr(arg, visibleFields, locals, label, declaredParams, declaredConstants, declaredPlanet, imports, extraIdentifiers, allowImplicitGeo);
}

// Carry the schema's imports object through unmodified. v2 always
// passes `{ permitAll: true, historyFields: ... }`; the side-channel
// fields (historyFields in particular) are read by other validators
// downstream. There is no longer any v1-shape array form to translate.
function buildImportSets(imports) {
  return imports ?? {};
}

// Legacy namespace-import constraint check. v2 enforces its own flat
// import constraint in validate-v2.mjs; this function is now an
// unconditional no-op kept only so the 25-or-so callsites threaded
// through expression / stage / metric validators don't need surgery.
// Future cleanup: drop this function and remove the `imports` parameter
// from those callsites.
function requireImport(_imports, _from, _name, _label) {
  return;
}

function requireWrite(field, writes, stageId) {
  if (!writes.has(field)) throw new Error(`${stageId}: writes to undeclared field ${field}`);
}

function requireOutput(field, writes, declares, stageId) {
  if (!writes.has(field) && !declares.has(field)) {
    throw new Error(`${stageId}: writes to undeclared field ${field}`);
  }
}

function requireRead(field, reads, stageId) {
  if (!reads.has(field)) throw new Error(`${stageId}: additive write to ${field} requires declaring it in reads`);
}

function requireDeclaredField(field, declaredFields, stageId, label) {
  if (declaredFields.size > 0 && !declaredFields.has(field)) {
    throw new Error(`${stageId}: ${label} references undeclared field ${field}`);
  }
}

function requireMutableField(field, sourceFields, stageId, label) {
  if (sourceFields.has(field)) {
    throw new Error(`${stageId}: ${label} references immutable source ${field}`);
  }
}

function requireVisibleField(field, visibleFields, stageId, label) {
  if (!visibleFields.has(field)) throw new Error(`${stageId}: ${label} references undeclared field ${field}`);
}

export function deriveEdges(stages) {
  const edges = [];
  const lastWriter = new Map();
  for (const stage of stages) {
    for (const field of stage.reads) {
      const from = lastWriter.get(field);
      if (!from) continue;
      edges.push({
        from: { node: from, port: field },
        to: { node: stage.id, port: field },
      });
    }
    for (const field of [...stage.writes, ...stage.declares]) {
      lastWriter.set(field, stage.id);
    }
  }
  return edges;
}
