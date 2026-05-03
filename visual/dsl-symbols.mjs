// =============================================================================
// DSL symbol catalog — visual-layer projection of the canonical spec.
//
// Single source of truth for the recipe DSL surface lives in
// `../dsl/dsl-spec.mjs`. This module shapes the spec into the
// `{name, kind, category, importLine, signature, doc, example}` records
// the tooltip / docs window / autocomplete consumers expect. Adding a
// new symbol = edit dsl-spec.mjs; this module picks it up automatically.
//
// Recipe-declared identifiers (declared fields, sources, params, consts,
// planet constants) are NOT in this catalog — they're discovered by
// parsing the live DSL text since they vary per recipe.
// =============================================================================

import { allDslSymbolsFlat } from "../dsl/dsl-spec.mjs";

// Map a spec group name to the human-facing category shown in the docs
// window. Categories double as section headers in the index — keep them
// aligned with how recipe authors mentally chunk the surface area.
const CATEGORY_BY_GROUP = {
  MATH_FUNCTIONS:      "Math functions",
  STENCIL_HELPERS:     "Math functions",
  CLOCK_BUILTINS:      "Time builtins",
  CLOCK_HELPERS:       "Time builtins",
  GEO_BUILTINS:        "Geodesic position builtins",
  GEO_CONSTANTS:       "Math constants",
  STAMP_EXTRAS:        "Geodesic position builtins",
  PIPELINE_PRIMITIVES: "Pipeline primitives",
  STAGE_BLOCKS:        "Control flow",
  INIT_VERBS:          "Init verbs (presets/stamps)",
  ACTION_VERBS:        "Action verbs (cell/event/each)",
  DECL_DIRECTIVES:     "Schema declarations",
  BLOCK_KEYWORDS:      "Block forms",
  STAGE_IO_KEYWORDS:   "Stage I/O",
  CONTROL_KEYWORDS:    "Control flow",
  LOGICAL_OPS:         "Logical operators",
  LITERALS:            "Literals",
  MODIFIERS:           "Stamp/spot modifiers",
  GRID_KEYWORDS:       "Grid declaration",
};

// `recipe`, `summary`, `recommendedPreset` aren't really "schema
// declarations" — they're the recipe's identity. Split those out for
// the docs index. Same module, same canonical entry; only the category
// label differs.
const RECIPE_IDENTITY_NAMES = new Set([
  "recipe", "summary", "recommendedPreset",
]);

// Parameter-decl modifiers (slider / boolean / label / step / default)
// belong under their own category; the rest of MODIFIERS are init-verb
// trailing args.
const PARAM_MODIFIER_NAMES = new Set([
  "slider", "boolean", "label", "step", "default",
]);

// Convert a spec entry → catalog symbol. The `importLine` formats the
// v2 `import` directive (or null when the symbol is always in scope).
// The legacy v1 form `use NAMESPACE NAME` is gone in v2 — imports are
// flat `import name1, name2` lines.
function specToSymbol(spec) {
  const importLine = spec.importNamespace
    ? `import ${spec.name}`
    : null;
  let category = CATEGORY_BY_GROUP[spec.group] ?? "Other";
  if (spec.group === "DECL_DIRECTIVES" && RECIPE_IDENTITY_NAMES.has(spec.name)) {
    category = "Recipe identity";
  }
  if (spec.group === "MODIFIERS" && PARAM_MODIFIER_NAMES.has(spec.name)) {
    category = "Param modifiers";
  }
  return {
    name: spec.name,
    kind: spec.kind,
    category,
    importLine,
    // Original spec namespace ("core" / "geo" / "clock" / …) — kept for
    // category grouping in docs and as a "this symbol is importable"
    // sentinel for autocomplete's auto-import path. v2 imports are flat
    // (`import name1, name2`); the namespace is no longer surface syntax
    // but still useful as metadata.
    importNamespace: spec.importNamespace ?? null,
    signature: spec.signature ?? null,
    doc: spec.doc ?? "",
    example: spec.example ?? null,
  };
}

export const DSL_SYMBOLS = allDslSymbolsFlat().map(specToSymbol);

const SYMBOL_BY_NAME = new Map(DSL_SYMBOLS.map((s) => [s.name, s]));

export function getSymbolInfo(name) {
  return SYMBOL_BY_NAME.get(name) ?? null;
}

// Group symbols by category in the order they first appear. Used by the
// docs window to render section-by-section.
export function symbolsByCategory() {
  const out = new Map();
  for (const sym of DSL_SYMBOLS) {
    if (!out.has(sym.category)) out.set(sym.category, []);
    out.get(sym.category).push(sym);
  }
  return out;
}

// All known names — used by autocomplete/tooltip to decide which words
// are catalog-resolvable vs. user-declared.
export function allSymbolNames() {
  return [...SYMBOL_BY_NAME.keys()];
}
