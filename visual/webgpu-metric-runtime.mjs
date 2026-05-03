// =============================================================================
// V2 metric runtime.
//
// Owns the GPU buffers + compute pipelines that turn `metric x = <reduction>
// cells [where pred] { expr }` declarations into post-step scalar values
// the JS metrics panel can display.
//
// Per metric × per primitive op (sum/max/min/count) there are:
//   - per-cell compute pipeline (writes a scratch buffer)
//   - reduce compute pipeline (workgroup tree-reduce)
//   - two ping-pong scratch buffers sized to cellCount × 4 bytes
//   - one uniform buffer per expected reduce pass (length parameter)
//   - one readback buffer (4 bytes mapped on demand)
//
// `mean` decomposes into [sum, count] primitives — the readback layer
// divides on the JS side.
//
// Per-cell + reduce passes run at the end of every tick, after all stages
// complete. The runtime exposes the most recent value from the most recent
// completed readback; the readback is async, so very early ticks may
// return null until the first one finishes.
// =============================================================================

import { metricReduceShader } from "../dsl/webgpu-geodesic-compiler.mjs";

const WORKGROUP_SIZE = 128;

export class MetricRuntime {
  constructor({ runtime, metrics }) {
    // runtime is the WebGpuGeodesicRuntime instance — provides device,
    // cellCount, params buffer, neighbor / position buffers, field
    // buffers, and the readbackBuffer.
    this.runtime = runtime;
    this.device = runtime.device;
    this.metrics = metrics; // [{ id, op, primitives: [...] }, ...]
    this.byId = new Map();
    // Cached scalar values, populated when readMetric resolves. Reads
    // before the first readback completes return null. The metrics panel
    // tolerates null — it shows "—" until a value lands.
    this.values = new Map();
    // Pending readback flags: prevents stacking up readbacks faster than
    // the GPU can produce them. If a tick fires while a readback is
    // still mapping, we skip dispatching this tick's metric and wait.
    this.pendingReadback = new Map();
    for (const metric of metrics) this._allocateMetric(metric);
  }

  _allocateMetric(metric) {
    const cellCount = this.runtime.cellCount;
    const perPrim = [];
    for (const primitive of metric.primitives) {
      perPrim.push(this._allocatePrimitive(metric, primitive, cellCount));
    }
    this.byId.set(metric.id, { metric, perPrim });
  }

  _allocatePrimitive(metric, primitive, cellCount) {
    const device = this.device;
    // Two ping-pong scratch buffers sized to cellCount × 4 bytes. The
    // first reduce pass reads scratch[0] (the per-cell output), writes
    // ceil(cellCount/128) values into scratch[1]; the second pass reads
    // scratch[1], writes ceil(prev/128) into scratch[0]; and so on until
    // length is 1. We always allocate the full cellCount even though
    // later passes use only a small prefix — the wasted tail is harmless
    // and lets us reuse the same two buffers for any input size.
    const scratchA = device.createBuffer({
      size: alignTo(cellCount * 4, 4),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
    const scratchB = device.createBuffer({
      size: alignTo(cellCount * 4, 4),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
    // Pre-compute the sequence of pass lengths: cellCount → … → 1.
    const lengths = [];
    let n = cellCount;
    while (n > 1) {
      lengths.push(n);
      n = Math.ceil(n / WORKGROUP_SIZE);
    }
    // Uniform buffer per reduce pass — each pass takes a different
    // input length and we don't want write/dispatch ordering hazards.
    const uniformBuffers = lengths.map(() => device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    }));
    // Readback buffer for the final scalar (4 bytes f32).
    const readbackBuffer = device.createBuffer({
      size: 4,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    // Compile pipelines.
    const perCellPipeline = device.createComputePipeline({
      layout: "auto",
      compute: { module: device.createShaderModule({ code: primitive.perCellSource }), entryPoint: "main" },
    });
    const reducePipeline = device.createComputePipeline({
      layout: "auto",
      compute: { module: device.createShaderModule({ code: metricReduceShader(primitive.primOp) }), entryPoint: "main" },
    });
    return {
      primOp: primitive.primOp,
      reads: primitive.reads,
      prevReads: primitive.prevReads,
      needsNeighbors: primitive.needsNeighbors,
      layout: primitive.layout,
      scratchA,
      scratchB,
      uniformBuffers,
      lengths,
      readbackBuffer,
      perCellPipeline,
      reducePipeline,
    };
  }

  // Dispatch the per-cell pass + cascading reduce passes for every metric.
  // Called by the pipeline runtime at the end of each tick (post all stages,
  // post history rotation). Reads use the runtime's currentBuffer for each
  // field — since this runs after rotation, that's the just-written value.
  dispatch(uniforms) {
    const device = this.device;
    const cellCount = this.runtime.cellCount;
    const dispatchCount = Math.ceil(cellCount / WORKGROUP_SIZE);
    const encoder = device.createCommandEncoder();
    for (const [id, entry] of this.byId.entries()) {
      // Skip if a readback is still in flight for this metric — we'd
      // either overwrite the readback target mid-map (which would
      // throw) or queue work faster than the readback can complete.
      if (this.pendingReadback.get(id)) continue;
      for (const prim of entry.perPrim) {
        // Per-cell pass: write scratchA. The shader was compiled by the
        // existing cell-stage compiler, so its bind layout matches a
        // regular cell pass — reads bindings + prev bindings + output +
        // params + positions + (neighbors). The output binding is the
        // metric scratch buffer.
        const perCellEntries = [];
        let binding = 0;
        for (const name of prim.reads) {
          perCellEntries.push({ binding, resource: { buffer: this.runtime.currentBuffer(name) } });
          binding++;
        }
        for (const name of prim.prevReads) {
          perCellEntries.push({ binding, resource: { buffer: this.runtime.historyBuffer(name) } });
          binding++;
        }
        perCellEntries.push({ binding, resource: { buffer: prim.scratchA } });
        binding++;
        perCellEntries.push({ binding, resource: { buffer: this.runtime.paramsBuffer } });
        binding++;
        perCellEntries.push({ binding, resource: { buffer: this.runtime.positionsBuffer } });
        binding++;
        if (prim.needsNeighbors) {
          perCellEntries.push({ binding, resource: { buffer: this.runtime.neighborsBuffer } });
          binding++;
          perCellEntries.push({ binding, resource: { buffer: this.runtime.neighborCountsBuffer } });
          binding++;
        }
        // Per-cell pass uses the same `params` uniform shape as cell
        // stages — we reuse the runtime's shared paramsBuffer which the
        // pipeline runtime writes to before every metric dispatch.
        const perCellBindGroup = device.createBindGroup({
          layout: prim.perCellPipeline.getBindGroupLayout(0),
          entries: perCellEntries,
        });
        const pass1 = encoder.beginComputePass();
        pass1.setPipeline(prim.perCellPipeline);
        pass1.setBindGroup(0, perCellBindGroup);
        pass1.dispatchWorkgroups(dispatchCount);
        pass1.end();
        // Reduce passes: ping-pong between scratchA / scratchB until
        // length is 1. The final value lands in whichever buffer was
        // last written.
        let inputBuf = prim.scratchA;
        let outputBuf = prim.scratchB;
        let finalBuf = prim.scratchA;
        for (let i = 0; i < prim.lengths.length; i++) {
          const length = prim.lengths[i];
          const uniformBuf = prim.uniformBuffers[i];
          // Write the input length for THIS pass.
          device.queue.writeBuffer(uniformBuf, 0, new Uint32Array([length, 0, 0, 0]));
          const reduceEntries = [
            { binding: 0, resource: { buffer: inputBuf } },
            { binding: 1, resource: { buffer: outputBuf } },
            { binding: 2, resource: { buffer: uniformBuf } },
          ];
          const reduceBindGroup = device.createBindGroup({
            layout: prim.reducePipeline.getBindGroupLayout(0),
            entries: reduceEntries,
          });
          const reducePass = encoder.beginComputePass();
          reducePass.setPipeline(prim.reducePipeline);
          reducePass.setBindGroup(0, reduceBindGroup);
          reducePass.dispatchWorkgroups(Math.ceil(length / WORKGROUP_SIZE));
          reducePass.end();
          finalBuf = outputBuf;
          // Swap for next pass.
          [inputBuf, outputBuf] = [outputBuf, inputBuf];
        }
        // Copy the final scalar (output[0]) into the readback buffer.
        encoder.copyBufferToBuffer(finalBuf, 0, prim.readbackBuffer, 0, 4);
        prim.lastFinalBuf = finalBuf;
      }
    }
    device.queue.submit([encoder.finish()]);
    // Kick off async readbacks. Each metric's primitives map to their
    // own readback buffer; once all primitives for a metric are read,
    // we combine them (mean = sum/count) and update this.values.
    for (const [id, entry] of this.byId.entries()) {
      if (this.pendingReadback.get(id)) continue;
      this.pendingReadback.set(id, true);
      this._readMetricAsync(id, entry).catch((err) => {
        console.warn(`metric ${id} readback failed`, err);
      }).finally(() => {
        this.pendingReadback.set(id, false);
      });
    }
  }

  async _readMetricAsync(id, entry) {
    const partials = [];
    for (const prim of entry.perPrim) {
      await prim.readbackBuffer.mapAsync(GPUMapMode.READ);
      const view = new Float32Array(prim.readbackBuffer.getMappedRange(), 0, 1);
      partials.push({ primOp: prim.primOp, value: view[0] });
      prim.readbackBuffer.unmap();
    }
    const value = combinePrimitives(entry.metric.op, partials);
    this.values.set(id, value);
  }

  // Latest value or null if no readback has completed yet.
  read(id) {
    return this.values.has(id) ? this.values.get(id) : null;
  }

  values_snapshot() {
    const out = {};
    for (const [id, v] of this.values.entries()) out[id] = v;
    return out;
  }

  dispose() {
    for (const entry of this.byId.values()) {
      for (const prim of entry.perPrim) {
        prim.scratchA.destroy();
        prim.scratchB.destroy();
        prim.readbackBuffer.destroy();
        for (const buf of prim.uniformBuffers) buf.destroy();
      }
    }
    this.byId.clear();
    this.values.clear();
  }
}

function combinePrimitives(op, partials) {
  if (op === "mean") {
    const sum = partials.find((p) => p.primOp === "sum")?.value ?? NaN;
    const count = partials.find((p) => p.primOp === "count")?.value ?? 0;
    if (count === 0) return NaN;
    return sum / count;
  }
  // sum / max / min / count: 1:1 with their primitive
  return partials[0]?.value ?? NaN;
}

function alignTo(value, alignment) {
  return Math.ceil(value / alignment) * alignment;
}
