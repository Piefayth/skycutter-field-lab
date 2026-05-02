// =============================================================================
// Recipe library + load/apply pipeline.
//
// Each recipe is an `.mjs` module exporting `{ name, summary, knobs,
// toggles, presets, stamps, views, overlays, metrics, regime, pipeline,
// recommendedPreset }`. The manifest names which recipe to auto-load at
// boot. The browser wraps DSL metadata with a geodesic WebGPU executor;
// the recipe file on disk is the only persistence today.
// =============================================================================

import {
  reallocateState, resetState,
} from "../kernel/kernel.mjs";
import { createGeodesicGrid } from "../kernel/geodesic-grid.mjs";
import { buildDslPresetDecls, buildDslStampDecls } from "./dsl-init-runtime.mjs";
import { createPipelineMetadata } from "./pipeline-metadata.mjs";
import { setControlHandlers } from "./controls.mjs";
import { formModal, confirmModal } from "./modal.mjs";
import { showToast } from "./toast.mjs";
import { compileDsl } from "../dsl/compiler.mjs";

const registry = {
  manifest: { defaultRecipe: null, recipes: [] },
  defaultRecipeId: null,
  // Currently-active recipe id (mirrors `ui.recipeSelect.value`). Used
  // by the top menu's File→Recipe submenu to render checkmarks.
  activeId: null,
  // Async loader. Swaps the active recipe + rebuilds the runner.
  loadById: null,
  // Apply a recipe-declared preset by id. Resets state first; throws if
  // the active recipe doesn't declare a preset by that name.
  applyPreset: null,
  // View spec by id from the active recipe's `views[]`. Returns
  // `{ id, label, color }` where `color` is a per-cell colorer function.
  viewById: null,
  // True if the active recipe declares an overlay of `type` and its
  // checkbox is currently checked.
  isOverlayEnabled: null,
  // The WebGPU-backed runner for the active recipe. `null` until the first
  // recipe loads. boot.mjs reads this through `getRunner()` so per-tick
  // calls always pick up the latest one across recipe swaps.
  runner: null,
};

export const recipes = registry;

const AUTHOR_COORD_W = 256;
const AUTHOR_COORD_H = 128;

export function getRunner() {
  return registry.runner;
}

export function initRecipes({
  state,
  ui,
  applyControlSpec,
  controls,
  metrics,
  pipelineEditor,
  getParams,
  getFrame,
  getProbe,
  renderer,
  runPreset,
  refreshView,
  onActiveRecipeChange,
}) {
  if (registry.loadById) throw new Error("recipes.mjs: initRecipes called twice");

  // Active recipe state.
  let activeRecipe = null;
  let activeRecipeId = null;
  let activeViewDecls = [];
  let activeOverlayDecls = [];
  let activePresetDecls = [];
  let activeFieldDecls = [];
  const overlayEls = new Map();

  registry.viewById = (id) => activeViewDecls.find((decl) => decl.id === id);
  registry.isOverlayEnabled = (type) => {
    for (const decl of activeOverlayDecls) {
      if (decl.type !== type) continue;
      const el = overlayEls.get(decl.id);
      if (el) return Boolean(el.checked);
    }
    return false;
  };

  function applyPreset(state, name) {
    const decl = activePresetDecls.find((p) => p.id === name);
    if (!decl) {
      // Unknown preset id — leave state alone. Caller already reset
      // frame counter / activity history.
      return;
    }
    resetState(state);
    decl.run(state);
  }
  registry.applyPreset = applyPreset;

  async function bootstrap() {
    try {
      const response = await fetch("recipes/manifest.json", { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (!Array.isArray(data.recipes) || data.recipes.length === 0) return;
      registry.manifest = data;
      registry.defaultRecipeId = typeof data.defaultRecipe === "string" ? data.defaultRecipe : null;
      populateSelect();
      // Refresh menu so File → Recipe shows the populated list even
      // before the default recipe finishes loading.
      onActiveRecipeChange?.(null);
      if (registry.defaultRecipeId) {
        try {
          await loadById(registry.defaultRecipeId);
        } catch (error) {
          console.error("recipes.mjs: default recipe load failed:", error);
          showToast(`default recipe load failed: ${error.message}`, { kind: "error" });
          pipelineEditor.setStatus(`default recipe load failed: ${error.message}`, true);
        }
      }
    } catch (error) {
      console.error("recipes.mjs: manifest load failed:", error);
      showToast(`manifest load failed: ${error.message}`, { kind: "error" });
      pipelineEditor.setStatus(`recipe manifest load failed: ${error.message}`, true);
    }
  }

  async function loadById(id) {
    const entry = registry.manifest.recipes.find((recipe) => recipe.id === id);
    if (!entry || !entry.path) throw new Error(`recipe "${id}" not in manifest`);
    // Dynamic import the .mjs module. Cache-bust via timestamp query so
    // edits to the recipe source during dev are picked up on reload.
    const url = new URL(entry.path, window.location.href);
    url.searchParams.set("v", String(Date.now()));
    const recipeModule = await import(url.href);
    activeRecipe = materializeRecipe(recipeModule);
    activeRecipeId = id;
    registry.activeId = id;
    applyRecipe(activeRecipe, id);
    onActiveRecipeChange?.(id);
    pipelineEditor.setStatus(`loaded recipe "${activeRecipe.name ?? id}"`);
  }

  function applyActivePipelineDsl(source) {
    if (!activeRecipe || !activeRecipeId) throw new Error("no active recipe");
    const pipeline = compileDsl(source);
    activeRecipe.pipelineDsl = source;
    activeRecipe.pipeline = pipeline;
    applyDslRecipeMetadata(activeRecipe, pipeline.dsl);
    applyRecipe(activeRecipe, activeRecipeId);
    refreshView();
    pipelineEditor.setStatus(`applied DSL for "${activeRecipe.name ?? activeRecipeId}"`);
  }

  // Re-render the [04]/[05] sections without rebuilding the runner or
  // resetting state. Used after an inline "+ New" or "× Delete" so the
  // new control surface appears without losing the simulation in
  // flight. The active recipe object is mutated in place — user-added
  // params/fields live on `activeRecipe` until the user "Save as
  // recipe"s them.
  function refreshControlSurface() {
    if (!activeRecipe) return;
    applyControlSpec(activeRecipe);
    // Reapplying the spec rebuilds the slider DOM, which would reset
    // every slider to its declared `default`. That's acceptable for
    // now — adding/removing user knobs is a rare action; live sliders
    // resetting to defaults is a known cost. If it bites later, snapshot
    // current values before applyControlSpec and restore after.
    if (activeRecipe.defaultParameters) {
      for (const [name, value] of Object.entries(activeRecipe.defaultParameters)) {
        const handle = controls.paramEls.get(name);
        if (!handle || !handle.input) continue;
        if (handle.input.type === "checkbox") {
          handle.input.checked = Boolean(value);
          handle.input.dispatchEvent(new Event("change", { bubbles: true }));
        } else {
          handle.input.value = String(value);
          handle.input.dispatchEvent(new Event("input", { bubbles: true }));
        }
      }
    }
  }

  function applyRecipe(recipe, recipeId) {
    if (!recipe?.pipeline) throw new Error("recipe missing pipeline");
    if (recipe.pipelineDsl) {
      recipe.pipeline = compileDsl(applyGeodesicTileOverride(recipe.pipelineDsl));
      applyDslRecipeMetadata(recipe, recipe.pipeline.dsl);
    }
    const prepared = prepareRecipeState(recipe, state);
    activeFieldDecls = prepared.fieldDecls;

    applyControlSpec(recipe);
    metrics?.applySpec(recipe);
    controls.baseParams = { ...(recipe.defaultParameters ?? {}) };

    // Lock the [04] parameters / [05] stamps section when the recipe
    // declares them as explicitly empty. Locked sections render dimmed
    // and stay collapsed — there's nothing the recipe wants the user
    // fiddling with.
    setSectionLocked("parameters", Array.isArray(recipe.parameters) && recipe.parameters.length === 0);
    setSectionLocked("stamps", Array.isArray(recipe.stamps) && recipe.stamps.length === 0);

    // Presets. Recipes that declare zero presets get a synthetic "blank"
    // entry so [02] INIT isn't empty. Real recipes always declare at
    // least one.
    activePresetDecls = Array.isArray(recipe.presets) && recipe.presets.length > 0
      ? recipe.presets
      : [{ id: "blank", label: "Blank canvas", run: () => {} }];
    populatePresetSelect(activePresetDecls);

    // Views.
    activeViewDecls = Array.isArray(recipe.views) ? recipe.views : [];
    populateViewSelect(activeViewDecls);

    // Overlays.
    activeOverlayDecls = Array.isArray(recipe.overlays) ? recipe.overlays : [];
    populateOverlaysGrid(activeOverlayDecls);

    // Build the runner. The metadata runner owns graph/editor shape;
    // the WebGPU wrapper below owns geodesic tick execution.
    registry.runner?.dispose?.();
    const metadataRunner = createPipelineMetadata(recipe);
    const runner = wrapGeodesicRunner(recipe, metadataRunner, { renderer, getParams, getFrame, state });
    registry.runner = runner;

    // Hand the runner to the pipeline editor.
    pipelineEditor.loadRecipe(runner, recipeId);
    // Drop any stale contribution records — they reference fields /
    // step names that may not exist in the new recipe. The probe
    // re-populates from the next tick onward.
    getProbe?.()?.clearContribs?.();

    // Defaults from the recipe override the widget initial values at
    // load time. Dispatch events so visible readouts and listeners
    // stay consistent.
    if (recipe.defaultParameters) {
      for (const [name, value] of Object.entries(recipe.defaultParameters)) {
        const handle = controls.paramEls.get(name);
        if (!handle || !handle.input) continue;
        if (handle.input.type === "checkbox") {
          handle.input.checked = Boolean(value);
          handle.input.dispatchEvent(new Event("change", { bubbles: true }));
        } else {
          handle.input.value = String(value);
          handle.input.dispatchEvent(new Event("input", { bubbles: true }));
        }
      }
    }

    // Run the recipe's recommended preset (or the first declared preset)
    // so the canvas isn't a black square on initial load.
    const initialPreset = recipe.recommendedPreset
      ?? activePresetDecls[0]?.id
      ?? null;
    if (initialPreset) {
      ui.presetSelect.value = initialPreset;
      runPreset(initialPreset);
    } else {
      refreshView();
    }
  }

  function wrapGeodesicRunner(recipe, metadataRunner, deps) {
    let gpuRunner = null;
    let gpuReady = false;
    let dirty = true;
    let failed = false;
    let reading = false;
    let disposed = false;
    const wrapper = {
      ...metadataRunner,
      backend: "geodesic-webgpu",
      grid: deps.state.grid?.topology ?? null,
      markStateDirty() {
        dirty = true;
      },
      readFields(state, names) {
        void readBack(state, names).catch(handleReadbackError);
      },
      syncState(state) {
        void readBack(state).catch(handleReadbackError);
      },
      runTick(state, dt) {
        if (disposed || !gpuReady || failed) return;
        try {
          if (state.events) {
            state.events.totalThisTick = 0;
            state.events.byLabel = Object.create(null);
          }
          if (dirty) {
            gpuRunner.uploadState(state);
            dirty = false;
          }
          gpuRunner.runTick(dt);
        } catch (error) {
          failed = true;
          console.warn("geodesic WebGPU tick failed", error);
          throw error;
        }
      },
      dispose() {
        disposed = true;
        gpuRunner?.dispose?.();
      },
    };

    async function readBack(state, names = gpuRunner?.fieldNames) {
      if (disposed || !gpuReady || failed || dirty || reading) return;
      reading = true;
      try {
        await gpuRunner.readState(state, names);
        await gpuRunner.readEventCounts?.(state);
      } finally {
        reading = false;
      }
    }

    function handleReadbackError(error) {
      if (disposed) return;
      console.warn("geodesic WebGPU readback failed", error);
    }

    import("./webgpu-geodesic-pipeline-runtime.mjs")
      .then(async ({ createWebGpuGeodesicPipeline }) => {
        if (disposed || failed) return;
        gpuRunner = await createWebGpuGeodesicPipeline({
          pipeline: recipe.pipeline,
          grid: deps.state.grid?.topology,
          getParams,
          getFrame,
        });
        wrapper.grid = gpuRunner.grid;
        gpuReady = true;
        dirty = true;
        console.info(`geodesic WebGPU pipeline enabled (${gpuRunner.grid.cellCount} cells)`);
      })
      .catch((error) => {
        failed = true;
        console.warn("geodesic WebGPU pipeline failed to initialize", error);
      });

    return wrapper;
  }

  // -----------------------------------------------------------------------
  // Hidden recipeSelect mirrors the active recipe id; the top menu's
  // File→Recipe submenu is the user-facing picker.
  // -----------------------------------------------------------------------

  function populateSelect() {
    const select = ui.recipeSelect;
    const previous = select.value;
    select.innerHTML = "";
    for (const recipe of registry.manifest.recipes) {
      const opt = document.createElement("option");
      opt.value = recipe.id;
      opt.textContent = recipe.name ?? recipe.id;
      if (recipe.summary) opt.title = recipe.summary;
      select.appendChild(opt);
    }
    if ([...select.options].some((option) => option.value === previous)) {
      select.value = previous;
    } else if (registry.defaultRecipeId) {
      select.value = registry.defaultRecipeId;
    }
  }

  // -----------------------------------------------------------------------
  // Section locking
  // -----------------------------------------------------------------------

  function setSectionLocked(sectionId, locked) {
    const node = document.querySelector(`.lab-section[data-section="${sectionId}"]`);
    if (!node) return;
    node.classList.toggle("lab-section--locked", locked);
    if (locked) node.classList.add("lab-section--collapsed");
  }

  // -----------------------------------------------------------------------
  // [02] INIT preset dropdown
  // -----------------------------------------------------------------------

  function populatePresetSelect(presets) {
    const select = ui.presetSelect;
    if (!select) return;
    const previous = select.value;
    select.innerHTML = "";
    for (const decl of presets) {
      const opt = document.createElement("option");
      opt.value = decl.id;
      opt.textContent = decl.label ?? decl.id;
      select.appendChild(opt);
    }
    if ([...select.options].some((option) => option.value === previous)) {
      select.value = previous;
    } else if (select.options.length > 0) {
      select.value = select.options[0].value;
    }
  }

  // -----------------------------------------------------------------------
  // [03] RENDER view dropdown + overlays grid
  // -----------------------------------------------------------------------

  function populateViewSelect(views) {
    const select = ui.viewSelect;
    if (!select) return;
    const previous = select.value;
    select.innerHTML = "";
    for (const decl of views) {
      const opt = document.createElement("option");
      opt.value = decl.id;
      opt.textContent = decl.label ?? decl.id;
      select.appendChild(opt);
    }
    if ([...select.options].some((option) => option.value === previous)) {
      select.value = previous;
    } else if (select.options.length > 0) {
      select.value = select.options[0].value;
    }
  }

  function populateOverlaysGrid(overlays) {
    const grid = ui.overlaysGrid;
    if (!grid) return;
    grid.innerHTML = "";
    overlayEls.clear();
    for (const decl of overlays) {
      const label = document.createElement("label");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.id = `overlay_${decl.id}`;
      input.checked = decl.default !== false;
      const span = document.createElement("span");
      span.textContent = decl.label ?? decl.id;
      label.appendChild(input);
      label.appendChild(span);
      grid.appendChild(label);
      overlayEls.set(decl.id, input);
      input.addEventListener("change", refreshView);
    }
  }

  ui.recipeSelect.addEventListener("change", () => {
    loadById(ui.recipeSelect.value).catch((error) => {
      console.error("recipe load failed:", error);
      showToast(`recipe load failed: ${error.message}`, { kind: "error" });
      pipelineEditor.setStatus(`recipe load failed: ${error.message}`, true);
    });
  });

  // Wire the inline "+ New" / "× Delete" affordances on the [04]/[05]
  // sections. Handlers patch `activeRecipe.parameters` in place and
  // re-render the control surface; the simulation state + runner are
  // NOT reset, so adding a knob mid-flight doesn't blow away your work.
  // Edits live on the in-memory recipe object until "Save as recipe".
  setControlHandlers({
    onAddParameter: async () => {
      if (!activeRecipe) return;
      // First ask for type so we can show the right follow-up form.
      // Only number / boolean today; string / enum / color come later.
      const typeChoice = await formModal({
        title: "+ New parameter",
        confirmLabel: "Next",
        fields: [
          { name: "type", label: "Type (number or boolean)", type: "text",
            default: "number", required: true,
            validate: (v) => /^(number|boolean)$/i.test(v) ? null : 'must be "number" or "boolean"' },
        ],
      });
      if (!typeChoice) return;
      const type = typeChoice.type.toLowerCase();
      let decl;
      if (type === "number") {
        decl = await formModal({
          title: "+ New parameter (number)",
          confirmLabel: "Add",
          fields: [
            { name: "name", label: "Name (identifier)", type: "text", required: true,
              placeholder: "myKnob", validate: validIdentifier },
            { name: "label", label: "Display label", type: "text", required: true, placeholder: "MY KNOB" },
            { name: "min", label: "Min", type: "number", default: 0, required: true },
            { name: "max", label: "Max", type: "number", default: 1, required: true },
            { name: "step", label: "Step", type: "number", default: 0.01, required: true },
            { name: "default", label: "Default value", type: "number", default: 0.5, required: true },
          ],
        });
        if (!decl) return;
        decl.type = "number";
      } else {
        decl = await formModal({
          title: "+ New parameter (boolean)",
          confirmLabel: "Add",
          fields: [
            { name: "name", label: "Name (identifier)", type: "text", required: true,
              placeholder: "enableMyThing", validate: validIdentifier },
            { name: "label", label: "Display label", type: "text", required: true, placeholder: "my thing" },
            { name: "default", label: "Default (true/false)", type: "text", default: "false",
              validate: (v) => /^(true|false)$/i.test(v) ? null : 'must be "true" or "false"' },
          ],
        });
        if (!decl) return;
        decl.type = "boolean";
        decl.default = String(decl.default).toLowerCase() === "true";
      }
      const params = Array.isArray(activeRecipe.parameters) ? activeRecipe.parameters : [];
      const dup = params.findIndex((p) => p?.name === decl.name);
      const tagged = { ...decl, userAdded: true };
      if (dup >= 0) params[dup] = tagged;
      else params.push(tagged);
      activeRecipe.parameters = params;
      refreshControlSurface();
    },
    onDeleteParameter: async (name) => {
      if (!activeRecipe) return;
      const ok = await confirmModal({
        title: "Delete parameter",
        message: `Delete user-added parameter "${name}"?`,
        confirmLabel: "Delete",
        danger: true,
      });
      if (!ok) return;
      activeRecipe.parameters = (Array.isArray(activeRecipe.parameters) ? activeRecipe.parameters : [])
        .filter((p) => p?.name !== name);
      refreshControlSurface();
    },
  });

  registry.loadById = loadById;
  pipelineEditor.applyPipelineDsl = applyActivePipelineDsl;
  bootstrap();
}

export function materializeRecipe(recipeModule) {
  const recipe = { ...recipeModule };
  applyDslRecipeMetadata(recipe, recipe.pipeline?.dsl);
  return recipe;
}

export function prepareRecipeState(recipe, state) {
  requireGeodesicRecipe(recipe);
  applyRecipeResolution(recipe, state);

  // Field decls prefer the DSL recipe schema when present. User-added
  // fields patch `recipe.fields` in place, so a subsequent reallocation
  // round-trips them.
  const dslFields = recipe.pipeline?.dsl?.fields;
  const recipeFields = Array.isArray(dslFields) && dslFields.length > 0 ? dslFields : recipe.fields;
  const fieldDecls = mergeFieldDecls(recipeFields, declaredPipelineFieldDecls(recipe.pipeline?.dsl))
    .map((d) => (typeof d === "string" ? { name: d } : { ...d }));
  reallocateState(state, {
    fields: fieldDecls.length > 0 ? fieldDecls : (recipeFields ?? null),
  });
  return { fieldDecls };
}

function applyDslRecipeMetadata(recipe, dsl) {
  if (!recipe || !dsl) return;
  if (dsl.recipe?.name) recipe.name = dsl.recipe.name;
  if (dsl.recipe?.summary) recipe.summary = dsl.recipe.summary;
  if (dsl.recipe?.recommendedPreset) recipe.recommendedPreset = dsl.recipe.recommendedPreset;
  if (dsl.planet && Object.keys(dsl.planet).length > 0) recipe.planet = { ...dsl.planet };
  if (dsl.constants?.length) recipe.constants = dsl.constants.map((decl) => ({ ...decl }));
  if (dsl.fields?.length) recipe.fields = mergeFieldDecls(dsl.fields, declaredPipelineFieldDecls(dsl));
  if (dsl.presets?.length) recipe.presets = buildDslPresetDecls(dsl.presets, dsl);
  recipe.stamps = buildDslStampDecls(dsl.stamps ?? [], dsl);
  if (dsl.settings?.length) recipe.settings = dsl.settings.map((decl) => ({ ...decl }));
  if (dsl.settings?.length || dsl.parameters?.length) {
    recipe.parameters = (dsl.parameters ?? []).map((decl) => ({ ...decl }));
    recipe.defaultParameters = Object.fromEntries(
      [...(dsl.settings ?? []), ...(dsl.parameters ?? [])]
        .filter((decl) => Object.hasOwn(decl, "default"))
        .map((decl) => [decl.name, decl.default]),
    );
  }
}

function declaredPipelineFieldDecls(dsl) {
  if (Array.isArray(dsl?.declared) && dsl.declared.length > 0) {
    return dsl.declared.map((decl) => ({
      ...(typeof decl === "string" ? { name: decl } : decl),
      kind: "declared",
    }));
  }
  return (dsl?.stages ?? [])
    .flatMap((stage) => stage.declares ?? [])
    .map((name) => ({ name, kind: "declared", scope: "pipeline" }));
}

function mergeFieldDecls(...groups) {
  const out = [];
  const seen = new Set();
  for (const group of groups) {
    for (const decl of Array.isArray(group) ? group : []) {
      const name = typeof decl === "string" ? decl : decl?.name;
      if (!name || seen.has(name)) continue;
      seen.add(name);
      out.push(typeof decl === "string" ? { name } : { ...decl });
    }
  }
  return out;
}

function applyRecipeResolution(recipe, state) {
  const grid = recipe.pipeline?.dsl?.grid;
  const topology = createGeodesicGrid({ frequency: grid.frequency ?? geodesicFrequency() });
  state.grid = {
    kind: "geodesic",
    frequency: topology.frequency,
    cells: topology.cellCount,
    topology,
    // Width/height are retained only for fixed-format UI readouts and
    // brush-radius scaling; DSL author coordinates are spherical.
    width: AUTHOR_COORD_W,
    height: AUTHOR_COORD_H,
  };
}

function geodesicFrequency() {
  const value = geodesicFrequencyOverride() ?? 64;
  return Number.isInteger(value) && value >= 1 && value <= 512 ? value : 64;
}

function geodesicFrequencyOverride() {
  const raw = new URLSearchParams(window.location.search).get("geodesicFreq");
  if (raw == null || raw === "") return null;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 && value <= 512 ? value : null;
}

function applyGeodesicTileOverride(source) {
  const override = geodesicFrequencyOverride();
  if (override == null) return source;
  const line = `grid geodesic tiles ${override}`;
  return source.replace(/^grid\s+geodesic\s+.*$/m, line);
}

function requireGeodesicRecipe(recipe) {
  const grid = recipe.pipeline?.dsl?.grid;
  if (grid?.kind !== "geodesic") {
    throw new Error(`${recipe.name ?? "recipe"} must declare a geodesic DSL grid`);
  }
}

function validIdentifier(value) {
  if (!value) return "name required";
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value)) return "must be a valid JS identifier";
  return null;
}
