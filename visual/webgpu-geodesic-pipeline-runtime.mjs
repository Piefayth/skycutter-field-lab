import { createGeodesicGrid } from "../kernel/geodesic-grid.mjs";
import {
  buildWebGpuGeodesicUniforms,
  compileWebGpuGeodesicPipeline,
} from "../dsl/webgpu-geodesic-compiler.mjs";
import { clamp, hashNoise, smoothstep, spatialNoise } from "../kernel/kernel.mjs";
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
  if (expr === undefined || expr === null || expr === "") throw new Error("missing primitive uniform expression");
  if (typeof expr === "number") return expr;
  switch (expr.type) {
    case "Number":
      return Number(expr.value);
    case "Identifier":
      return evalUniformIdentifier(expr.name, env);
    case "Member": {
      const object = evalUniformExpr(expr.object, env);
      if (object == null || !Object.hasOwn(object, expr.prop)) {
        throw new Error(`unknown primitive uniform property ${expr.prop}`);
      }
      return object[expr.prop];
    }
    case "Unary": {
      const value = evalUniformExpr(expr.expr, env);
      if (expr.op === "-") return -value;
      if (expr.op === "+") return +value;
      if (expr.op === "!") return !value;
      throw new Error(`unknown primitive uniform unary op ${expr.op}`);
    }
    case "Binary":
      return evalUniformBinary(expr.op, evalUniformExpr(expr.left, env), evalUniformExpr(expr.right, env));
    case "Conditional":
      return evalUniformExpr(expr.test, env)
        ? evalUniformExpr(expr.consequent, env)
        : evalUniformExpr(expr.alternate, env);
    case "Call":
      return evalUniformCall(expr, env);
    default:
      throw new Error(`unknown primitive uniform expression node ${expr.type}`);
  }
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

function evalUniformBinary(op, left, right) {
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
    default: throw new Error(`unknown primitive uniform binary op ${op}`);
  }
}

function evalUniformCall(ast, env) {
  const name = ast.callee.type === "Identifier" ? ast.callee.name : null;
  const args = ast.args.map((arg) => evalUniformExpr(arg, env));
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
