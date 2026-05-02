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
import { createFieldColorPalette, fieldCssColor, fieldCssTint } from "./field-colors.mjs";

// Recipe-identity declarations. One per line.
const RECIPE_KEYWORDS = new Set([
  "recipe", "summary", "recommendedPreset", "grid",
]);

// Schema declarations — introduce names into the recipe.
const SCHEMA_KEYWORDS = new Set([
  "planet", "const", "use", "field", "source", "setting", "param",
]);

// Block headers — `stage id "label" { ... }`.
const DEFINITION_KEYWORDS = new Set([
  "stage", "preset", "stamp",
]);

// Stage I/O lists.
const DECLARATION_KEYWORDS = new Set([
  "reads", "writes", "declares",
]);

// Control-flow blocks. `when` doubles as a function helper; the
// `(`-lookahead in token() routes the call form to "function" first.
const CONTROL_KEYWORDS = new Set([
  "cell", "event", "each", "eachCell", "when", "if", "else",
]);

// Statement verbs inside stage / preset / stamp bodies.
const ACTION_KEYWORDS = new Set([
  "add", "set", "let",
  "fill", "spot", "ellipse", "region", "copy",
  "wind", "advect", "diffuse", "clamp", "normalize",
  "decay", "divergence", "gradient", "curl",
]);

// Trailing-argument keywords on action lines and param lines. Words
// that overlap with builtins (`min`, `max`, `dt`, `step`) deliberately
// stay out — the tokenizer can't reliably tell which form is intended.
const MODIFIER_KEYWORDS = new Set([
  "by", "amount", "damping", "strength",
  "radius", "angle", "rx", "ry", "lon", "lat",
  "slider", "boolean", "label",
  "step", "default",
  "geodesic", "frequency", "tiles", "tileSize",
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

// Namespace identifier after `use` (`use sim wind, …`).
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
// - "single-def": only the first identifier is the definition site;
//   anything after (modifiers, values, label string) is regular.
// - "namespace": the first identifier is the namespace; the rest are
//   keyword-matched (since they're imported keyword names).
const LINE_MODES = {
  field: "field-list",
  source: "source-list",
  setting: "single-def",
  param: "single-def",
  const: "single-def",
  stage: "single-def",
  preset: "single-def",
  stamp: "single-def",
  use: "namespace",
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
  { tag: t.variableName,                      color: "var(--bone)" },
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
    backgroundColor: fieldCssTint(name, 40, palette),
    borderRadius: "3px",
    padding: "0 2px",
  })));
  return [
    syntaxHighlighting(fieldLabHighlight),
    syntaxHighlighting(fieldHighlight),
    new LanguageSupport(makeFieldLabLanguage({ fieldTags, tokenNames, sourceTokenNames, immutableTokenNames })),
  ];
}

export function extractDslFieldNames(source) {
  return extractTopLevelDeclNames(source, /^field\b(.*)$/);
}

export function extractDslSourceNames(source) {
  return extractTopLevelDeclNames(source, /^source\b(.*)$/);
}

// Names recipe authors declared as `param X ...`, `const X ...`, or
// `planet X ...`. After bare-name DSL, these resolve as bare identifiers
// and need bold styling distinct from regular locals/variableNames.
export function extractDslImmutableNames(source) {
  const names = new Set();
  const text = String(source ?? "");
  for (const line of text.split(/\r?\n/)) {
    const clean = line.replace(/\/\/.*$/, "").trim();
    let match = /^param\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/.exec(clean);
    if (match) { names.add(match[1]); continue; }
    match = /^const\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/.exec(clean);
    if (match) { names.add(match[1]); continue; }
    match = /^planet\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/.exec(clean);
    if (match) { names.add(match[1]); continue; }
  }
  return [...names];
}

function extractTopLevelDeclNames(source, lineRegex) {
  const names = new Set();
  const text = String(source ?? "");
  for (const line of text.split(/\r?\n/)) {
    const clean = line.replace(/\/\/.*$/, "").trim();
    const match = lineRegex.exec(clean);
    if (!match) continue;
    for (const id of match[1].matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)) {
      const word = id[0];
      // MODIFIER_KEYWORDS still skipped because trailing-arg keywords
      // like `lon`/`lat`/`rx`/`ry` aren't field names. Builtin filtering
      // dropped — recipes can declare `field u, v` (gray-scott, BZ) or
      // `field W` (inverter-front) and those should make it into the
      // extracted set so the tokenizer can colour them as fields.
      if (!MODIFIER_KEYWORDS.has(word)) names.add(word);
    }
  }
  return [...names];
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

      // Past the namespace on a `use sim …` line, the remaining
      // identifiers are imported symbol names. Render them as plain
      // identifiers — keyword styling here would inconsistently
      // colour `clamp` / `cell` / `event` while leaving `smoothstep`
      // / `max` / `noise2` plain, which is what tipped this off.
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

      // Def-site short-circuit. `stamp X "..."`, `preset X`, `stage X`,
      // `param X`, `const X` style their leading id as a definition
      // even when the id collides with an existing field name.
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
