// =============================================================================
// Recipe library + load/apply pipeline.
//
// Each recipe is an `.mjs` module exporting `{ name, summary, knobs,
// toggles, presets, stamps, views, overlays, metrics, regime, pipeline,
// recommendedPreset }`. The manifest names which recipe to auto-load at
// boot. The browser wraps DSL metadata with a geodesic WebGPU executor;
// Built-in recipe files are immutable in-browser; user snapshots live in
// localStorage and can be exported/imported as JSON recipe files.
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
import { compileV2 as compileDsl } from "../dsl/compile-v2.mjs";
import { gray, materializeView } from "../prims/colorers.mjs";
import {
  downloadRecipeSnapshot,
  loadSavedRecipes,
  makeRecipeSnapshot,
  parseRecipeFile,
  persistSavedRecipes,
  pickRecipeFile,
  upsertSavedRecipe,
} from "./recipe-storage.mjs";

const registry = {
  manifest: { defaultRecipe: null, recipes: [] },
  defaultRecipeId: null,
  savedRecipes: [],
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
  saveCurrentLocal: null,
  saveCurrentAsLocal: null,
  loadSavedById: null,
  deleteSavedById: null,
  exportCurrentFile: null,
  importRecipeFile: null,
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

  // Per-name reader over the live controls. Threaded into the init
  // runtime so preset / stamp / eachCell expressions can reference
  // recipe-declared params at apply time. `getParams()` returns an
  // object keyed by name; we expose a per-name function because that's
  // what dsl-init-runtime expects.
  const getParamLive = (name) => {
    const all = typeof getParams === "function" ? getParams() : null;
    return all ? all[name] : undefined;
  };

  // Active recipe state.
  let activeRecipe = null;
  let activeRecipeId = null;
  let activeBaseRecipeId = null;
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
      registry.savedRecipes = loadSavedRecipes();
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
    const recipeModule = await importManifestRecipe(id);
    activeRecipe = materializeRecipe(recipeModule);
    activeRecipeId = id;
    activeBaseRecipeId = id;
    registry.activeId = id;
    applyRecipe(activeRecipe, id);
    onActiveRecipeChange?.(id);
    pipelineEditor.setStatus(`loaded recipe "${activeRecipe.name ?? id}"`);
  }

  async function loadSavedById(id) {
    const snapshot = registry.savedRecipes.find((recipe) => recipe.id === id);
    if (!snapshot) throw new Error(`saved recipe "${id}" not found`);
    const recipe = await materializeSavedRecipe(snapshot);
    activeRecipe = recipe;
    activeRecipeId = snapshot.id;
    activeBaseRecipeId = snapshot.baseRecipeId;
    registry.activeId = snapshot.id;
    applyRecipe(activeRecipe, snapshot.id);
    onActiveRecipeChange?.(snapshot.id);
    pipelineEditor.setStatus(`loaded saved recipe "${snapshot.name ?? snapshot.id}"`);
    showToast(`loaded saved recipe "${snapshot.name ?? snapshot.id}"`);
  }

  async function materializeSavedRecipe(snapshot) {
    const baseId = snapshot.baseRecipeId ?? registry.defaultRecipeId ?? registry.manifest.recipes[0]?.id;
    const baseModule = await importManifestRecipe(baseId);
    const recipe = materializeRecipe(baseModule);
    recipe.pipelineDsl = snapshot.pipelineDsl;
    recipe.pipeline = compileDsl(snapshot.pipelineDsl);
    applyDslRecipeMetadata(recipe, recipe.pipeline.dsl, getParamLive);
    recipe.name = snapshot.name ?? recipe.name;
    recipe.summary = snapshot.summary ?? recipe.summary;
    return recipe;
  }

  async function saveCurrentLocal() {
    const existing = activeRecipeId?.startsWith("local:")
      ? registry.savedRecipes.find((recipe) => recipe.id === activeRecipeId)
      : null;
    if (!existing) return saveCurrentAsLocal();

    const source = currentPipelineDsl({ applyEditorDraft: true });
    const compiled = compileDsl(source);
    const snapshot = makeRecipeSnapshot({
      id: existing.id,
      name: existing.name ?? activeRecipe?.name ?? compiled.dsl?.recipe?.name ?? "Untitled recipe",
      summary: existing.summary ?? activeRecipe?.summary ?? compiled.dsl?.recipe?.summary ?? "",
      pipelineDsl: source,
      baseRecipeId: activeBaseRecipeId ?? existing.baseRecipeId ?? registry.defaultRecipeId,
      defaultRecipeId: registry.defaultRecipeId,
      existing,
      existingIds: savedRecipeIds(),
    });
    activateSavedSnapshot(snapshot);
    pipelineEditor.setStatus(`saved recipe "${snapshot.name}"`);
    showToast(`saved recipe "${snapshot.name}"`);
    return snapshot;
  }

  async function saveCurrentAsLocal() {
    const source = currentPipelineDsl({ applyEditorDraft: true });
    const compiled = compileDsl(source);
    const defaultName = activeRecipe?.name ?? compiled.dsl?.recipe?.name ?? "Untitled recipe";
    const form = await formModal({
      title: "Save recipe as",
      confirmLabel: "Save",
      fields: [
        { name: "name", label: "Name", type: "text", default: defaultName, required: true },
        { name: "summary", label: "Summary", type: "text", default: activeRecipe?.summary ?? "" },
      ],
    });
    if (!form) return null;
    const snapshot = makeRecipeSnapshot({
      name: form.name,
      summary: form.summary,
      pipelineDsl: source,
      baseRecipeId: activeBaseRecipeId ?? registry.defaultRecipeId,
      defaultRecipeId: registry.defaultRecipeId,
      existingIds: savedRecipeIds(),
    });
    activateSavedSnapshot(snapshot);
    pipelineEditor.setStatus(`saved recipe "${snapshot.name}"`);
    showToast(`saved recipe "${snapshot.name}"`);
    return snapshot;
  }

  function activateSavedSnapshot(snapshot) {
    const next = upsertSavedRecipe(registry.savedRecipes, snapshot);
    persistSavedRecipes(next);
    registry.savedRecipes = next;
    activeRecipeId = snapshot.id;
    activeBaseRecipeId = snapshot.baseRecipeId;
    registry.activeId = snapshot.id;
    if (activeRecipe) {
      activeRecipe.name = snapshot.name;
      activeRecipe.summary = snapshot.summary;
    }
    onActiveRecipeChange?.(snapshot.id);
  }

  async function deleteSavedById(id) {
    const snapshot = registry.savedRecipes.find((recipe) => recipe.id === id);
    if (!snapshot) return false;
    const ok = await confirmModal({
      title: "Delete saved recipe",
      message: `Delete saved recipe "${snapshot.name ?? id}" from local storage?`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return false;
    const next = registry.savedRecipes.filter((recipe) => recipe.id !== id);
    persistSavedRecipes(next);
    registry.savedRecipes = next;
    if (registry.activeId === id) registry.activeId = null;
    onActiveRecipeChange?.(registry.activeId);
    showToast(`deleted saved recipe "${snapshot.name ?? id}"`);
    return true;
  }

  function exportCurrentFile() {
    const source = currentPipelineDsl({ applyEditorDraft: true });
    const compiled = compileDsl(source);
    const snapshot = makeRecipeSnapshot({
      name: activeRecipe?.name ?? compiled.dsl?.recipe?.name ?? "Untitled recipe",
      summary: activeRecipe?.summary ?? compiled.dsl?.recipe?.summary ?? "",
      pipelineDsl: source,
      baseRecipeId: activeBaseRecipeId ?? registry.defaultRecipeId,
      defaultRecipeId: registry.defaultRecipeId,
      existingIds: savedRecipeIds(),
    });
    downloadRecipeSnapshot(snapshot);
    pipelineEditor.setStatus(`exported recipe "${snapshot.name}"`);
    showToast(`exported recipe "${snapshot.name}"`);
  }

  async function importRecipeFile() {
    const file = await pickRecipeFile();
    if (!file) return null;
    const text = await file.text();
    const snapshot = parseRecipeFile(text, {
      filename: file.name,
      baseRecipeId: activeBaseRecipeId ?? registry.defaultRecipeId,
      existingIds: savedRecipeIds(),
    });
    const next = upsertSavedRecipe(registry.savedRecipes, snapshot);
    persistSavedRecipes(next);
    registry.savedRecipes = next;
    await loadSavedById(snapshot.id);
    return snapshot;
  }

  function applyActivePipelineDsl(source) {
    if (!activeRecipe || !activeRecipeId) throw new Error("no active recipe");
    const pipeline = compileDsl(source);
    activeRecipe.pipelineDsl = source;
    activeRecipe.pipeline = pipeline;
    applyDslRecipeMetadata(activeRecipe, pipeline.dsl, getParamLive);
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
      applyDslRecipeMetadata(recipe, recipe.pipeline.dsl, getParamLive);
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
    recipe.views = reconcileRecipeViews(recipe);
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
    // Set by markPresetApplied: on the next upload, also seed the
    // history field's prev slot from current. Stamps DON'T set this —
    // their asymmetry between current and prev is the velocity impulse.
    let presetJustApplied = true;
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
      // Distinct from markStateDirty: signals that current state.fields
      // came from preset apply rather than a stamp. The next runTick
      // will copy current → prev for every history field so prev(u)
      // reads u_0 on the first tick instead of uninitialized memory.
      markPresetApplied() {
        dirty = true;
        presetJustApplied = true;
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
            if (presetJustApplied) {
              gpuRunner.initHistory?.();
              presetJustApplied = false;
            }
            dirty = false;
          }
          gpuRunner.runTick(dt);
          // Pull the latest GPU-reduced metric values into state.dslMetrics
          // so the metrics panel (which evaluates `dsl:<id>` sources)
          // sees them. Values are async-readback; entries are null
          // until the first readback completes, which evaluateMetricSource
          // renders as NaN → "—" in the UI.
          const dslMetrics = gpuRunner.readDslMetrics?.();
          if (dslMetrics) state.dslMetrics = dslMetrics;
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
    // Lock implies collapse (the body is hidden anyway). Unlock
    // implies UN-collapse so a recipe-with-parameters shows its
    // parameters open by default — without this, switching from a
    // no-params recipe (e.g. `blank`) to a recipe with parameters
    // left the section in the collapsed state set by the previous
    // recipe and the user had to manually expand it every time.
    node.classList.toggle("lab-section--collapsed", locked);
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
  registry.loadSavedById = loadSavedById;
  registry.saveCurrentLocal = saveCurrentLocal;
  registry.saveCurrentAsLocal = saveCurrentAsLocal;
  registry.deleteSavedById = deleteSavedById;
  registry.exportCurrentFile = exportCurrentFile;
  registry.importRecipeFile = importRecipeFile;
  pipelineEditor.applyPipelineDsl = applyActivePipelineDsl;
  bootstrap();

  async function importManifestRecipe(id) {
    const entry = registry.manifest.recipes.find((recipe) => recipe.id === id);
    if (!entry || !entry.path) throw new Error(`recipe "${id}" not in manifest`);
    // Dynamic import the .mjs module. Cache-bust via timestamp query so
    // edits to the recipe source during dev are picked up on reload.
    const url = new URL(entry.path, window.location.href);
    url.searchParams.set("v", String(Date.now()));
    return import(url.href);
  }

  function currentPipelineDsl({ applyEditorDraft = false } = {}) {
    if (applyEditorDraft && pipelineEditor.isPipelineDslDirty?.()) {
      const draft = pipelineEditor.getCurrentPipelineDsl?.();
      if (typeof draft === "string") {
        // Compile before applying so Save surfaces DSL diagnostics instead
        // of silently persisting the last applied source.
        compileDsl(draft);
        applyActivePipelineDsl(draft);
      }
    }
    if (!activeRecipe?.pipelineDsl) throw new Error("no active recipe DSL to save");
    return activeRecipe.pipelineDsl;
  }
}

export function materializeRecipe(recipeModule) {
  const recipe = { ...recipeModule };
  applyDslRecipeMetadata(recipe, recipe.pipeline?.dsl);
  return recipe;
}

function reconcileRecipeViews(recipe) {
  const views = Array.isArray(recipe?.views) ? recipe.views : [];
  const fields = recipeFieldNames(recipe);
  const compatible = views.filter((view) => {
    const required = view?.color?.fields;
    return !Array.isArray(required) || required.every((name) => fields.has(name));
  });
  if (compatible.length > 0) return compatible;
  return [...fields].map((name) => ({
    id: name,
    label: name.toUpperCase(),
    color: gray(name),
  }));
}

function recipeFieldNames(recipe) {
  const out = new Set();
  for (const group of [recipe?.pipeline?.dsl?.fields, recipe?.pipeline?.dsl?.declared, recipe?.fields]) {
    for (const decl of Array.isArray(group) ? group : []) {
      const name = typeof decl === "string" ? decl : decl?.name;
      if (name) out.add(name);
    }
  }
  return out;
}

function savedRecipeIds() {
  return registry.savedRecipes.map((recipe) => recipe.id);
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

function applyDslRecipeMetadata(recipe, dsl, getParam) {
  if (!recipe || !dsl) return;
  recipe.name = dsl.recipe?.name ?? recipe.name;
  recipe.summary = dsl.recipe?.summary ?? "";
  recipe.recommendedPreset = dsl.recipe?.recommendedPreset ?? null;
  recipe.planet = { ...(dsl.planet ?? {}) };
  recipe.constants = (dsl.constants ?? []).map((decl) => ({ ...decl }));
  recipe.fields = mergeFieldDecls(dsl.fields ?? [], declaredPipelineFieldDecls(dsl));
  recipe.presets = buildDslPresetDecls(dsl.presets ?? [], dsl, getParam);
  recipe.stamps = buildDslStampDecls(dsl.stamps ?? [], dsl, getParam);
  recipe.settings = (dsl.settings ?? []).map((decl) => ({ ...decl }));
  recipe.parameters = (dsl.parameters ?? []).map((decl) => ({ ...decl }));
  recipe.defaultParameters = Object.fromEntries(
    [...(dsl.settings ?? []), ...(dsl.parameters ?? [])]
      .filter((decl) => Object.hasOwn(decl, "default"))
      .map((decl) => [decl.name, decl.default]),
  );
  // V2 DSL metrics: each `metric x = <reduction> cells [where pred] {
  // expr }` gets a JS metrics-panel entry pointed at `dsl:<id>`. The
  // metric runtime populates state.dslMetrics[id] each tick and
  // metric-specs.mjs's evaluateMetricSource resolves `dsl:<id>` against
  // it. Recipe authors can also override the panel's metric list via
  // `export const metrics = [...]` in the .mjs sibling — synthesized
  // entries don't replace authored ones, they just augment them.
  const dslMetrics = dsl.metrics ?? [];
  if (dslMetrics.length > 0) {
    const synthesized = dslMetrics.map((m) => ({
      id: m.id,
      label: m.id.toUpperCase(),
      source: `dsl:${m.id}`,
      mini: true,
      // count metrics produce integer-valued counts (0.0, 1.0, 2.0, ...
      // — see V2-SPEC.md note on count's f32 implementation). Display
      // with no decimals; other reductions get the standard 3-digit
      // precision the metrics panel uses by default.
      precision: m.op === "count" ? 0 : 3,
    }));
    const existing = Array.isArray(recipe.metrics) ? recipe.metrics : [];
    const existingIds = new Set(existing.map((d) => d?.id));
    recipe.metrics = [
      ...existing,
      ...synthesized.filter((d) => !existingIds.has(d.id)),
    ];
  }

  // V2 DSL render decls: `palette` / `view` / `overlay`. If the
  // recipe declares any `view` blocks in DSL, those are the
  // authoritative views — the JS-export `views[]` is ignored. (We
  // don't merge — a recipe that mixes both would be ambiguous.) If
  // no DSL views exist, the JS-export views[] stays in effect for
  // back-compat. Same fallback shape for overlays.
  const dslViews = dsl.views ?? [];
  const dslPalettes = dsl.palettes ?? [];
  if (dslViews.length > 0) {
    const fieldDecls = recipe.fields ?? [];
    const paramDecls = recipe.parameters ?? [];
    const constDecls = recipe.constants ?? [];
    const materialized = dslViews.map((v) =>
      materializeView(v, dslPalettes, fieldDecls, paramDecls, constDecls),
    );
    // Bind the live params/consts onto each expr-view colorer so
    // body expressions resolving param refs read the current slider
    // values, not the snapshot at recipe-load time. Slider drags
    // take effect on the next frame.
    if (typeof getParam === "function") {
      for (const view of materialized) {
        if (typeof view.color?.bindContext === "function") {
          view.color.bindContext({
            params: new Proxy({}, { get: (_, name) => getParam(name) }),
            consts: Object.fromEntries(constDecls.map((c) => [c.name, c.value])),
          });
        }
      }
    }
    recipe.views = materialized;
  }
  const dslOverlays = dsl.overlays ?? [];
  if (dslOverlays.length > 0) {
    recipe.overlays = dslOverlays.map((o) => ({
      id: o.name,
      type: o.name,
      label: o.name.charAt(0).toUpperCase() + o.name.slice(1),
    }));
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
  // v2 uses `substrate geodesic frequency N`. The legacy v1 form was
  // `grid geodesic tiles N`. Handle both — the user might have saved
  // recipe text from before the v2 cutover. Either pattern is replaced
  // with the v2 substrate directive.
  const line = `substrate geodesic frequency ${override}`;
  if (/^substrate\s+geodesic\s+/m.test(source)) {
    return source.replace(/^substrate\s+geodesic\s+.*$/m, line);
  }
  if (/^grid\s+geodesic\s+/m.test(source)) {
    return source.replace(/^grid\s+geodesic\s+.*$/m, line);
  }
  return source;
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
