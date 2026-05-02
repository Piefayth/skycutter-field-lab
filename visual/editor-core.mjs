// =============================================================================
// Shared CodeMirror primitives.
//
// Shared CodeMirror setup for the pipeline DSL editor and selected-node
// DSL body pane.
// =============================================================================

import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, drawSelection, highlightActiveLine, highlightActiveLineGutter, tooltips } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import {
  syntaxHighlighting, indentOnInput, bracketMatching, foldGutter, foldKeymap,
} from "@codemirror/language";
import { javascript } from "@codemirror/lang-javascript";
import {
  createFieldLabExtensions, fieldLabHighlight, fieldNameKey,
} from "./editor-fieldlab-lang.mjs";
import { dslHoverTooltip } from "./dsl-tooltip.mjs";
import { dslAutocomplete } from "./dsl-autocomplete.mjs";

export const fieldLabTheme = EditorView.theme({
  "&": {
    height: "100%",
    fontSize: "11.5px",
  },
  ".cm-scroller": {
    fontFamily: "var(--font-mono)",
    backgroundColor: "var(--ink-950)",
  },
  ".cm-content": {
    color: "var(--bone-bright)",
    caretColor: "var(--signal)",
  },
  "&.cm-focused": { outline: "none" },
  "&.cm-focused .cm-cursor": {
    borderLeftColor: "var(--signal)",
    borderLeftWidth: "1.5px",
  },
  "&.cm-focused .cm-selectionBackground, ::selection": {
    backgroundColor: "rgba(124, 249, 157, 0.18)",
  },
  ".cm-selectionBackground": {
    backgroundColor: "rgba(124, 249, 157, 0.10)",
  },
  ".cm-gutters": {
    backgroundColor: "var(--ink-900)",
    color: "var(--bone-mute)",
    border: "0",
    borderRight: "1px solid var(--line)",
    fontFamily: "var(--font-mono)",
    fontSize: "10px",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "var(--ink-800)",
    color: "var(--bone)",
  },
  ".cm-activeLine": {
    backgroundColor: "rgba(255, 255, 255, 0.015)",
  },
  ".cm-matchingBracket": {
    color: "var(--signal)",
    backgroundColor: "rgba(124, 249, 157, 0.10)",
  },
  ".cm-foldPlaceholder": {
    backgroundColor: "var(--ink-800)",
    color: "var(--bone-dim)",
    border: "1px solid var(--line)",
    padding: "0 4px",
  },
}, { dark: true });

// Construct an EditorView with the standard extension stack. Returns
// `{ view, setSource, getSource }` plus a few helpers.
//
//   parent          — DOM node to mount inside.
//   onApply         — called on Cmd/Ctrl+Enter.
//   onDocChange     — called whenever the doc changes (after the suppress
//                     flag clears). Use it to dirty the status line.
//   language        — "javascript" or "fieldlab"; the pipeline DSL
//                     editor uses "fieldlab".
export function createEditorView({ parent, onApply, onDocChange, language = "javascript", readOnly = false }) {
  const isFieldLab = language === "fieldlab";
  const languageCompartment = new Compartment();
  let currentFieldKey = "";
  let suppressDocChange = false;
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: "",
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        history(),
        drawSelection(),
        indentOnInput(),
        bracketMatching(),
        foldGutter(),
        highlightActiveLine(),
        languageCompartment.of(isFieldLab
          ? createFieldLabExtensions([])
          : [syntaxHighlighting(fieldLabHighlight), javascript()]),
        ...(isFieldLab ? [dslHoverTooltip(), dslAutocomplete()] : []),
        // Tooltips render at the body level with `position: fixed` so
        // they (a) escape the floating window's `overflow: hidden`
        // clipping and (b) escape the per-window stacking context that
        // a `.win` z-index creates. Fixed positioning is viewport-
        // relative, so the placement math doesn't depend on the parent
        // having any particular layout. The CSS pin (`.cm-tooltip`
        // z-index in style.css) keeps tooltips above the entire
        // floating-window range.
        tooltips({
          parent: document.body,
          position: "fixed",
        }),
        keymap.of([
          {
            key: "Mod-Enter",
            run: () => { onApply?.(); return true; },
          },
          ...defaultKeymap,
          ...historyKeymap,
          ...foldKeymap,
          indentWithTab,
        ]),
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
        EditorView.updateListener.of((u) => {
          if (suppressDocChange) return;
          if (u.docChanged) onDocChange?.();
        }),
        fieldLabTheme,
      ],
    }),
  });

  function setSource(text) {
    suppressDocChange = true;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: text ?? "" },
      // Move cursor to start so loading a fresh item doesn't leave it
      // pointing past the new content.
      selection: { anchor: 0 },
    });
    suppressDocChange = false;
  }
  function getSource() {
    return view.state.doc.toString();
  }
  function setFieldNames(fieldNames, sourceNames = [], immutableNames = []) {
    if (!isFieldLab) return;
    const nextKey = fieldNameKey(fieldNames, sourceNames, immutableNames);
    if (nextKey === currentFieldKey) return;
    currentFieldKey = nextKey;
    view.dispatch({
      effects: languageCompartment.reconfigure(
        createFieldLabExtensions(fieldNames, sourceNames, immutableNames),
      ),
    });
  }
  function refreshLayout() {
    view.requestMeasure?.();
    view.scrollDOM.dispatchEvent(new Event("scroll"));
  }

  return { view, setSource, getSource, setFieldNames, refreshLayout };
}
