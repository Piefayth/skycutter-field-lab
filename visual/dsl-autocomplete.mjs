// =============================================================================
// DSL autocomplete + auto-import.
//
// Behaviour the issue asks for:
//   - Typing an identifier prefix shows suggestions.
//   - Tab accepts; Escape dismisses.
//   - Exactly one match → render a ghost-inline preview after the
//     cursor (no popup); Tab still accepts.
//   - Two-or-more matches → standard autocomplete popup.
//   - Auto-import: accepting a catalog symbol whose `use NAMESPACE name`
//     line isn't yet in the recipe inserts that line for you, in the
//     right place, without disturbing the cursor.
//
// Suggestions come from two sources in priority order:
//   1. Recipe-declared identifiers (live-parsed from the doc) —
//      fields, sources, params, consts, planet constants.
//   2. The static DSL_SYMBOLS catalog, scoped to the cursor's context
//      (top-level vs stage body vs preset body vs `use NAMESPACE` etc).
// =============================================================================

import {
  autocompletion, completionKeymap, acceptCompletion,
} from "@codemirror/autocomplete";
import {
  keymap, Decoration, WidgetType, EditorView,
} from "@codemirror/view";
import { StateField, StateEffect, Prec } from "@codemirror/state";

import { DSL_SYMBOLS } from "./dsl-symbols.mjs";
import { extractDslNames } from "../dsl/introspect.mjs";

// ---------------------------------------------------------------------------
// Catalog buckets — precomputed once so context-filtered lookups are cheap.
// ---------------------------------------------------------------------------

// `use NAMESPACE` line: extract the namespace from the symbol's importLine.
// importLine looks like "use sim diffuse" / "use core sin" / "use geo lon" —
// the first word after `use` is always the namespace.
function importNamespace(sym) {
  if (!sym.importLine) return null;
  const m = /^\s*use\s+(\w+)/.exec(sym.importLine);
  return m ? m[1] : null;
}

// All distinct namespaces the catalog references — used for the
// `use NAMESPACE` completion when the cursor is right after `use `.
const ALL_NAMESPACES = [...new Set(
  DSL_SYMBOLS.map(importNamespace).filter(Boolean),
)].sort();

const NAMESPACE_DOC = {
  sim: "Stage primitives + per-cell control flow (cell/event/each, wind, advect, diffuse, clamp, ...)",
  core: "Math + neighbor helpers (sin, cos, hypot, smoothstep, sample, neighborMax, ...)",
  init: "Init verbs for presets and stamps (fill, spot, ellipse, region, copy, eachCell)",
  geo: "Geodesic position builtins (lon, lat, x, y, u, v, px, py, pz, i, PI, TAU, E, N)",
  clock: "Time builtins (dt, frame)",
};

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
    case "param":
    case "const":
    case "planet":    return "constant";
    default:          return "variable";
  }
}

function declaredBoost(role) {
  switch (role) {
    case "field":
    case "param":     return 9;
    case "const":
    case "planet":
    case "source":
    case "declared":  return 8;
    default:          return 6;
  }
}

// ---------------------------------------------------------------------------
// Context detection. Walk the document up to the cursor, ignoring strings
// and line comments, tracking which block-keyword opened each `{`.
// ---------------------------------------------------------------------------

function detectContext(state, pos) {
  const text = state.doc.sliceString(0, pos);
  const stack = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i++;
      while (i < text.length && text[i] !== quote) {
        if (text[i] === "\\") i++;
        i++;
      }
      i++;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (ch === "{") {
      // Look back to the keyword that opened this block — limit lookback
      // to the previous newline so a `{` on its own line still finds
      // the keyword on the line above.
      const before = text.slice(Math.max(0, i - 200), i);
      const m = /\b(stage|preset|stamp|cell|each|event|eachCell|when)\b[^{]*$/.exec(before);
      stack.push(m ? m[1] : "?");
      i++;
      continue;
    }
    if (ch === "}") {
      stack.pop();
      i++;
      continue;
    }
    i++;
  }
  const lineStart = state.doc.lineAt(pos).from;
  const lineUpToCursor = state.doc.sliceString(lineStart, pos);
  return { stack, lineUpToCursor };
}

// Map context → completion mode. `when` is treated as transparent so a
// `when ... { CURSOR }` inside `cell { ... }` still classifies as cellBody.
function classifyContext(ctx) {
  const line = ctx.lineUpToCursor;
  // `use …` lines. The first word after `use` is the namespace; the rest
  // are imports. Detect whether the cursor is still in the namespace
  // slot or past it by counting completed (whitespace/comma-terminated)
  // tokens, ignoring any trailing partial identifier the user is mid-
  // typing. This way `use s` still suggests namespaces, and
  // `use sim d` suggests sim imports starting with `d`.
  if (/^\s*use(\s|$)/.test(line)) {
    const afterUse = line.replace(/^\s*use\s*/, "");
    const terminated = afterUse.replace(/[A-Za-z_$][A-Za-z0-9_$]*$/, "");
    const tokens = terminated.split(/[\s,]+/).filter(Boolean);
    if (tokens.length === 0) return { mode: "useNamespace" };
    return { mode: "useImports", ns: tokens[0] };
  }

  let inner = null;
  for (let i = ctx.stack.length - 1; i >= 0; i--) {
    const top = ctx.stack[i];
    if (top === "?" || top === "when") continue;
    inner = top;
    break;
  }
  if (!inner) return { mode: "topLevel" };
  if (inner === "cell" || inner === "each" || inner === "event") return { mode: "cellBody" };
  if (inner === "eachCell") return { mode: "initCellBody" };
  if (inner === "stage") return { mode: "stageBody" };
  if (inner === "preset" || inner === "stamp") return { mode: "presetBody" };
  return { mode: "topLevel" };
}

// ---------------------------------------------------------------------------
// Build options.
// ---------------------------------------------------------------------------

function symbolsForMode(mode) {
  switch (mode.mode) {
    case "topLevel":
      return DSL_SYMBOLS.filter((s) => TOP_LEVEL_KINDS.has(s.kind));
    case "stageBody":
      return DSL_SYMBOLS.filter((s) =>
        s.kind === "declarationKw" || s.kind === "primVerb" || s.kind === "controlKw"
      );
    case "cellBody":
      return DSL_SYMBOLS.filter((s) => STAGE_BODY_KINDS.has(s.kind));
    case "presetBody":
      return DSL_SYMBOLS.filter((s) => PRESET_BODY_KINDS.has(s.kind));
    case "initCellBody":
      return DSL_SYMBOLS.filter((s) => INIT_CELL_KINDS.has(s.kind));
    case "useNamespace":
      return ALL_NAMESPACES.map((ns) => ({
        name: ns,
        kind: "modifier",
        category: "Use namespace",
        importLine: null,
        signature: `use ${ns} ...`,
        doc: NAMESPACE_DOC[ns] ?? "",
      }));
    case "useImports":
      return DSL_SYMBOLS.filter((s) => importNamespace(s) === mode.ns);
    default:
      return DSL_SYMBOLS;
  }
}

function declaredFromDoc(doc) {
  try {
    const names = extractDslNames(doc);
    const out = [];
    for (const n of names.fields ?? []) out.push({ name: n, role: "field" });
    for (const n of names.sources ?? []) out.push({ name: n, role: "source" });
    for (const n of names.parameters ?? []) out.push({ name: n, role: "param" });
    for (const n of names.constants ?? []) out.push({ name: n, role: "const" });
    for (const n of names.planet ?? []) out.push({ name: n, role: "planet" });
    return out;
  } catch {
    return [];
  }
}

function buildOptions(state, ctx, mode, prefix) {
  const allowDeclared = mode.mode === "cellBody" || mode.mode === "initCellBody"
    || mode.mode === "presetBody" || mode.mode === "stageBody";

  const declared = allowDeclared ? declaredFromDoc(state.doc.toString()) : [];

  const declaredOptions = declared
    .filter((d) => !prefix || d.name.toLowerCase().startsWith(prefix.toLowerCase()))
    .map((d) => declaredCompletion(d.name, d.role));

  const docText = state.doc.toString();
  const catalog = symbolsForMode(mode);
  const catalogOptions = catalog
    .filter((s) => !prefix || s.name.toLowerCase().startsWith(prefix.toLowerCase()))
    .map((sym) => {
      if (mode.mode === "useNamespace") return catalogCompletion(sym, { withImport: false });
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
  // Strip line comments so trailing `// note` text doesn't get parsed
  // as identifiers. The DSL supports only single-line `use` directives,
  // so a per-line scan suffices.
  const cleaned = docText.split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
  const re = new RegExp(`^[ \\t]*use[ \\t]+${ns}[ \\t]+([\\w$,\\s]+)$`, "gm");
  for (const m of cleaned.matchAll(re)) {
    const names = m[1].split(",").map((s) => s.trim());
    if (names.includes(sym.name)) return true;
  }
  return false;
}

// Insert (or extend) a `use NS name` line.
//   1. If a `use NS …` line already exists, append `, name` to it.
//   2. Else, drop a fresh `use NS name` line — after the last existing
//      `use` line if any; else after the last schema directive
//      (recipe / summary / recommendedPreset / grid / planet / const);
//      else at the top of file.
//   3. Cursor is shifted forward by the inserted length so the user
//      stays at their typing position.
function ensureImportFor(view, sym) {
  const ns = importNamespace(sym);
  if (!ns) return;
  const docText = view.state.doc.toString();
  if (importedAlready(docText, sym)) return;

  const lineRe = new RegExp(`^([ \\t]*use[ \\t]+${ns}[ \\t]+)([\\w$,\\s]+)$`, "m");
  const extend = lineRe.exec(docText);
  if (extend) {
    const lineEnd = extend.index + extend[0].length;
    const inserted = `, ${sym.name}`;
    const cursor = view.state.selection.main.head;
    // Compute new cursor: extend's lineEnd is upstream of the cursor
    // (we only auto-import for body-context completions), so the cursor
    // shifts forward by inserted.length. If somehow the cursor is
    // upstream, leave it alone.
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
  const insertText = (needsLeadingNewline ? "\n" : "")
    + `use ${ns} ${sym.name}\n`;
  const cursor = view.state.selection.main.head;
  const newCursor = cursor > insertAt ? cursor + insertText.length : cursor;
  view.dispatch({
    changes: { from: insertAt, to: insertAt, insert: insertText },
    selection: { anchor: newCursor },
  });
}

function chooseImportInsertPoint(docText) {
  const lines = docText.split("\n");
  let lastUse = -1;
  let lastSchema = -1;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (/^use\s+\w+/.test(trimmed)) lastUse = i;
    else if (/^(recipe|summary|recommendedPreset|grid|planet|const)\b/.test(trimmed)) {
      lastSchema = i;
    }
  }
  const target = lastUse >= 0 ? lastUse : lastSchema;
  if (target < 0) return 0;
  let offset = 0;
  for (let i = 0; i <= target; i++) offset += lines[i].length + 1;
  // The +1 newline-per-line accounting overshoots when the target IS the
  // doc's last line and the file has no trailing newline. Clamp so CM's
  // change-set doesn't have to.
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
