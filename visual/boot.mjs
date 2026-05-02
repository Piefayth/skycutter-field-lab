// boot.mjs composes DOM glue + per-frame execution. Recipes declare a
// canonical pipeline DSL; the browser tick path runs through the
// geodesic WebGPU pipeline. Three.js scene/raycasting flow lives in
// three-setup.mjs / paint.mjs.

import { createState } from "../kernel/kernel.mjs";
import { createThreeSetup } from "./three-setup.mjs";
import { createView } from "./view.mjs";
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

const {
  canvas,
  renderer,
  scene,
  camera,
  orbitControls,
  texCtx,
  imageData,
  fieldTexture,
  globe,
  arrows,
  arrowGeometry,
} = await createThreeSetup();
const { updateTexture, updateArrows } = createView({
  renderer,
  texCtx,
  imageData,
  fieldTexture,
  globe,
  arrows,
  arrowGeometry,
});

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
  getRunner()?.markStateDirty?.();
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

function runSelectedNode(id) {
  const runner = getRunner();
  if (!runner || !id) return;
  try {
    state.events.totalThisTick = 0;
    state.events.byLabel = Object.create(null);
    probe.clearContribs();
    runner.runNode(state, id, FIXED_SIM_DT);
    updateAll({ force: true });
    pipelineEditor.setStatus(`ran ${runner.nodes[id].name ?? id}`);
  } catch (error) {
    console.error("run failed:", error);
    showToast(`run failed: ${error.message}`, { kind: "error" });
    pipelineEditor.setStatus(`run failed: ${error.message}`, true);
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
let lastArrowRefreshFrame = -Infinity;
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
  if (state.grid?.kind !== "geodesic") {
    runner?.readFields?.(state, recipes.viewById?.(ui.viewSelect.value)?.color?.fields);
    updateTexture({
      fields: state.fields,
      viewSpec: recipes.viewById?.(ui.viewSelect.value),
    });
  }
  geodesicPreview?.refresh?.({
    fields: state.fields,
    viewSpec: recipes.viewById?.(ui.viewSelect.value),
    frame: runtime.frame,
    force,
  });
  if (state.grid?.kind !== "geodesic" && (force || runtime.frame - lastArrowRefreshFrame >= 6)) {
    runner?.readFields?.(state, ["windU", "windV"]);
    updateArrows({
      windU: state.fields.windU,
      windV: state.fields.windV,
      showArrows: recipes.isOverlayEnabled?.("wind-vectors") ?? false,
    });
    lastArrowRefreshFrame = runtime.frame;
  }
  if (force || runtime.frame - lastMetricsRefreshFrame >= 6) {
    runner?.syncState?.(state);
    metrics.updateStrip({ fields: state.fields, events: state.events });
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
    const preview = await createGeodesicPreview({ scene, globe, grid: grid.topology });
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
  return { pipelineWindow };
}

function buildMenu(windows) {
  const host = document.querySelector("#menuBar");
  // File → Recipe → list of recipes from the manifest. We poll the
  // manifest at every menu open (`items` is rebuilt by the menu module
  // each time) so newly-added recipes show up without a page reload —
  // but for now the menu module captures the items array at build time,
  // which is fine since manifest is fetched once at boot. If we add
  // mid-session manifest reload, this needs a `rebuild()` call.
  const recipeItems = () => recipes.manifest.recipes.map((r) => ({
    type: "checkable",
    label: r.name ?? r.id,
    title: r.summary,
    isChecked: () => r.id === recipes.activeId,
    onClick: () => {
      ui.recipeSelect.value = r.id;
      ui.recipeSelect.dispatchEvent(new Event("change", { bubbles: true }));
    },
  }));
  const menu = buildMenuBar({
    container: host,
    brand: "SKYCUTTER · FIELD LAB",
    rev: gridLabel(),
    menus: [
      {
        label: "File",
        items: [{ type: "submenu", label: "Recipe", items: recipeItems() }],
      },
      {
        label: "Window",
        items: windowMenuItems(windows),
      },
    ],
  });
  return { rebuild: () => menu.rebuild([
    { label: "File", items: [{ type: "submenu", label: "Recipe", items: recipeItems() }] },
    { label: "Window", items: windowMenuItems(windows) },
  ]) };
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
  ];
}

// =========================================================================
// Boot
// =========================================================================
export function bootApp() {
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
    onRunNode: runSelectedNode,
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
