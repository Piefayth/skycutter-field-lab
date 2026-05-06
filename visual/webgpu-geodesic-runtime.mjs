// =============================================================================
// WebGPU geodesic compute runtime.
//
// This is deliberately independent of Three/WebGL. It owns storage buffers for
// field values and topology buffers for a geodesic cell graph. Kernels dispatch
// one invocation per cell and use neighbor indices rather than texture offsets.
// =============================================================================

import {
  buildMetricKernelTable,
  metricKernelCacheKey,
  resolveMetricKernelSpec,
} from "../kernel/metric-kernel-table.mjs";

const WORKGROUP_SIZE = 128;
const PARAMS_BUFFER_SIZE = 4096;

// Bytes per cell for each field type. f32 = 1 component × 4 bytes;
// vec2 = 2 components × 4 bytes. Future vec3 will be 16 (WGSL pads
// vec3 to vec4 alignment in storage buffers).
const FIELD_TYPE_BYTES = {
  f32: 4,
  vec2: 8,
  u32: 4,    // integer-storage fields use one u32 per cell
  bool: 4,   // bool sugars onto u32 storage (0 / 1)
};
function fieldTypeBytes(type) {
  const bytes = FIELD_TYPE_BYTES[type];
  if (!bytes) throw new Error(`unsupported field type "${type}"`);
  return bytes;
}

// JS-side typed-array constructor that matches the GPU storage layout.
// Used by the upload (state.fields[…] → GPU) and readback (GPU →
// state.fields[…]) paths so the wire format matches on both sides.
function fieldTypedArrayCtor(type) {
  if (type === "u32" || type === "bool") return Uint32Array;
  return Float32Array;
}

export function webgpuSupported() {
  if (!globalThis.navigator?.gpu) return { ok: false, reason: "navigator.gpu unavailable" };
  const hostname = globalThis.location?.hostname;
  const isLocalhost = hostname === "localhost" || hostname === "127.0.0.1";
  if (!globalThis.isSecureContext && !isLocalhost) {
    return { ok: false, reason: "WebGPU requires a secure context" };
  }
  return { ok: true, reason: "ok" };
}

export async function createWebGpuGeodesicRuntime({ grid, fieldNames = [], fieldTypes = {}, device = null } = {}) {
  const support = webgpuSupported();
  if (!support.ok) throw new Error(`WebGPU unavailable: ${support.reason}`);
  if (!device) {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error("WebGPU unavailable: no adapter");
    device = await adapter.requestDevice();
  }
  return new WebGpuGeodesicRuntime({ device, grid, fieldNames, fieldTypes });
}

export class WebGpuGeodesicRuntime {
  constructor({ device, grid, fieldNames = [], fieldTypes = {} }) {
    this.device = device;
    this.grid = grid;
    this.cellCount = grid.cellCount;
    this.dispatchCount = Math.ceil(this.cellCount / WORKGROUP_SIZE);
    // fieldTypes: name → "f32" | "vec2". Defaults to f32 for unlisted
    // names. Used by ensureField to size storage buffers correctly
    // (f32 = 4 bytes/cell, vec2 = 8).
    this.fieldTypes = fieldTypes;
    this.fields = new Map();
    this.pipelines = new Map();
    this.bindGroups = new Map();
    this.bindLayouts = new Map();
    this.metricKernels = new Map();
    this.edgeFluxBuffers = new Map();
    this.deltaBuffers = new Map();

    this.positionsBuffer = makeStorageBuffer(device, grid.positions, GPUBufferUsage.STORAGE);
    this.neighborsBuffer = makeStorageBuffer(device, grid.neighbors, GPUBufferUsage.STORAGE);
    this.neighborCountsBuffer = makeStorageBuffer(device, grid.neighborCounts, GPUBufferUsage.STORAGE);
    this.paramsBuffer = device.createBuffer({
      size: PARAMS_BUFFER_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    // Sized to the largest possible field type (vec2 = 8 bytes/cell).
    // Shared across all field readbacks; the readField call writes
    // only as many bytes as the field actually uses.
    this.readbackBuffer = device.createBuffer({
      size: alignTo(this.cellCount * fieldTypeBytes("vec2"), 4),
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });

    for (const name of fieldNames) this.ensureField(name);
  }

  // Default scalar (f32) byte length. For typed fields use
  // `fieldByteLength(name)` which sizes by the field's actual type.
  get byteLength() {
    return alignTo(this.cellCount * 4, 4);
  }

  fieldByteLength(name) {
    const type = this.fieldTypes[name] ?? "f32";
    return alignTo(this.cellCount * fieldTypeBytes(type), 4);
  }

  fieldType(name) {
    return this.fieldTypes[name] ?? "f32";
  }

  ensureField(name) {
    if (!name) throw new Error("field name required");
    if (this.fields.has(name)) return this.fields.get(name);
    // Non-history fields use 2-buffer ping-pong: index toggles each
    // swap, current = buffers[index], next = buffers[1-index]. History
    // fields upgrade to a (depth + 2)-buffer rotation in ensureHistory.
    const bytes = this.fieldByteLength(name);
    const entry = {
      type: this.fieldType(name),
      bytes,
      buffers: [
        this.device.createBuffer({ size: bytes, usage: fieldUsage() }),
        this.device.createBuffer({ size: bytes, usage: fieldUsage() }),
      ],
      history: 0,
      index: 0,
      // bufferIdx[0]=next (write target), [1]=current, [2..depth+1]=prev1..prevDepth
      bufferIdx: [],
    };
    this.fields.set(name, entry);
    return entry;
  }

  // Upgrade a field to history mode at the requested depth. With depth
  // = 1 you get the v1 {prev, current, next} 3-buffer rotation; with
  // depth = 2 you get {prev2, prev1, current, next}; etc. Called by
  // the pipeline runtime at recipe load with the depth inferred from
  // every `field@prev(N)` site. Calling with a higher depth than was
  // previously requested grows the buffer ring.
  //
  // Buffer roles (in `bufferIdx` ordering):
  //   bufferIdx[0]               = next    (cell pass writes here)
  //   bufferIdx[1]               = current (bare-ident reads)
  //   bufferIdx[2..depth+1]      = prev_1..prev_depth (oldest at the back)
  //
  // History fields are NEVER swap()-ed within a tick; rotateHistory()
  // is the only way their indices move. The validator enforces this by
  // restricting history-field writes to a single cell-pass stage.
  ensureHistory(name, depth = 1) {
    const field = this.ensureField(name);
    if (field.history >= depth) return field;
    const target = depth + 2;
    while (field.buffers.length < target) {
      field.buffers.push(
        this.device.createBuffer({ size: field.bytes, usage: fieldUsage() }),
      );
    }
    if (field.history === 0) {
      // Initialise the rotation: [next, current, prev1, prev2, ...].
      field.bufferIdx = Array.from({ length: target }, (_, i) => i);
    } else {
      // Already had some history — extend bufferIdx with new buffer
      // indices appended as the older prev slots.
      const prior = field.bufferIdx.length;
      for (let i = prior; i < target; i++) field.bufferIdx.push(i);
    }
    field.history = depth;
    return field;
  }

  // Returns the buffer holding the K-th-most-recent past value of
  // FIELD. K = 1 is the value as of last tick (the v1 prev semantics).
  historyBuffer(name, depth = 1) {
    const field = this.fields.get(name);
    if (!field?.history) {
      throw new Error(`field ${name} was not allocated with history`);
    }
    if (depth < 1 || depth > field.history) {
      throw new Error(`field ${name}: @prev(${depth}) requested but only ${field.history} ticks of history allocated`);
    }
    return field.buffers[field.bufferIdx[1 + depth]];
  }

  currentBuffer(name) {
    const field = this.ensureField(name);
    return field.history ? field.buffers[field.bufferIdx[1]] : field.buffers[field.index];
  }

  currentRenderField(name) {
    const field = this.ensureField(name);
    return {
      name,
      type: field.type,
      bytes: field.bytes,
      cellCount: this.cellCount,
      buffer: this.currentBuffer(name),
    };
  }

  nextBuffer(name) {
    const field = this.ensureField(name);
    return field.history ? field.buffers[field.bufferIdx[0]] : field.buffers[1 - field.index];
  }

  swap(name) {
    const field = this.ensureField(name);
    if (field.history) {
      // History fields rotate exactly once per tick at end-of-tick;
      // a per-pass swap would either lose `prev` or shuffle the rotation
      // into an inconsistent state. The validator forbids the recipe
      // shape that would land here, so this is a defensive guardrail.
      throw new Error(`Cannot swap history field ${name}; rotation happens at tick boundary`);
    }
    field.index ^= 1;
  }

  swapFields(names = []) {
    for (const name of names) this.swap(name);
  }

  // End-of-tick rotation for history fields. The cell pass that wrote
  // u this tick deposited the new value into nextBuffer. Promote that
  // to current; demote the old current to prev (now u_{N-1} from the
  // viewpoint of the next tick); recycle the old prev as scratch for
  // the next tick's write.
  rotateHistory(names = []) {
    // Right-rotate bufferIdx so the OLDEST prev slot becomes the new
    // "next" (recycled scratch), the previous "next" becomes the new
    // "current", and every previous prev_k becomes prev_{k+1}.
    //
    //   before: [next, current, prev1, prev2, ..., prev_depth]
    //   after:  [prev_depth, next, current, prev1, ..., prev_{depth-1}]
    //
    // Note bufferIdx stores buffer indices — popping the back and
    // unshifting the front is O(depth) but depth is tiny (typically 1,
    // up to ~3 for higher-order time integrators).
    for (const name of names) {
      const field = this.fields.get(name);
      if (!field?.history) continue;
      field.bufferIdx.unshift(field.bufferIdx.pop());
    }
  }

  uploadField(name, values) {
    if (!values) return;
    const field = this.ensureField(name);
    const target = field.history ? field.buffers[field.bufferIdx[1]] : field.buffers[field.index];
    this.device.queue.writeBuffer(target, 0, values.buffer, values.byteOffset, values.byteLength);
    // Note: we do NOT copy into prev for history fields here.
    // uploadField is hit on every tick (from stamp/paint markStateDirty
    // paths as well as preset apply). Mirroring into prev every time
    // would erase the velocity impulse a stamp creates — splash
    // semantics would become "translate the medium" by accident.
    // History prev-init is a separate explicit step (initHistory)
    // called only after preset apply.
  }

  // Force-copy each history field's current buffer into its prev
  // buffer right now. Use after preset apply so prev(u) reads the
  // initialized value on the first tick rather than uninitialized GPU
  // memory. Stamps deliberately bypass this path: their asymmetry
  // between current and prev is the velocity-impulse mechanism.
  initHistory(names = []) {
    if (!names.length) return;
    const encoder = this.device.createCommandEncoder();
    let didCopy = false;
    for (const name of names) {
      const field = this.fields.get(name);
      if (!field?.history) continue;
      const current = this.currentBuffer(name);
      for (let depth = 1; depth <= field.history; depth++) {
        encoder.copyBufferToBuffer(
          current, 0,
          this.historyBuffer(name, depth), 0,
          field.bytes,
        );
        didCopy = true;
      }
    }
    if (didCopy) this.device.queue.submit([encoder.finish()]);
  }

  uploadState(state, names = Object.keys(state?.fields ?? {})) {
    for (const name of names) this.uploadField(name, state.fields[name]);
  }

  async readField(name, out) {
    const field = this.ensureField(name);
    const type = field.type;
    const components = field.bytes / 4 / this.cellCount; // 1 for f32 / u32 / bool, 2 for vec2
    const totalElems = this.cellCount * components;
    // Match the readback typed-array to the field's storage type so
    // u32-stored fields (cellular automata, counts, state machines)
    // round-trip correctly. Without this an integer field's GPU u32
    // bits would be reinterpreted as Float32 (NaN garbage).
    const Ctor = fieldTypedArrayCtor(type);
    if (!out) out = new Ctor(totalElems);
    const encoder = this.device.createCommandEncoder();
    encoder.copyBufferToBuffer(this.currentBuffer(name), 0, this.readbackBuffer, 0, field.bytes);
    this.device.queue.submit([encoder.finish()]);
    await this.readbackBuffer.mapAsync(GPUMapMode.READ);
    out.set(new Ctor(this.readbackBuffer.getMappedRange(), 0, totalElems));
    this.readbackBuffer.unmap();
    return out;
  }

  async readState(state, names = Object.keys(state?.fields ?? {})) {
    for (const name of names) {
      if (!state.fields[name]) continue;
      await this.readField(name, state.fields[name]);
    }
  }

  applyFieldDelta(name, values) {
    if (!(values instanceof Float32Array)) return false;
    const field = this.ensureField(name);
    if (field.type !== "f32" && field.type !== "vec2") return false;
    const expectedBytes = field.bytes;
    if (values.byteLength !== expectedBytes) return false;
    const deltaBuffer = this.deltaBuffer(name);
    this.device.queue.writeBuffer(deltaBuffer, 0, values.buffer, values.byteOffset, values.byteLength);
    const source = field.type === "vec2" ? vec2DeltaShader() : f32DeltaShader();
    const pipeline = this.pipeline(`paint-delta:${field.type}`, source);
    const bindGroup = this.cachedBindGroup(
      pipeline,
      `paint-delta:${name}:${this.fieldBufferToken(name, "current")}`,
      [
        { binding: 0, resource: { buffer: this.currentBuffer(name) } },
        { binding: 1, resource: { buffer: deltaBuffer } },
        { binding: 2, resource: { buffer: this.paramsBuffer } },
      ],
    );
    this.writeUniforms(new Float32Array([0, 0, this.cellCount, 0]));
    this.dispatch(pipeline, bindGroup);
    return true;
  }

  applyFieldDeltas(deltas = {}) {
    let applied = false;
    for (const [name, values] of Object.entries(deltas)) {
      applied = this.applyFieldDelta(name, values) || applied;
    }
    return applied;
  }

  runCellPass({ key, source, field, reads = [], prevReads = [], uniforms = null, needsNeighbors = false, kernelSpecs = [], params = {}, swapAfter = true }) {
    const pipeline = this.pipeline(key, source);
    this.writeUniforms(uniforms ?? new Float32Array([0, 0, this.cellCount, 0]));
    const entries = [];
    const tokenParts = [key];
    let binding = 0;
    for (const name of reads) {
      entries.push({ binding, resource: { buffer: this.currentBuffer(name) } });
      tokenParts.push(`r:${name}:${this.fieldBufferToken(name, "current")}`);
      binding++;
    }
    // Prev-bindings sit between regular reads and the output binding —
    // matches the WGSL compiler's layout (see compileCellShader). Each
    // entry is `{ field, depth }` so multiple history depths of the
    // same field get distinct bind slots.
    for (const entry of prevReads) {
      entries.push({ binding, resource: { buffer: this.historyBuffer(entry.field, entry.depth) } });
      tokenParts.push(`p:${entry.field}:${entry.depth}:${this.fieldBufferToken(entry.field, "prev", entry.depth)}`);
      binding++;
    }
    entries.push({ binding, resource: { buffer: this.nextBuffer(field) } });
    tokenParts.push(`w:${field}:${this.fieldBufferToken(field, "next")}`);
    binding++;
    entries.push({ binding, resource: { buffer: this.paramsBuffer } });
    binding++;
    entries.push({ binding, resource: { buffer: this.positionsBuffer } });
    binding++;
    if (needsNeighbors) {
      entries.push({ binding, resource: { buffer: this.neighborsBuffer } });
      binding++;
      entries.push({ binding, resource: { buffer: this.neighborCountsBuffer } });
      binding++;
    }
    for (const spec of kernelSpecs ?? []) {
      const table = this.metricKernelBuffers(spec, params);
      tokenParts.push(`k:${table.key}`);
      entries.push({ binding, resource: { buffer: table.offsetsBuffer } });
      binding++;
      entries.push({ binding, resource: { buffer: table.entriesBuffer } });
      binding++;
    }
    const bindGroupKey = tokenParts.join("|");
    let bindGroup = this.bindGroups.get(bindGroupKey);
    if (!bindGroup) {
      bindGroup = this.device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries,
      });
      this.bindGroups.set(bindGroupKey, bindGroup);
    }
    this.dispatch(pipeline, bindGroup);
    if (swapAfter) this.swap(field);
  }

  runEdgeFluxPass({ key, source, applySource, field, reads = [], uniforms = null, params = {}, swapAfter = true }) {
    this.writeUniforms(uniforms ?? new Float32Array([0, 0, this.cellCount, 0]));
    const fluxBuffer = this.edgeFluxBuffer(key);

    const computePipeline = this.pipeline(`${key}:compute`, source);
    const computeEntries = [];
    const computeTokenParts = [`${key}:compute`];
    let binding = 0;
    for (const name of reads) {
      computeEntries.push({ binding, resource: { buffer: this.currentBuffer(name) } });
      computeTokenParts.push(`r:${name}:${this.fieldBufferToken(name, "current")}`);
      binding++;
    }
    computeEntries.push({ binding, resource: { buffer: fluxBuffer } });
    computeTokenParts.push(`flux:${key}`);
    binding++;
    computeEntries.push({ binding, resource: { buffer: this.paramsBuffer } });
    binding++;
    computeEntries.push({ binding, resource: { buffer: this.positionsBuffer } });
    binding++;
    computeEntries.push({ binding, resource: { buffer: this.neighborsBuffer } });
    binding++;
    computeEntries.push({ binding, resource: { buffer: this.neighborCountsBuffer } });

    const computeBindGroup = this.cachedBindGroup(
      computePipeline,
      computeTokenParts.join("|"),
      computeEntries,
    );
    this.dispatch(computePipeline, computeBindGroup);

    const applyPipeline = this.pipeline(`${key}:apply`, applySource);
    const applyEntries = [
      { binding: 0, resource: { buffer: this.currentBuffer(field) } },
      { binding: 1, resource: { buffer: fluxBuffer } },
      { binding: 2, resource: { buffer: this.nextBuffer(field) } },
      { binding: 3, resource: { buffer: this.paramsBuffer } },
      { binding: 4, resource: { buffer: this.neighborsBuffer } },
      { binding: 5, resource: { buffer: this.neighborCountsBuffer } },
    ];
    const applyBindGroup = this.cachedBindGroup(
      applyPipeline,
      [
        `${key}:apply`,
        `r:${field}:${this.fieldBufferToken(field, "current")}`,
        `w:${field}:${this.fieldBufferToken(field, "next")}`,
        `flux:${key}`,
      ].join("|"),
      applyEntries,
    );
    this.dispatch(applyPipeline, applyBindGroup);
    if (swapAfter) this.swap(field);
  }

  cachedBindGroup(pipeline, key, entries) {
    let bindGroup = this.bindGroups.get(key);
    if (!bindGroup) {
      bindGroup = this.device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries,
      });
      this.bindGroups.set(key, bindGroup);
    }
    return bindGroup;
  }

  edgeFluxBuffer(key) {
    const existing = this.edgeFluxBuffers.get(key);
    if (existing) return existing;
    const bytes = alignTo(this.cellCount * 6 * 4, 4);
    const buffer = this.device.createBuffer({
      size: bytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.edgeFluxBuffers.set(key, buffer);
    return buffer;
  }

  deltaBuffer(name) {
    const field = this.ensureField(name);
    const key = `${name}:${field.bytes}`;
    const existing = this.deltaBuffers.get(key);
    if (existing) return existing;
    const buffer = this.device.createBuffer({
      size: field.bytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.deltaBuffers.set(key, buffer);
    return buffer;
  }

  fieldBufferToken(name, role, depth = 1) {
    const field = this.ensureField(name);
    if (field.history) {
      if (role === "next") return `h:${field.bufferIdx[0]}`;
      if (role === "current") return `h:${field.bufferIdx[1]}`;
      return `h:${field.bufferIdx[1 + depth]}`;
    }
    if (role === "next") return `p:${1 - field.index}`;
    return `p:${field.index}`;
  }

  metricKernelBuffers(spec, params = {}) {
    const resolved = resolveMetricKernelSpec(spec, params);
    const key = metricKernelCacheKey(resolved);
    let cached = this.metricKernels.get(key);
    if (cached) return cached;
    const table = buildMetricKernelTable(this.grid, resolved);
    const entries = packMetricKernelEntries(table);
    cached = {
      key,
      offsetsBuffer: makeStorageBuffer(this.device, table.offsets, GPUBufferUsage.STORAGE),
      entriesBuffer: makeStorageBuffer(this.device, entries, GPUBufferUsage.STORAGE),
      entryCount: table.indices.length,
    };
    this.metricKernels.set(key, cached);
    return cached;
  }

  dispatch(pipeline, bindGroup) {
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(this.dispatchCount);
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  pipeline(key, source) {
    if (this.pipelines.has(key)) return this.pipelines.get(key);
    const pipeline = this.device.createComputePipeline({
      layout: "auto",
      compute: {
        module: this.device.createShaderModule({ code: source }),
        entryPoint: "main",
      },
    });
    this.pipelines.set(key, pipeline);
    return pipeline;
  }

  writeUniforms(values) {
    if (!(values instanceof Float32Array)) values = new Float32Array(values ?? []);
    if (values.byteLength > PARAMS_BUFFER_SIZE) {
      throw new Error(`WebGPU geodesic uniforms exceed ${PARAMS_BUFFER_SIZE} bytes`);
    }
    this.device.queue.writeBuffer(this.paramsBuffer, 0, values.buffer, values.byteOffset, values.byteLength);
  }

  dispose() {
    this.positionsBuffer.destroy();
    this.neighborsBuffer.destroy();
    this.neighborCountsBuffer.destroy();
    this.bindGroups.clear();
    for (const kernel of this.metricKernels.values()) {
      kernel.offsetsBuffer.destroy();
      kernel.entriesBuffer.destroy();
    }
    for (const buffer of this.edgeFluxBuffers.values()) buffer.destroy();
    this.edgeFluxBuffers.clear();
    for (const buffer of this.deltaBuffers.values()) buffer.destroy();
    this.deltaBuffers.clear();
    this.paramsBuffer.destroy();
    this.readbackBuffer.destroy();
    for (const field of this.fields.values()) {
      for (const buffer of field.buffers) buffer.destroy();
    }
    this.fields.clear();
  }
}

function f32DeltaShader() {
  return `
@group(0) @binding(0) var<storage, read_write> field: array<f32>;
@group(0) @binding(1) var<storage, read> delta: array<f32>;
@group(0) @binding(2) var<uniform> params: vec4f;

@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= u32(params.z)) { return; }
  field[i] = field[i] + delta[i];
}
`;
}

function vec2DeltaShader() {
  return `
@group(0) @binding(0) var<storage, read_write> field: array<vec2f>;
@group(0) @binding(1) var<storage, read> delta: array<vec2f>;
@group(0) @binding(2) var<uniform> params: vec4f;

@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= u32(params.z)) { return; }
  field[i] = field[i] + delta[i];
}
`;
}

function fieldUsage() {
  return GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
}

function makeStorageBuffer(device, typedArray, extraUsage = 0) {
  const buffer = device.createBuffer({
    size: alignTo(typedArray.byteLength, 4),
    usage: GPUBufferUsage.COPY_DST | extraUsage,
  });
  device.queue.writeBuffer(buffer, 0, typedArray.buffer, typedArray.byteOffset, typedArray.byteLength);
  return buffer;
}

function packMetricKernelEntries(table) {
  const buffer = new ArrayBuffer(table.indices.length * 8);
  const view = new DataView(buffer);
  for (let i = 0; i < table.indices.length; i++) {
    const offset = i * 8;
    view.setUint32(offset, table.indices[i], true);
    view.setFloat32(offset + 4, table.weights[i], true);
  }
  return new Uint32Array(buffer);
}

function alignTo(value, alignment) {
  return Math.ceil(value / alignment) * alignment;
}
