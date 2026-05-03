// =============================================================================
// CodeMirror language for the Field Lab recipe DSL.
//
// The DSL is small enough that a hand-written StreamLanguage tokenizer
// covers it without a Lezer grammar. We classify identifiers against a
// few keyword sets, use one-char `(` lookahead to distinguish action
// verbs (`clamp pressure 0 1`) from same-named expression functions
// (`clamp(moisture, 0, 1)`), and track a per-line "lineMode" so that
// definition sites (`stage growClouds`, `param simRateHz`) get distinct
// highlighting from references.
//
// Per-field colors mirror the graph chips. Mutable field names are derived
// from the current DSL text, not a fixed palette list. Immutable sources
// intentionally do not get chip colors in code.
// =============================================================================

import { StreamLanguage, LanguageSupport, syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import { Tag, tags as t } from "@lezer/highlight";
import { extractDslNames } from "../dsl/introspect.mjs";
import { createFieldColorPalette, fieldCssColor, fieldCssBgPill } from "./field-colors.mjs";

// Recipe-identity declarations. One per line.
const RECIPE_KEYWORDS = new Set([
  "recipe", "summary", "recommendedPreset", "substrate",
]);

// Schema declarations — introduce names into the recipe.
const SCHEMA_KEYWORDS = new Set([
  "const", "field", "param", "import", "metric",
  // Render decls — inside `views { ... }`.
  "palette", "overlay",
]);

// Block headers — `stage id "label" { ... }` and friends.
const DEFINITION_KEYWORDS = new Set([
  "stage", "scenario", "stamp",
  // Render: `view ID "Label" { color KIND ... }`.
  "view",
]);

// Stage I/O lists.
const DECLARATION_KEYWORDS = new Set([
  "reads", "writes", "declares",
]);

// Control-flow blocks. `when` doubles as a function helper; the
// `(`-lookahead in token() routes the call form to "function" first.
// Note: `step` is intentionally NOT here — it collides with the slider
// modifier (`param x slider 0..1 step 0.1 default 0.5`) and falls
// through to MODIFIER_KEYWORDS, which is the more frequent case.
// `step { }` blocks still highlight cleanly, just with modifier
// styling rather than control-keyword styling.
const CONTROL_KEYWORDS = new Set([
  "cell", "for", "when", "if", "else",
  "neighbors", "neighbor", "ring", "disk", "kernel", "bell",
  "views", "stamps", "scenarios",
]);

// Statement verbs inside stage / scenario / stamp bodies.
//   set/add/let — cell-action verbs
//   spot/ellipse/region — scenario/stamp action verbs
//   sum/max/min/mean/count — neighbor reduction ops + metric ops
const ACTION_KEYWORDS = new Set([
  "add", "set", "let",
  "spot", "ellipse", "region",
  "sum", "max", "min", "mean", "count",
]);

// Trailing-argument keywords on action lines and param lines. Words
// that overlap with builtins (`min`, `max`, `dt`, `step`) deliberately
// stay out — the tokenizer can't reliably tell which form is intended.
//   `derived` — field-decl annotation
//   `previous` — explicit history declaration on stage reads
//   `cells` / `where` — metric reduction shape
//   `at` / `in` — positional/iteration prepositions
//   `radius` / `lon` / `lat` / `rx` / `ry` / `angle` — spot/ellipse args
//   `slider` / `toggle` / `default` / `step` / `label` — param-decl form
//   `geodesic` / `frequency` — substrate-decl form
const MODIFIER_KEYWORDS = new Set([
  "derived", "previous",
  "cells", "where", "at", "in",
  "by", "strength",
  "radius", "angle", "rx", "ry", "lon", "lat",
  "lonMin", "lonMax", "latMin", "latMax", "amount",
  "slider", "toggle", "boolean", "label",
  "step", "default",
  "geodesic", "frequency",
  // Render-DSL trailing keywords:
  //   `color ramp FIELD range [a, b] palette NAME` / `stops { … }`
  //   `color wheel FIELD range [a, b]`
  //   `color expr { … }`
  //   palette / inline-stops body: `stop T color [r, g, b]`
  "color", "ramp", "wheel", "expr",
  "range", "stops", "stop",
  // `step` lands here too — see the comment on CONTROL_KEYWORDS above.
]);

const LOGICAL_OPS = new Set(["and", "or", "not"]);
const BOOLEANS = new Set(["true", "false"]);
const NULLS = new Set(["null", "undefined"]);

// (Builtin/namespace identifier sets dropped — clock/geo identifiers
// are now `use`-imported per recipe, and the deprecated `params.X` /
// `consts.X` / `planet.X` dotted form is rejected by the compiler.
// Token resolution: keyword/control sets first, then def-site short-
// circuits, then declared-name lookups, then variableName fallback.)

// Definition-site identifiers. `stage <id>`, `param <id>`, `const <id>`
// — all rendered with the same "definition" emphasis (bone-bright).
const definitionNameTag = Tag.define(t.variableName);
export { definitionNameTag };

// Identifiers in `import name1, name2, ...` lines. Tag retains its
// historical "namespace" name so existing style entries still resolve.
const namespaceTag = Tag.define(t.variableName);
export { namespaceTag };

// Bare references to declared params / consts / planet constants.
// Coloured the same as the declaration site (definitionName) so the
// reference and the def site read as the same identity.
const immutableRefTag = Tag.define(t.variableName);
export { immutableRefTag };

// References to declared `source` fields. Sources are preset-init,
// stage-readonly — same "can't write here" contract as the namespace
// references above. Distinct tag so style can carry the source-specific
// italic alongside bold (mirrors the `pg-port-row--source` italic
// convention on graph chips).
const sourceRefTag = Tag.define(t.variableName);
export { sourceRefTag };

// Per-line state. RECIPE_LINE_MODES decides what kind of identifier
// to expect after the line-leading keyword.
//
// - "field-list" / "source-list": every subsequent identifier is a
//   declaration site (e.g. `field pressure, moisture, cloud`).
// - "field-def": only the first identifier is a field definition site;
//   if the live field-name extractor already knows it, use the field's
//   per-name color token instead of generic definition styling.
// - "single-def": only the first identifier is the definition site;
//   anything after (modifiers, values, label string) is regular.
// - "namespace" (legacy name; v2 import lines): the leading
//   `import` keyword is consumed first; every following identifier on
//   the line is a flat-imported builtin name with the "namespace"
//   highlighter (italic info-color).
const LINE_MODES = {
  // V2 fields are one-per-line with a type annotation (`field u: f32`).
  // The "field-def" mode highlights the first identifier with the same
  // per-field colour used for references and graph chips, then lets the
  // rest of the line tokenize normally (type annotation, optional `derived`).
  field: "field-def",
  param: "single-def",
  const: "single-def",
  stage: "single-def",
  scenario: "single-def",
  stamp: "single-def",
  metric: "single-def",
  // `import sin, cos, ...` — every identifier on the line is a builtin
  // name being brought into scope. Treat as namespace mode (no
  // declaration emphasis on the names).
  import: "namespace",
};

export const fieldLabHighlight = HighlightStyle.define([
  { tag: t.keyword,                           color: "#b494d4" },
  { tag: t.definitionKeyword,                 color: "var(--amber)", fontWeight: "600" },
  { tag: t.controlKeyword,                    color: "#b494d4", fontWeight: "600" },
  { tag: t.modifier,                          color: "#b494d4", fontStyle: "italic" },
  { tag: [t.string, t.special(t.string)],     color: "var(--amber)" },
  { tag: t.number,                            color: "var(--info)" },
  { tag: t.bool,                              color: "var(--info)" },
  { tag: t.null,                              color: "var(--info)" },
  { tag: t.atom,                              color: "var(--info)" },
  { tag: t.comment,                           color: "var(--bone-mute)", fontStyle: "italic" },
  { tag: t.lineComment,                       color: "var(--bone-mute)", fontStyle: "italic" },
  { tag: t.blockComment,                      color: "var(--bone-mute)", fontStyle: "italic" },
  { tag: t.docComment,                        color: "var(--bone-mute)", fontStyle: "italic" },
  { tag: t.function(t.variableName),          color: "var(--bone-bright)" },
  { tag: t.function(t.propertyName),          color: "var(--bone-bright)" },
  // Note: NO base rule for `t.variableName` here. Field tags (used for
  // per-name colored field references) are derived as children of
  // `t.variableName` via `Tag.define(t.variableName)`. If the parent
  // had a `color` rule here, CodeMirror would emit two competing CSS
  // classes on the span (one from this style for the variableName
  // parent, one from the field-specific style with the per-name
  // color), and cascade order between the two stylesheets would
  // determine which colour the user actually sees — washing the
  // per-field colours into bone-tone. Locals fall through to the
  // editor's inherited foreground colour instead, which IS bone.
  { tag: t.propertyName,                      color: "var(--info)" },
  { tag: t.definition(t.variableName),        color: "var(--bone-bright)" },
  { tag: definitionNameTag,                   color: "var(--bone-bright)", fontWeight: "600" },
  { tag: namespaceTag,                        color: "var(--info)", fontStyle: "italic" },
  { tag: immutableRefTag,                     color: "var(--bone-bright)", fontWeight: "600" },
  { tag: sourceRefTag,                        color: "var(--bone)", fontWeight: "600", fontStyle: "italic" },
  { tag: [t.operator, t.operatorKeyword],     color: "var(--bone-dim)" },
  { tag: [t.punctuation, t.bracket],          color: "var(--bone-mute)" },
  { tag: t.regexp,                            color: "var(--violet)" },
  { tag: t.typeName,                          color: "var(--info)" },
  { tag: t.className,                         color: "var(--info)" },
  { tag: t.invalid,                           color: "var(--danger)" },
]);

export function createFieldLabExtensions(fieldNames = [], sourceNames = [], immutableNames = []) {
  const names = normalizeFieldNames(fieldNames);
  const sources = normalizeFieldNames(sourceNames);
  const immutables = normalizeFieldNames(immutableNames);
  const palette = createFieldColorPalette(names);
  const fieldTags = new Map(names.map((name) => [name, Tag.define(t.variableName)]));
  const tokenNames = new Map(names.map((name, index) => [name, `field_${index}`]));
  // Single shared tag for all source references — sources don't get
  // per-name colours (the editor reserves the colour palette for
  // mutable fields), they get the bold + italic "immutable" treatment.
  const sourceTokenNames = new Map(sources.map((name) => [name, "source_ref"]));
  // Bare references to declared params/consts/planet — render bold
  // (info-colored) to match the existing namespace-prop styling, so
  // `windStrength` reads the same way `params.windStrength` used to.
  const immutableTokenNames = new Map(immutables.map((name) => [name, "immutable_ref"]));
  const fieldHighlight = HighlightStyle.define(names.map((name) => ({
    tag: fieldTags.get(name),
    color: fieldCssColor(name, palette),
    // Subtle pill — text uses the palette's 68% lightness, bg uses 60%
    // at 18% alpha. The lightness gap between text and bg is what gives
    // the pill its punch on a dark surround; same-colour text+bg reads
    // as a washed ghost of the text.
    backgroundColor: fieldCssBgPill(name, 0.18, palette),
    borderRadius: "2px",
  })));
  return [
    syntaxHighlighting(fieldLabHighlight),
    syntaxHighlighting(fieldHighlight),
    new LanguageSupport(makeFieldLabLanguage({ fieldTags, tokenNames, sourceTokenNames, immutableTokenNames })),
  ];
}

export function extractDslFieldNames(source) {
  return extractDslNames(source).fields;
}

export function extractDslSourceNames(source) {
  return extractDslNames(source).sources;
}

// Names recipe authors declared as `param X ...`, `const X ...`, or
// `planet X ...`. After bare-name DSL, these resolve as bare identifiers
// and need bold styling distinct from regular locals/variableNames.
export function extractDslImmutableNames(source) {
  return extractDslNames(source).immutables;
}

export function fieldNameKey(fieldNames = [], sourceNames = [], immutableNames = []) {
  return [
    normalizeFieldNames(fieldNames).join(","),
    normalizeFieldNames(sourceNames).join(","),
    normalizeFieldNames(immutableNames).join(","),
  ].join("\n");
}

function normalizeFieldNames(fieldNames) {
  return [...new Set(fieldNames.map((name) => String(name ?? "").trim()).filter(Boolean))].sort();
}

function makeFieldLabLanguage({ fieldTags, tokenNames, sourceTokenNames, immutableTokenNames }) {
  return StreamLanguage.define({
  name: "fieldlab",

  startState() {
    return { afterDot: false, lineMode: null, defConsumed: false };
  },

  token(stream, state) {
    if (stream.sol()) {
      state.lineMode = null;
      state.defConsumed = false;
    }

    if (stream.eatSpace()) return null;

    if (stream.match("//")) {
      stream.skipToEnd();
      return "lineComment";
    }

    if (stream.match(/^"(?:[^"\\\n]|\\.)*"/)) return "string";
    if (stream.match(/^'(?:[^'\\\n]|\\.)*'/)) return "string";

    // Resolution literal (`256x128`) — treat the whole token as a
    // number so the `x` doesn't break out as an identifier.
    if (stream.match(/^\d+x\d+\b/)) return "number";
    if (stream.match(/^\d+\.\d+(?:[eE][+-]?\d+)?/)) return "number";
    if (stream.match(/^\d+(?:\.\d*)?(?:[eE][+-]?\d+)?/)) return "number";

    if (stream.match("->")) return "operator";
    if (stream.match("=>")) return "operator";
    if (stream.match(/^(==|!=|<=|>=|&&|\|\|)/)) return "operator";
    if (stream.match(/^[+\-*/%=<>!?:]/)) return "operator";

    if (stream.match(/^[{}()[\]]/)) return "bracket";
    if (stream.match(/^[,;]/)) return "punctuation";

    // V2 coordinate query: `field@coord`. Highlight the `@` as an
    // operator so the eye picks it out as a special read (the model's
    // unifying primitive) rather than blending into the identifier.
    if (stream.eat("@")) {
      return "operator";
    }

    if (stream.eat(".")) {
      state.afterDot = true;
      return "punctuation";
    }

    const idMatch = stream.match(/^[A-Za-z_$][A-Za-z0-9_$]*/);
    if (idMatch) {
      const word = idMatch[0];
      const wasAfterDot = state.afterDot;
      state.afterDot = false;

      // `(`-lookahead: any identifier directly followed by `(` is a
      // function call, regardless of whether it's also a keyword. This
      // routes `clamp(x, 0, 1)` and `when(cond, a, b)` to function
      // styling without losing the action-verb form's keyword color.
      const isCall = stream.match(/^\s*\(/, false);

      if (wasAfterDot) return isCall ? "function" : "propertyName";
      if (isCall) return "function";

      // Past the leading keyword on an `import a, b, c` line, the
      // remaining identifiers are imported builtin names. Render as
      // plain identifiers — keyword styling here would inconsistently
      // colour `clamp` / `cell` / `event` while leaving `smoothstep`
      // / `max` / `cellNoise` plain, which is what tipped this off.
      if (state.lineMode === "namespace" && state.defConsumed) {
        return "variableName";
      }

      if (RECIPE_KEYWORDS.has(word)) {
        if (LINE_MODES[word]) state.lineMode = LINE_MODES[word];
        return "keyword";
      }
      if (SCHEMA_KEYWORDS.has(word)) {
        if (LINE_MODES[word]) state.lineMode = LINE_MODES[word];
        return "keyword";
      }
      if (DEFINITION_KEYWORDS.has(word)) {
        state.lineMode = LINE_MODES[word];
        return "definitionKeyword";
      }
      if (DECLARATION_KEYWORDS.has(word)) {
        // reads/writes/declares: trailing identifiers are field refs.
        // We don't need a line mode — field refs already match through
        // the DSL-derived field set below.
        return "modifier";
      }
      if (CONTROL_KEYWORDS.has(word)) return "controlKeyword";
      if (ACTION_KEYWORDS.has(word)) return "keyword";
      if (MODIFIER_KEYWORDS.has(word)) return "modifier";
      if (LOGICAL_OPS.has(word)) return "operatorKeyword";
      if (BOOLEANS.has(word)) return "bool";
      if (NULLS.has(word)) return "null";

      // Field declaration site. Once the editor has re-extracted the
      // declared name, use the same per-field token as references so
      // `field theta: f32` matches later `theta` reads/writes. While the
      // user is still typing a brand-new name, fall back to generic
      // definition styling until the next extraction pass catches up.
      if (state.lineMode === "field-def" && !state.defConsumed) {
        state.defConsumed = true;
        return tokenNames.get(word) ?? "definitionName";
      }

      // Def-site short-circuit. `stamp X "..."`, `stage X`, `param X`,
      // `const X` style their leading id as a definition even when the id
      // collides with an existing field name.
      if (state.lineMode === "single-def" && !state.defConsumed) {
        state.defConsumed = true;
        return "definitionName";
      }
      if (state.lineMode === "namespace" && !state.defConsumed) {
        state.defConsumed = true;
        return "namespace";
      }

      // Recipe-declared names. Sources get bold+italic, params/consts/
      // planet bare refs get bold info-color, fields get the per-name
      // pill. A recipe declaring `field u, v` shadows the geodesic
      // position-coord `u`/`v` here just as it does in the WGSL
      // compiler's ctx.reads-first resolution.
      if (sourceTokenNames.has(word)) return sourceTokenNames.get(word);
      if (immutableTokenNames.has(word)) return immutableTokenNames.get(word);
      if (tokenNames.has(word)) return tokenNames.get(word);

      // Field/source-list mode fallback. tokenNames already catches
      // names that survived a re-extraction; this fires while the user
      // is still typing a brand-new declaration before the editor has
      // had a chance to re-extract.
      if (state.lineMode === "field-list" || state.lineMode === "source-list") {
        return "definitionName";
      }
      return "variableName";
    }

    stream.next();
    return null;
  },

  languageData: {
    commentTokens: { line: "//" },
    closeBrackets: { brackets: ["(", "[", "{", "\"", "'"] },
    indentOnInput: /^\s*[}\])]$/,
  },

  tokenTable: {
    function: t.function(t.variableName),
    definitionName: definitionNameTag,
    namespace: namespaceTag,
    immutable_ref: immutableRefTag,
    source_ref: sourceRefTag,
    ...Object.fromEntries([...tokenNames].map(([name, token]) => [token, fieldTags.get(name)])),
  },
});
}
