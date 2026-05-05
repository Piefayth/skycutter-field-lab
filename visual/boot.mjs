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
import { createGeodesicSurfaceRenderer } from "./geodesic-surface-renderer.mjs";
import { createDslDocsContent, registerDslDocsWindow } from "./dsl-docs.mjs";
import { groupManifestRecipes } from "./recipe-menu-model.mjs";
import { perfNow, recordPerfSpan } from "./perf-counters.mjs";

let canvas = null;
let inputCanvas = null;
let surfaceCanvas = null;
let device = null;
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
const gpuRenderQueryEnabled = new URLSearchParams(window.location.search).has("gpu-render");
const gpuSurfaceQueryEnabled = new URLSearchParams(window.location.search).has("gpu-surface")
  || globalThis.__FIELD_LAB_GPU_SURFACE_ENABLED__ === true;
let gpuSurfaceActive = gpuSurfaceQueryEnabled;
const surfaceContinuousQueryEnabled = new URLSearchParams(window.location.search).has("surface-continuous");
const surfaceFrameIntervalMs = surfacePresentIntervalMs();
const startPausedQueryEnabled = new URLSearchParams(window.location.search).has("startPaused");
const simRateOverride = simRateQueryOverride();
const perfHudQueryEnabled = new URLSearchParams(window.location.search).has("perfHud");
const idleRafQueryEnabled = new URLSearchParams(window.location.search).has("idleRaf");
const bootStage = new URLSearchParams(window.location.search).get("bootStage") ?? "";
const skipGpuDeviceQueryEnabled = new URLSearchParams(window.location.search).has("skipGpuDevice");
document.body.classList.toggle("gpu-surface-mode", gpuSurfaceActive);

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
  const simRateHz = Math.max(0, Number(simRateOverride ?? paramValue("simRateHz") ?? FIXED_SIM_HZ));
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
  debugFrameStats.simStepCalls++;
  debugFrameStats.simSteps += steps;
  if (steps > 0) {
    debugFrameStats.simFramesWithSteps++;
    updateAll();
  }
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
let lastRenderSyncMs = -Infinity;
let lastFullSyncMs = -Infinity;
let pendingReadback = null;
let readbackInFlight = false;
let lastCanvasWidth = 0;
let lastCanvasHeight = 0;
let lastOverlayRenderMs = -Infinity;
let geodesicPreview = null;
let geodesicPreviewLoadingFrequency = null;
let geodesicSurfaceRenderer = null;
let menuRef = null;
let overlayCanvasVisible = true;
let perfHudEl = null;
let lastAnimatePhase = "not-started";
let lastAnimateError = null;
let lastSurfaceSkipReason = "";
let lastRafAt = 0;
let animationScheduled = false;
let animationFallbackTimer = null;
let animationRafId = 0;
let animationTicket = 0;
let lastFrameSource = "none";
let watchdogTicks = 0;
const RAF_FALLBACK_MS = 180;
const debugTrace = [];
const debugFrameStats = {
  samples: [],
  lastFps: 0,
  recentFps: 0,
  lastFrameMs: 0,
  minFrameMs: Infinity,
  maxFrameMs: 0,
  surfaceRenders: 0,
  surfaceReuses: 0,
  simSteps: 0,
  simFramesWithSteps: 0,
  simStepCalls: 0,
};
const lastSurfaceRender = {
  frame: -Infinity,
  viewId: "",
  fieldName: "",
  width: 0,
  height: 0,
  aspect: 0,
  presentMs: -Infinity,
};

function traceDebug(event, detail = null) {
  debugTrace.push({
    t: Number(performance.now().toFixed(1)),
    frame: runtime.frame,
    event,
    detail,
  });
  if (debugTrace.length > 80) debugTrace.shift();
}

function installDebugTraps() {
  globalThis.addEventListener?.("error", (event) => {
    traceDebug("window-error", {
      message: event.message,
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
    });
  });
  globalThis.addEventListener?.("unhandledrejection", (event) => {
    traceDebug("unhandled-rejection", {
      reason: event.reason?.message ?? String(event.reason),
      stack: event.reason?.stack ?? "",
    });
  });
  setInterval(() => {
    watchdogTicks++;
    const age = lastRafAt ? performance.now() - lastRafAt : null;
    if (age == null || age > 500) {
      traceDebug("raf-watchdog", {
        age: age == null ? null : Number(age.toFixed(1)),
        phase: lastAnimatePhase,
        frameSamples: debugFrameStats.samples.length,
        error: lastAnimateError?.message ?? null,
      });
    }
  }, 500);
}

function scheduleAnimationFrame() {
  if (animationScheduled) return;
  animationScheduled = true;
  const ticket = ++animationTicket;
  animationRafId = requestAnimationFrame(() => {
    if (!animationScheduled || ticket !== animationTicket) return;
    runAnimationFrame("raf");
  });
  animationFallbackTimer = setTimeout(() => {
    if (!animationScheduled || ticket !== animationTicket) return;
    cancelAnimationFrame(animationRafId);
    animationRafId = 0;
    runAnimationFrame("timeout");
  }, RAF_FALLBACK_MS);
}

function updateAll({ force = false } = {}) {
  const perfStart = perfNow();
  syncGeodesicPreview();
  updateGridRev();
  const runner = getRunner();
  const viewSpec = gpuSurfaceActive ? ensureGpuSurfaceCompatibleView() : recipes.viewById?.(ui.viewSelect.value);
  const now = performance.now();
  const shouldRefreshPipeline =
    (pipelineEditor.isVisible?.() || pipelineEditor.hasPreviewPopouts?.()) &&
    (force || runtime.frame - lastPreviewRefreshFrame >= 12);
  const shouldRefreshMetrics = force || runtime.frame - lastMetricsRefreshFrame >= 30;
  const shouldRefreshProbe = force || runtime.frame - lastProbeRefreshFrame >= 30;
  const shouldSyncFull = force || now - lastFullSyncMs >= 5000;
  const renderSyncIntervalMs = gpuSurfaceActive ? 100 : 33;
  const shouldSyncRender = force || now - lastRenderSyncMs >= renderSyncIntervalMs;
  const gpuRenderField = (globalThis.__FIELD_LAB_GPU_RENDER_ENABLED__ === true || gpuRenderQueryEnabled)
    && !globalThis.__FIELD_LAB_GPU_RENDER_DISABLED__
    ? gpuRenderableField(viewSpec)
    : null;
  const gpuRenderQueued = gpuRenderField && typeof runner?.copyFieldToRenderTexture === "function";
  const gpuRenderResource = gpuRenderQueued ? copyGpuRenderResource(gpuRenderField) : null;
  const surfaceField = gpuSurfaceField(viewSpec);
  const surfaceActive = Boolean(
    gpuSurfaceActive &&
    geodesicSurfaceRenderer?.hasFrame?.() &&
    surfaceField &&
    runner?.renderField
  );
  const renderFields = fieldsForView(viewSpec, {
    gpuRenderField: surfaceActive ? surfaceField : (gpuRenderQueued ? gpuRenderField : null),
    skipParticles: surfaceActive,
  });
  const shouldBackgroundFullSync = !surfaceActive && (shouldRefreshPipeline || shouldRefreshMetrics || shouldRefreshProbe);
  const shouldForceFullSync = force && !surfaceActive;
  if (runner && (shouldForceFullSync || shouldBackgroundFullSync) && shouldSyncFull) {
    queueReadback({ full: true });
    lastFullSyncMs = now;
    lastRenderSyncMs = now;
  } else if (runner && shouldSyncRender && renderFields.length > 0 && typeof runner.readFields === "function") {
    queueReadback({ fields: renderFields });
    lastRenderSyncMs = now;
  }
  if (shouldRefreshPipeline) {
    pipelineEditor.refreshPreviews?.();
    lastPreviewRefreshFrame = runtime.frame;
  }
  geodesicPreview?.refresh?.({
    fields: state.fields,
    viewSpec,
    frame: runtime.frame,
    fieldRevision: state.__fieldRevision ?? 0,
    force,
    gpuRenderBuffer: gpuRenderResource,
    externalSurfaceActive: surfaceActive,
  });
  if (shouldRefreshMetrics) {
    metrics.updateStrip({ state });
    lastMetricsRefreshFrame = runtime.frame;
  }
  ui.stats.textContent = `frame ${runtime.frame} | ${paint.lastPaintLabel}`;
  if (shouldRefreshProbe) {
    probe.render();
    lastProbeRefreshFrame = runtime.frame;
  }
  recordPerfSpan("boot.updateAll", perfStart, { force });
}

function queueReadback(request) {
  if (request.full) {
    pendingReadback = { full: true, fields: null };
    return;
  }
  if (pendingReadback?.full) return;
  pendingReadback = { full: false, fields: request.fields ?? [] };
}

function gpuRenderableField(viewSpec) {
  if (viewSpec?.gpuColor?.kind !== "ramp") return null;
  const fields = viewSpec?.color?.fields;
  if (!Array.isArray(fields) || fields.length !== 1) return null;
  if (viewSpec?.glyph) return null;
  return fields[0] ?? null;
}

function gpuSurfaceField(viewSpec) {
  if (viewSpec?.gpuColor?.kind !== "ramp" && viewSpec?.gpuColor?.kind !== "wheel") return null;
  if (viewSpec.gpuColor.field) return viewSpec.gpuColor.field;
  const fields = viewSpec?.color?.fields;
  if (!Array.isArray(fields) || fields.length !== 1) return null;
  return fields[0] ?? null;
}

function ensureGpuSurfaceCompatibleView() {
  const current = recipes.viewById?.(ui.viewSelect.value);
  if (!gpuSurfaceActive || gpuSurfaceField(current)) return current;
  const fallback = recipes.activeViews?.().find((view) => gpuSurfaceField(view));
  if (!fallback) return current;
  ui.viewSelect.value = fallback.id;
  return fallback;
}

function copyGpuRenderResource(field) {
  const runner = getRunner();
  const info = runner?.copyFieldToRenderTexture?.(field);
  if (!info) return null;
  return {
    field,
    width: info.width,
    height: info.height,
    cellCount: info.cellCount,
    type: info.type,
    frame: runtime.frame,
    texture: info.texture,
  };
}

function flushReadbackAfterRender() {
  if (!pendingReadback || readbackInFlight) return;
  const runner = getRunner();
  if (!runner) return;
  const request = pendingReadback;
  pendingReadback = null;
  const promise = request.full
    ? runner.syncState?.(state)
    : runner.readFields?.(state, request.fields);
  if (!promise || typeof promise.finally !== "function") return;
  readbackInFlight = true;
  promise.finally(() => {
    readbackInFlight = false;
  });
}

function fieldsForView(viewSpec, { gpuRenderField = null, skipParticles = false } = {}) {
  const names = new Set();
  for (const name of viewSpec?.color?.fields ?? []) {
    if (name === gpuRenderField) continue;
    if (name) names.add(name);
  }
  const glyph = viewSpec?.glyph;
  if (glyph?.rotate) names.add(glyph.rotate);
  if (glyph?.size) names.add(glyph.size);
  const particles = skipParticles ? null : viewSpec?.particles;
  if (particles?.advect) names.add(particles.advect);
  return [...names];
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
  const sizeSource = document.querySelector(".viewport-frame") ?? inputCanvas ?? canvas;
  const width = sizeSource.clientWidth;
  const height = sizeSource.clientHeight;
  if (width === lastCanvasWidth && height === lastCanvasHeight) return;
  lastCanvasWidth = width;
  lastCanvasHeight = height;
  renderer?.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}

function runAnimationFrame(source = "raf") {
  animationScheduled = false;
  animationRafId = 0;
  if (animationFallbackTimer) {
    clearTimeout(animationFallbackTimer);
    animationFallbackTimer = null;
  }
  scheduleAnimationFrame();
  lastFrameSource = source;
  lastRafAt = performance.now();
  try {
    lastAnimatePhase = "resize";
    resize();
    lastAnimatePhase = "tick-frame";
    const { frameMs, dt } = tickFrame();
    recordDebugFrame(frameMs);
    if (idleRafQueryEnabled) {
      lastAnimatePhase = "idle";
      updatePerfHud();
      return;
    }
    if (!runtime.paused) {
      lastAnimatePhase = "step-sim";
      const stepStart = perfNow();
      stepSim(dt);
      recordPerfSpan("boot.stepSim", stepStart);
    }
    lastAnimatePhase = "preview-update";
    geodesicPreview?.update?.();
    lastAnimatePhase = "orbit";
    const cameraChanged = orbitControls.update();
    lastAnimatePhase = "surface-render";
    const surfaceRendered = renderGeodesicSurface({ cameraChanged });
    const viewSpec = recipes.viewById?.(ui.viewSelect.value);
    lastAnimatePhase = "overlay-choice";
    const renderOverlay = shouldRenderThreeOverlay({ surfaceRendered, viewSpec });
    setOverlayCanvasVisible(renderOverlay);
    if (renderOverlay && shouldPresentThreeOverlay({ cameraChanged, viewSpec })) {
      lastAnimatePhase = "three-render";
      const renderStart = perfNow();
      renderer?.render(scene, camera);
      lastOverlayRenderMs = performance.now();
      recordPerfSpan("boot.render", renderStart);
    }
    lastAnimatePhase = "readback";
    flushReadbackAfterRender();
    lastAnimatePhase = "metrics";
    metrics.updateFpsMetric(frameMs, { paused: runtime.paused });
    updatePerfHud();
    lastAnimatePhase = "done";
    lastAnimateError = null;
  } catch (error) {
    lastAnimateError = {
      phase: lastAnimatePhase,
      message: error?.message ?? String(error),
      stack: error?.stack ?? "",
    };
    traceDebug("animate-error", lastAnimateError);
    console.error("animation frame failed:", error);
  }
}

function renderGeodesicSurface({ cameraChanged = true } = {}) {
  if (!gpuSurfaceActive || !geodesicSurfaceRenderer) return false;
  const perfStart = perfNow();
  const viewSpec = ensureGpuSurfaceCompatibleView();
  const fieldName = gpuSurfaceField(viewSpec);
  const runner = getRunner();
  const field = fieldName ? runner?.renderField?.(fieldName) : null;
  if (!fieldName) lastSurfaceSkipReason = "no-surface-field";
  else if (!runner) lastSurfaceSkipReason = "no-runner";
  else if (!field) lastSurfaceSkipReason = "field-not-ready";
  else lastSurfaceSkipReason = "";
  if (lastSurfaceSkipReason) traceDebug("surface-skip", { reason: lastSurfaceSkipReason, fieldName });
  if (canReuseSurfaceFrame({ viewSpec, fieldName, cameraChanged })) {
    geodesicSurfaceRenderer.setVisible(true);
    debugFrameStats.surfaceReuses++;
    return true;
  }
  if (canThrottleSurfacePresent({ viewSpec, fieldName, cameraChanged })) {
    geodesicSurfaceRenderer.setVisible(true);
    debugFrameStats.surfaceReuses++;
    return true;
  }
  let rendered = false;
  try {
    rendered = geodesicSurfaceRenderer.render({
      grid: state.grid?.topology,
      field,
      viewSpec,
      camera,
    });
  } catch (error) {
    console.warn("GPU surface renderer disabled:", error);
    geodesicSurfaceRenderer?.setVisible?.(false);
    geodesicSurfaceRenderer = null;
    gpuSurfaceActive = false;
    document.body.classList.toggle("gpu-surface-mode", false);
    return false;
  }
  if (!rendered) geodesicSurfaceRenderer.setVisible(false);
  if (rendered) rememberSurfaceFrame({ viewSpec, fieldName });
  if (rendered) debugFrameStats.surfaceRenders++;
  recordPerfSpan("surface.render", perfStart, { view: viewSpec?.id ?? "" });
  return rendered;
}

function canReuseSurfaceFrame({ viewSpec, fieldName, cameraChanged }) {
  return !surfaceContinuousQueryEnabled
    && !cameraChanged
    && geodesicSurfaceRenderer.hasFrame?.()
    && lastSurfaceRender.frame === runtime.frame
    && lastSurfaceRender.viewId === (viewSpec?.id ?? "")
    && lastSurfaceRender.fieldName === (fieldName ?? "")
    && lastSurfaceRender.width === lastCanvasWidth
    && lastSurfaceRender.height === lastCanvasHeight
    && lastSurfaceRender.aspect === camera.aspect;
}

function canThrottleSurfacePresent({ viewSpec, fieldName, cameraChanged }) {
  if (surfaceContinuousQueryEnabled || surfaceFrameIntervalMs <= 0 || cameraChanged) return false;
  if (!geodesicSurfaceRenderer.hasFrame?.()) return false;
  if (lastSurfaceRender.viewId !== (viewSpec?.id ?? "")) return false;
  if (lastSurfaceRender.fieldName !== (fieldName ?? "")) return false;
  if (lastSurfaceRender.width !== lastCanvasWidth || lastSurfaceRender.height !== lastCanvasHeight) return false;
  if (lastSurfaceRender.aspect !== camera.aspect) return false;
  return performance.now() - lastSurfaceRender.presentMs < surfaceFrameIntervalMs;
}

function rememberSurfaceFrame({ viewSpec, fieldName }) {
  lastSurfaceRender.frame = runtime.frame;
  lastSurfaceRender.viewId = viewSpec?.id ?? "";
  lastSurfaceRender.fieldName = fieldName ?? "";
  lastSurfaceRender.width = lastCanvasWidth;
  lastSurfaceRender.height = lastCanvasHeight;
  lastSurfaceRender.aspect = camera.aspect;
  lastSurfaceRender.presentMs = performance.now();
}

function invalidateSurfaceFrame() {
  lastSurfaceRender.frame = -Infinity;
}

function recordDebugFrame(frameMs) {
  debugFrameStats.samples.push(frameMs);
  if (debugFrameStats.samples.length > 240) debugFrameStats.samples.shift();
  debugFrameStats.lastFrameMs = frameMs;
  debugFrameStats.minFrameMs = Math.min(debugFrameStats.minFrameMs, frameMs);
  debugFrameStats.maxFrameMs = Math.max(debugFrameStats.maxFrameMs, frameMs);
  let total = 0;
  for (const sample of debugFrameStats.samples) total += sample;
  const mean = total / Math.max(1, debugFrameStats.samples.length);
  debugFrameStats.lastFps = mean > 0 ? 1000 / mean : 0;
  let recentTotal = 0;
  const recent = debugFrameStats.samples.slice(-30);
  for (const sample of recent) recentTotal += sample;
  const recentMean = recentTotal / Math.max(1, recent.length);
  debugFrameStats.recentFps = recentMean > 0 ? 1000 / recentMean : 0;
}

function updatePerfHud() {
  if (!perfHudEl) return;
  perfHudEl.textContent = [
    `RAF ${debugFrameStats.recentFps.toFixed(1)}`,
    `focus ${document.hasFocus() ? "yes" : "no"}`,
    `vis ${document.visibilityState}`,
    `sim ${debugFrameStats.simSteps}`,
    `surf ${debugFrameStats.surfaceRenders}/${debugFrameStats.surfaceReuses}`,
  ].join("  ");
}

function shouldRenderThreeOverlay({ surfaceRendered, viewSpec }) {
  if (gpuSurfaceActive) {
    return Boolean(viewSpec?.glyph);
  }
  if (!surfaceRendered) return true;
  // In surface mode the colored planet is already drawn by the custom WebGPU
  // pass. CPU particles are intentionally disabled in this mode until they
  // move to a GPU-native path.
  return Boolean(viewSpec?.glyph);
}

function shouldPresentThreeOverlay({ cameraChanged = false, viewSpec = null } = {}) {
  if (!gpuSurfaceActive) return true;
  if (cameraChanged) return true;
  if (viewSpec?.glyph && !viewSpec?.particles) return true;
  if (!viewSpec?.particles) return true;
  return performance.now() - lastOverlayRenderMs >= 1000 / 30;
}

function setOverlayCanvasVisible(next) {
  if (overlayCanvasVisible === next) return;
  overlayCanvasVisible = next;
  if (gpuSurfaceActive) {
    canvas.style.display = next ? "block" : "none";
  } else {
    canvas.style.visibility = next ? "visible" : "hidden";
  }
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
    const preview = await createGeodesicPreview({ scene, globe, renderer, camera, grid: grid.topology });
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
  traceDebug("boot-start", { gpuSurface: gpuSurfaceQueryEnabled });
  let nextGpuSurfaceActive = false;
  ({
    canvas,
    inputCanvas,
    surfaceCanvas,
    device,
    renderer,
    scene,
    camera,
    orbitControls,
    globe,
    gpuSurfaceActive: nextGpuSurfaceActive,
  } = await createThreeSetup({
    gpuSurface: gpuSurfaceQueryEnabled,
    skipGpuDevice: skipGpuDeviceQueryEnabled,
  }));
  traceDebug("three-setup", {
    requestedSurface: gpuSurfaceQueryEnabled,
    activeSurface: nextGpuSurfaceActive,
    hasSurfaceCanvas: Boolean(surfaceCanvas),
    hasRenderer: Boolean(renderer),
    hasDevice: Boolean(device),
  });
  gpuSurfaceActive = Boolean(nextGpuSurfaceActive && surfaceCanvas && device);
  document.body.classList.toggle("gpu-surface-mode", gpuSurfaceActive);
  if (gpuSurfaceActive && surfaceCanvas) {
    try {
      geodesicSurfaceRenderer = createGeodesicSurfaceRenderer({
        device,
        canvas: surfaceCanvas,
        maxPixelRatio: surfacePixelRatioCap(),
      });
      gpuSurfaceActive = Boolean(geodesicSurfaceRenderer);
    } catch (error) {
      console.warn("GPU surface renderer disabled:", error);
      geodesicSurfaceRenderer = null;
      gpuSurfaceActive = false;
    }
    document.body.classList.toggle("gpu-surface-mode", gpuSurfaceActive);
    if (gpuSurfaceActive) {
      geodesicSurfaceRenderer?.setVisible?.(false);
      setOverlayCanvasVisible(true);
    }
  }
  installDebugSnapshot();
  installDebugTraps();
  if (bootStage === "three") {
    initPerfHud();
    initRuntime();
    if (startPausedQueryEnabled) runtime.paused = true;
    animate();
    return;
  }

  initControls(ui);
  initPaint({
    canvas: inputCanvas ?? canvas, camera, globe, ui, state, controls,
    onBeforePaint: () => getRunner()?.syncState?.(state),
    onAfterPaint: () => {
      const runner = getRunner();
      runner?.markStateDirty?.();
      runner?.flushStateUpload?.(state);
      invalidateSurfaceFrame();
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
  if (bootStage === "paint") {
    initPerfHud();
    initRuntime();
    if (startPausedQueryEnabled) {
      runtime.paused = true;
      ui.pauseButton.textContent = "Resume";
    }
    animate();
    return;
  }

  // Build authoring windows + mount editors before recipes.mjs's
  // bootstrap fires — recipes.mjs's `applyRecipe()` calls
  // `pipelineEditor.loadRecipe(...)` and the editors need to be ready.
  const windows = buildWindows();
  initEditors({
    pipelineWindow: windows.pipelineWindow,
    getState: () => state,
    getPreviewView: previewView,
  });
  if (bootStage === "editors") {
    initPerfHud();
    initRuntime();
    if (startPausedQueryEnabled) {
      runtime.paused = true;
      ui.pauseButton.textContent = "Resume";
    }
    animate();
    return;
  }
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
    device,
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
  initPerfHud();
  initRuntime();
  if (startPausedQueryEnabled) {
    runtime.paused = true;
    ui.pauseButton.textContent = "Resume";
  }
  syncGeodesicPreview();
  traceDebug("animate-start");
  scheduleAnimationFrame();
}

function initPerfHud() {
  if (!perfHudQueryEnabled) return;
  perfHudEl = document.createElement("div");
  perfHudEl.className = "perf-hud";
  perfHudEl.textContent = "RAF ...";
  document.body.appendChild(perfHudEl);
}

function surfacePixelRatioCap() {
  const raw = new URLSearchParams(window.location.search).get("surfaceDpr");
  const parsed = raw == null ? 1 : Number(raw);
  return Number.isFinite(parsed) ? parsed : 1;
}

function surfacePresentIntervalMs() {
  const raw = new URLSearchParams(window.location.search).get("surfaceFps");
  if (raw == null) return 0;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return 1000 / Math.min(240, parsed);
}

function simRateQueryOverride() {
  const raw = new URLSearchParams(window.location.search).get("simFps");
  if (raw == null) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : null;
}

function installDebugSnapshot() {
  globalThis.__FIELD_LAB_DEBUG__ = () => {
    const debugViewSpec = recipes.viewById?.(ui.viewSelect?.value);
    const debugSurfaceField = gpuSurfaceField(debugViewSpec);
    const debugRunner = getRunner();
    const debugRenderField = debugSurfaceField ? debugRunner?.renderField?.(debugSurfaceField) : null;
    return ({
    recipe: recipes.activeId,
    view: ui.viewSelect?.value ?? null,
    frame: runtime.frame,
    fpsText: document.querySelector('[data-metric-id="fps"] .metric-cell__num')?.textContent ?? null,
    rafFps: Number(debugFrameStats.lastFps.toFixed(1)),
    recentRafFps: Number(debugFrameStats.recentFps.toFixed(1)),
    frameSamples: debugFrameStats.samples.length,
    lastFrameMs: Number(debugFrameStats.lastFrameMs.toFixed(2)),
    minFrameMs: Number(debugFrameStats.minFrameMs.toFixed(2)),
    maxFrameMs: Number(debugFrameStats.maxFrameMs.toFixed(2)),
    visibilityState: document.visibilityState,
    focused: document.hasFocus(),
    reducedMotion: globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? null,
    surfaceRenders: debugFrameStats.surfaceRenders,
    surfaceReuses: debugFrameStats.surfaceReuses,
    simSteps: debugFrameStats.simSteps,
    simFramesWithSteps: debugFrameStats.simFramesWithSteps,
    simStepCalls: debugFrameStats.simStepCalls,
    simRateOverride,
    lastAnimatePhase,
    lastAnimateError,
    lastSurfaceSkipReason,
    lastFrameSource,
    lastRafAgeMs: lastRafAt ? Number((performance.now() - lastRafAt).toFixed(1)) : null,
    watchdogTicks,
    gpuErrors: globalThis.__FIELD_LAB_GPU_ERRORS__ ?? [],
    debugTrace: [...debugTrace],
    gpuSurface: gpuSurfaceQueryEnabled,
    gpuSurfaceActive,
    surfaceField: debugSurfaceField,
    surfaceFieldType: debugRenderField?.type ?? null,
    idleRaf: idleRafQueryEnabled,
    bootStage: bootStage || "full",
    skipGpuDevice: skipGpuDeviceQueryEnabled,
    surfaceContinuous: surfaceContinuousQueryEnabled,
    surfaceFpsCap: surfaceFrameIntervalMs > 0 ? Number((1000 / surfaceFrameIntervalMs).toFixed(1)) : null,
    surfaceDprCap: surfacePixelRatioCap(),
    devicePixelRatio: globalThis.devicePixelRatio,
    overlayCanvasVisible,
    readbackInFlight,
    pendingReadback: pendingReadback
      ? { full: pendingReadback.full, fields: pendingReadback.fields?.length ?? null }
      : null,
    viewport: elementDebug(canvas),
    surface: elementDebug(surfaceCanvas),
    lastSurfaceRender: { ...lastSurfaceRender },
    bodyClasses: document.body.className,
    });
  };
}

function elementDebug(el) {
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  const style = getComputedStyle(el);
  return {
    client: [el.clientWidth, el.clientHeight],
    buffer: [el.width ?? null, el.height ?? null],
    rect: [Math.round(rect.width), Math.round(rect.height)],
    display: style.display,
    visibility: style.visibility,
    position: style.position,
  };
}
