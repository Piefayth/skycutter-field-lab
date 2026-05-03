import { cursorContextForAst, parseDslAst } from "../dsl/ast-v2.mjs";
import { DSL_SYMBOLS } from "./dsl-symbols.mjs";

const TOP_LEVEL_KINDS = new Set([
  "declKeyword", "blockKeyword", "gridKeyword",
]);
const STAGE_BODY_KINDS = new Set([
  "actionVerb", "primVerb", "controlKw", "mathFn", "mathConst",
  "builtin", "logicalOp", "literal", "modifier",
]);
const PRESET_BODY_KINDS = new Set([
  "initVerb", "controlKw", "mathFn", "mathConst", "builtin",
  "logicalOp", "literal", "modifier",
]);
const VIEW_BODY_KINDS = new Set([
  "actionVerb", "mathFn", "mathConst", "builtin", "logicalOp",
  "literal", "modifier",
]);
const INIT_CELL_KINDS = new Set([
  "actionVerb", "controlKw", "mathFn", "mathConst", "builtin",
  "logicalOp", "literal", "modifier",
]);

const TOP_LEVEL_COMPLETIONS = [
  keywordOption("recipe", "recipe \"Name\"", 30),
  keywordOption("summary", "summary \"Short description\"", 30),
  keywordOption("recommendedPreset", "recommendedPreset scenarioId"),
  keywordOption("substrate", "substrate geodesic frequency 64", 30),
  keywordOption("field", "field name: f32", 30),
  keywordOption("source", "source name: vec2"),
  keywordOption("const", "const NAME = value", 30),
  keywordOption("import", "import builtinName"),
  keywordOption("param", "param name slider lo..hi default value", 30),
  keywordOption("metric", "metric name = reduction cells { expr }", 30),
  keywordOption("step", "step { stage ... }", 30),
  keywordOption("views", "views { ... }", 30),
  keywordOption("stamps", "stamps { ... }", 30),
  keywordOption("scenarios", "scenarios { ... }", 30),
];

// Most new DSL constructs should enter autocomplete through one of these small
// tables plus, when needed, a CST expected-zone in dsl/cst-v2.mjs. Keep the
// CodeMirror adapter out of language-shape decisions.
const FIELD_TYPE_COMPLETIONS = [
  keywordOption("f32", "scalar field"),
  keywordOption("vec2", "2-component vector field"),
  keywordOption("u32", "unsigned integer field"),
  keywordOption("bool", "boolean field"),
];

const PARAM_WIDGET_COMPLETIONS = [
  keywordOption("slider", "numeric parameter"),
  keywordOption("toggle", "boolean parameter"),
];

const PARAM_MODIFIER_COMPLETIONS = [
  keywordOption("default"),
  keywordOption("label"),
  keywordOption("step"),
];

const METRIC_REDUCTION_COMPLETIONS = [
  keywordOption("sum", "sum cells { expr }"),
  keywordOption("max", "max cells { expr }"),
  keywordOption("min", "min cells { expr }"),
  keywordOption("mean", "mean cells { expr }"),
  keywordOption("count", "count cells where predicate"),
];

export function completionOptionsForSource(source, pos, prefix = "") {
  source = String(source ?? "");
  const ctx = detectContextForSource(source, pos);
  const mode = classifyContext(ctx);
  return buildOptions(source, ctx, mode, prefix);
}

export function detectContextForSource(source, pos) {
  source = String(source ?? "");
  const lineStart = source.lastIndexOf("\n", Math.max(0, pos - 1)) + 1;
  const lineUpToCursor = source.slice(lineStart, pos);
  const ast = parseDslAst(source);
  const cursor = cursorContextForAst(ast, pos);
  return {
    stack: cursor.stack.map((block) => block.keyword),
    lineUpToCursor,
    ast,
    cursor,
  };
}

export function classifyContext(ctx) {
  const line = ctx.lineUpToCursor;
  if (/^\s*(import|use)(\s|$)/.test(line)) {
    return { mode: "v2Import" };
  }
  if (ctx.cursor?.mode) return { mode: ctx.cursor.mode };

  let inner = null;
  for (let i = ctx.stack.length - 1; i >= 0; i--) {
    const top = ctx.stack[i];
    if (top === "?" || top === "when") continue;
    inner = top;
    break;
  }
  if (!inner) return { mode: "topLevel" };
  if (inner === "for") return { mode: "initCellBody" };
  if (inner === "cell") return { mode: "cellBody" };
  if (inner === "view") return { mode: "viewBody" };
  if (inner === "palette") return { mode: "paletteBody" };
  if (inner === "stage") return { mode: "stageBody" };
  if (inner === "step") return { mode: "stepBody" };
  if (inner === "views") return { mode: "viewsSection" };
  if (inner === "stamps") return { mode: "stampsSection" };
  if (inner === "scenarios") return { mode: "scenariosSection" };
  if (inner === "scenario" || inner === "stamp") return { mode: "presetBody" };
  return { mode: "topLevel" };
}

export function importedAlready(docText, sym) {
  const ns = importNamespace(sym);
  if (!ns) return true;
  const cleaned = String(docText ?? "").split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
  const importLines = [...cleaned.matchAll(/^[ \t]*import[ \t]+([\w$,\s]+)$/gm)];
  if (importLines.length === 0) return true;
  for (const m of importLines) {
    const names = m[1].split(",").map((s) => s.trim());
    if (names.includes(sym.name)) return true;
  }
  return false;
}

export function chooseImportInsertPoint(docText) {
  docText = String(docText ?? "");
  const lines = docText.split("\n");
  let lastImport = -1;
  let lastSchema = -1;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (/^(import|use)\s+\w+/.test(trimmed)) lastImport = i;
    else if (/^(recipe|summary|recommendedPreset|substrate|grid|planet|const)\b/.test(trimmed)) {
      lastSchema = i;
    }
  }
  const target = lastImport >= 0 ? lastImport : lastSchema;
  if (target < 0) return 0;
  let offset = 0;
  for (let i = 0; i <= target; i++) offset += lines[i].length + 1;
  return Math.min(offset, docText.length);
}

function buildOptions(docText, ctx, mode, prefix) {
  const grammarOptions = optionsForGrammarPosition(ctx, mode, prefix);
  if (grammarOptions) return grammarOptions;

  const allowDeclared = mode.mode === "cellBody" || mode.mode === "initCellBody"
    || mode.mode === "presetBody" || mode.mode === "stageBody"
    || mode.mode === "viewBody";

  const declared = allowDeclared ? declaredFromContext(ctx, docText) : [];
  const declaredOptions = declared
    .filter((d) => !prefix || d.name.toLowerCase().startsWith(prefix.toLowerCase()))
    .map((d) => declaredOption(d.name, d.role));

  const catalogOptions = symbolsForMode(mode)
    .filter((s) => !prefix || s.name.toLowerCase().startsWith(prefix.toLowerCase()))
    .map((sym) => catalogOption(sym, { withImport: mode.mode === "v2Import" ? false : !importedAlready(docText, sym) }));

  const seen = new Set();
  const out = [];
  for (const c of [...declaredOptions, ...catalogOptions]) {
    if (seen.has(c.label)) continue;
    seen.add(c.label);
    out.push(c);
  }
  return out;
}

function symbolsForMode(mode) {
  switch (mode.mode) {
    case "topLevel":
      return DSL_SYMBOLS.filter((s) => {
        if (s.kind === "declKeyword") return s.name !== "overlay";
        if (s.kind === "blockKeyword") return ["step", "views", "stamps", "scenarios"].includes(s.name);
        return TOP_LEVEL_KINDS.has(s.kind);
      });
    case "stageBody":
      return DSL_SYMBOLS.filter((s) =>
        s.kind === "declarationKw" || s.kind === "primVerb" || s.kind === "controlKw"
      );
    case "cellBody":
      return DSL_SYMBOLS.filter((s) => STAGE_BODY_KINDS.has(s.kind));
    case "presetBody":
      return DSL_SYMBOLS.filter((s) => PRESET_BODY_KINDS.has(s.kind));
    case "viewBody":
      return DSL_SYMBOLS.filter((s) => VIEW_BODY_KINDS.has(s.kind));
    case "paletteBody":
      return DSL_SYMBOLS.filter((s) => s.name === "stop" || s.name === "color");
    case "initCellBody":
      return DSL_SYMBOLS.filter((s) => INIT_CELL_KINDS.has(s.kind));
    case "stepBody":
      return DSL_SYMBOLS.filter((s) => s.name === "stage");
    case "viewsSection":
      return DSL_SYMBOLS.filter((s) => ["palette", "view", "overlay"].includes(s.name));
    case "stampsSection":
      return DSL_SYMBOLS.filter((s) => s.name === "stamp");
    case "scenariosSection":
      return DSL_SYMBOLS.filter((s) => s.name === "scenario");
    case "v2Import":
      return DSL_SYMBOLS.filter((s) => importNamespace(s));
    default:
      return DSL_SYMBOLS;
  }
}

function optionsForGrammarPosition(ctx, mode, prefix) {
  const expectedOptions = optionsForExpectedContext(ctx, prefix);
  if (expectedOptions) return expectedOptions;

  const fullLine = (ctx.lineUpToCursor ?? "").replace(/\/\/.*$/, "");
  const line = mode.mode === "topLevel" || mode.mode === "v2Import"
    ? fullLine
    : activeLineSegment(fullLine);
  const trimmed = line.trimStart();
  const initial = /^\s*$/.test(trimmed);
  const structural = (options) => filterOptions(options, prefix);

  if (mode.mode === "topLevel") {
    if (/^\s*recommendedPreset\s+$/.test(line)) return structural(scenariosFromAst(ctx));
    if (/^\s*field\s+[A-Za-z_][A-Za-z0-9_]*\s*:\s*$/.test(line)) return structural(FIELD_TYPE_COMPLETIONS);
    if (/^\s*source\s+[A-Za-z_][A-Za-z0-9_]*\s*:\s*$/.test(line)) return structural([keywordOption("vec2", "2-component source vector")]);
    if (/^\s*field\s+[A-Za-z_][A-Za-z0-9_]*\s*:\s+\w+\s+$/.test(line)) return structural([keywordOption("derived", "computed field")]);
    if (/^\s*param\s+[A-Za-z_][A-Za-z0-9_]*\s+$/.test(line)) return structural(PARAM_WIDGET_COMPLETIONS);
    if (/^\s*param\s+[A-Za-z_][A-Za-z0-9_]*\s+(slider|toggle)\s+.*\s+$/.test(line)) return structural(PARAM_MODIFIER_COMPLETIONS);
    if (/^\s*substrate\s+$/.test(line)) return structural([keywordOption("geodesic")]);
    if (/^\s*substrate\s+geodesic\s+$/.test(line)) return structural([keywordOption("frequency")]);
    if (/^\s*import(\s|$)/.test(line)) return null;
    if (/^\s*[A-Za-z_]*$/.test(trimmed)) return structural(TOP_LEVEL_COMPLETIONS);
  }

  if (mode.mode === "stepBody" && /^\s*[A-Za-z_]*$/.test(trimmed)) {
    return structural([keywordOption("stage", "stage id \"Label\" { ... }", 30)]);
  }

  if (mode.mode === "stageBody") {
    if (/^\s*(reads|writes)\s+[\w\s,]*$/.test(line)) return structural(fieldsFromAst(ctx));
    if (/^\s*[A-Za-z_]*$/.test(trimmed)) {
      return structural([
        keywordOption("reads", "reads field1, field2", 30),
        keywordOption("writes", "writes field1, field2", 30),
        keywordOption("cell", "cell { ... }", 30),
      ]);
    }
  }

  if (mode.mode === "viewsSection") {
    if (/^\s*overlay\s+$/.test(line)) return structural([keywordOption("grid")]);
    if (/^\s*[A-Za-z_]*$/.test(trimmed)) {
      return structural([
        keywordOption("palette", "palette NAME { stop ... }", 30),
        keywordOption("view", "view id \"Label\" { color ... }", 30),
        keywordOption("overlay", "overlay grid", 30),
      ]);
    }
  }

  if (mode.mode === "stampsSection" && /^\s*[A-Za-z_]*$/.test(trimmed)) {
    return structural([keywordOption("stamp", "stamp id \"Label\" { ... }", 30)]);
  }
  if (mode.mode === "scenariosSection" && /^\s*[A-Za-z_]*$/.test(trimmed)) {
    return structural([keywordOption("scenario", "scenario id \"Label\" { ... }", 30)]);
  }

  if (mode.mode === "paletteBody") {
    if (/^\s*stop\s+[-+.\w]+\s+$/.test(line)) return structural([keywordOption("color")]);
    if (/^\s*[A-Za-z_]*$/.test(trimmed)) return structural([keywordOption("stop", "stop 0 color [0, 0, 0]", 30)]);
  }

  if (mode.mode === "viewBody") {
    if (/^\s*color\s+$/.test(line)) return structural([keywordOption("ramp", "color ramp field palette PALETTE", 30), keywordOption("wheel", "color wheel field", 30), keywordOption("expr", "color expr { ... }", 30)]);
    if (/^\s*color\s+(ramp|wheel)\s+$/.test(line)) return structural(fieldsFromAst(ctx));
    if (/^\s*color\s+ramp\s+[A-Za-z_][A-Za-z0-9_]*\s+$/.test(line)) return structural([keywordOption("range", "range [lo, hi]"), keywordOption("palette", "palette NAME"), keywordOption("stops", "stops { stop ... }")]);
    if (/^\s*color\s+ramp\s+[A-Za-z_][A-Za-z0-9_]*\s+range\s+\[[^\]]+\]\s+$/.test(line)) return structural([keywordOption("palette", "palette NAME"), keywordOption("stops", "stops { stop ... }")]);
    if (/^\s*color\s+wheel\s+[A-Za-z_][A-Za-z0-9_]*\s+$/.test(line)) return structural([keywordOption("range", "range [lo, hi]")]);
    if (/\bpalette\s+$/.test(line)) return structural(palettesFromAst(ctx));
    if (/\brange\s+\[\s*$/.test(line) || /\brange\s+\[[^,\]]*,\s*$/.test(line)) return structural(constantsFromAst(ctx));
    if (/^\s*set\s+$/.test(line)) return structural([declaredOption("red", "declared"), declaredOption("green", "declared"), declaredOption("blue", "declared")]);
    if (/^\s*[A-Za-z_]*$/.test(trimmed)) return structural([keywordOption("color", "color ramp|wheel|expr", 30)]);
  }

  if (mode.mode === "presetBody") {
    if (/^\s*(set|spot|ellipse|region)\s+$/.test(line)) return structural(fieldsFromAst(ctx));
    if (/\bat\s+$/.test(line) && ctx.stack.includes("stamp")) return structural([declaredOption("brush", "declared")]);
    if (initial || /^\s*[A-Za-z_]*$/.test(trimmed)) {
      return structural([
        keywordOption("set", "set field = expr", 30),
        keywordOption("spot", "spot field at ...", 30),
        keywordOption("ellipse", "ellipse field at ...", 30),
        keywordOption("region", "region field at ...", 30),
        keywordOption("for", "for each cell { ... }", 30),
      ]);
    }
  }

  if (mode.mode === "cellBody" || mode.mode === "initCellBody") {
    if (/^\s*(set|add)\s+$/.test(line)) return structural(fieldsFromAst(ctx));
    if (initial || /^\s*[A-Za-z_]*$/.test(trimmed)) {
      return structural([
        keywordOption("let", "let name = expr", 30),
        keywordOption("set", "set field = expr", 30),
        keywordOption("add", "add field = expr", 30),
        keywordOption("when", "when condition { ... }", 30),
      ]);
    }
  }

  return null;
}

function optionsForExpectedContext(ctx, prefix) {
  const expected = new Set(ctx.cursor?.expected ?? []);
  if (expected.size === 0 || expected.has("expression")) return null;
  const structural = (options) => filterOptions(options, prefix);
  if (expected.has("fieldName")) return structural(fieldsFromAst(ctx));
  if (expected.has("paletteName")) return structural(palettesFromAst(ctx));
  if (expected.has("scenarioName")) return structural(scenariosFromAst(ctx));
  if (expected.has("fieldType")) return structural(FIELD_TYPE_COMPLETIONS);
  if (expected.has("coordName")) return structural(coordOptionsFromContext(ctx));
  if (expected.has("substrateKind")) return structural([keywordOption("geodesic")]);
  if (expected.has("substrateOption")) return structural([keywordOption("frequency")]);
  if (expected.has("paramWidget")) return structural(PARAM_WIDGET_COMPLETIONS);
  if (expected.has("paramModifier")) return structural(PARAM_MODIFIER_COMPLETIONS);
  if (expected.has("metricReduction")) return structural(METRIC_REDUCTION_COMPLETIONS);
  if (expected.has("colorRampModifier")) return structural([keywordOption("range", "range [lo, hi]"), keywordOption("palette", "palette NAME"), keywordOption("stops", "stops { stop ... }")]);
  if (expected.has("colorWheelModifier")) return structural([keywordOption("range", "range [lo, hi]")]);
  if (expected.has("colorKind")) return structural([keywordOption("ramp", "color ramp field palette PALETTE", 30), keywordOption("wheel", "color wheel field", 30), keywordOption("expr", "color expr { ... }", 30)]);
  return null;
}

function declaredFromDoc(doc) {
  const names = parseDslAst(doc).names;
  const out = [];
  for (const n of names.fields ?? []) out.push({ name: n, role: "field" });
  for (const n of names.sources ?? []) out.push({ name: n, role: "source" });
  for (const n of names.parameters ?? []) out.push({ name: n, role: "param" });
  for (const n of names.constants ?? []) out.push({ name: n, role: "const" });
  for (const n of names.planet ?? []) out.push({ name: n, role: "planet" });
  for (const n of names.palettes ?? []) out.push({ name: n, role: "palette" });
  return out;
}

function declaredFromContext(ctx, doc) {
  const symbols = ctx.cursor?.symbols ?? null;
  if (!symbols) return declaredFromDoc(doc);
  const out = [];
  for (const symbol of symbols) {
    if (symbol.kind === "field") out.push({ name: symbol.name, role: "field" });
    else if (symbol.kind === "source") out.push({ name: symbol.name, role: "source" });
    else if (symbol.kind === "param") out.push({ name: symbol.name, role: "param" });
    else if (symbol.kind === "const") out.push({ name: symbol.name, role: "const" });
    else if (symbol.kind === "palette") out.push({ name: symbol.name, role: "palette" });
    else if (symbol.kind === "local") out.push({ name: symbol.name, role: "local" });
    else if (symbol.kind === "binder") out.push({ name: symbol.name, role: "binder" });
  }
  return out;
}

function astNames(ctx) {
  return ctx.ast?.names ?? {};
}

function fieldsFromAst(ctx) {
  return optionsFromNames(astNames(ctx).fields, "field");
}

function palettesFromAst(ctx) {
  return optionsFromNames(astNames(ctx).palettes, "palette");
}

function scenariosFromAst(ctx) {
  return optionsFromNames(astNames(ctx).scenarios, "declared");
}

function constantsFromAst(ctx) {
  const names = astNames(ctx);
  return [
    ...optionsFromNames(names.constants, "const"),
    ...optionsFromNames(names.parameters, "param"),
    declaredOption("PI", "const"),
    declaredOption("TAU", "const"),
  ];
}

function coordOptionsFromContext(ctx) {
  const binders = (ctx.cursor?.symbols ?? [])
    .filter((symbol) => symbol.kind === "binder")
    .map((symbol) => declaredOption(symbol.name, "binder"));
  return [
    ...binders,
    keywordOption("prev", "previous tick", 30),
    keywordOption("upstream", "upstream(velX, velY, dt)", 30),
  ];
}

function optionsFromNames(names, role) {
  return [...new Set(names ?? [])].map((name) => declaredOption(name, role));
}

function filterOptions(options, prefix) {
  const q = String(prefix ?? "").toLowerCase();
  const seen = new Set();
  const out = [];
  for (const option of options) {
    if (!option?.label) continue;
    if (q && !option.label.toLowerCase().startsWith(q)) continue;
    if (seen.has(option.label)) continue;
    seen.add(option.label);
    out.push(option);
  }
  return out;
}

function activeLineSegment(line) {
  const brace = line.lastIndexOf("{");
  const semi = line.lastIndexOf(";");
  const cut = Math.max(brace, semi);
  return cut >= 0 ? line.slice(cut + 1) : line;
}

function keywordOption(label, detail = undefined, boost = 20) {
  return { source: "keyword", label, type: "keyword", detail, boost };
}

function declaredOption(name, role) {
  return {
    source: "declared",
    label: name,
    role,
    type: roleToCmType(role),
    detail: role,
    boost: declaredBoost(role),
  };
}

function catalogOption(sym, { withImport = false } = {}) {
  return {
    source: "catalog",
    label: sym.name,
    type: kindToCmType(sym.kind),
    detail: sym.kind === "mathFn" ? sym.signature?.split("\n")[0] : undefined,
    boost: catalogBoost(sym),
    symbol: sym,
    withImport,
  };
}

function importNamespace(sym) {
  return sym.importNamespace ?? null;
}

function kindToCmType(kind) {
  switch (kind) {
    case "primVerb":
    case "actionVerb":
    case "initVerb":      return "method";
    case "mathFn":        return "function";
    case "mathConst":     return "constant";
    case "builtin":       return "variable";
    case "controlKw":
    case "declKeyword":
    case "blockKeyword":
    case "declarationKw":
    case "gridKeyword":
    case "logicalOp":     return "keyword";
    case "modifier":      return "property";
    case "literal":       return "constant";
    default:              return "variable";
  }
}

function catalogBoost(sym) {
  switch (sym.kind) {
    case "primVerb":      return 5;
    case "actionVerb":
    case "initVerb":      return 4;
    case "controlKw":
    case "declKeyword":
    case "blockKeyword":  return 3;
    case "mathFn":        return 2;
    case "builtin":
    case "mathConst":     return 1;
    case "literal":       return 0;
    case "modifier":      return -2;
    default:              return 0;
  }
}

function roleToCmType(role) {
  switch (role) {
    case "field":
    case "source":
    case "declared":  return "variable";
    case "local":     return "variable";
    case "binder":    return "variable";
    case "param":
    case "const":
    case "palette":
    case "planet":    return "constant";
    default:          return "variable";
  }
}

function declaredBoost(role) {
  switch (role) {
    case "field":
    case "param":     return 9;
    case "local":     return 10;
    case "binder":    return 10;
    case "const":
    case "palette":
    case "planet":
    case "source":
    case "declared":  return 8;
    default:          return 6;
  }
}
