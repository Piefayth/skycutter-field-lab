// =============================================================================
// In-app DSL documentation window.
//
// Two-pane reader for the DSL symbol catalog. Left: filterable, category-
// grouped index. Right: full detail for the selected symbol — kind, import
// line, signature, doc, example, "see also". Reads from `dsl-symbols.mjs`
// so the catalog is the single source of truth for tooltips, docs, and
// (later) autocomplete.
//
// Integration with the hover tooltip:
//   - dsl-tooltip.mjs's tooltip body has a small "Open in docs ⤴" link
//     that calls `showSymbolInDocs(name)`. We export that as a module-
//     level function the tooltip imports without going through boot.
// =============================================================================

import { DSL_SYMBOLS, symbolsByCategory, getSymbolInfo } from "./dsl-symbols.mjs";

// One-line summary on each category, shown under its header in the index.
// Keeping these short so the index stays scannable.
const CATEGORY_HINTS = {
  "Recipe identity": "Top-of-file declarations naming the recipe.",
  "Schema declarations": "Declare what state, inputs, and metrics the recipe owns (field, param, const, metric, import).",
  "Block forms": "step, stage, scenario, stamp — the body shapes wrapping per-cell logic and init.",
  "Stage I/O": "Lists of fields a stage reads / writes. Append `previous` to a read for explicit @prev declaration.",
  "Control flow": "Per-cell math blocks (cell), iteration helpers (for each cell), conditional branches (when / if).",
  "Action verbs (cell)": "Statements inside per-cell bodies — set / add / let / when.",
  "Init verbs (presets/stamps)": "Statements inside scenario / stamp bodies — spot, ellipse, region, for each cell.",
  "Math functions": "Callable inside any cell or metric expression. Available by default; an `import` line scopes them down if declared.",
  "Math constants": "Compile-time numeric constants (PI, TAU, ...).",
  "Time builtins": "dt and frame for time-dependent math; prev for the @prev coordinate query.",
  "Geodesic position builtins": "Per-cell longitude / latitude / unit-sphere coords on the geodesic substrate.",
  "Grid declaration": "Substrate definition (substrate geodesic frequency N).",
  "Param modifiers": "Trailing keywords on `param` declarations (slider, toggle, default, label, range).",
  "Stamp/spot modifiers": "Trailing keywords on init verbs (at, radius, amount, lon, lat, brush.pos, brush.r).",
  "Logical operators": "and / or / not (also &&, ||, !).",
  "Literals": "true, false, null, undefined.",
};

// Categories rendered in the order DSL_SYMBOLS first encounters them.
// Single source of grouping — symbolsByCategory() preserves first-seen order.

const KIND_LABELS = {
  declKeyword: "decl",
  blockKeyword: "block",
  declarationKw: "i/o",
  controlKw: "ctrl",
  actionVerb: "verb",
  initVerb: "init",
  primVerb: "prim",
  mathFn: "fn",
  mathConst: "const",
  builtin: "builtin",
  modifier: "mod",
  logicalOp: "op",
  literal: "lit",
  gridKeyword: "grid",
};

let activeWindow = null;
let activeSetSelection = null;

// Module-level entry point used by the hover tooltip's "Open in docs" link.
// Lazily creates / shows the window so importing the docs module is cheap.
export function showSymbolInDocs(name) {
  if (!activeWindow) return false;
  activeWindow.show();
  activeWindow.bringToFront?.();
  if (typeof activeSetSelection === "function") {
    activeSetSelection(name);
  }
  return true;
}

export function createDslDocsContent() {
  const root = document.createElement("div");
  root.className = "docs-root";

  // ---------------------------------------------------------------------
  // Left pane — search + category-grouped index.
  // ---------------------------------------------------------------------
  const indexPane = document.createElement("div");
  indexPane.className = "docs-index";
  root.appendChild(indexPane);

  const searchRow = document.createElement("div");
  searchRow.className = "docs-search";

  const searchIcon = document.createElement("span");
  searchIcon.className = "docs-search__icon";
  searchIcon.textContent = "⌕";
  searchRow.appendChild(searchIcon);

  const searchInput = document.createElement("input");
  searchInput.type = "search";
  searchInput.className = "docs-search__input";
  searchInput.placeholder = "filter symbols";
  searchInput.spellcheck = false;
  searchInput.autocomplete = "off";
  searchRow.appendChild(searchInput);

  const searchHint = document.createElement("span");
  searchHint.className = "docs-search__count";
  searchHint.textContent = `${DSL_SYMBOLS.length}`;
  searchRow.appendChild(searchHint);

  indexPane.appendChild(searchRow);

  const indexList = document.createElement("div");
  indexList.className = "docs-list";
  indexPane.appendChild(indexList);

  // ---------------------------------------------------------------------
  // Right pane — detail view.
  // ---------------------------------------------------------------------
  const detailPane = document.createElement("div");
  detailPane.className = "docs-detail";
  root.appendChild(detailPane);

  // Items live as a Map<name, { sym, el }> keyed by symbol name so
  // selection / search can flip CSS classes without rebuilding the DOM.
  const items = new Map();
  let selected = null;
  let query = "";

  function renderIndex() {
    indexList.replaceChildren();
    items.clear();
    for (const [category, syms] of symbolsByCategory()) {
      const group = document.createElement("div");
      group.className = "docs-group";
      group.dataset.category = category;

      const head = document.createElement("div");
      head.className = "docs-group__head";

      const title = document.createElement("span");
      title.className = "docs-group__title";
      title.textContent = category;
      head.appendChild(title);

      const count = document.createElement("span");
      count.className = "docs-group__count";
      count.textContent = `${syms.length}`;
      head.appendChild(count);

      const hint = CATEGORY_HINTS[category];
      if (hint) {
        const sub = document.createElement("div");
        sub.className = "docs-group__hint";
        sub.textContent = hint;
        head.appendChild(sub);
      }
      group.appendChild(head);

      for (const sym of syms) {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "docs-item";
        item.dataset.name = sym.name;
        item.dataset.kind = sym.kind;

        const nameEl = document.createElement("span");
        nameEl.className = "docs-item__name";
        nameEl.textContent = sym.name;
        item.appendChild(nameEl);

        const kindEl = document.createElement("span");
        kindEl.className = "docs-item__kind";
        kindEl.dataset.kind = sym.kind;
        kindEl.textContent = KIND_LABELS[sym.kind] ?? sym.kind;
        item.appendChild(kindEl);

        item.addEventListener("click", () => setSelection(sym.name));
        items.set(sym.name, { sym, el: item });
        group.appendChild(item);
      }

      indexList.appendChild(group);
    }
  }

  function renderDetail(sym) {
    detailPane.replaceChildren();

    if (!sym) {
      const empty = document.createElement("div");
      empty.className = "docs-empty";
      empty.textContent = "Pick a symbol on the left, or hit a key in the filter.";
      detailPane.appendChild(empty);
      return;
    }

    const head = document.createElement("div");
    head.className = "docs-detail__head";

    const title = document.createElement("span");
    title.className = "docs-detail__title";
    title.textContent = sym.name;
    head.appendChild(title);

    const kind = document.createElement("span");
    kind.className = "docs-detail__kind";
    kind.dataset.kind = sym.kind;
    kind.textContent = (KIND_LABELS[sym.kind] ?? sym.kind).toUpperCase();
    head.appendChild(kind);

    detailPane.appendChild(head);

    const meta = document.createElement("div");
    meta.className = "docs-detail__meta";
    const cat = document.createElement("span");
    cat.className = "docs-detail__category";
    cat.textContent = sym.category;
    meta.appendChild(cat);
    if (sym.importLine) {
      const importEl = document.createElement("code");
      importEl.className = "docs-detail__import";
      importEl.textContent = sym.importLine;
      importEl.title = "Add this line to bring the symbol into scope.";
      meta.appendChild(importEl);
    } else {
      const span = document.createElement("span");
      span.className = "docs-detail__import docs-detail__import--builtin";
      span.textContent = "always in scope";
      meta.appendChild(span);
    }
    detailPane.appendChild(meta);

    if (sym.signature) {
      const sigLabel = document.createElement("div");
      sigLabel.className = "docs-detail__label";
      sigLabel.textContent = "Signature";
      detailPane.appendChild(sigLabel);

      const sig = document.createElement("pre");
      sig.className = "docs-detail__sig";
      sig.textContent = sym.signature;
      detailPane.appendChild(sig);
    }

    if (sym.doc) {
      const docLabel = document.createElement("div");
      docLabel.className = "docs-detail__label";
      docLabel.textContent = "Description";
      detailPane.appendChild(docLabel);

      const doc = document.createElement("p");
      doc.className = "docs-detail__doc";
      doc.textContent = sym.doc;
      detailPane.appendChild(doc);
    }

    if (sym.example) {
      const exLabel = document.createElement("div");
      exLabel.className = "docs-detail__label";
      exLabel.textContent = "Example";
      detailPane.appendChild(exLabel);

      const example = document.createElement("pre");
      example.className = "docs-detail__example";
      example.textContent = sym.example;
      detailPane.appendChild(example);
    }

    if (Array.isArray(sym.seeAlso) && sym.seeAlso.length > 0) {
      const seeLabel = document.createElement("div");
      seeLabel.className = "docs-detail__label";
      seeLabel.textContent = "See also";
      detailPane.appendChild(seeLabel);

      const list = document.createElement("div");
      list.className = "docs-detail__see-also";
      for (const ref of sym.seeAlso) {
        const target = getSymbolInfo(ref);
        if (!target) continue;
        const link = document.createElement("button");
        link.type = "button";
        link.className = "docs-detail__see-link";
        link.dataset.kind = target.kind;
        link.textContent = ref;
        link.addEventListener("click", () => setSelection(ref));
        list.appendChild(link);
      }
      detailPane.appendChild(list);
    }
  }

  function setSelection(name) {
    if (!items.has(name)) return;
    if (selected && items.has(selected)) {
      items.get(selected).el.classList.remove("docs-item--selected");
    }
    selected = name;
    const entry = items.get(name);
    entry.el.classList.add("docs-item--selected");
    entry.el.scrollIntoView({ block: "nearest" });
    renderDetail(entry.sym);
  }

  function applyFilter() {
    const q = query.trim().toLowerCase();
    let firstVisible = null;
    let visibleCount = 0;
    for (const group of indexList.querySelectorAll(".docs-group")) {
      let groupVisible = 0;
      for (const item of group.querySelectorAll(".docs-item")) {
        const name = item.dataset.name.toLowerCase();
        const sym = items.get(item.dataset.name)?.sym;
        const matches = !q
          || name.includes(q)
          || (sym?.doc && sym.doc.toLowerCase().includes(q))
          || (sym?.signature && sym.signature.toLowerCase().includes(q))
          || (sym?.category && sym.category.toLowerCase().includes(q));
        if (matches) {
          item.classList.remove("docs-item--hidden");
          groupVisible++;
          visibleCount++;
          if (!firstVisible) firstVisible = item.dataset.name;
        } else {
          item.classList.add("docs-item--hidden");
        }
      }
      group.classList.toggle("docs-group--hidden", groupVisible === 0);
    }
    searchHint.textContent = q ? `${visibleCount}/${DSL_SYMBOLS.length}` : `${DSL_SYMBOLS.length}`;
    if (q && firstVisible && firstVisible !== selected) setSelection(firstVisible);
  }

  searchInput.addEventListener("input", () => {
    query = searchInput.value;
    applyFilter();
  });

  searchInput.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      searchInput.value = "";
      query = "";
      applyFilter();
      event.preventDefault();
    }
  });

  renderIndex();
  // Open with the most useful starting point — `recipe`. Defines the
  // first thing in any file; nothing more orienting for a first-time
  // reader landing in the docs window.
  setSelection("recipe");

  return {
    contentEl: root,
    setSelection,
    focusSearch: () => searchInput.focus(),
  };
}

// Wire up the module-level shortcut. Boot calls this with the created
// window so showSymbolInDocs() can show + focus + select in one shot.
export function registerDslDocsWindow(win, controller) {
  activeWindow = win;
  activeSetSelection = controller.setSelection;
}
