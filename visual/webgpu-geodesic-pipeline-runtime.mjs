import { createGeodesicGrid } from "../kernel/geodesic-grid.mjs";
import {
  buildWebGpuGeodesicUniforms,
  compileWebGpuGeodesicPipeline,
  compileWebGpuMetric,
} from "../dsl/webgpu-geodesic-compiler.mjs";
import { evalExpression } from "../dsl/expression-runtime.mjs";
import { clamp, hashNoise, smoothstep, spatialNoise } from "../kernel/kernel.mjs";
import { createWebGpuGeodesicRuntime } from "./webgpu-geodesic-runtime.mjs";
import { MetricRuntime } from "./webgpu-metric-runtime.mjs";

// =============================================================================
// Recipe-shaped WebGPU geodesic runner.
//
// This is the bridge from "individual kernels work" to "a DSL pipeline can run
// on a spherical cell graph." It intentionally supports a narrow subset first:
//   - cell { ... }, each { ... }, and local event stages compiled to WGSL storage-buffer compute
//   - diffuse primitives over geodesic neighbors
//   - clamp primitives
//   - wind pressure -> windU, windV, lift over local sphere tangent frames
//   - nearest-neighbor semi-Lagrangian advect over the geodesic graph
//
// Reductions, non-local each/sample stages, and stamping need geodesic-specific
// semantics before they should run here.
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
  const { stages, eventCounters } = compileWebGpuGeodesicPipeline(dsl);
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
    eventCounters,
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
    async readEventCounts(state) {
      if (!state?.events || eventCounters.length === 0) return;
      const byLabel = await runtime.readEventCounters(eventCounters);
      state.events.byLabel = Object.create(null);
      let total = 0;
      for (const [label, count] of Object.entries(byLabel)) {
        state.events.byLabel[label] = count;
        total += count;
      }
      state.events.totalThisTick = total;
    },
    runTick(dt) {
      const params = getParams?.() ?? {};
      const frame = getFrame?.() ?? 0;
      for (const stage of stages) {
        const delayedCellSwaps = stage.passes.length > 1 && stage.passes.every((pass) => pass.kind === "cell");
        const fieldsToSwap = [];
        for (const pass of stage.passes) {
          if (pass.kind === "cell") {
            if (pass.eventCounter) runtime.resetEventCounter(pass.eventCounter.key);
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
              eventCounter: pass.eventCounter,
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
          } else if (pass.kind === "diffuse") {
            runtime.runDiffuse({ field: pass.field, amount: evalUniformExpr(pass.amount, { params, consts, planet, dt, frame }) });
          } else if (pass.kind === "clamp") {
            runtime.runClamp({
              field: pass.field,
              lo: evalUniformExpr(pass.lo, { params, consts, planet, dt, frame }),
              hi: evalUniformExpr(pass.hi, { params, consts, planet, dt, frame }),
            });
          } else if (pass.kind === "wind") {
            runtime.runWind({
              pressure: pass.pressure,
              windU: pass.windU,
              windV: pass.windV,
              lift: pass.lift,
              strength: evalUniformExpr(pass.strength, { params, consts, planet, dt, frame }),
            });
          } else if (pass.kind === "advect") {
            runtime.runAdvect({
              field: pass.field,
              windU: pass.windU,
              windV: pass.windV,
              wind: pass.wind,    // vec2 field path
              dt: evalUniformExpr(pass.dt, { params, consts, planet, dt, frame }),
            });
          } else if (pass.kind === "normalize") {
            const enabled = Boolean(evalUniformExpr(pass.condition, { params, consts, planet, dt, frame }));
            if (enabled) throw new Error(`${stage.id}: WebGPU geodesic normalize requires a reduction pass`);
          }
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
      if (metricRuntime) metricRuntime.dispatch();
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

function evalUniformExpr(expr, env) {
  return evalExpression(expr, {
    resolveIdentifier: (name) => evalUniformIdentifier(name, env),
    callFunction: (name, args) => evalUniformCall(name, args),
  });
}

function evalUniformIdentifier(name, env) {
  if (name === "true") return true;
  if (name === "false") return false;
  if (name === "null") return null;
  if (name === "undefined") return undefined;
  if (name === "dt") return env.dt ?? 0;
  if (name === "frame") return env.frame ?? 0;
  if (name === "PI") return Math.PI;
  if (name === "TAU") return Math.PI * 2;
  if (Object.hasOwn(env.params ?? {}, name)) return env.params[name];
  if (Object.hasOwn(env.consts ?? {}, name)) return env.consts[name];
  if (Object.hasOwn(env.planet ?? {}, name)) return env.planet[name];
  throw new Error(`unknown primitive uniform identifier ${name}`);
}

function evalUniformCall(name, args) {
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
  if (name === "cellNoise") {
    // Uniform-context call (no per-cell position); fall back to a
    // deterministic per-seed scalar via the lattice at origin so the
    // value is stable across frames.
    return spatialNoise(0, 0, 0, args[0] ?? 0);
  }
  if (name === "wrapAngle") return Math.atan2(Math.sin(args[0]), Math.cos(args[0]));
  throw new Error(`unknown primitive uniform function ${name ?? "call"}`);
}
