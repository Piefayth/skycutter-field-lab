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
  W, H, TAU, sample, hashNoise, noise2,
  clamp, lerp, smoothstep,
  reallocateState, resetState,
} from "../kernel/kernel.mjs";
import { createGeodesicGrid } from "../kernel/geodesic-grid.mjs";
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
    width: W,
    height: H,
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

function buildDslPresetDecls(presets, dsl) {
  return presets.map((preset) => ({
    id: preset.id,
    label: preset.label ?? preset.id,
    run: (state) => runDslPreset(state, preset, dsl),
  }));
}

function buildDslStampDecls(stamps, dsl) {
  return stamps.map((stamp) => ({
    id: stamp.id,
    label: stamp.label ?? stamp.id,
    run: (state, x, y, r, hit = null) => runDslStamp(state, stamp, x, y, r, dsl, hit),
  }));
}

function runDslPreset(state, preset, dsl) {
  const context = initContext(dsl);
  for (const action of preset.actions ?? []) runPresetAction(state, action, context);
}

function runDslStamp(state, stamp, x, y, r, dsl, hit = null) {
  const cell = {
    x, y, r,
    ...(hit ?? {}),
    locals: Object.create(null),
    field: Object.create(null),
    ...initContext(dsl),
  };
  for (const action of stamp.actions ?? []) runPresetAction(state, action, cell);
}

function initContext(dsl) {
  return {
    consts: Object.fromEntries((dsl?.constants ?? []).map((decl) => [decl.name, decl.value])),
    planet: { ...(dsl?.planet ?? {}) },
  };
}

function runPresetAction(state, action, cell) {
  if (action.type === "fill") {
    const arr = state.fields[action.field];
    if (arr) arr.fill(evalInitExpr(action.value, state, cell));
    return;
  }
  if (action.type === "spot") {
    addGeodesicSpot(
      state,
      action.field,
      evalInitExpr(action.lon, state, cell),
      evalInitExpr(action.lat, state, cell),
      evalInitExpr(action.radius, state, cell),
      evalInitExpr(action.amount, state, cell),
    );
    return;
  }
  if (action.type === "ellipse") {
    addGeodesicEllipseAtLonLat(
      state,
      action.field,
      evalInitExpr(action.lon, state, cell),
      evalInitExpr(action.lat, state, cell),
      evalInitExpr(action.rx, state, cell),
      evalInitExpr(action.ry, state, cell),
      evalInitExpr(action.amount, state, cell),
      evalInitExpr(action.angle, state, cell),
    );
    return;
  }
  if (action.type === "region") {
    setGeodesicRegion(
      state,
      action.field,
      evalInitExpr(action.lonMin, state, cell),
      evalInitExpr(action.lonMax, state, cell),
      evalInitExpr(action.latMin, state, cell),
      evalInitExpr(action.latMax, state, cell),
      evalInitExpr(action.amount, state, cell),
    );
    return;
  }
  if (action.type === "eachCell") {
    const grid = state.grid?.topology;
    if (!grid) return;
    for (let i = 0; i < grid.cellCount; i++) {
      const coords = geodesicAuthorCoords(grid, i);
      const field = {};
      for (const name of Object.keys(state.fields)) field[name] = state.fields[name][i];
      runPresetCellActions(state, action.actions ?? [], {
        ...coords, i,
        locals: Object.create(null),
        field,
        consts: cell?.consts ?? {},
        planet: cell?.planet ?? {},
      });
    }
    return;
  }
  throw new Error(`unknown preset action ${action.type}`);
}

function runPresetCellActions(state, actions, cell) {
  for (const action of actions) {
    if (action.type === "let") {
      cell.locals[action.name] = evalInitExpr(action.expr, state, cell);
    } else if (action.type === "add") {
      const arr = state.fields[action.field];
      if (arr) {
        const value = evalInitExpr(action.expr, state, cell);
        arr[cell.i] += value;
        cell.field[action.field] = arr[cell.i];
      }
    } else if (action.type === "set") {
      const arr = state.fields[action.field];
      if (arr) {
        const value = evalInitExpr(action.expr, state, cell);
        arr[cell.i] = value;
        cell.field[action.field] = value;
      }
    } else if (action.type === "when") {
      if (evalInitExpr(action.condition, state, cell)) {
        runPresetCellActions(state, action.actions ?? [], {
          ...cell,
          locals: { ...cell.locals },
        });
      }
    } else {
      throw new Error(`unknown preset cell action ${action.type}`);
    }
  }
}

function evalInitExpr(ast, state, cell) {
  switch (ast.type) {
    case "Number":
      return Number(ast.value);
    case "Identifier":
      return evalInitIdentifier(ast.name, state, cell);
    case "Member": {
      const object = evalInitExpr(ast.object, state, cell);
      return object?.[ast.prop];
    }
    case "Unary": {
      const value = evalInitExpr(ast.expr, state, cell);
      if (ast.op === "-") return -value;
      if (ast.op === "+") return +value;
      if (ast.op === "!") return !value;
      throw new Error(`unknown unary op ${ast.op}`);
    }
    case "Binary":
      return evalInitBinary(ast.op, evalInitExpr(ast.left, state, cell), evalInitExpr(ast.right, state, cell));
    case "Conditional":
      return evalInitExpr(ast.test, state, cell)
        ? evalInitExpr(ast.consequent, state, cell)
        : evalInitExpr(ast.alternate, state, cell);
    case "Call":
      return evalInitCall(ast, state, cell);
    default:
      throw new Error(`unknown init expression node ${ast.type}`);
  }
}

function evalInitIdentifier(name, state, cell) {
  if (name === "true") return true;
  if (name === "false") return false;
  if (name === "null") return null;
  if (name === "undefined") return undefined;
  if (name === "N") return state?.grid?.cells ?? W * H;
  if (name === "TAU") return TAU;
  if (name === "PI") return Math.PI;
  if (cell?.locals && Object.hasOwn(cell.locals, name)) return cell.locals[name];
  if (name === "x") return cell?.x ?? 0;
  if (name === "y") return cell?.y ?? 0;
  if (name === "lon") return cell?.lon ?? 0;
  if (name === "lat") return cell?.lat ?? 0;
  if (name === "u") return cell?.u ?? 0;
  if (name === "v") return cell?.v ?? 0;
  if (name === "px") return cell?.px ?? 0;
  if (name === "py") return cell?.py ?? 0;
  if (name === "pz") return cell?.pz ?? 0;
  if (name === "r") return cell?.r ?? 0;
  if (name === "i") return cell?.i ?? 0;
  // Bare-name DSL: const / planet values are reachable directly. The
  // validator forbids `consts.X` / `planet.X` so the only way in is a
  // bare identifier, looked up here. Params aren't threaded into the
  // preset context (presets fire on recipe load, not per tick) — they
  // resolve to 0 via the silent fallback below.
  if (cell?.consts && Object.hasOwn(cell.consts, name)) return cell.consts[name];
  if (cell?.planet && Object.hasOwn(cell.planet, name)) return cell.planet[name];
  if (cell?.field && Object.hasOwn(cell.field, name)) return cell.field[name];
  const arr = state.fields[name];
  if (arr && cell) return arr[cell.i];
  return 0;
}

function evalInitBinary(op, left, right) {
  switch (op) {
    case "??": return left ?? right;
    case "||": return left || right;
    case "&&": return left && right;
    case "===": return left === right;
    case "!==": return left !== right;
    case "==": return left == right;
    case "!=": return left != right;
    case ">": return left > right;
    case ">=": return left >= right;
    case "<": return left < right;
    case "<=": return left <= right;
    case "+": return left + right;
    case "-": return left - right;
    case "*": return left * right;
    case "/": return left / right;
    case "%": return left % right;
    default: throw new Error(`unknown binary op ${op}`);
  }
}

function evalInitCall(ast, state, cell) {
  const name = ast.callee.type === "Identifier" ? ast.callee.name : null;
  const args = ast.args.map((arg) => evalInitExpr(arg, state, cell));
  if (name === "clamp") return clamp(args[0], args[1], args[2]);
  if (name === "smoothstep") return smoothstep(args[0], args[1], args[2]);
  if (name === "max") return Math.max(...args);
  if (name === "min") return Math.min(...args);
  if (name === "abs") return Math.abs(args[0]);
  if (name === "hypot") return Math.hypot(...args);
  if (name === "sin") return Math.sin(args[0]);
  if (name === "asin") return Math.asin(args[0]);
  if (name === "cos") return Math.cos(args[0]);
  if (name === "exp") return Math.exp(args[0]);
  if (name === "sqrt") return Math.sqrt(args[0]);
  if (name === "pow") return Math.pow(args[0], args[1]);
  if (name === "noise") return hashNoise(cell?.i ?? 0, args[0] ?? 0);
  if (name === "noise2") return noise2(args[0], args[1]);
  if (name === "sample") {
    const fieldArg = ast.args[0];
    const fieldName = fieldArg?.type === "Identifier" ? fieldArg.name : null;
    const arr = fieldName ? state.fields[fieldName] : null;
    if (state.grid?.kind === "geodesic" && arr && cell) {
      return arr[cell.i] ?? 0;
    }
    return arr && cell ? sample(arr, cell.x + (args[1] ?? 0), cell.y + (args[2] ?? 0)) : 0;
  }
  throw new Error(`unknown init function ${name ?? "call"}`);
}

function geodesicAuthorCoords(grid, cell) {
  const offset = cell * 3;
  const px = grid.positions[offset + 0];
  const py = grid.positions[offset + 1];
  const pz = grid.positions[offset + 2];
  const lon = Math.atan2(pz, px);
  const lat = Math.asin(clamp(py, -1, 1));
  const u = euclideanModulo(lon / TAU + 0.5, 1);
  const v = clamp(lat / Math.PI + 0.5, 0, 1);
  return {
    x: u,
    y: v,
    lon,
    lat,
    u,
    v,
    px,
    py,
    pz,
  };
}

function addGeodesicSpot(state, fieldName, lon, lat, radius, amount) {
  const c = Math.cos(lat);
  addGeodesicBlobAtVector(
    state,
    fieldName,
    [Math.cos(lon) * c, Math.sin(lat), Math.sin(lon) * c],
    radius,
    amount,
  );
}

function addGeodesicBlobAtVector(state, fieldName, center, radius, amount) {
  const field = state.fields[fieldName];
  const grid = state.grid?.topology;
  if (!field || !grid) return;
  const centerCell = nearestGeodesicCell(grid, center);
  const ringRadius = Math.max(1, Math.round(Math.abs(radius) / averageNeighborAngle(grid, centerCell)));
  const visited = new Uint8Array(grid.cellCount);
  const queue = [{ cell: centerCell, depth: 0 }];
  visited[centerCell] = 1;
  for (let head = 0; head < queue.length; head++) {
    const { cell, depth } = queue[head];
    const t = depth / Math.max(1, ringRadius);
    field[cell] += amount * Math.max(0, 1 - t * t);
    if (depth >= ringRadius) continue;
    const count = grid.neighborCounts[cell] ?? 0;
    for (let slot = 0; slot < count; slot++) {
      const next = grid.neighbors[cell * grid.maxNeighbors + slot];
      if (next < 0 || visited[next]) continue;
      visited[next] = 1;
      queue.push({ cell: next, depth: depth + 1 });
    }
  }
}

function nearestGeodesicCell(grid, point) {
  let bestCell = 0;
  let bestDot = -Infinity;
  for (let cell = 0; cell < grid.cellCount; cell++) {
    const offset = cell * 3;
    const dot = point[0] * grid.positions[offset + 0]
      + point[1] * grid.positions[offset + 1]
      + point[2] * grid.positions[offset + 2];
    if (dot > bestDot) {
      bestDot = dot;
      bestCell = cell;
    }
  }
  return bestCell;
}

function averageNeighborAngle(grid, cell) {
  const base = cell * 3;
  const px = grid.positions[base + 0];
  const py = grid.positions[base + 1];
  const pz = grid.positions[base + 2];
  const count = grid.neighborCounts[cell] ?? 0;
  let total = 0;
  for (let slot = 0; slot < count; slot++) {
    const n = grid.neighbors[cell * grid.maxNeighbors + slot] * 3;
    const dot = clamp(px * grid.positions[n + 0] + py * grid.positions[n + 1] + pz * grid.positions[n + 2], -1, 1);
    total += Math.acos(dot);
  }
  return count > 0 ? total / count : Math.PI / Math.max(1, grid.frequency * 2);
}

function addGeodesicEllipseAtLonLat(state, fieldName, lon, lat, rx, ry, amount, angle = 0) {
  const c = Math.cos(lat);
  addGeodesicEllipseAtVector(
    state,
    fieldName,
    [Math.cos(lon) * c, Math.sin(lat), Math.sin(lon) * c],
    rx,
    ry,
    amount,
    angle,
  );
}

function addGeodesicEllipseAtVector(state, fieldName, center, rx, ry, amount, angle = 0) {
  const field = state.fields[fieldName];
  const grid = state.grid?.topology;
  if (!field || !grid) return;
  const basis = tangentBasis(center);
  const sx = Math.max(0.0001, Math.abs(rx));
  const sy = Math.max(0.0001, Math.abs(ry));
  const ca = Math.cos(angle);
  const sa = Math.sin(angle);
  const maxReach = Math.max(sx, sy) * 3;
  for (let cell = 0; cell < grid.cellCount; cell++) {
    const offset = cell * 3;
    const px = grid.positions[offset + 0];
    const py = grid.positions[offset + 1];
    const pz = grid.positions[offset + 2];
    const dot = clamp(center[0] * px + center[1] * py + center[2] * pz, -1, 1);
    const arc = Math.acos(dot);
    if (arc > maxReach) continue;
    const tangentLen = Math.max(1e-6, Math.sin(arc));
    const tx = (px - center[0] * dot) / tangentLen;
    const ty = (py - center[1] * dot) / tangentLen;
    const tz = (pz - center[2] * dot) / tangentLen;
    const east = (tx * basis.east[0] + ty * basis.east[1] + tz * basis.east[2]) * arc;
    const south = -(tx * basis.north[0] + ty * basis.north[1] + tz * basis.north[2]) * arc;
    const u = (east * ca + south * sa) / sx;
    const v = (-east * sa + south * ca) / sy;
    const g = Math.exp(-(u * u + v * v));
    if (g < 0.0001) continue;
    field[cell] += amount * g;
  }
}

function setGeodesicRegion(state, fieldName, lonMin, lonMax, latMin, latMax, amount) {
  const field = state.fields[fieldName];
  const grid = state.grid?.topology;
  if (!field || !grid) return;
  const loLat = Math.min(latMin, latMax);
  const hiLat = Math.max(latMin, latMax);
  for (let cell = 0; cell < grid.cellCount; cell++) {
    const { lon, lat } = geodesicAuthorCoords(grid, cell);
    if (lat < loLat || lat > hiLat) continue;
    const inLon = lonMin <= lonMax
      ? lon >= lonMin && lon <= lonMax
      : lon >= lonMin || lon <= lonMax;
    if (inLon) field[cell] = amount;
  }
}

function tangentBasis(center) {
  let east = [-center[2], 0, center[0]];
  let len = Math.hypot(east[0], east[1], east[2]);
  if (len < 1e-6) {
    east = [1, 0, 0];
    len = 1;
  }
  east = [east[0] / len, east[1] / len, east[2] / len];
  const north = [
    east[1] * center[2] - east[2] * center[1],
    east[2] * center[0] - east[0] * center[2],
    east[0] * center[1] - east[1] * center[0],
  ];
  return { east, north };
}

function euclideanModulo(n, m) {
  return ((n % m) + m) % m;
}

function validIdentifier(value) {
  if (!value) return "name required";
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value)) return "must be a valid JS identifier";
  return null;
}
