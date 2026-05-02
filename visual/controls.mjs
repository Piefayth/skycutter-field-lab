// =============================================================================
// Recipe-driven controls.
//
// Owns the visual app's [04] PARAMETERS + [05] STAMPS sections. Recipes
// declare parameters (number → slider, boolean → checkbox) and stamps
// (paint brushes); this module renders them as DOM and exposes their
// live values via readParams() / readBrushRadius(). Brush radius is the
// one app-level paint knob that lives outside the recipe surface (built
// once from static HTML and survives recipe swaps).
//
// Boot order: `initControls(ui)` must run before `applyControlSpec(...)`.
// =============================================================================

const registry = {
  parameterDecls: [],
  stampDecls: [],
  // `name -> { input, get value() }` handles per parameter, rebuilt per
  // recipe. Sliders for type:"number"; checkbox-wrappers for
  // type:"boolean". Both expose `value` as a number / boolean
  // respectively.
  paramEls: new Map(),
  // `id -> (state, x, y, r) => void` compiled stamp dispatch, or null
  // if the recipe declared `stamps: []` explicitly.
  stamps: null,
  // Recipe-declared defaults — used as the base layer in readParams()
  // so values declared by the recipe but not surfaced as a UI control
  // still reach the pipeline. Mirrors the harness precedence stack.
  baseParams: {},
  // App-level paint slider, bound once on initControls().
  brushRadius: null,
};

export const controls = registry;

let uiRef = null;

let onAddParameterHandler = null;
let onDeleteParameterHandler = null;

export function setControlHandlers({ onAddParameter, onDeleteParameter } = {}) {
  onAddParameterHandler = onAddParameter ?? null;
  onDeleteParameterHandler = onDeleteParameter ?? null;
}

export function initControls(ui) {
  if (uiRef) throw new Error("controls.mjs: initControls(ui) called twice");
  uiRef = ui;
  registry.brushRadius = bindSlider("brushRadius", "brushOut");
}

function ensureUi() {
  if (!uiRef) {
    throw new Error("controls.mjs: initControls(ui) must run before this call");
  }
}

/**
 * Apply a recipe's control surface: rebuild [04] PARAMETERS + [05]
 * STAMPS from the recipe's declarations.
 *
 * Each parameter decl carries a truthy `userAdded` flag for entries the
 * user added at runtime — those render with an inline "× Delete"
 * button. Recipe-shipped parameters can't be deleted from the UI.
 */
export function applyControlSpec(recipe) {
  ensureUi();
  const dslOwnsParameters = hasDslParameterSchema(recipe);
  const parameterDecls = resolveParameterDeclarations(recipe);
  const stampDecls = Array.isArray(recipe?.stamps) ? recipe.stamps : [];

  registry.parameterDecls = parameterDecls;
  registry.stampDecls = stampDecls;

  renderParameters(parameterDecls, { canAdd: !dslOwnsParameters });
  renderStamps(stampDecls);
}

function hasDslParameterSchema(recipe) {
  const dsl = recipe?.pipeline?.dsl;
  return (Array.isArray(dsl?.parameters) && dsl.parameters.length > 0)
    || (Array.isArray(dsl?.settings) && dsl.settings.length > 0);
}

function resolveParameterDeclarations(recipe) {
  const dsl = recipe?.pipeline?.dsl;
  const dslDecls = [
    ...(Array.isArray(dsl?.settings) ? dsl.settings : []),
    ...(Array.isArray(dsl?.parameters) ? dsl.parameters : []),
  ];
  const decls = Array.isArray(dslDecls) && dslDecls.length > 0
    ? dslDecls
    : (Array.isArray(recipe?.parameters) ? recipe.parameters : []);
  const defaults = recipe?.defaultParameters ?? {};
  return decls.map((d) => {
    const type = d.type === "boolean" ? "boolean" : "number";
    if (type === "boolean") {
      return {
        type,
        name: d.name,
        label: d.label ?? d.name,
        default: Boolean(d.default ?? defaults[d.name] ?? false),
        userAdded: Boolean(d.userAdded),
      };
    }
    return {
      type,
      name: d.name,
      label: d.label ?? d.name.toUpperCase(),
      min: Number(d.min ?? 0),
      max: Number(d.max ?? 1),
      step: Number(d.step ?? 0.01),
      default: Number(d.default ?? defaults[d.name] ?? 0),
      userAdded: Boolean(d.userAdded),
    };
  });
}

function makeAddButton(label, handler) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "control-add-btn";
  btn.textContent = label;
  btn.addEventListener("click", () => {
    if (typeof handler === "function") handler();
  });
  return btn;
}

function makeDeleteButton(name, onClick) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "control-delete-btn";
  btn.textContent = "×";
  btn.title = `Delete parameter "${name}"`;
  btn.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    onClick();
  });
  return btn;
}

function renderParameters(decls, { canAdd = true } = {}) {
  uiRef.parametersGrid.innerHTML = "";
  registry.paramEls = new Map();
  if (canAdd && onAddParameterHandler) {
    uiRef.parametersGrid.appendChild(makeAddButton("+ New parameter", onAddParameterHandler));
  }
  for (const decl of decls) {
    if (decl.type === "boolean") {
      uiRef.parametersGrid.appendChild(renderBooleanRow(decl));
    } else {
      uiRef.parametersGrid.appendChild(renderNumberRow(decl));
    }
  }
}

function renderNumberRow(decl) {
  const wrapper = document.createElement("div");
  wrapper.className = "param param--number";
  if (decl.userAdded) wrapper.classList.add("param--user-added");
  const labelEl = document.createElement("label");
  labelEl.appendChild(document.createTextNode(`${decl.label} `));
  const out = document.createElement("span");
  out.className = "param__val";
  out.id = `param_${decl.name}_out`;
  labelEl.appendChild(out);
  if (decl.userAdded && onDeleteParameterHandler) {
    labelEl.appendChild(makeDeleteButton(decl.name, () => onDeleteParameterHandler(decl.name)));
  }
  const input = document.createElement("input");
  input.type = "range";
  input.id = `param_${decl.name}`;
  input.min = String(decl.min);
  input.max = String(decl.max);
  input.step = String(decl.step);
  input.value = String(decl.default);
  wrapper.appendChild(labelEl);
  wrapper.appendChild(input);
  registry.paramEls.set(decl.name, makeSlider(input, out, decl.step));
  return wrapper;
}

function renderBooleanRow(decl) {
  const label = document.createElement("label");
  label.className = "param param--boolean";
  if (decl.userAdded) label.classList.add("param--user-added");
  const input = document.createElement("input");
  input.type = "checkbox";
  input.id = `param_${decl.name}`;
  input.checked = Boolean(decl.default);
  const span = document.createElement("span");
  span.textContent = decl.label;
  label.appendChild(input);
  label.appendChild(span);
  if (decl.userAdded && onDeleteParameterHandler) {
    label.appendChild(makeDeleteButton(decl.name, () => onDeleteParameterHandler(decl.name)));
  }
  registry.paramEls.set(decl.name, {
    input,
    get value() { return Boolean(input.checked); },
  });
  return label;
}

function renderStamps(decls) {
  const map = Object.create(null);
  for (const decl of decls) {
    if (typeof decl?.id === "string" && typeof decl.run === "function") {
      map[decl.id] = decl.run;
    }
  }
  registry.stamps = map;
  uiRef.brushSelect.innerHTML = "";
  for (const decl of decls) {
    const opt = document.createElement("option");
    opt.value = decl.id;
    opt.textContent = decl.label ?? decl.id;
    uiRef.brushSelect.appendChild(opt);
  }
}

/** Live parameter value by name. Returns number for type:"number"
 *  parameters and boolean for type:"boolean". Undefined if the recipe
 *  doesn't surface this name. */
export function paramValue(name) {
  const handle = registry.paramEls.get(name);
  return handle ? handle.value : undefined;
}

/**
 * Merge the active recipe's `defaultParameters` (base layer) with the
 * currently-displayed widget values (override layer). The paint radius
 * lives in the stamps section and is read directly by paint.mjs.
 */
export function readParams() {
  const out = { ...registry.baseParams };
  for (const [name, handle] of registry.paramEls) out[name] = handle.value;
  return out;
}

// =============================================================================
// Slider helpers
// =============================================================================

export function bindSlider(id, outId) {
  const input = document.querySelector(`#${id}`);
  const out = document.querySelector(`#${outId}`);
  return makeSlider(input, out, 0.01);
}

export function makeSlider(input, out, step) {
  const digits = decimalDigits(step);
  const sync = () => {
    out.textContent = Number(input.value).toFixed(digits);
  };
  input.addEventListener("input", sync);
  sync();
  return {
    input,
    get value() {
      return Number(input.value);
    },
  };
}

export function decimalDigits(step) {
  const s = Number(step);
  if (!Number.isFinite(s) || s <= 0) return 2;
  if (s >= 1) return 0;
  return Math.min(4, Math.max(0, Math.ceil(-Math.log10(s))));
}
