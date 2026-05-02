// =============================================================================
// DSL hover-tooltip extension.
//
// Hover any identifier in the DSL editor → small popup showing what the
// symbol IS (kind), its signature, doc text, an example, and (for
// recipe-declared things) the line where it was declared.
//
// Resolution order, mirroring the validator:
//   1. Recipe-declared name (field / source / param / const / planet /
//      declared output) — info comes from the live DSL text.
//   2. Catalog symbol — info comes from `dsl-symbols.mjs`.
//   3. Locals (`let X = ...`) — minimal "local in this stage" tooltip.
//
// The tooltip DOM is plain elements styled via `.dsl-tooltip` rules in
// style.css; this keeps the lab's design vocabulary centralized.
// =============================================================================

import { hoverTooltip } from "@codemirror/view";
import { getSymbolInfo } from "./dsl-symbols.mjs";

const KIND_LABELS = {
  declKeyword: "Recipe declaration",
  blockKeyword: "Block",
  declarationKw: "Stage I/O",
  controlKw: "Control flow",
  actionVerb: "Action verb",
  initVerb: "Init verb",
  primVerb: "Pipeline primitive",
  mathFn: "Math function",
  mathConst: "Math constant",
  builtin: "Builtin",
  modifier: "Modifier",
  logicalOp: "Logical operator",
  literal: "Literal",
  gridKeyword: "Grid",
  field: "Field",
  source: "Source",
  param: "Param",
  const: "Const",
  planet: "Planet constant",
  declared: "Declared output",
  local: "Local",
};

// Stage 1 — `nameLookup` finds out what the hovered word resolves to.
// Returns one of: { kind, info } where `kind` is the resolution category
// and `info` is enough data to render the tooltip.
function resolveName(word, declared) {
  if (!word) return null;
  if (declared.fields.has(word)) {
    return {
      kind: "field",
      name: word,
      doc: "Mutable per-cell state. Stages can `add` or `set` this field.",
      declLine: declared.declLines.get(word),
    };
  }
  if (declared.sources.has(word)) {
    return {
      kind: "source",
      name: word,
      doc: "Preset-init forcing map. Read-only inside stages.",
      declLine: declared.declLines.get(word),
    };
  }
  if (declared.params.has(word)) {
    return {
      kind: "param",
      name: word,
      doc: "User-tunable runtime knob (slider/checkbox in the side panel). Read-only inside stages.",
      declLine: declared.declLines.get(word),
    };
  }
  if (declared.consts.has(word)) {
    return {
      kind: "const",
      name: word,
      doc: "Recipe-shipped numeric constant. Read-only.",
      declLine: declared.declLines.get(word),
    };
  }
  if (declared.planet.has(word)) {
    return {
      kind: "planet",
      name: word,
      doc: "Recipe-shipped planetary constant (gravity, radius, etc.). Read-only.",
      declLine: declared.declLines.get(word),
    };
  }
  if (declared.declared.has(word)) {
    return {
      kind: "declared",
      name: word,
      doc: "Field declared by a stage primitive (e.g. `wind` declares windU/windV/lift). Allocated automatically.",
      declLine: declared.declLines.get(word),
    };
  }
  const sym = getSymbolInfo(word);
  if (sym) return { kind: "catalog", sym };
  return null;
}

// Parse the current DSL doc for declared-name → line-number lookups.
// Walks the doc once, scanning for `field`/`source`/`param`/`const`/
// `planet`/`stage X declares ...` lines and recording the (1-indexed)
// line number of each declared name. Cheap (O(N) over the doc text).
function buildDeclaredIndex(text) {
  const result = {
    fields: new Set(),
    sources: new Set(),
    params: new Set(),
    consts: new Set(),
    planet: new Set(),
    declared: new Set(),
    declLines: new Map(),
  };
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const clean = lines[i].replace(/\/\/.*$/, "").trim();
    if (!clean) continue;

    let m;
    if ((m = /^field\s+(.+)$/.exec(clean))) {
      for (const id of m[1].matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)) {
        const name = id[0];
        result.fields.add(name);
        if (!result.declLines.has(name)) result.declLines.set(name, i + 1);
      }
      continue;
    }
    if ((m = /^source\s+(.+)$/.exec(clean))) {
      for (const id of m[1].matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)) {
        const name = id[0];
        result.sources.add(name);
        if (!result.declLines.has(name)) result.declLines.set(name, i + 1);
      }
      continue;
    }
    if ((m = /^(?:param|setting)\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/.exec(clean))) {
      result.params.add(m[1]);
      result.declLines.set(m[1], i + 1);
      continue;
    }
    if ((m = /^const\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/.exec(clean))) {
      result.consts.add(m[1]);
      result.declLines.set(m[1], i + 1);
      continue;
    }
    if ((m = /^planet\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/.exec(clean))) {
      result.planet.add(m[1]);
      result.declLines.set(m[1], i + 1);
      continue;
    }
    if ((m = /^declares\s+(.+)$/.exec(clean))) {
      for (const id of m[1].matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)) {
        const name = id[0];
        result.declared.add(name);
        if (!result.declLines.has(name)) result.declLines.set(name, i + 1);
      }
    }
  }
  return result;
}

function renderTooltipDom(resolution) {
  const dom = document.createElement("div");
  dom.className = "dsl-tooltip";

  const head = document.createElement("div");
  head.className = "dsl-tooltip__head";
  dom.appendChild(head);

  const kindBadge = document.createElement("span");
  kindBadge.className = "dsl-tooltip__kind";

  let titleText;
  let bodyParts = [];

  if (resolution.kind === "catalog") {
    const sym = resolution.sym;
    kindBadge.textContent = KIND_LABELS[sym.kind] ?? sym.kind;
    kindBadge.dataset.kind = sym.kind;
    titleText = sym.name;
    if (sym.signature) bodyParts.push({ cls: "dsl-tooltip__sig", text: sym.signature });
    if (sym.doc) bodyParts.push({ cls: "dsl-tooltip__doc", text: sym.doc });
    if (sym.importLine) bodyParts.push({ cls: "dsl-tooltip__import", text: `Requires: ${sym.importLine}` });
    if (sym.example) bodyParts.push({ cls: "dsl-tooltip__example", text: sym.example });
  } else {
    kindBadge.textContent = KIND_LABELS[resolution.kind] ?? resolution.kind;
    kindBadge.dataset.kind = resolution.kind;
    titleText = resolution.name;
    bodyParts.push({ cls: "dsl-tooltip__doc", text: resolution.doc });
    if (resolution.declLine) {
      bodyParts.push({
        cls: "dsl-tooltip__decl",
        text: `Declared at line ${resolution.declLine}`,
      });
    }
  }

  const title = document.createElement("span");
  title.className = "dsl-tooltip__title";
  title.textContent = titleText;
  head.appendChild(title);
  head.appendChild(kindBadge);

  const body = document.createElement("div");
  body.className = "dsl-tooltip__body";
  dom.appendChild(body);

  for (const part of bodyParts) {
    const el = document.createElement("div");
    el.className = part.cls;
    el.textContent = part.text;
    body.appendChild(el);
  }

  return dom;
}

// Find the word at a given position in the doc. Mirrors the DSL
// tokenizer's identifier rule.
function wordAt(state, pos) {
  const line = state.doc.lineAt(pos);
  const text = line.text;
  const off = pos - line.from;
  const id = /[A-Za-z_$][A-Za-z0-9_$]*/g;
  let match;
  while ((match = id.exec(text))) {
    const start = match.index;
    const end = start + match[0].length;
    if (off >= start && off <= end) {
      return { word: match[0], from: line.from + start, to: line.from + end };
    }
  }
  return null;
}

export function dslHoverTooltip() {
  return hoverTooltip((view, pos, side) => {
    const at = wordAt(view.state, pos);
    if (!at) return null;
    // `side` is +1 if the cursor is between two characters' right sides;
    // skip lookups when the user is on whitespace (off=at.to).
    if (side > 0 && pos === at.to) return null;
    const declared = buildDeclaredIndex(view.state.doc.toString());
    const resolution = resolveName(at.word, declared);
    if (!resolution) return null;
    return {
      pos: at.from,
      end: at.to,
      above: true,
      create: () => ({ dom: renderTooltipDom(resolution) }),
    };
  }, {
    hoverTime: 200,
  });
}
