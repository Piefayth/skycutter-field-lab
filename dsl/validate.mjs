// Field Lab DSL validation and graph metadata.

import {
  CLOCK_IDENTIFIERS,
  EXPR_FUNC_ARITY,
  EXPR_FUNC_TARGETS,
  GEO_IDENTIFIERS,
  STAMP_IDENTIFIERS,
  formatCallee,
} from "./expr-parser.mjs";
import { RESERVED_NAMES } from "./dsl-spec.mjs";

const UNIFORM_IDENTIFIERS = new Set(["PI", "TAU"]);

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
    default:
      return;
  }
}
export function validateNameUniqueness(schema, stages = []) {
  const declaredBy = new Map();
  function claim(name, kind) {
    if (!name) return;
    const prior = declaredBy.get(name);
    if (prior && prior !== kind) {
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
  // breaking semantics: literals (true/false) and the math/sample
  // helpers that DSL bodies invoke as function calls. Driven by
  // `RESERVED_NAMES` in dsl-spec — adding a math fn or stencil helper
  // automatically reserves its name.
  //
  // Geodesic position coordinates (x, y, lon, lat, u, v, px, py, pz, i)
  // and projection constants (PI, TAU, N) are deliberately NOT in the
  // reserved set — recipes can declare e.g. `field u` (gray-scott) or
  // `field W` (inverter-front), in which case a bare reference resolves
  // to the field. The position coord is then unreachable inside that
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

function validateStatement(statement, stage, reads, writes, declares, visibleFields, declaredParams, declaredConstants, declaredPlanet, imports) {
  switch (statement.type) {
    case "event":
      requireImport(imports, "sim", "event", stage.id);
      validateExpr(statement.condition, visibleFields, new Set(), `${stage.id} event condition`, declaredParams, declaredConstants, declaredPlanet, imports);
      validateActions(statement.actions, stage, reads, writes, declares, visibleFields, "event", declaredParams, declaredConstants, declaredPlanet, imports);
      break;
    case "cell":
      requireImport(imports, "sim", "cell", stage.id);
      validateActions(statement.actions, stage, reads, writes, declares, visibleFields, "cell", declaredParams, declaredConstants, declaredPlanet, imports);
      break;
    case "each":
      requireImport(imports, "sim", "each", stage.id);
      validateActions(statement.actions, stage, reads, writes, declares, visibleFields, "each", declaredParams, declaredConstants, declaredPlanet, imports);
      break;
    case "wind":
      requireImport(imports, "sim", "wind", stage.id);
      requireVisibleField(statement.pressure, visibleFields, stage.id, "wind pressure");
      requireOutput(statement.windU, writes, declares, stage.id);
      requireOutput(statement.windV, writes, declares, stage.id);
      if (statement.lift) requireOutput(statement.lift, writes, declares, stage.id);
      validateUniformExpr(statement.strength, `${stage.id} wind strength`, declaredParams, declaredConstants, declaredPlanet, imports);
      break;
    case "advect":
      requireImport(imports, "sim", "advect", stage.id);
      requireVisibleField(statement.field, visibleFields, stage.id, "advect field");
      requireVisibleField(statement.windU, visibleFields, stage.id, "advect windU");
      requireVisibleField(statement.windV, visibleFields, stage.id, "advect windV");
      requireWrite(statement.field, writes, stage.id);
      validateUniformExpr(statement.dt, `${stage.id} advect dt`, declaredParams, declaredConstants, declaredPlanet, imports);
      break;
    case "diffuse":
      requireImport(imports, "sim", statement.type, stage.id);
      requireVisibleField(statement.field, visibleFields, stage.id, statement.type);
      requireWrite(statement.field, writes, stage.id);
      validateUniformExpr(statement.amount, `${stage.id} diffuse amount`, declaredParams, declaredConstants, declaredPlanet, imports);
      break;
    case "clamp":
      requireImport(imports, "sim", statement.type, stage.id);
      requireVisibleField(statement.field, visibleFields, stage.id, statement.type);
      requireWrite(statement.field, writes, stage.id);
      validateUniformExpr(statement.lo, `${stage.id} clamp lo`, declaredParams, declaredConstants, declaredPlanet, imports);
      validateUniformExpr(statement.hi, `${stage.id} clamp hi`, declaredParams, declaredConstants, declaredPlanet, imports);
      break;
    case "normalize":
      requireImport(imports, "sim", statement.type, stage.id);
      requireVisibleField(statement.field, visibleFields, stage.id, statement.type);
      requireWrite(statement.field, writes, stage.id);
      validateUniformExpr(statement.damping, `${stage.id} normalize damping`, declaredParams, declaredConstants, declaredPlanet, imports);
      validateUniformExpr(statement.condition, `${stage.id} normalize when`, declaredParams, declaredConstants, declaredPlanet, imports);
      break;
    default:
      throw new Error(`Unknown statement in ${stage.id}: ${statement.type}`);
  }
}

function validateUniformExpr(ast, label, declaredParams, declaredConstants, declaredPlanet, imports) {
  validateExpr(ast, new Set(), new Set(), label, declaredParams, declaredConstants, declaredPlanet, imports, UNIFORM_IDENTIFIERS, false);
}

function validateActions(actions, stage, reads, writes, declares, visibleFields, mode, declaredParams, declaredConstants, declaredPlanet, imports, locals = new Set()) {
  for (const action of actions) {
    if (action.type === "let") {
      validateExpr(action.expr, visibleFields, locals, `${stage.id} let ${action.name}`, declaredParams, declaredConstants, declaredPlanet, imports, GEO_IDENTIFIERS);
      locals.add(action.name);
    } else if (action.type === "add" || action.type === "set") {
      requireOutput(action.field, writes, declares, stage.id);
      if (action.type === "add") requireRead(action.field, reads, stage.id);
      validateExpr(action.expr, visibleFields, locals, `${stage.id} ${action.type} ${action.field}`, declaredParams, declaredConstants, declaredPlanet, imports, GEO_IDENTIFIERS);
    } else if (action.type === "when") {
      validateExpr(action.condition, visibleFields, locals, `${stage.id} ${mode} when`, declaredParams, declaredConstants, declaredPlanet, imports, GEO_IDENTIFIERS);
      validateActions(action.actions, stage, reads, writes, declares, visibleFields, mode, declaredParams, declaredConstants, declaredPlanet, imports, new Set(locals));
    } else {
      throw new Error(`Unknown ${mode} action in ${stage.id}: ${action.type}`);
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
    default:
      throw new Error(`${label}: unknown expression node ${ast.type}`);
  }
}

function validateCall(ast, visibleFields, locals, label, declaredParams, declaredConstants, declaredPlanet, imports, extraIdentifiers, allowImplicitGeo = true) {
  if (ast.callee.type === "Identifier" && ast.callee.name === "sample") {
    requireImport(imports, "core", "sample", label);
    if (ast.args.length !== 3) throw new Error(`${label}: sample expects 3 arguments`);
    const [field, dx, dy] = ast.args;
    if (field.type !== "Identifier") throw new Error(`${label}: sample first argument must be a field name`);
    requireVisibleField(field.name, visibleFields, label, "sample field");
    validateExpr(dx, visibleFields, locals, label, declaredParams, declaredConstants, declaredPlanet, imports, extraIdentifiers, allowImplicitGeo);
    validateExpr(dy, visibleFields, locals, label, declaredParams, declaredConstants, declaredPlanet, imports, extraIdentifiers, allowImplicitGeo);
    return;
  }
  if (ast.callee.type === "Identifier" && ast.callee.name === "neighborMax") {
    requireImport(imports, "core", "neighborMax", label);
    if (ast.args.length !== 1) throw new Error(`${label}: neighborMax expects 1 argument`);
    const [field] = ast.args;
    if (field.type !== "Identifier") throw new Error(`${label}: neighborMax first argument must be a field name`);
    requireVisibleField(field.name, visibleFields, label, "neighborMax field");
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

function buildImportSets(imports) {
  const sets = new Map();
  for (const decl of imports) {
    if (!sets.has(decl.from)) sets.set(decl.from, new Set());
    for (const name of decl.names ?? []) sets.get(decl.from).add(name);
  }
  return sets;
}

function requireImport(imports, from, name, label) {
  if (!imports) return;
  if (imports.get(from)?.has(name)) return;
  throw new Error(`${label}: ${from}.${name} is not imported`);
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
