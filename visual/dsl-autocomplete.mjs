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
  autocompletion, completionKeymap, acceptCompletion, completionStatus, startCompletion,
} from "@codemirror/autocomplete";
import {
  keymap, Decoration, WidgetType, EditorView, ViewPlugin,
} from "@codemirror/view";
import { StateField, StateEffect, Prec } from "@codemirror/state";

import {
  blankStructuralOptionsForSource,
  chooseImportInsertPoint,
  completionOptionsForSource,
  importedAlready,
} from "./dsl-completion-core.mjs";

// ---------------------------------------------------------------------------
// Core candidate → CodeMirror completion mapping.
// ---------------------------------------------------------------------------

function toCodeMirrorCompletion(option) {
  if (option.source === "catalog" && option.symbol) return catalogCompletion(option);
  return {
    label: option.label,
    type: option.type,
    detail: option.detail,
    boost: option.boost,
  };
}

function catalogCompletion(option) {
  const sym = option.symbol;
  return {
    label: option.label,
    type: option.type,
    detail: option.detail,
    boost: option.boost,
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
      if (option.withImport && sym.importLine) {
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
        changes: { from, to, insert: option.label },
        selection: { anchor: from + option.label.length },
      });
      if (option.withImport) ensureImportFor(view, sym);
    },
  };
}

// ---------------------------------------------------------------------------
// Auto-import.
// ---------------------------------------------------------------------------

// Insert (or extend) an `import name` line. Two paths:
//   1. If an `import …` line already exists, append `, name` to it.
//   2. Else, drop a fresh `import name` line — after the last existing
//      schema directive, else at the top of file.
function ensureImportFor(view, sym) {
  if (!sym?.importNamespace) return;
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

  // Implicit (typed) completion only fires once a prefix exists. Explicit
  // (Ctrl-Space) shows everything for the context.
  if (!prefix && !context.explicit) return null;

  const docText = context.state.doc.toString();
  const options = completionOptionsForSource(docText, from, prefix).map(toCodeMirrorCompletion);
  if (options.length === 0) return null;

  // Single match → suppress the popup; the ghost extension shows the
  // suggestion inline instead. Returning null here prevents the popup
  // from opening for that case.
  if (options.length === 1 && !context.explicit) return null;

  return { from, to, options, filter: true };
}

// ---------------------------------------------------------------------------
// Empty-prefix popup trigger.
//
// CodeMirror's typed autocomplete naturally starts after a prefix. For this DSL,
// the useful state is often a blank structural position where the CST says the
// only legal words are, say, `let` / `set` / `add` / `when`. When a user lands on
// such a blank line, open the picker immediately if there are multiple options.
// Single-option cases still stay quiet until a typed prefix can ghost.
// ---------------------------------------------------------------------------

const blankStructuralCompletionPlugin = ViewPlugin.fromClass(class {
  constructor(view) {
    this.view = view;
    this.request = 0;
  }
  update(update) {
    if (!update.docChanged && !update.selectionSet) return;
    this.schedule();
  }
  schedule() {
    if (this.request) cancelAnimationFrame(this.request);
    this.request = requestAnimationFrame(() => {
      this.request = 0;
      if (shouldOpenBlankStructuralMenu(this.view)) startCompletion(this.view);
    });
  }
  destroy() {
    if (this.request) cancelAnimationFrame(this.request);
  }
});

function shouldOpenBlankStructuralMenu(view) {
  if (completionStatus(view.state) !== null) return false;
  const sel = view.state.selection.main;
  if (!sel.empty) return false;
  const pos = sel.head;
  if (cursorIsMidWord(view.state, pos)) return false;
  if (wordBefore(view.state, pos)) return false;

  return blankStructuralOptionsForSource(view.state.doc.toString(), pos).length > 0;
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
  const options = completionOptionsForSource(state.doc.toString(), word.from, word.text)
    .map(toCodeMirrorCompletion);
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
    blankStructuralCompletionPlugin,
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
