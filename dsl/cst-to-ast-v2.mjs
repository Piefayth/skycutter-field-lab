// Projection from tolerant v2 CST nodes to the existing compiler AST shape.
// The CST remains editor-facing and tolerant; this module is the bridge that
// lets us migrate compiler consumers one construct at a time.

const FIELD_TYPES = new Set(["f32", "vec2", "vec3", "u32", "bool"]);
const METRIC_OPS = new Set(["sum", "max", "min", "mean", "count"]);

export function recipeCstToAst(cst, options = {}) {
  if (!cst || cst.type !== "RecipeCst") throw new Error("v2 CST projection: expected recipe CST");
  if (options.strict) validateStrictRecipeCst(cst);
  const recipe = {};
  let substrate = null;
  const fields = [];
  const params = [];
  const constants = [];
  const importedNames = [];

  for (const stmt of sorted(cst.root.statements)) {
    if (stmt.keyword === "recipe") recipe.name = firstString(cst, stmt) ?? null;
    else if (stmt.keyword === "summary") recipe.summary = firstString(cst, stmt) ?? null;
    else if (stmt.keyword === "recommendedPreset") recipe.recommendedPreset = wordsAfterKeyword(stmt)[0] ?? null;
    else if (stmt.keyword === "substrate") substrate = substrateCstToAst(stmt);
    else if (stmt.keyword === "field") fields.push(fieldCstToAst(stmt));
    else if (stmt.keyword === "param") params.push(paramCstToAst(cst, stmt));
    else if (stmt.keyword === "const") constants.push(constCstToAst(stmt));
    else if (stmt.keyword === "import") importedNames.push(...wordsAfterKeyword(stmt));
  }

  const scenarios = cst.blocks
    .filter((block) => block.keyword === "scenario")
    .sort(byFrom)
    .map((block) => scenarioCstToAst(cst, block));
  const stamps = cst.blocks
    .filter((block) => block.keyword === "stamp")
    .sort(byFrom)
    .map((block) => stampCstToAst(cst, block));
  const render = renderCstToAst(cst);

  return {
    recipe,
    grid: substrate,
    planet: {},
    constants,
    resolution: {},
    importedNames: importedNames.length > 0 ? dedupe(importedNames) : null,
    imports: [],
    fields,
    sources: [],
    settings: [],
    parameters: params,
    presets: scenarios.map((s) => ({ id: s.id, label: s.label, actions: s.actions })),
    stamps,
    stages: cst.blocks
      .filter((block) => block.keyword === "stage")
      .sort(byFrom)
      .map((block) => stageCstToAst(cst, block)),
    metrics: cst.statements
      .filter((stmt) => stmt.keyword === "metric")
      .sort(byFrom)
      .map(metricCstToAst),
    palettes: render.palettes,
    views: render.views,
    overlays: render.overlays,
  };
}

function validateStrictRecipeCst(cst) {
  if ((cst.errors ?? []).length > 0) {
    throw new Error(cst.errors[0].message ?? "v2 CST parse: syntax error");
  }

  const rootStatementKinds = new Set([
    "recipe", "summary", "recommendedPreset", "substrate",
    "field", "param", "const", "import", "metric",
    "step", "views", "stamps", "scenarios",
  ]);
  for (const stmt of sorted(cst.root.statements)) {
    if (stmt.keyword === "scenario") throw new Error("v2 parse: `scenario` blocks must live inside `scenarios { ... }`");
    if (stmt.keyword === "stamp") throw new Error("v2 parse: `stamp` blocks must live inside `stamps { ... }`");
    if (stmt.keyword === "palette") throw new Error("v2 parse: `palette` blocks must live inside `views { ... }`");
    if (stmt.keyword === "view") throw new Error("v2 parse: `view` blocks must live inside `views { ... }`");
    if (stmt.keyword === "overlay") throw new Error("v2 parse: `overlay` declarations must live inside `views { ... }`");
    if (!rootStatementKinds.has(stmt.keyword)) {
      throw new Error(`v2 parse: unknown top-level keyword "${stmt.keyword}"`);
    }
  }

  const rootBlocks = sorted(cst.root.children ?? []);
  for (const block of rootBlocks) {
    if (!["step", "views", "stamps", "scenarios"].includes(block.keyword)) {
      throw new Error(`v2 parse: \`${block.keyword}\` blocks must live inside the proper section`);
    }
  }

  const recipeStmt = cst.root.statements.find((stmt) => stmt.keyword === "recipe");
  if (!recipeStmt || !firstString(cst, recipeStmt)) {
    throw new Error("v2 parse: recipe must declare `recipe \"<name>\"`");
  }
  if (!cst.root.statements.some((stmt) => stmt.keyword === "substrate")) {
    throw new Error("v2 parse: recipe must declare `substrate ...`");
  }
  const stepBlocks = cst.blocks.filter((block) => block.keyword === "step");
  if (stepBlocks.length === 0 || !stepBlocks.some((block) => (block.children ?? []).some((child) => child.keyword === "stage"))) {
    throw new Error("v2 parse: recipe must declare at least one stage inside `step { }`");
  }

  for (const block of sorted(cst.blocks)) {
    validateBlockPlacement(block);
    if (block.keyword === "step") validateStepBlock(block);
    else if (block.keyword === "stage") validateStageBlock(block);
    else if (block.keyword === "views") validateSectionBlock(block, ["palette", "view"], ["palette", "view", "overlay"]);
    else if (block.keyword === "stamps") validateSectionBlock(block, ["stamp"], ["stamp"]);
    else if (block.keyword === "scenarios") validateSectionBlock(block, ["scenario"], ["scenario"]);
    else if (block.keyword === "scenario" || block.keyword === "stamp") validateInitBlock(block);
    else if (block.keyword === "cell" || block.keyword === "for" || block.keyword === "when") validateCellLikeBlock(block);
    else if (block.keyword === "palette") validatePaletteBlock(block);
    else if (block.keyword === "view") validateViewBlock(block);
  }
}

function validateBlockPlacement(block) {
  const parent = block.parent?.keyword ?? "root";
  const ok =
    (["step", "views", "stamps", "scenarios"].includes(block.keyword) && parent === "root")
    || (block.keyword === "stage" && parent === "step")
    || (block.keyword === "cell" && parent === "stage")
    || (block.keyword === "when" && (parent === "cell" || parent === "for" || parent === "when" || parent === "view"))
    || (block.keyword === "for" && (parent === "scenario" || parent === "stamp"))
    || (block.keyword === "palette" && parent === "views")
    || (block.keyword === "view" && parent === "views")
    || (block.keyword === "scenario" && parent === "scenarios")
    || (block.keyword === "stamp" && parent === "stamps");
  if (!ok) {
    if (block.keyword === "scenario") throw new Error("v2 parse: `scenario` blocks must live inside `scenarios { ... }`");
    if (block.keyword === "stamp") throw new Error("v2 parse: `stamp` blocks must live inside `stamps { ... }`");
    if (block.keyword === "palette") throw new Error("v2 parse: `palette` blocks must live inside `views { ... }`");
    if (block.keyword === "view") throw new Error("v2 parse: `view` blocks must live inside `views { ... }`");
    throw new Error(`v2 parse: misplaced ${block.keyword} block`);
  }
}

function validateStepBlock(block) {
  if (!(block.children ?? []).some((child) => child.keyword === "stage")) {
    throw new Error("v2 parse: empty step block");
  }
  validateSectionBlock(block, ["stage"], ["stage"]);
}

function validateStageBlock(block) {
  const allowed = new Set(["reads", "writes", "cell"]);
  let cellCount = 0;
  for (const stmt of sorted(block.statements)) {
    if (!allowed.has(stmt.keyword)) {
      if (["advect", "wind", "diffuse", "clamp", "normalize"].includes(stmt.keyword)) {
        throw new Error(`v2 parse: stage ${block.id}: \`${stmt.keyword}\` is no longer a stage primitive in v2`);
      }
      throw new Error(`v2 parse: stage ${block.id}: unknown clause "${stmt.keyword}"`);
    }
    if (stmt.keyword === "cell") cellCount++;
  }
  if (cellCount === 0) throw new Error(`v2 parse: stage ${block.id}: missing cell { } block (or legacy primitive)`);
  if (cellCount > 1) throw new Error(`v2 parse: stage ${block.id}: only one cell { } block per stage`);
}

function validateSectionBlock(block, childKeywords, statementKeywords) {
  const childAllowed = new Set(childKeywords);
  const statementAllowed = new Set(statementKeywords);
  for (const child of sorted(block.children ?? [])) {
    if (!childAllowed.has(child.keyword)) {
      throw new Error(`v2 parse: ${block.keyword} section: unexpected ${child.keyword} block`);
    }
  }
  for (const stmt of sorted(block.statements ?? [])) {
    if (!statementAllowed.has(stmt.keyword)) {
      throw new Error(`v2 parse: ${block.keyword} section: unexpected ${stmt.keyword} declaration`);
    }
  }
}

function validateInitBlock(block) {
  const allowed = new Set(["set", "spot", "ellipse", "region", "for"]);
  for (const stmt of sorted(block.statements)) {
    if (!allowed.has(stmt.keyword)) throw new Error(`v2 parse: ${block.keyword} ${block.id}: unknown action "${stmt.keyword}"`);
  }
}

function validateCellLikeBlock(block) {
  const allowed = new Set(["let", "set", "add", "when"]);
  for (const stmt of sorted(block.statements)) {
    if (block.keyword === "for" && stmt.keyword === "for") continue;
    if (!allowed.has(stmt.keyword)) throw new Error(`v2 parse: ${block.keyword} body: unknown action "${stmt.keyword}"`);
  }
}

function validatePaletteBlock(block) {
  validateSectionBlock(block, [], ["stop"]);
}

function validateViewBlock(block) {
  const allowed = new Set(["color", "glyph", "let", "set", "when", "stop"]);
  for (const stmt of sorted(block.statements)) {
    if (!allowed.has(stmt.keyword)) throw new Error(`v2 parse: view ${block.id}: unknown declaration "${stmt.keyword}"`);
  }
}

export function expressionCstToAst(node) {
  if (!node || typeof node !== "object") throw new Error("v2 CST projection: missing expression node");
  switch (node.type) {
    case "ExprNumber":
      return { type: "Number", value: node.value };
    case "ExprIdentifier":
      return { type: "Identifier", name: node.name };
    case "ExprUnary":
      return { type: "Unary", op: node.op, expr: expressionCstToAst(node.expr) };
    case "ExprBinary":
      return {
        type: "Binary",
        op: node.op,
        left: expressionCstToAst(node.left),
        right: expressionCstToAst(node.right),
      };
    case "ExprConditional":
      return {
        type: "Conditional",
        test: expressionCstToAst(node.test),
        consequent: expressionCstToAst(node.consequent),
        alternate: expressionCstToAst(node.alternate),
      };
    case "ExprGroup":
      return expressionCstToAst(node.expr);
    case "ExprMember":
      return projectMember(node);
    case "ExprCall":
      return {
        type: "Call",
        callee: expressionCstToAst(node.callee),
        args: node.args.map(expressionCstToAst),
      };
    case "ExprCoordRead":
      return projectCoordRead(node);
    case "ExprNeighborReduce":
      return {
        type: "NeighborReduce",
        op: node.op,
        coord: node.binder,
        body: expressionCstToAst(node.body),
      };
    case "ExprMissing":
      throw new Error(`v2 CST projection: incomplete ${node.label ?? "expression"}`);
    case "ExprUnknown":
      throw new Error(`v2 CST projection: unknown expression token "${node.value}"`);
    default:
      throw new Error(`v2 CST projection: unsupported expression node ${node.type}`);
  }
}

export function cellActionsCstToAst(cst, cellBlock) {
  const statements = [...(cellBlock?.statements ?? [])]
    .filter((stmt) => ["let", "set", "add", "when"].includes(stmt.keyword))
    .sort((a, b) => a.from - b.from);
  return statements.map((stmt) => cellActionCstToAst(cst, stmt));
}

export function cellActionCstToAst(cst, stmt) {
  if (!stmt || stmt.type !== "Statement") throw new Error("v2 CST projection: missing cell action statement");
  if (stmt.keyword === "let") {
    if (!stmt.parts.local?.name) throw new Error("v2 CST projection: incomplete let action");
    return {
      type: "let",
      name: stmt.parts.local.name,
      expr: expressionCstToAst(firstExpression(stmt)),
    };
  }
  if (stmt.keyword === "set" || stmt.keyword === "add") {
    if (!stmt.parts.target?.name) throw new Error(`v2 CST projection: incomplete ${stmt.keyword} action`);
    return {
      type: stmt.keyword,
      field: stmt.parts.target.name,
      expr: expressionCstToAst(firstExpression(stmt)),
    };
  }
  if (stmt.keyword === "when") {
    const whenBlock = findBlockForStatement(cst, stmt, "when");
    return {
      type: "when",
      condition: expressionCstToAst(firstExpression(stmt)),
      actions: cellActionsCstToAst(cst, whenBlock),
    };
  }
  throw new Error(`v2 CST projection: unsupported cell action ${stmt.keyword}`);
}

export function stageCstToAst(cst, stageBlock) {
  if (!stageBlock || stageBlock.keyword !== "stage") {
    throw new Error("v2 CST projection: expected stage block");
  }
  const reads = [];
  const writes = [];
  const previousReads = new Set();
  const statements = [];
  for (const stmt of [...(stageBlock.statements ?? [])].sort((a, b) => a.from - b.from)) {
    if (stmt.keyword === "reads") {
      for (const item of fieldListFromStatement(stmt)) {
        reads.push(item.name);
        if (item.previous) previousReads.add(item.name);
      }
    } else if (stmt.keyword === "writes") {
      for (const item of fieldListFromStatement(stmt)) writes.push(item.name);
    }
  }
  const cellBlock = (stageBlock.children ?? []).find((block) => block.keyword === "cell");
  if (cellBlock) {
    statements.push({ type: "cell", actions: cellActionsCstToAst(cst, cellBlock) });
  }
  return {
    id: stageBlock.id,
    name: stageLabel(cst, stageBlock),
    reads: dedupe(reads),
    writes: dedupe(writes),
    declares: [],
    body: { statements },
    previousReads: [...previousReads],
  };
}

export function metricCstToAst(stmt) {
  if (!stmt || stmt.keyword !== "metric") {
    throw new Error("v2 CST projection: expected metric statement");
  }
  const parts = [...stmt.cleanText.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*\b/g)].map((m) => m[0]);
  const id = parts[1] ?? null;
  const op = parts.find((word, index) => index > 1 && METRIC_OPS.has(word)) ?? null;
  if (!id) throw new Error("v2 CST projection: incomplete metric declaration");
  if (!op) throw new Error(`v2 parse: metric ${id}: unknown reduction "${parts[2] ?? ""}"`);
  const predicateSpan = (stmt.expressions ?? []).find((expr) => expr.kind === "metricPredicate");
  const bodySpan = (stmt.expressions ?? []).find((expr) => expr.kind === "metricBody");
  return {
    id,
    op,
    predicate: predicateSpan ? expressionCstToAst(predicateSpan.node) : null,
    body: bodySpan ? expressionCstToAst(bodySpan.node) : null,
  };
}

function substrateCstToAst(stmt) {
  const words = wordsFrom(stmt.cleanText);
  if (words[1] !== "geodesic") throw new Error(`v2 CST projection: unsupported substrate ${words[1] ?? ""}`);
  const frequency = numberAfter(stmt.cleanText, /\bfrequency\s+/);
  return { kind: "geodesic", frequency, tiles: frequency };
}

function fieldCstToAst(stmt) {
  const words = wordsFrom(stmt.cleanText);
  const name = words[1] ?? null;
  const type = words.find((word) => FIELD_TYPES.has(word)) ?? null;
  if (!name || !type) throw new Error("v2 CST projection: incomplete field declaration");
  return {
    name,
    kind: "field",
    history: 0,
    type,
    derived: words.includes("derived"),
  };
}

function paramCstToAst(cst, stmt) {
  const words = wordsFrom(stmt.cleanText);
  const name = words[1] ?? null;
  const widget = words[2] ?? null;
  if (!name || !widget) throw new Error("v2 CST projection: incomplete param declaration");
  const decl = { name, kind: "param", label: firstString(cst, stmt) ?? name };
  if (widget === "slider") {
    const number = String.raw`[+-]?(?:\d+\.\d*|\.\d+|\d+)(?:e[+-]?\d+)?`;
    const re = new RegExp(String.raw`\bslider\s+(${number})\s*\.\.\s*(${number})(?:\s+step\s+(${number}))?\s+default\s+(${number})`, "i");
    const match = re.exec(stmt.cleanText);
    if (!match) throw new Error(`v2 CST projection: incomplete slider param ${name}`);
    decl.type = "number";
    decl.control = "slider";
    decl.min = Number(match[1]);
    decl.max = Number(match[2]);
    if (match[3] != null) decl.step = Number(match[3]);
    decl.default = Number(match[4]);
  } else if (widget === "toggle") {
    const match = /\btoggle\s+default\s+(true|false)\b/.exec(stmt.cleanText);
    if (!match) throw new Error(`v2 CST projection: incomplete toggle param ${name}`);
    decl.type = "boolean";
    decl.default = match[1] === "true";
  } else {
    throw new Error(`v2 CST projection: unknown param widget ${widget}`);
  }
  return decl;
}

function constCstToAst(stmt) {
  const words = wordsFrom(stmt.cleanText);
  const name = words[1] ?? null;
  const eq = stmt.cleanText.indexOf("=");
  if (!name || eq < 0) throw new Error("v2 CST projection: incomplete const declaration");
  return { name, value: Number(stmt.cleanText.slice(eq + 1).trim()) };
}

function scenarioCstToAst(cst, block) {
  return {
    id: block.id,
    label: blockLabel(cst, block) ?? block.id,
    actions: initActionsCstToAst(cst, block, false),
  };
}

function stampCstToAst(cst, block) {
  return {
    id: block.id,
    label: blockLabel(cst, block) ?? block.id,
    actions: initActionsCstToAst(cst, block, true),
  };
}

function initActionsCstToAst(cst, block, allowBrush) {
  const entries = [
    ...sorted(block.statements).filter((stmt) => ["set", "spot", "ellipse", "region"].includes(stmt.keyword)),
    ...(block.children ?? []).filter((child) => child.keyword === "for"),
  ].sort(byFrom);
  return entries.map((entry) => {
    if (entry.type === "Block" && entry.keyword === "for") return eachCellCstToAst(cst, entry);
    return initActionCstToAst(entry, allowBrush);
  });
}

function initActionCstToAst(stmt, allowBrush) {
  if (stmt.keyword === "set") {
    if (!stmt.parts.target?.name) throw new Error("v2 CST projection: incomplete init set action");
    return { type: "fill", field: stmt.parts.target.name, value: expressionCstToAst(firstExpression(stmt)) };
  }
  const words = wordsFrom(stmt.cleanText);
  const field = words[1] ?? null;
  if (!field) throw new Error(`v2 CST projection: incomplete ${stmt.keyword} action`);
  const args = {};
  if (allowBrush && /\bbrush\s*\.\s*pos\b/.test(stmt.cleanText)) {
    args.lon = { type: "Identifier", name: "lon" };
    args.lat = { type: "Identifier", name: "lat" };
  }
  for (const expr of stmt.expressions ?? []) {
    if (!expr.kind.endsWith("Arg")) continue;
    const key = expr.kind.slice(0, -"Arg".length);
    args[key] = expressionCstToAst(expr.node);
  }
  return { type: stmt.keyword, field, ...args };
}

function eachCellCstToAst(cst, block) {
  const stmt = (cst.statements ?? []).find((candidate) => candidate.keyword === "for" && candidate.from === block.from);
  const predicateSpan = (stmt?.expressions ?? []).find((expr) => expr.kind === "eachCellPredicate");
  return {
    type: "eachCell",
    predicate: predicateSpan ? expressionCstToAst(predicateSpan.node) : null,
    actions: cellActionsCstToAst(cst, block),
  };
}

function renderCstToAst(cst) {
  const viewsSections = cst.blocks.filter((block) => block.keyword === "views").sort(byFrom);
  const palettes = [];
  const views = [];
  const overlays = [];
  for (const section of viewsSections) {
    for (const block of sorted(section.children ?? [])) {
      if (block.keyword === "palette") palettes.push(paletteCstToAst(block));
      else if (block.keyword === "view") views.push(viewCstToAst(cst, block));
    }
    for (const stmt of sorted(section.statements ?? [])) {
      if (stmt.keyword === "overlay") overlays.push({ name: wordsAfterKeyword(stmt)[0] ?? null });
    }
  }
  return { palettes, views, overlays };
}

function paletteCstToAst(block) {
  return {
    name: block.id,
    stops: sorted(block.statements)
      .filter((stmt) => stmt.keyword === "stop")
      .map(stopCstToAst),
  };
}

function stopCstToAst(stmt) {
  const match = /\bstop\s+([+-]?(?:\d+\.\d*|\.\d+|\d+)(?:e[+-]?\d+)?)\s+color\s*\[\s*([+-]?(?:\d+\.\d*|\.\d+|\d+))\s*,\s*([+-]?(?:\d+\.\d*|\.\d+|\d+))\s*,\s*([+-]?(?:\d+\.\d*|\.\d+|\d+))\s*\]/i.exec(stmt.cleanText);
  if (!match) throw new Error("v2 CST projection: incomplete palette stop");
  return {
    t: Number(match[1]),
    color: [Number(match[2]), Number(match[3]), Number(match[4])],
  };
}

function viewCstToAst(cst, block) {
  const colorStmt = sorted(block.statements).find((stmt) => stmt.keyword === "color");
  if (!colorStmt) throw new Error(`v2 CST projection: view ${block.id} missing color declaration`);
  const words = wordsFrom(colorStmt.cleanText);
  const kind = words[1] ?? null;
  const glyph = glyphFromViewBlock(block);
  const base = { id: block.id, label: blockLabel(cst, block) ?? block.id, glyph };
  if (kind === "ramp") {
    const range = rangeFromColorStatement(colorStmt) ?? [0, 1];
    const paletteName = /\bpalette\s+([A-Za-z_][A-Za-z0-9_]*)\b/.exec(colorStmt.cleanText)?.[1] ?? null;
    const stops = sorted(block.statements)
      .filter((stmt) => stmt.keyword === "stop")
      .map(stopCstToAst);
    return {
      ...base,
      kind,
      field: words[2] ?? null,
      range,
      paletteName,
      stops: stops.length > 0 ? stops : null,
    };
  }
  if (kind === "wheel") {
    return {
      ...base,
      kind,
      field: words[2] ?? null,
      range: rangeFromColorStatement(colorStmt) ?? [0, Math.PI * 2],
    };
  }
  if (kind === "expr") {
    return { ...base, kind, actions: cellActionsCstToAst(cst, block) };
  }
  throw new Error(`v2 CST projection: unsupported view color kind ${kind ?? ""}`);
}

// `glyph` is a sibling clause to `color` inside a `view` block —
// renders a small per-cell shape (arrow / dot / ring / square / plus)
// overlaid on the colored sphere, with optional rotation and size
// driven by recipe fields. Generalises the earlier `arrows`-only
// surface: any glyph shape, rotated by any vec2 field, scaled by any
// scalar field.
//
//   view flow "Velocity field" {
//     color ramp speed range [0, 1] palette HEAT
//     glyph arrow rotate=wind size=length(wind) length=0.6 stride=2
//   }
//
//   view density "Density dots" {
//     color ramp rho range [0, 1] palette MONO
//     glyph dot size=rho length=0.4
//   }
//
// `KIND` is one of: arrow, dot, ring, square, plus.
// `rotate=FIELD` (optional, vec2) — orient glyph by atan2(field.y, field.x).
// `size=FIELD` (optional, scalar) — scale glyph by field magnitude.
// `length=N` (default 0.5) — base size, units of cell-radius.
// `stride=N` (default 1) — render every Nth cell only.
function glyphFromViewBlock(block) {
  const stmt = sorted(block.statements).find((s) => s.keyword === "glyph");
  if (!stmt) return null;
  const text = stmt.cleanText;
  // First word after `glyph` is the KIND.
  const head = /\bglyph\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(text);
  if (!head) throw new Error(`v2 CST projection: view ${block.id}: glyph clause missing kind`);
  const kind = head[1];
  // `name=identifier` (rotate / size — field references)
  const fieldArgs = {};
  for (const m of text.matchAll(/\b(rotate|size)\s*=\s*([A-Za-z_][A-Za-z0-9_]*)/g)) {
    fieldArgs[m[1]] = m[2];
  }
  // `name=number` (length / stride)
  const numericArgs = {};
  for (const m of text.matchAll(/\b(length|stride)\s*=\s*(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)/g)) {
    numericArgs[m[1]] = Number(m[2]);
  }
  return {
    kind,
    rotate: fieldArgs.rotate ?? null,
    size:   fieldArgs.size   ?? null,
    length: Number.isFinite(numericArgs.length) ? numericArgs.length : 0.5,
    stride: Number.isFinite(numericArgs.stride) ? Math.max(1, Math.round(numericArgs.stride)) : 1,
  };
}

function rangeFromColorStatement(stmt) {
  const lo = (stmt.expressions ?? []).find((expr) => expr.kind === "rangeLower");
  const hi = (stmt.expressions ?? []).find((expr) => expr.kind === "rangeUpper");
  if (!lo || !hi) return null;
  return [rangeBoundCstToAst(lo.node), rangeBoundCstToAst(hi.node)];
}

function rangeBoundCstToAst(node) {
  if (node.type === "ExprNumber") return Number(node.value);
  if (node.type === "ExprUnary" && node.expr?.type === "ExprNumber") {
    const value = Number(node.expr.value);
    if (node.op === "-") return -value;
    if (node.op === "+") return value;
  }
  if (node.type === "ExprIdentifier") return { __ref: node.name };
  throw new Error("v2 CST projection: range bound must be a number or identifier");
}

function fieldListFromStatement(stmt) {
  const afterKeyword = stmt.cleanText.slice(stmt.cleanText.indexOf(stmt.keyword) + stmt.keyword.length);
  const items = [];
  for (const part of afterKeyword.split(",")) {
    const words = [...part.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*\b/g)].map((m) => m[0]);
    if (words.length === 0) continue;
    items.push({ name: words[0], previous: words.includes("previous") });
  }
  return items;
}

function stageLabel(cst, stageBlock) {
  return blockLabel(cst, stageBlock) ?? stageBlock.id;
}

function dedupe(values) {
  return [...new Set(values)];
}

function sorted(values) {
  return [...(values ?? [])].sort(byFrom);
}

function byFrom(a, b) {
  return a.from - b.from;
}

function wordsFrom(text) {
  return [...String(text ?? "").matchAll(/\b[A-Za-z_][A-Za-z0-9_]*\b/g)].map((m) => m[0]);
}

function wordsAfterKeyword(stmt) {
  return wordsFrom(stmt.cleanText).slice(1);
}

function firstString(cst, node) {
  const lineEnd = cst.source.indexOf("\n", node.from);
  const to = node.type === "Statement" ? (lineEnd >= 0 ? lineEnd : cst.source.length) : node.to;
  const text = cst.source.slice(node.from, to);
  return /"([^"]*)"/.exec(text)?.[1] ?? null;
}

function blockLabel(cst, block) {
  const header = cst.source.slice(block.headerFrom, block.headerTo);
  return /"([^"]*)"/.exec(header)?.[1] ?? null;
}

function numberAfter(text, prefixRe) {
  const start = prefixRe.exec(text);
  if (!start) throw new Error("v2 CST projection: expected number");
  const tail = text.slice(start.index + start[0].length);
  const number = /^[+-]?(?:\d+\.\d*|\.\d+|\d+)(?:e[+-]?\d+)?/i.exec(tail);
  if (!number) throw new Error("v2 CST projection: expected number");
  return Number(number[0]);
}

function firstExpression(stmt) {
  const expr = stmt.expressions?.[0]?.node;
  if (!expr && !stmt.cleanText.includes("=") && ["let", "set", "add"].includes(stmt.keyword)) {
    const match = new RegExp(String.raw`^\s*${stmt.keyword}\s+[A-Za-z_][A-Za-z0-9_]*\s*(.*)$`).exec(stmt.cleanText);
    const tail = match?.[1]?.trim() ?? "";
    if (tail) throw new Error(`v2 parse: expected "=" at "${tail}"`);
  }
  if (!expr) throw new Error(`v2 CST projection: ${stmt.keyword} action is missing expression`);
  return expr;
}

function findBlockForStatement(cst, stmt, keyword) {
  const block = (cst?.blocks ?? [])
    .filter((candidate) => candidate.keyword === keyword && candidate.from === stmt.from)
    .sort((a, b) => a.openBrace - b.openBrace)[0];
  if (!block) throw new Error(`v2 CST projection: missing ${keyword} block for statement`);
  return block;
}

function projectMember(node) {
  if (!node.prop) throw new Error("v2 CST projection: incomplete member access");
  const object = expressionCstToAst(node.object);
  if (object.type === "Identifier" && object.name === "brush") {
    return { type: "Identifier", name: node.prop };
  }
  return { type: "Member", object, prop: node.prop };
}

function projectCoordRead(node) {
  if (!node.field) {
    throw new Error("v2 CST projection: @ coordinate query must follow a bare field name");
  }
  if (!node.coord) {
    throw new Error("v2 CST projection: expected coordinate name after @");
  }
  if (node.coord === "prev") {
    return { type: "CoordRead", field: node.field, coord: { kind: "prev" } };
  }
  if (node.coord === "upstream") {
    if (node.args.length !== 3) {
      throw new Error(`v2 CST projection: ${node.field}@upstream takes exactly 3 args; got ${node.args.length}`);
    }
    return {
      type: "CoordRead",
      field: node.field,
      coord: {
        kind: "upstream",
        velX: expressionCstToAst(node.args[0]),
        velY: expressionCstToAst(node.args[1]),
        dt: expressionCstToAst(node.args[2]),
      },
    };
  }
  return { type: "CoordRead", field: node.field, coord: { kind: "neighbor", binding: node.coord } };
}
