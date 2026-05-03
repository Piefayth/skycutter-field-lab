import { createGeodesicGrid } from "../kernel/geodesic-grid.mjs";
import {
  buildWebGpuGeodesicUniforms,
  compileWebGpuGeodesicPipeline,
  compileWebGpuMetric,
} from "../dsl/webgpu-geodesic-compiler.mjs";
import { createWebGpuGeodesicRuntime } from "./webgpu-geodesic-runtime.mjs";
import { MetricRuntime } from "./webgpu-metric-runtime.mjs";

// =============================================================================
// Recipe-shaped WebGPU geodesic runner.
//
// V2 stages are exclusively `cell { ... }` bodies — every kernel
// operation (diffusion, advection, gradient/divergence, neighbor
// reductions, history reads) is expressed as a per-cell expression and
// compiled by the cell-shader emitter. This file is a thin orchestrator:
// allocate the runtime, dispatch each compiled cell pass per tick, run
// metric reductions, rotate history buffers.
// =============================================================================

export async function createWebGpuGeodesicPipeline({ pipeline, grid: providedGrid = null, getParams, getFrame } = {}) {
  if (!pipeline?.dsl) throw new Error("WebGPU geodesic pipeline requires DSL metadata");
  const dsl = pipeline.dsl;
  if (dsl.grid?.kind !== "geodesic") {
    throw new Error(`WebGPU geodesic pipeline requires grid geodesic, got ${dsl.grid?.kind ?? "unknown"}`);
  }
  const grid = providedGrid ?? createGeodesicGrid({ frequency: dsl.grid.frequency ?? 48 });
  const fieldNames = recipeFieldNames(dsl);
  // V2 typed fields: pass each declared field's type through to the
  // runtime so storage buffers use the correct stride (f32 = 4
  // bytes/cell, vec2 = 8). Unlisted fields default to f32 inside the
  // runtime — covers `declared` fields that don't carry an explicit
  // type annotation.
  const fieldTypes = Object.fromEntries(
    (dsl.fields ?? [])
      .filter((decl) => decl?.name && decl.type)
      .map((decl) => [decl.name, decl.type]),
  );
  const runtime = await createWebGpuGeodesicRuntime({ grid, fieldNames, fieldTypes });
  const { stages } = compileWebGpuGeodesicPipeline(dsl);
  const consts = Object.fromEntries((dsl.constants ?? []).map((decl) => [decl.name, decl.value]));
  const planet = dsl.planet ?? {};
  // Upgrade every history-declared field to 3-buffer rotation. The
  // cell pass that writes the field deposits the new value into the
  // `next` slot; rotateHistory at end-of-tick promotes next→current
  // and demotes the old current→prev (visible to next tick's
  // prev(field) reads).
  const historyFieldNames = (dsl.fields ?? [])
    .filter((decl) => (decl?.history ?? 0) > 0)
    .map((decl) => decl.name);
  const historyFieldSet = new Set(historyFieldNames);
  for (const name of historyFieldNames) runtime.ensureHistory(name);

  // Compile every v2 `metric x = ...` into a per-cell pass + reduce
  // pipelines. Allocates scratch / readback buffers and pre-builds the
  // pipelines so per-tick dispatch is just bind-group + dispatch calls.
  const compiledMetrics = (dsl.metrics ?? []).map((m) => compileWebGpuMetric(m, dsl));
  const metricRuntime = compiledMetrics.length > 0
    ? new MetricRuntime({ runtime, metrics: compiledMetrics })
    : null;

  return {
    grid,
    runtime,
    metricRuntime,
    fieldNames,
    stages,
    metrics: compiledMetrics,
    uploadState(state, names = fieldNames) {
      runtime.uploadState(state, names);
    },
    // Initialize the prev slot of every history field from its current
    // value. Called by the recipe layer after preset apply so the
    // first tick's prev() reads the freshly-initialized state rather
    // than uninitialized GPU memory. Stamps DON'T walk this path —
    // their asymmetry between current and prev IS the velocity-impulse
    // mechanism (post-stamp prev = pre-stamp current; the difference
    // becomes the wave's launch velocity).
    initHistory() {
      if (historyFieldNames.length) runtime.initHistory(historyFieldNames);
    },
    async readState(state, names = fieldNames) {
      await runtime.readState(state, names);
    },
    runTick(dt) {
      const params = getParams?.() ?? {};
      const frame = getFrame?.() ?? 0;
      for (const stage of stages) {
        // V2 stages always emit only `cell`-kind passes (the parser
        // rejects every legacy v1 primitive form). Multi-pass stages
        // delay the field swap to the end of the stage so each pass
        // sees the same input snapshot.
        const delayedCellSwaps = stage.passes.length > 1;
        const fieldsToSwap = [];
        for (const pass of stage.passes) {
          // History-field writes never swap. The cell pass deposits
          // u_{N+1} into `next`; the end-of-tick rotateHistory call
          // promotes it to current. Swapping mid-tick would scramble
          // the {prev, current, next} invariant the rotation depends
          // on. The validator restricts history fields to a single
          // cell-pass writer, so this branch is the only place a
          // history field's `next` is written within a tick.
          const isHistoryWrite = historyFieldSet.has(pass.field);
          const swapAfter = isHistoryWrite ? false : !delayedCellSwaps;
          runtime.runCellPass({
            key: pass.key,
            source: pass.source,
            field: pass.field,
            reads: pass.reads,
            prevReads: pass.prevReads ?? [],
            needsNeighbors: pass.needsNeighbors,
            kernelSpecs: pass.kernelSpecs ?? [],
            params,
            swapAfter,
            uniforms: buildWebGpuGeodesicUniforms(pass.layout, {
              dt,
              frame,
              cellCount: grid.cellCount,
              params,
              consts,
              planet,
            }),
          });
          if (delayedCellSwaps && !isHistoryWrite) fieldsToSwap.push(pass.field);
        }
        if (delayedCellSwaps) runtime.swapFields([...new Set(fieldsToSwap)]);
      }
      // End-of-tick rotation for history fields. The cell pass that
      // wrote u this tick produced u_{N+1} in `next`; promote it to
      // current and demote the previous current to prev (so next
      // tick's prev(u) reads u_N, completing the leapfrog cycle).
      if (historyFieldNames.length) runtime.rotateHistory(historyFieldNames);
      // V2 metrics: dispatch per-cell + cascading reduce passes for
      // every declared metric. Reads use post-rotation currentBuffer
      // (the just-written value) for each field. Async readback
      // populates the metric runtime's value cache; consumers see the
      // latest completed readback via readDslMetrics() below.
      if (metricRuntime) metricRuntime.dispatch(null, params);
    },
    // Returns the most recent post-readback values for every metric
    // declared in the recipe. Values may be null until the first
    // readback completes — the metrics panel renders nulls as "—".
    readDslMetrics() {
      if (!metricRuntime) return {};
      return metricRuntime.values_snapshot();
    },
    dispose() {
      metricRuntime?.dispose();
      runtime.dispose();
    },
  };
}

function recipeFieldNames(dsl) {
  const fields = (dsl.fields ?? []).map((decl) => (typeof decl === "string" ? decl : decl?.name)).filter(Boolean);
  const declared = (dsl.declared ?? []).map((decl) => (typeof decl === "string" ? decl : decl?.name)).filter(Boolean);
  return [...new Set([...fields, ...declared])];
}
