// =============================================================================
// WGSL execution harness — runs the v2 compile pipeline's WGSL output
// on a real GPU via dawn-node and lets tests assert numeric outputs.
//
// Setup (one-time):
//   npm install
//   # webgpu (dawn-node) downloads a ~30MB native binary for your
//   # platform (macOS arm64/intel, Linux, Windows). No display server,
//   # no canvas — pure compute + buffer readback.
//
// Usage (in tests):
//   import { makeHarness, harnessAvailable } from "./wgsl-harness.mjs";
//
//   if (!await harnessAvailable()) {
//     // Fresh-clone path: tests skip cleanly until `npm install` runs.
//     return;
//   }
//
//   const harness = await makeHarness({ recipeDsl, frequency: 16 });
//   try {
//     harness.uploadField("u", new Float32Array(...));
//     harness.runStage(0);
//     const out = await harness.readField("u");
//     assert.ok(closeTo(out[0], 0.5, 1e-5));
//   } finally {
//     harness.dispose();
//   }
//
// Cleanup matters — dawn-node's adapter holds the process open until
// every device + buffer is released and `globalThis.navigator` is
// removed. dispose() handles all of that; tests should always call it
// in a `finally` (or via `t.after`).
// =============================================================================

import { compileV2 } from "../dsl/compile-v2.mjs";
import { compileWebGpuGeodesicPipeline, buildWebGpuGeodesicUniforms } from "../dsl/webgpu-geodesic-compiler.mjs";
import { createGeodesicGrid } from "../kernel/geodesic-grid.mjs";
import { WebGpuGeodesicRuntime } from "../visual/webgpu-geodesic-runtime.mjs";

let cachedModule = null;
let cachedGpu = null;
let cachedAvailability = null;

// True if `webgpu` (dawn-node) imports cleanly AND a GPU adapter is
// reachable. Cached because each invocation runs through the slow
// dawn-node binding-load path; we only want to do that once per
// process. Returns false (not throws) when unavailable so tests can
// `if (!await harnessAvailable()) return;` cleanly.
//
// The production runtime's helper `createWebGpuGeodesicRuntime` looks
// up `globalThis.navigator.gpu`, but Node 21+ makes `globalThis.navigator`
// a getter-only property (it can't be reassigned), so we bypass the
// helper and instantiate `WebGpuGeodesicRuntime` directly with a device
// requested from a stand-alone GPU instance via `create([])`.
export async function harnessAvailable() {
  if (cachedAvailability !== null) return cachedAvailability;
  try {
    cachedModule = await import("webgpu");
  } catch (_) {
    cachedAvailability = false;
    return false;
  }
  try {
    // The dawn-node `globals` export carries the GPU* type constructors
    // (GPUBufferUsage, GPUMapMode, etc.) the WGSL runtime references at
    // bind-group/buffer-creation time. Assigning them onto globalThis
    // doesn't touch `navigator` (which Node owns) — those names just
    // didn't exist before.
    Object.assign(globalThis, cachedModule.globals);
    cachedGpu = cachedModule.create([]);
    const adapter = await cachedGpu.requestAdapter();
    cachedAvailability = adapter !== null;
    return cachedAvailability;
  } catch (_) {
    cachedAvailability = false;
    return false;
  }
}

// Build a runnable harness around a recipe. The recipe is compiled
// twice — once via compileV2 (parse + validate + typecheck) and once
// via compileWebGpuGeodesicPipeline (WGSL emission). Field types
// flow from the parsed DSL into the runtime's storage allocator so
// the buffers match the WGSL bindings exactly.
//
// Pass either { recipeDsl } (raw v2 DSL string) or { dsl } (already
// compiled via compileV2).
export async function makeHarness({ recipeDsl, dsl, frequency = 16 } = {}) {
  if (!recipeDsl && !dsl) throw new Error("makeHarness: pass `recipeDsl` (string) or `dsl` (compiled)");
  if (!await harnessAvailable()) {
    throw new Error("makeHarness: dawn-node unavailable. Run `npm install` first.");
  }
  const compiled = dsl ?? compileV2(recipeDsl).dsl;
  const stagesPipeline = compileWebGpuGeodesicPipeline(compiled);

  const fieldDecls = compiled.fields ?? [];
  const fieldNames = fieldDecls.map((f) => f.name);
  const fieldTypes = Object.fromEntries(fieldDecls.map((f) => [f.name, f.type ?? "f32"]));
  const grid = createGeodesicGrid({ frequency });

  const adapter = await cachedGpu.requestAdapter();
  const device = await adapter.requestDevice();
  const runtime = new WebGpuGeodesicRuntime({ device, grid, fieldNames, fieldTypes });

  // Upgrade history fields to 3-buffer rotation. The compile pipeline
  // marks any field used with `@prev` as `history: 1`; the runtime
  // needs ensureHistory() called explicitly so its currentBuffer /
  // historyBuffer accessors don't throw "field X was not allocated
  // with history". Mirrors what the production pipeline runtime does
  // at recipe load.
  for (const decl of fieldDecls) {
    if ((decl.history ?? 0) > 0) runtime.ensureHistory(decl.name);
  }

  // Each pass in `stagesPipeline.stages[i].passes` corresponds to one
  // (stage, output-field) pair the WGSL compiler emits separately.
  // The harness exposes them flat so tests can address them by index.
  const passes = stagesPipeline.stages.flatMap((stage) =>
    stage.passes.map((pass) => ({ stageId: stage.id, ...pass })),
  );

  // History fields rotate at end-of-tick rather than swap per-pass.
  // tick() needs to know which fields are history-flavoured so it
  // can pass swapAfter=false on those passes and call rotateHistory
  // afterward. Mirrors webgpu-geodesic-pipeline-runtime.mjs.
  const historyFieldNames = fieldDecls.filter(d => (d.history ?? 0) > 0).map(d => d.name);
  const historyFieldSet = new Set(historyFieldNames);

  return {
    runtime,
    grid,
    cellCount: grid.cellCount,
    fieldTypes,
    layout: passes[0]?.layout,
    passes,
    compiled,

    // Upload an initial field state. `values` is a Float32Array (for
    // f32 / vec2 fields) or Uint32Array (for u32 / bool). The buffer
    // length must match `cellCount × components` (1 for scalar, 2 for
    // vec2). Vec2 is interleaved [x0, y0, x1, y1, ...] matching the
    // WGSL `array<vec2<f32>>` storage shape.
    uploadField(name, values) {
      runtime.uploadField(name, values);
    },

    // Read field state back from the GPU. Returns a typed array sized
    // by the field's storage type. Async because the readback walks
    // through a mapped buffer.
    async readField(name) {
      return runtime.readField(name);
    },

    // Run a single pass (one stage's output for one field) for one
    // tick. `uniforms` is the dt/frame/params/consts blob — defaults
    // sufficient for most assertions are auto-built from the layout.
    //
    // Returns nothing; call readField after to inspect outputs.
    runPass(passIndex, { dt = 1 / 60, frame = 0, params = {}, consts = {} } = {}) {
      const pass = passes[passIndex];
      if (!pass) throw new Error(`runPass: index ${passIndex} out of range (have ${passes.length})`);
      const uniforms = buildWebGpuGeodesicUniforms(pass.layout, {
        dt, frame, cellCount: grid.cellCount, params, consts,
      });
      // History-field passes must not swap mid-tick — rotation
      // happens via rotateHistory at end-of-tick.
      const swapAfter = !historyFieldSet.has(pass.field);
      runtime.runCellPass({
        key: pass.key,
        source: pass.source,
        field: pass.field,
        reads: pass.reads,
        prevReads: pass.prevReads,
        uniforms,
        needsNeighbors: pass.needsNeighbors,
        kernelSpecs: pass.kernelSpecs ?? [],
        params,
        swapAfter,
      });
    },

    // Run every pass in declared order — equivalent to one tick of
    // the recipe's `step { ... }` block. Async because we wrap the
    // dispatch in an error scope and await it: dawn-node logs WGSL
    // validation failures to stderr by default but doesn't throw, so
    // without scoping a recipe with bad WGSL would silently produce
    // garbage. popErrorScope returns the first uncaptured error
    // queued during the tick (or null if everything succeeded).
    async tick({ dt = 1 / 60, frame = 0, params = {}, consts = {} } = {}) {
      device.pushErrorScope("validation");
      for (let i = 0; i < passes.length; i++) {
        this.runPass(i, { dt, frame, params, consts });
      }
      // End-of-tick rotation for history fields — promotes the
      // freshly-written `next` slot to `current` and demotes
      // `current` to `prev` (so the next tick's @prev reads what
      // we just wrote). Mirrors the production pipeline runtime.
      if (historyFieldNames.length) runtime.rotateHistory(historyFieldNames);
      const err = await device.popErrorScope();
      if (err) throw new Error(`WGSL tick failed: ${err.message}`);
    },

    dispose() {
      try { runtime.dispose(); } catch (_) { /* idempotent */ }
      try { device.destroy?.(); } catch (_) { /* */ }
    },
  };
}

// Convenience for assertions: |a - b| < eps. GPU floats are not
// bit-exact across vendors, so test code should use closeTo instead
// of strict equality.
export function closeTo(actual, expected, eps = 1e-4) {
  return Math.abs(actual - expected) < eps;
}
