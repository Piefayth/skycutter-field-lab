// =============================================================================
// DSL autocomplete + auto-import.
//
// Behaviour:
//   - Typing an identifier prefix shows suggestions.
//   - Tab accepts; Escape dismisses.
//   - Exactly one match → render a ghost-inline preview after the
//     cursor (no popup); Tab still accepts.
//   - Two-or-more matches → standard autocomplete popup.
//   - Auto-import: accepting a catalog symbol whose name isn't yet on
//     an `import …` line inserts (or extends) the import for you,
//     in the right place, without disturbing the cursor.
//
// Suggestions come from two sources in priority order:
//   1. Recipe-declared identifiers (live-parsed from the doc) —
//      fields, sources, params, consts, planet constants.
//   2. The static DSL_SYMBOLS catalog, scoped to the cursor's context
//      (top-level vs stage body vs scenario body vs `import` line).
// =============================================================================

import {
  autocompletion, completionKeymap, acceptCompletion,
} from "@codemirror/autocomplete";
import {
  keymap, Decoration, WidgetType, EditorView,
} from "@codemirror/view";
import { StateField, StateEffect, Prec } from "@codemirror/state";

import { DSL_SYMBOLS } from "./dsl-symbols.mjs";
import { cursorContextForAst, parseDslAst } from "../dsl/ast-v2.mjs";

// ---------------------------------------------------------------------------
// Catalog buckets — precomputed once so context-filtered lookups are cheap.
// ---------------------------------------------------------------------------

// V2 imports are flat (`import name1, name2`) — there is no surface
// namespace anymore. The legacy `importNamespace` accessor is kept ONLY
// as a "this symbol comes from a namespaced builtin and therefore needs
// importing" sentinel; the value (when present) still classifies the
// symbol's origin module for docs grouping. Reads `sym.importNamespace`
// directly — no importLine regex parsing.
function importNamespace(sym) {
  return sym.importNamespace ?? null;
}

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

// ---------------------------------------------------------------------------
// Catalog → Completion mapping.
// ---------------------------------------------------------------------------

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

function catalogCompletion(sym, { withImport = false } = {}) {
  return {
    label: sym.name,
    type: kindToCmType(sym.kind),
    detail: sym.kind === "mathFn" ? sym.signature?.split("\n")[0] : undefined,
    boost: catalogBoost(sym),
    info() {
      const root = document.createElement("div");
      root.className = "dsl-ac-info";
      if (sym.signature) {
        const sig = document.createElement("pre");
        sig.className = "dsl-ac-info__sig";
        sig.textContent = sym.signature;
        root.appendChild(sig);
      }
      if (sym.doc) {
        const doc = document.createElement("p");
        doc.className = "dsl-ac-info__doc";
        doc.textContent = sym.doc;
        root.appendChild(doc);
      }
      if (withImport && sym.importLine) {
        const imp = document.createElement("div");
        imp.className = "dsl-ac-info__import";
        imp.textContent = `auto-imports: ${sym.importLine.replace(/\n/g, " · ")}`;
        root.appendChild(imp);
      } else if (sym.importLine) {
        const imp = document.createElement("div");
        imp.className = "dsl-ac-info__import dsl-ac-info__import--present";
        imp.textContent = sym.importLine;
        root.appendChild(imp);
      }
      return root;
    },
    apply(view, completion, from, to) {
      view.dispatch({
        changes: { from, to, insert: sym.name },
        selection: { anchor: from + sym.name.length },
      });
      if (withImport) ensureImportFor(view, sym);
    },
  };
}

function declaredCompletion(name, role) {
  return {
    label: name,
    type: roleToCmType(role),
    detail: role,
    boost: declaredBoost(role),
  };
}

function roleToCmType(role) {
  switch (role) {
    case "field":
    case "source":
    case "declared":  return "variable";
    case "local":     return "variable";
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
    case "const":
    case "palette":
    case "planet":
    case "source":
    case "declared":  return 8;
    default:          return 6;
  }
}

// ---------------------------------------------------------------------------
// Context detection. Use the tolerant DSL AST scanner so folding,
// autocomplete, and name extraction share one structural model even
// while the compiler parser would reject the half-typed document.
// ---------------------------------------------------------------------------

function detectContext(state, pos) {
  const lineStart = state.doc.lineAt(pos).from;
  const lineUpToCursor = state.doc.sliceString(lineStart, pos);
  const ast = parseDslAst(state.doc.toString());
  const cursor = cursorContextForAst(ast, pos);
  return {
    stack: cursor.stack.map((block) => block.keyword),
    lineUpToCursor,
    ast,
    cursor,
  };
}

// Map context → completion mode. `when` is treated as transparent so a
// `when ... { CURSOR }` inside `cell { ... }` still classifies as cellBody.
function classifyContext(ctx) {
  const line = ctx.lineUpToCursor;
  // `import …` line: every identifier on it is a flat builtin name.
  // The `use` form below is preserved as a graceful catch for any
  // saved-recipe text typed before v2 landed — same suggestion path.
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

// ---------------------------------------------------------------------------
// Build options.
// ---------------------------------------------------------------------------

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
      // Inside `step { ... }` only stage declarations belong here.
      return DSL_SYMBOLS.filter((s) => s.name === "stage");
    case "viewsSection":
      return DSL_SYMBOLS.filter((s) => ["palette", "view", "overlay"].includes(s.name));
    case "stampsSection":
      return DSL_SYMBOLS.filter((s) => s.name === "stamp");
    case "scenariosSection":
      return DSL_SYMBOLS.filter((s) => s.name === "scenario");
    case "v2Import":
      // Flat list of every importable builtin (filtered to symbols that
      // actually need importing — built-in syntax keywords don't).
      return DSL_SYMBOLS.filter((s) => importNamespace(s));
    default:
      return DSL_SYMBOLS;
  }
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
  }
  return out;
}

const TOP_LEVEL_COMPLETIONS = [
  keywordOption("recipe", "recipe \"Name\""),
  keywordOption("summary", "summary \"Short description\""),
  keywordOption("recommendedPreset", "recommendedPreset scenarioId"),
  keywordOption("substrate", "substrate geodesic frequency 64"),
  keywordOption("field", "field name: f32"),
  keywordOption("source", "source name: vec2"),
  keywordOption("const", "const NAME = value"),
  keywordOption("import", "import builtinName"),
  keywordOption("param", "param name slider lo..hi default value"),
  keywordOption("metric", "metric name = reduction cells { expr }"),
  keywordOption("step", "step { stage ... }"),
  keywordOption("views", "views { ... }"),
  keywordOption("stamps", "stamps { ... }"),
  keywordOption("scenarios", "scenarios { ... }"),
];

const FIELD_TYPE_COMPLETIONS = [
  keywordOption("f32", "scalar field"),
  keywordOption("vec2", "2-component vector field"),
  keywordOption("u32", "unsigned integer field"),
  keywordOption("bool", "boolean field"),
];

function keywordOption(label, detail = undefined, boost = 20) {
  return { label, type: "keyword", detail, boost };
}

function structuralOption(label, detail = undefined, boost = 30) {
  return { label, type: "keyword", detail, boost };
}

function optionsFromNames(names, role) {
  return [...new Set(names ?? [])].map((name) => declaredCompletion(name, role));
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
    declaredCompletion("PI", "const"),
    declaredCompletion("TAU", "const"),
  ];
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

function lineWithoutPrefix(ctx) {
  // `detectContext` is called at the start of the currently matched word,
  // so `lineUpToCursor` is already the structural text before the prefix.
  return ctx.lineUpToCursor ?? "";
}

function activeLineSegment(line) {
  const brace = line.lastIndexOf("{");
  const semi = line.lastIndexOf(";");
  const cut = Math.max(brace, semi);
  return cut >= 0 ? line.slice(cut + 1) : line;
}

function optionsForGrammarPosition(ctx, mode, prefix) {
  const before = lineWithoutPrefix(ctx);
  const fullLine = before.replace(/\/\/.*$/, "");
  const line = mode.mode === "topLevel" || mode.mode === "v2Import"
    ? fullLine
    : activeLineSegment(fullLine);
  const trimmed = line.trimStart();
  const initial = /^\s*$/.test(trimmed);
  const structural = (options) => filterOptions(options, prefix);

  if (mode.mode === "topLevel") {
    if (/^\s*recommendedPreset\s+$/.test(line)) return structural(scenariosFromAst(ctx));
    if (/^\s*field\s+[A-Za-z_][A-Za-z0-9_]*\s*:\s*$/.test(line)) {
      return structural(FIELD_TYPE_COMPLETIONS);
    }
    if (/^\s*source\s+[A-Za-z_][A-Za-z0-9_]*\s*:\s*$/.test(line)) {
      return structural([keywordOption("vec2", "2-component source vector")]);
    }
    if (/^\s*field\s+[A-Za-z_][A-Za-z0-9_]*\s*:\s+\w+\s+$/.test(line)) {
      return structural([keywordOption("derived", "computed field")]);
    }
    if (/^\s*param\s+[A-Za-z_][A-Za-z0-9_]*\s+$/.test(line)) {
      return structural([
        keywordOption("slider", "numeric parameter"),
        keywordOption("toggle", "boolean parameter"),
      ]);
    }
    if (/^\s*param\s+[A-Za-z_][A-Za-z0-9_]*\s+(slider|toggle)\s+.*\s+$/.test(line)) {
      return structural([
        keywordOption("default"),
        keywordOption("label"),
        keywordOption("step"),
      ]);
    }
    if (/^\s*substrate\s+$/.test(line)) return structural([keywordOption("geodesic")]);
    if (/^\s*substrate\s+geodesic\s+$/.test(line)) return structural([keywordOption("frequency")]);
    if (/^\s*import(\s|$)/.test(line)) return null;
    if (/^\s*[A-Za-z_]*$/.test(trimmed)) return structural(TOP_LEVEL_COMPLETIONS);
  }

  if (mode.mode === "stepBody") {
    if (/^\s*[A-Za-z_]*$/.test(trimmed)) {
      return structural([structuralOption("stage", "stage id \"Label\" { ... }")]);
    }
  }

  if (mode.mode === "stageBody") {
    if (/^\s*(reads|writes)\s+[\w\s,]*$/.test(line)) return structural(fieldsFromAst(ctx));
    if (/^\s*[A-Za-z_]*$/.test(trimmed)) {
      return structural([
        structuralOption("reads", "reads field1, field2"),
        structuralOption("writes", "writes field1, field2"),
        structuralOption("cell", "cell { ... }"),
      ]);
    }
  }

  if (mode.mode === "viewsSection") {
    if (/^\s*overlay\s+$/.test(line)) return structural([keywordOption("grid")]);
    if (/^\s*[A-Za-z_]*$/.test(trimmed)) {
      return structural([
        structuralOption("palette", "palette NAME { stop ... }"),
        structuralOption("view", "view id \"Label\" { color ... }"),
        structuralOption("overlay", "overlay grid"),
      ]);
    }
  }

  if (mode.mode === "stampsSection") {
    if (/^\s*[A-Za-z_]*$/.test(trimmed)) {
      return structural([structuralOption("stamp", "stamp id \"Label\" { ... }")]);
    }
  }

  if (mode.mode === "scenariosSection") {
    if (/^\s*[A-Za-z_]*$/.test(trimmed)) {
      return structural([structuralOption("scenario", "scenario id \"Label\" { ... }")]);
    }
  }

  if (mode.mode === "paletteBody") {
    if (/^\s*stop\s+[-+.\w]+\s+$/.test(line)) return structural([keywordOption("color")]);
    if (/^\s*[A-Za-z_]*$/.test(trimmed)) return structural([structuralOption("stop", "stop 0 color [0, 0, 0]")]);
  }

  if (mode.mode === "viewBody") {
    if (/^\s*color\s+$/.test(line)) {
      return structural([
        structuralOption("ramp", "color ramp field palette PALETTE"),
        structuralOption("wheel", "color wheel field"),
        structuralOption("expr", "color expr { ... }"),
      ]);
    }
    if (/^\s*color\s+(ramp|wheel)\s+$/.test(line)) return structural(fieldsFromAst(ctx));
    if (/^\s*color\s+ramp\s+[A-Za-z_][A-Za-z0-9_]*\s+$/.test(line)) {
      return structural([
        keywordOption("range", "range [lo, hi]"),
        keywordOption("palette", "palette NAME"),
        keywordOption("stops", "stops { stop ... }"),
      ]);
    }
    if (/^\s*color\s+ramp\s+[A-Za-z_][A-Za-z0-9_]*\s+range\s+\[[^\]]+\]\s+$/.test(line)) {
      return structural([
        keywordOption("palette", "palette NAME"),
        keywordOption("stops", "stops { stop ... }"),
      ]);
    }
    if (/^\s*color\s+wheel\s+[A-Za-z_][A-Za-z0-9_]*\s+$/.test(line)) {
      return structural([keywordOption("range", "range [lo, hi]")]);
    }
    if (/\bpalette\s+$/.test(line)) return structural(palettesFromAst(ctx));
    if (/\brange\s+\[\s*$/.test(line) || /\brange\s+\[[^,\]]*,\s*$/.test(line)) {
      return structural(constantsFromAst(ctx));
    }
    if (/^\s*set\s+$/.test(line)) {
      return structural([
        declaredCompletion("red", "declared"),
        declaredCompletion("green", "declared"),
        declaredCompletion("blue", "declared"),
      ]);
    }
    if (/^\s*[A-Za-z_]*$/.test(trimmed)) return structural([structuralOption("color", "color ramp|wheel|expr")]);
  }

  if (mode.mode === "presetBody") {
    if (/^\s*(set|spot|ellipse|region)\s+$/.test(line)) return structural(fieldsFromAst(ctx));
    if (/\bat\s+$/.test(line) && ctx.stack.includes("stamp")) {
      return structural([declaredCompletion("brush", "declared")]);
    }
    if (initial || /^\s*[A-Za-z_]*$/.test(trimmed)) {
      return structural([
        structuralOption("set", "set field = expr"),
        structuralOption("spot", "spot field at ..."),
        structuralOption("ellipse", "ellipse field at ..."),
        structuralOption("region", "region field where ..."),
        structuralOption("for", "for each cell { ... }"),
      ]);
    }
  }

  if (mode.mode === "cellBody") {
    if (/^\s*(set|add)\s+$/.test(line)) return structural(fieldsFromAst(ctx));
    if (initial || /^\s*[A-Za-z_]*$/.test(trimmed)) {
      return structural([
        structuralOption("let", "let name = expr"),
        structuralOption("set", "set field = expr"),
        structuralOption("add", "add field = expr"),
        structuralOption("when", "when condition { ... }"),
      ]);
    }
  }

  return null;
}

function buildOptions(state, ctx, mode, prefix) {
  const grammarOptions = optionsForGrammarPosition(ctx, mode, prefix);
  if (grammarOptions) return grammarOptions;

  const allowDeclared = mode.mode === "cellBody" || mode.mode === "initCellBody"
    || mode.mode === "presetBody" || mode.mode === "stageBody"
    || mode.mode === "viewBody";

  const docText = state.doc.toString();
  const declared = allowDeclared ? declaredFromContext(ctx, docText) : [];

  const declaredOptions = declared
    .filter((d) => !prefix || d.name.toLowerCase().startsWith(prefix.toLowerCase()))
    .map((d) => declaredCompletion(d.name, d.role));

  const catalog = symbolsForMode(mode);
  const catalogOptions = catalog
    .filter((s) => !prefix || s.name.toLowerCase().startsWith(prefix.toLowerCase()))
    .map((sym) => {
      // V2 imports are inserted as `import name1, name2, ...` lines —
      // the auto-import path injects the symbol's name into an
      // existing import line or creates one if none exists. When the
      // user is autocompleting INSIDE an `import` line, no auto-import
      // is needed (they're typing the import directly).
      if (mode.mode === "v2Import") return catalogCompletion(sym, { withImport: false });
      const present = sym.importLine ? importedAlready(docText, sym) : true;
      return catalogCompletion(sym, { withImport: !present });
    });

  // Dedup — declared name shadows catalog name (a recipe declaring
  // `field u` should suggest its own `u`, not the geodesic builtin).
  const seen = new Set();
  const out = [];
  for (const c of [...declaredOptions, ...catalogOptions]) {
    if (seen.has(c.label)) continue;
    seen.add(c.label);
    out.push(c);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Auto-import.
// ---------------------------------------------------------------------------

function importedAlready(docText, sym) {
  const ns = importNamespace(sym);
  if (!ns) return true;
  // A recipe is "ALREADY OK" if either:
  //   - it has no `import` line at all (default = all builtins in scope), OR
  //   - it has at least one `import` line and the symbol's name appears.
  // Strip line comments so trailing `// note` text doesn't get parsed
  // as identifiers.
  const cleaned = docText.split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
  const importLines = [...cleaned.matchAll(/^[ \t]*import[ \t]+([\w$,\s]+)$/gm)];
  if (importLines.length === 0) return true;
  for (const m of importLines) {
    const names = m[1].split(",").map((s) => s.trim());
    if (names.includes(sym.name)) return true;
  }
  return false;
}

// Insert (or extend) an `import name` line. Two paths:
//   1. If an `import …` line already exists, append `, name` to it.
//   2. Else, drop a fresh `import name` line — after the last existing
//      schema directive, else at the top of file.
function ensureImportFor(view, sym) {
  const ns = importNamespace(sym);
  if (!ns) return;
  const docText = view.state.doc.toString();
  if (importedAlready(docText, sym)) return;

  const lineRe = /^([ \t]*import[ \t]+)([\w$,\s]+)$/m;
  const extend = lineRe.exec(docText);
  if (extend) {
    const lineEnd = extend.index + extend[0].length;
    const inserted = `, ${sym.name}`;
    const cursor = view.state.selection.main.head;
    const newCursor = cursor > lineEnd ? cursor + inserted.length : cursor;
    view.dispatch({
      changes: { from: lineEnd, to: lineEnd, insert: inserted },
      selection: { anchor: newCursor },
    });
    return;
  }

  const insertAt = chooseImportInsertPoint(docText);
  // If the insertion point is end-of-doc and the doc doesn't already end
  // with a newline, prepend `\n` so the new directive doesn't fuse onto
  // the previous line's last token. Trailing `\n` ensures whatever
  // follows (a blank line, eof) keeps its shape.
  const needsLeadingNewline = insertAt === docText.length
    && docText.length > 0
    && !docText.endsWith("\n");
  // The first auto-imported name creates a fresh `import name` line;
  // subsequent names extend that line (handled by the `extend` branch
  // above).
  const insertText = (needsLeadingNewline ? "\n" : "")
    + `import ${sym.name}\n`;
  const cursor = view.state.selection.main.head;
  const newCursor = cursor > insertAt ? cursor + insertText.length : cursor;
  view.dispatch({
    changes: { from: insertAt, to: insertAt, insert: insertText },
    selection: { anchor: newCursor },
  });
}

function chooseImportInsertPoint(docText) {
  const lines = docText.split("\n");
  let lastImport = -1;
  let lastSchema = -1;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    // `import` lines anchor the new directive; the legacy `use` form
    // is matched too as a fallback for any older saved-recipe text.
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

// ---------------------------------------------------------------------------
// Completion source (popup driver).
// ---------------------------------------------------------------------------

function dslCompletionSource(context) {
  const word = context.matchBefore(/[A-Za-z_$][A-Za-z0-9_$]*/);
  if (!word && !context.explicit) return null;
  const from = word ? word.from : context.pos;
  const to = word ? word.to : context.pos;
  const prefix = word ? word.text : "";

  // Suppress mid-word completion: if the cursor sits inside a word
  // (the next char is an identifier char), the user is editing an
  // existing identifier, not typing a new one. Autocompleting in that
  // position would replace half a word the user wanted to keep.
  // Explicit invocation (Ctrl-Space) bypasses this check.
  if (!context.explicit && cursorIsMidWord(context.state, context.pos)) return null;

  const ctx = detectContext(context.state, from);
  const mode = classifyContext(ctx);

  // Implicit (typed) completion only fires once a prefix exists. Explicit
  // (Ctrl-Space) shows everything for the context.
  if (!prefix && !context.explicit) return null;

  const options = buildOptions(context.state, ctx, mode, prefix);
  if (options.length === 0) return null;

  // Single match → suppress the popup; the ghost extension shows the
  // suggestion inline instead. Returning null here prevents the popup
  // from opening for that case.
  if (options.length === 1 && !context.explicit) return null;

  return { from, to, options, filter: true };
}

// ---------------------------------------------------------------------------
// Inline ghost-text for the single-suggestion case.
//
// The ghost is a pure derivation of the editor state — given the current
// cursor + doc, what's the unique completion (if any). We compute it
// inside a StateField so it stays current with every transaction WITHOUT
// dispatching new transactions from inside an update (which CodeMirror
// forbids — that's the trap an earlier ViewPlugin-based version fell
// into).
//
// Suppression for Esc: a separate StateField holds an integer cursor pos
// the user dismissed the ghost at. Any doc change clears it. The main
// ghost field reads from it during compute and returns null while the
// cursor sits at the suppressed pos.
// ---------------------------------------------------------------------------

class GhostWidget extends WidgetType {
  constructor(text) { super(); this.text = text; }
  toDOM() {
    const span = document.createElement("span");
    span.className = "dsl-ac-ghost";
    span.textContent = this.text;
    return span;
  }
  ignoreEvent() { return true; }
  eq(other) { return other.text === this.text; }
}

// Esc-suppression. When the user dismisses the ghost, we record the
// cursor position; doc/selection changes invalidate the suppression so
// the next round of typing re-enables ghosting normally.
const suppressGhostAt = StateEffect.define();

const ghostSuppressField = StateField.define({
  create() { return -1; },
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(suppressGhostAt)) return effect.value;
    // Any doc edit moves us past the suppressed pos; let the ghost come
    // back. A pure selection move (cursor-around) also clears it — the
    // user is investigating a different position.
    if (tr.docChanged || tr.selection) return -1;
    return value;
  },
});

function wordBefore(state, pos) {
  const line = state.doc.lineAt(pos);
  const text = line.text.slice(0, pos - line.from);
  const m = /[A-Za-z_$][A-Za-z0-9_$]*$/.exec(text);
  if (!m) return null;
  return { from: line.from + m.index, to: pos, text: m[0] };
}

// True when the next character is an identifier char — i.e., the cursor
// is inside an existing word, not at its trailing edge. The autocomplete
// and ghost both suppress in this case so editing `dif|fuse` doesn't
// pop a suggestion that would replace the unread half of the word.
function cursorIsMidWord(state, pos) {
  if (pos >= state.doc.length) return false;
  const next = state.doc.sliceString(pos, pos + 1);
  return /[A-Za-z0-9_$]/.test(next);
}

// Pure function: given a state, return the ghost record (or null).
// Reads suppressed-at to honor recent Esc.
function computeGhost(state) {
  const suppressedAt = state.field(ghostSuppressField, false);
  const sel = state.selection.main;
  if (!sel.empty) return null;
  const pos = sel.head;
  if (suppressedAt === pos) return null;
  // Don't ghost in the middle of an existing word — the user is editing,
  // not typing-from-scratch.
  if (cursorIsMidWord(state, pos)) return null;
  const word = wordBefore(state, pos);
  if (!word || !word.text) return null;
  const ctx = detectContext(state, word.from);
  const mode = classifyContext(ctx);
  const options = buildOptions(state, ctx, mode, word.text);
  if (options.length !== 1) return null;
  const only = options[0];
  if (only.label === word.text) return null;
  if (!only.label.toLowerCase().startsWith(word.text.toLowerCase())) return null;
  return {
    from: word.from,
    to: word.to,
    cursor: pos,
    label: only.label,
    prefixLen: word.text.length,
    completion: only,
  };
}

// Self-deriving ghost field. Recomputes on every transaction by reading
// the new state directly — no view dispatches.
const ghostField = StateField.define({
  create(state) { return computeGhost(state); },
  update(value, tr) {
    if (!tr.docChanged && !tr.selection && !tr.effects.some((e) => e.is(suppressGhostAt))) {
      return value;
    }
    return computeGhost(tr.state);
  },
});

const ghostDecorations = EditorView.decorations.compute([ghostField], (state) => {
  const g = state.field(ghostField);
  if (!g) return Decoration.none;
  const tail = g.label.slice(g.prefixLen);
  if (!tail) return Decoration.none;
  return Decoration.set([
    Decoration.widget({
      widget: new GhostWidget(tail),
      side: 1,
    }).range(g.cursor),
  ]);
});

// Tab handler: accept the ghost if showing, else fall through.
function acceptGhost(view) {
  const ghost = view.state.field(ghostField, false);
  if (!ghost) return false;
  const completion = ghost.completion;
  if (typeof completion.apply === "function") {
    completion.apply(view, completion, ghost.from, ghost.to);
  } else {
    view.dispatch({
      changes: { from: ghost.from, to: ghost.to, insert: completion.label },
      selection: { anchor: ghost.from + completion.label.length },
    });
  }
  return true;
}

// Esc handler: dismiss the ghost without inserting.
function dismissGhost(view) {
  const ghost = view.state.field(ghostField, false);
  if (!ghost) return false;
  view.dispatch({ effects: suppressGhostAt.of(view.state.selection.main.head) });
  return true;
}

// ---------------------------------------------------------------------------
// Public extension.
// ---------------------------------------------------------------------------

export function dslAutocomplete() {
  return [
    autocompletion({
      override: [dslCompletionSource],
      activateOnTyping: true,
      closeOnBlur: true,
      defaultKeymap: true,
      tooltipClass: () => "dsl-ac-tooltip",
    }),
    // Order matters: ghostSuppressField must be defined before ghostField
    // so ghostField.create / .update can read it.
    ghostSuppressField,
    ghostField,
    ghostDecorations,
    // Wrap in Prec.high so our Tab/Escape run before editor-core's
    // `indentWithTab` (which would otherwise eat Tab and indent instead
    // of accepting). `completionKeymap` only binds Enter for accept, so
    // we add Tab → acceptCompletion explicitly. The two Tab bindings
    // chain: ghost first; if no ghost, fall through to popup; if no
    // popup, fall through to indentWithTab in the lower-prec keymap.
    Prec.high(keymap.of([
      { key: "Tab", run: acceptGhost },
      { key: "Tab", run: acceptCompletion },
      { key: "Escape", run: dismissGhost },
      ...completionKeymap,
    ])),
  ];
}
