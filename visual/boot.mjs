// boot.mjs composes DOM glue + per-frame execution. Recipes declare a
// canonical pipeline DSL; the browser tick path runs through the
// geodesic WebGPU pipeline. Three.js scene/raycasting flow lives in
// three-setup.mjs / paint.mjs.

import { createState } from "../kernel/kernel.mjs";
import { createThreeSetup } from "./three-setup.mjs";
import { createMetrics } from "./metrics.mjs";
import {
  applyControlSpec,
  controls,
  initControls,
  paramValue,
  readParams,
} from "./controls.mjs";
import { initPaint, paint } from "./paint.mjs";
import { initEditors, pipelineEditor } from "./pipeline-editor.mjs";
import { showToast } from "./toast.mjs";
import { initProbe, probe } from "./probe.mjs";
import { getRunner, initRecipes, recipes } from "./recipes.mjs";
import {
  advanceFrame,
  initRuntime,
  runtime,
  setFrame,
  tickFrame,
  togglePaused,
} from "./runtime-state.mjs";
import { createWindow, listWindows } from "./windows.mjs";
import { buildMenuBar } from "./menu.mjs";
import { createGeodesicPreview } from "./geodesic-preview.mjs";
import { createDslDocsContent, registerDslDocsWindow } from "./dsl-docs.mjs";
import { groupManifestRecipes } from "./recipe-menu-model.mjs";

let canvas = null;
let renderer = null;
let scene = null;
let camera = null;
let orbitControls = null;
let globe = null;

const state = createState();
// Don't destructure — state.fields and its inner Float32Arrays get
// reassigned by `reallocateState()` on every recipe load, and a
// destructured local would freeze the boot-time references. Read
// through `state.*` everywhere downstream.

const ui = {
  // Static UI refs the modules rely on. The pipeline authoring surface
  // lives inside its floating window and builds its own DOM dynamically.
  recipeSelect: document.querySelector("#recipeSelect"),
  presetSelect: document.querySelector("#presetSelect"),
  viewSelect: document.querySelector("#viewSelect"),
  overlaysGrid: document.querySelector("#overlaysGrid"),
  metricsStrip: document.querySelector("#metricsStrip"),
  autoPausePaint: document.querySelector("#autoPausePaint"),
  brushSelect: document.querySelector("#brushSelect"),
  parametersGrid: document.querySelector("#parametersGrid"),
  stats: document.querySelector("#stats"),
  probe: document.querySelector("#probe"),
  metricCloud: document.querySelector("#metricCloud"),
  metricGrowth: document.querySelector("#metricGrowth"),
  metricWind: document.querySelector("#metricWind"),
  metricVariance: document.querySelector("#metricVariance"),
  metricActive: document.querySelector("#metricActive"),
  metricActivity: document.querySelector("#metricActivity"),
  metricEvents: document.querySelector("#metricEvents"),
  metricFps: document.querySelector("#metricFps"),
  regimeIndicator: document.querySelector("#regimeIndicator"),
  // Side-panel run-time controls are wired in bootApp after creation.
  pauseButton: null, // wired in bootApp via dynamic creation
  stepButton: null,
  resetButton: null,
  randomButton: null,
};

// Pause/Step/Reset/Random live in the Init section [02]. Wire them up.
ui.pauseButton = document.querySelector("#pauseButton");
ui.stepButton = document.querySelector("#stepButton");
ui.resetButton = document.querySelector("#resetButton");
ui.randomButton = document.querySelector("#randomButton");

const metrics = createMetrics({ ui });

ui.pauseButton.addEventListener("click", () => {
  ui.pauseButton.textContent = togglePaused() ? "Resume" : "Pause";
});
ui.stepButton.addEventListener("click", () => stepOneTick());
ui.resetButton.addEventListener("click", () => initPreset(ui.presetSelect.value));
ui.randomButton.addEventListener("click", () => initPreset("random"));
ui.presetSelect.addEventListener("change", () => initPreset(ui.presetSelect.value));
ui.viewSelect.addEventListener("change", () => updateAll({ force: true }));

// =========================================================================
// Sim step / preset apply
// =========================================================================

function initPreset(name) {
  recipes.applyPreset?.(state, name);
  // Preset apply, not a stamp: signal so the runner seeds history
  // fields (prev := current) before the first tick. markStateDirty
  // alone would leave prev pointing at uninitialized memory.
  const runner = getRunner();
  (runner?.markPresetApplied ?? runner?.markStateDirty)?.call(runner);
  simAccumulator = 0;
  setFrame(state.frame);
  metrics.resetActivityHistory();
  paint.lastPaintLabel = "preset loaded";
  updateAll({ force: true });
}

// Tick errors fire on every frame until fixed — toast once on the
// first failure of a given message so the screen doesn't fill with
// 60 copies of the same banner.
let lastTickError = null;
const FIXED_SIM_HZ = 60;
const FIXED_SIM_DT = 1 / FIXED_SIM_HZ;
const MAX_SIM_SUBSTEPS = 24;
let simAccumulator = 0;

function stepSim(dt) {
  const runner = getRunner();
  if (!runner) return;
  const simRateHz = Math.max(0, Number(paramValue("simRateHz") ?? FIXED_SIM_HZ));
  simAccumulator += Math.max(0, dt) * simRateHz;
  let steps = 0;
  try {
    while (simAccumulator >= 1 && steps < MAX_SIM_SUBSTEPS) {
      runner.runTick(state, FIXED_SIM_DT);
      advanceFrame();
      steps++;
      simAccumulator -= 1;
    }
    if (steps === MAX_SIM_SUBSTEPS && simAccumulator >= 1) simAccumulator = 0;
    lastTickError = null;
  } catch (error) {
    simAccumulator = Math.min(simAccumulator, MAX_SIM_SUBSTEPS);
    if (error.message !== lastTickError) {
      lastTickError = error.message;
      console.error("tick failed:", error);
      showToast(`tick failed: ${error.message}`, { kind: "error" });
    }
    pipelineEditor.setStatus(`tick failed: ${error.message}`, true);
    return;
  }
  if (steps > 0) updateAll();
}

function stepOneTick() {
  const runner = getRunner();
  if (!runner) return;
  try {
    runner.runTick(state, FIXED_SIM_DT);
    advanceFrame();
    simAccumulator = 0;
    lastTickError = null;
    updateAll();
  } catch (error) {
    if (error.message !== lastTickError) {
      lastTickError = error.message;
      console.error("tick failed:", error);
      showToast(`tick failed: ${error.message}`, { kind: "error" });
    }
    pipelineEditor.setStatus(`tick failed: ${error.message}`, true);
  }
}

// =========================================================================
// Side-panel section collapse (chev button on the [02]–[06] sections)
// =========================================================================

function wireSectionCollapse() {
  for (const section of document.querySelectorAll(".lab-section--collapse")) {
    const head = section.querySelector(".lab-section__head");
    if (!head) continue;
    head.addEventListener("click", (event) => {
      if (event.target instanceof HTMLInputElement) return;
      section.classList.toggle("lab-section--collapsed");
    });
  }
}

// =========================================================================
// Render / metrics tick
// =========================================================================

let lastPreviewRefreshFrame = -Infinity;
let lastMetricsRefreshFrame = -Infinity;
let lastProbeRefreshFrame = -Infinity;
let geodesicPreview = null;
let geodesicPreviewLoadingFrequency = null;
let menuRef = null;

function updateAll({ force = false } = {}) {
  syncGeodesicPreview();
  updateGridRev();
  const runner = getRunner();
  if (pipelineEditor.isVisible?.() && (force || runtime.frame - lastPreviewRefreshFrame >= 12)) {
    runner?.syncState?.(state);
    pipelineEditor.refreshPreviews?.();
    lastPreviewRefreshFrame = runtime.frame;
  }
  geodesicPreview?.refresh?.({
    fields: state.fields,
    viewSpec: recipes.viewById?.(ui.viewSelect.value),
    frame: runtime.frame,
    fieldRevision: state.__fieldRevision ?? 0,
    force,
  });
  if (force || runtime.frame - lastMetricsRefreshFrame >= 6) {
    runner?.syncState?.(state);
    metrics.updateStrip({ state });
    lastMetricsRefreshFrame = runtime.frame;
  }
  ui.stats.textContent = `frame ${runtime.frame} | ${paint.lastPaintLabel}`;
  if (force || runtime.frame - lastProbeRefreshFrame >= 3) {
    runner?.syncState?.(state);
    probe.render();
    lastProbeRefreshFrame = runtime.frame;
  }
}

function previewView() {
  camera.updateMatrixWorld();
  const e = camera.matrixWorld.elements;
  return {
    right: [e[0], e[1], e[2]],
    up: [e[4], e[5], e[6]],
    forward: [e[8], e[9], e[10]],
  };
}

function resize() {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}

function animate() {
  requestAnimationFrame(animate);
  resize();
  const { frameMs, dt } = tickFrame();
  if (!runtime.paused) stepSim(dt);
  geodesicPreview?.update?.();
  orbitControls.update();
  if (pipelineEditor.isVisible?.() || pipelineEditor.hasPreviewPopouts?.()) pipelineEditor.refreshPreviews?.();
  renderer.render(scene, camera);
  metrics.updateFpsMetric(frameMs, { paused: runtime.paused });
}

async function syncGeodesicPreview() {
  const grid = state.grid;
  if (grid?.kind !== "geodesic" || !grid.topology) {
    geodesicPreview?.dispose?.();
    geodesicPreview = null;
    geodesicPreviewLoadingFrequency = null;
    return;
  }
  if (geodesicPreview?.grid === grid.topology) return;
  if (geodesicPreviewLoadingFrequency === grid.frequency) return;
  geodesicPreview?.dispose?.();
  geodesicPreview = null;
  geodesicPreviewLoadingFrequency = grid.frequency;
  try {
    const preview = await createGeodesicPreview({ scene, globe, camera, grid: grid.topology });
    if (state.grid?.topology !== grid.topology) {
      preview.dispose?.();
      if (geodesicPreviewLoadingFrequency === grid.frequency) geodesicPreviewLoadingFrequency = null;
      return;
    }
    geodesicPreview = preview;
    geodesicPreviewLoadingFrequency = null;
    if (!preview.ok) {
      showToast(`geodesic view unavailable: ${preview.reason}`, { kind: "error" });
      return;
    }
    preview.refresh?.({
      fields: state.fields,
      viewSpec: recipes.viewById?.(ui.viewSelect.value),
      frame: runtime.frame,
      fieldRevision: state.__fieldRevision ?? 0,
      force: true,
    });
    showToast(`geodesic view: ${preview.grid.cellCount} cells`);
    updateGridRev();
  } catch (error) {
    geodesicPreviewLoadingFrequency = null;
    console.error("WebGPU geodesic preview failed:", error);
    showToast(`geodesic view failed: ${error.message}`, { kind: "error" });
  }
}

// =========================================================================
// Floating windows + top menu bar
// =========================================================================

function buildWindows() {
  const layer = document.querySelector("#windowLayer");
  const pipelineWindow = createWindow({
    id: "pipeline",
    title: "Pipeline",
    contentEl: document.createElement("div"),
    defaultPos: { x: 24, y: 64 },
    defaultSize: { w: 520, h: 660 },
  });
  layer.appendChild(pipelineWindow.element);

  // DSL docs window — searchable reader over the symbol catalog. Hidden
  // by default; opened from Window menu or by clicking through a hover
  // tooltip. The catalog data is small enough that we can safely build
  // the full DOM up-front in createDslDocsContent.
  const docsController = createDslDocsContent();
  const docsWindow = createWindow({
    id: "dsl-docs",
    title: "DSL Docs",
    contentEl: docsController.contentEl,
    defaultPos: { x: 96, y: 96 },
    defaultSize: { w: 760, h: 540 },
    defaultVisible: false,
  });
  layer.appendChild(docsWindow.element);
  registerDslDocsWindow(docsWindow, docsController);

  return { pipelineWindow, docsWindow };
}

function buildMenu(windows) {
  const host = document.querySelector("#menuBar");
  // File -> Example Recipes is shaped by the manifest catalog metadata.
  // If we add mid-session manifest reload, this needs a `rebuild()` call.
  const recipeMenuItem = (r) => ({
    type: "checkable",
    label: r.name ?? r.id,
    title: r.summary,
    isChecked: () => r.id === recipes.activeId,
    onClick: () => {
      ui.recipeSelect.value = r.id;
      ui.recipeSelect.dispatchEvent(new Event("change", { bubbles: true }));
    },
  });
  const recipeItems = () => {
    const groups = groupManifestRecipes(recipes.manifest);
    if (!groups.length) return [{ label: "No example recipes", disabled: true }];
    const items = [];
    groups.forEach((group, index) => {
      if (index > 0 && groups[index - 1]?.virtual) items.push({ type: "separator" });
      items.push({
        type: "submenu",
        label: group.label,
        items: group.recipes.map(recipeMenuItem),
      });
    });
    return items;
  };
  const savedRecipeItems = () => {
    if (!recipes.savedRecipes.length) {
      return [{ label: "No saved recipes", disabled: true }];
    }
    return recipes.savedRecipes.map((r) => ({
      type: "checkable",
      label: r.name ?? r.id,
      title: r.summary,
      isChecked: () => r.id === recipes.activeId,
      onClick: () => recipes.loadSavedById?.(r.id)?.catch(handleRecipeMenuError),
    }));
  };
  const deleteSavedRecipeItems = () => {
    if (!recipes.savedRecipes.length) {
      return [{ label: "No saved recipes", disabled: true }];
    }
    return recipes.savedRecipes.map((r) => ({
      label: r.name ?? r.id,
      title: r.summary,
      onClick: () => recipes.deleteSavedById?.(r.id)?.catch(handleRecipeMenuError),
    }));
  };
  const fileMenuItems = () => [
    { label: "Save Recipe", title: "Cmd/Ctrl+S", onClick: () => recipes.saveCurrentLocal?.()?.catch(handleRecipeMenuError) },
    { label: "Save Recipe As...", title: "Shift+Cmd/Ctrl+S", onClick: () => recipes.saveCurrentAsLocal?.()?.catch(handleRecipeMenuError) },
    { type: "submenu", label: "Open Saved Recipe", items: savedRecipeItems() },
    { type: "submenu", label: "Delete Saved Recipe", items: deleteSavedRecipeItems() },
    { type: "separator" },
    { label: "Export Recipe File...", onClick: () => {
      try {
        recipes.exportCurrentFile?.();
      } catch (error) {
        handleRecipeMenuError(error);
      }
    } },
    { label: "Import Recipe File...", onClick: () => recipes.importRecipeFile?.()?.catch(handleRecipeMenuError) },
    { type: "separator" },
    { type: "submenu", label: "Example Recipes", items: recipeItems() },
  ];
  const menu = buildMenuBar({
    container: host,
    brand: "SKYCUTTER · FIELD LAB",
    rev: gridLabel(),
    menus: [
      {
        label: "File",
        items: fileMenuItems(),
      },
      {
        label: "Window",
        items: windowMenuItems(windows),
      },
    ],
  });
  return { rebuild: () => menu.rebuild([
    { label: "File", items: fileMenuItems() },
    { label: "Window", items: windowMenuItems(windows) },
  ]) };
}

function handleRecipeMenuError(error) {
  console.error("recipe menu action failed:", error);
  showToast(`recipe action failed: ${error.message}`, { kind: "error" });
  pipelineEditor.setStatus(`recipe action failed: ${error.message}`, true);
}

function wireRecipeSaveShortcuts() {
  document.addEventListener("keydown", (event) => {
    const key = event.key?.toLowerCase();
    if (key !== "s" || (!event.metaKey && !event.ctrlKey) || event.altKey) return;
    event.preventDefault();
    if (document.querySelector(".modal-backdrop")) return;
    const action = event.shiftKey ? recipes.saveCurrentAsLocal : recipes.saveCurrentLocal;
    action?.()?.catch(handleRecipeMenuError);
  }, true);
}

function gridLabel() {
  const grid = state.grid;
  if (grid?.kind === "geodesic") return `GEODESIC ${grid.frequency} · ${grid.cells} TILES`;
  return `GRID ${grid?.width ?? 256}×${grid?.height ?? 128}`;
}

function updateGridRev() {
  const label = gridLabel();
  menuRef?.setRev?.(label);
  const el = document.querySelector(".menu-bar__rev");
  if (el && el.textContent !== label) el.textContent = label;
}

function windowMenuItems(windows) {
  return [
    { type: "checkable", label: "Pipeline", isChecked: () => windows.pipelineWindow.isVisible(), onClick: () => windows.pipelineWindow.toggle() },
    { type: "checkable", label: "DSL Docs", isChecked: () => windows.docsWindow.isVisible(), onClick: () => windows.docsWindow.toggle() },
  ];
}

// =========================================================================
// Boot
// =========================================================================
export async function bootApp() {
  ({
    canvas,
    renderer,
    scene,
    camera,
    orbitControls,
    globe,
  } = await createThreeSetup());

  initControls(ui);
  initPaint({
    canvas, camera, globe, ui, state, controls,
    onBeforePaint: () => getRunner()?.syncState?.(state),
    onAfterPaint: () => {
      getRunner()?.markStateDirty?.();
      updateAll();
    },
    onProbeMove: (event) => probe.updateFromPointer(event),
    getPaused: () => runtime.paused,
    setPaused: (next) => {
      runtime.paused = Boolean(next);
      ui.pauseButton.textContent = runtime.paused ? "Resume" : "Pause";
    },
  });
  initProbe({ ui, state, pointerHit: paint.pointerHit });

  // Build authoring windows + mount editors before recipes.mjs's
  // bootstrap fires — recipes.mjs's `applyRecipe()` calls
  // `pipelineEditor.loadRecipe(...)` and the editors need to be ready.
  const windows = buildWindows();
  initEditors({
    pipelineWindow: windows.pipelineWindow,
    getState: () => state,
    getPreviewView: previewView,
  });
  initRecipes({
    state,
    ui,
    applyControlSpec,
    controls,
    metrics,
    pipelineEditor,
    getParams: readParams,
    getFrame: () => runtime.frame,
    getProbe: () => probe,
    renderer,
    runPreset: initPreset,
    refreshView: updateAll,
    onActiveRecipeChange: () => {
      menuRef?.rebuild?.();
      updateGridRev();
    },
  });

  // Build menu after recipes.bootstrap so the manifest is populated.
  // Manifest is loaded asynchronously but bootstrap kicks off an
  // immediate fetch — the menu's recipe submenu may briefly be empty
  // until the manifest resolves, which is fine.
  menuRef = buildMenu(windows);
  wireRecipeSaveShortcuts();

  // Window menu's checkmarks need to refresh whenever a window's
  // visibility changes (close button, escape, programmatic toggle).
  for (const win of listWindows()) {
    win.onChange = () => menuRef.rebuild();
  }

  metrics.setupSparklines();
  wireSectionCollapse();
  initRuntime();
  syncGeodesicPreview();
  animate();
}
