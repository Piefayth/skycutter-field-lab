import { createGeodesicGrid } from "../kernel/geodesic-grid.mjs";
import {
  buildWebGpuGeodesicUniforms,
  compileWebGpuGeodesicPipeline,
} from "../dsl/webgpu-geodesic-compiler.mjs";
import { createWebGpuGeodesicRuntime } from "./webgpu-geodesic-runtime.mjs";

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
  const runtime = await createWebGpuGeodesicRuntime({ grid, fieldNames });
  const { stages, eventCounters } = compileWebGpuGeodesicPipeline(dsl);
  const consts = Object.fromEntries((dsl.constants ?? []).map((decl) => [decl.name, decl.value]));
  const planet = dsl.planet ?? {};

  return {
    grid,
    runtime,
    fieldNames,
    stages,
    eventCounters,
    uploadState(state, names = fieldNames) {
      runtime.uploadState(state, names);
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
            runtime.runCellPass({
              key: pass.key,
              source: pass.source,
              field: pass.field,
              reads: pass.reads,
              needsNeighbors: pass.needsNeighbors,
              eventCounter: pass.eventCounter,
              swapAfter: !delayedCellSwaps,
              uniforms: buildWebGpuGeodesicUniforms(pass.layout, {
                dt,
                frame,
                cellCount: grid.cellCount,
                params,
                consts,
                planet,
              }),
            });
            if (delayedCellSwaps) fieldsToSwap.push(pass.field);
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
              dt: evalUniformExpr(pass.dt, { params, consts, planet, dt, frame }),
            });
          } else if (pass.kind === "normalize") {
            const enabled = Boolean(evalUniformExpr(pass.condition, { params, consts, planet, dt, frame }));
            if (enabled) throw new Error(`${stage.id}: WebGPU geodesic normalize requires a reduction pass`);
          }
        }
        if (delayedCellSwaps) runtime.swapFields([...new Set(fieldsToSwap)]);
      }
    },
    dispose() {
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
  if (expr === undefined || expr === null || expr === "") return 0;
  if (typeof expr === "number") return expr;
  const source = String(expr).replace(/\band\b/g, "&&").replace(/\bor\b/g, "||").replace(/\bnot\b/g, "!");
  // Bare-name DSL: params / consts / planet are all in one global scope.
  // Flatten them into individual Function args so an expression like
  // `windStrength * 0.18 * dt` can resolve `windStrength` as a free
  // identifier. Recipe-level uniqueness (validateNameUniqueness in the
  // compiler) guarantees no key collisions across the namespaces.
  const params = env.params ?? {};
  const consts = env.consts ?? {};
  const planet = env.planet ?? {};
  const names = ["dt", "frame", ...Object.keys(params), ...Object.keys(consts), ...Object.keys(planet)];
  const values = [env.dt ?? 0, env.frame ?? 0, ...Object.values(params), ...Object.values(consts), ...Object.values(planet)];
  // Internal DSL expression evaluation for primitive uniforms. These
  // strings are compiler-validated DSL, not arbitrary user JS editors.
  // eslint-disable-next-line no-new-func
  return Function(...names, `"use strict"; return (${source});`)(...values);
}
