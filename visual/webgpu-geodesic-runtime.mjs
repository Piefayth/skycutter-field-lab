// =============================================================================
// WebGPU geodesic compute runtime.
//
// This is deliberately independent of Three/WebGL. It owns storage buffers for
// field values and topology buffers for a geodesic cell graph. Kernels dispatch
// one invocation per cell and use neighbor indices rather than texture offsets.
// =============================================================================

const WORKGROUP_SIZE = 128;
const PARAMS_BUFFER_SIZE = 4096;

// Bytes per cell for each field type. f32 = 1 component × 4 bytes;
// vec2 = 2 components × 4 bytes. Future vec3 will be 16 (WGSL pads
// vec3 to vec4 alignment in storage buffers).
const FIELD_TYPE_BYTES = {
  f32: 4,
  vec2: 8,
};
function fieldTypeBytes(type) {
  const bytes = FIELD_TYPE_BYTES[type];
  if (!bytes) throw new Error(`unsupported field type "${type}"`);
  return bytes;
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

export async function createWebGpuGeodesicRuntime({ grid, fieldNames = [], fieldTypes = {} }) {
  const support = webgpuSupported();
  if (!support.ok) throw new Error(`WebGPU unavailable: ${support.reason}`);
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error("WebGPU unavailable: no adapter");
  const device = await adapter.requestDevice();
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
    this.bindLayouts = new Map();

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
    // fields upgrade to a 3-buffer rotation in ensureHistory below.
    const bytes = this.fieldByteLength(name);
    const entry = {
      type: this.fieldType(name),
      bytes,
      buffers: [
        this.device.createBuffer({ size: bytes, usage: fieldUsage() }),
        this.device.createBuffer({ size: bytes, usage: fieldUsage() }),
      ],
      history: false,
      index: 0,
      prevIdx: 0,
      currentIdx: 0,
      nextIdx: 0,
    };
    this.fields.set(name, entry);
    return entry;
  }

  // Upgrade a field to history mode: allocate a third buffer and
  // switch from 2-buffer ping-pong to 3-buffer {prev, current, next}
  // rotation. Called by the pipeline runtime at recipe load for every
  // field declared with `history N >= 1`. Idempotent — calling twice
  // is a no-op.
  //
  // Buffer roles:
  //   prev    — value as of last tick (read by `prev(field)`)
  //   current — value as of start of this tick (read by bare ident)
  //   next    — written by the cell pass; promoted at end of tick
  //
  // History fields are NEVER swap()-ed within a tick; rotateHistory()
  // is the only way their indices move. The validator enforces this
  // by restricting history-field writes to a single cell-pass stage.
  ensureHistory(name) {
    const field = this.ensureField(name);
    if (field.history) return field;
    field.buffers.push(
      this.device.createBuffer({ size: field.bytes, usage: fieldUsage() }),
    );
    field.history = true;
    field.prevIdx = 0;
    field.currentIdx = 1;
    field.nextIdx = 2;
    return field;
  }

  historyBuffer(name) {
    const field = this.fields.get(name);
    if (!field?.history) {
      throw new Error(`field ${name} was not allocated with history`);
    }
    return field.buffers[field.prevIdx];
  }

  currentBuffer(name) {
    const field = this.ensureField(name);
    return field.history ? field.buffers[field.currentIdx] : field.buffers[field.index];
  }

  nextBuffer(name) {
    const field = this.ensureField(name);
    return field.history ? field.buffers[field.nextIdx] : field.buffers[1 - field.index];
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
    for (const name of names) {
      const field = this.fields.get(name);
      if (!field?.history) continue;
      const oldPrev = field.prevIdx;
      field.prevIdx = field.currentIdx;
      field.currentIdx = field.nextIdx;
      field.nextIdx = oldPrev;
    }
  }

  uploadField(name, values) {
    if (!values) return;
    const field = this.ensureField(name);
    const target = field.history ? field.buffers[field.currentIdx] : field.buffers[field.index];
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
      encoder.copyBufferToBuffer(
        field.buffers[field.currentIdx], 0,
        field.buffers[field.prevIdx], 0,
        field.bytes,
      );
      didCopy = true;
    }
    if (didCopy) this.device.queue.submit([encoder.finish()]);
  }

  uploadState(state, names = Object.keys(state?.fields ?? {})) {
    for (const name of names) this.uploadField(name, state.fields[name]);
  }

  async readField(name, out) {
    const field = this.ensureField(name);
    const components = field.bytes / 4 / this.cellCount; // 1 for f32, 2 for vec2
    const totalFloats = this.cellCount * components;
    if (!out) out = new Float32Array(totalFloats);
    const encoder = this.device.createCommandEncoder();
    encoder.copyBufferToBuffer(this.currentBuffer(name), 0, this.readbackBuffer, 0, field.bytes);
    this.device.queue.submit([encoder.finish()]);
    await this.readbackBuffer.mapAsync(GPUMapMode.READ);
    out.set(new Float32Array(this.readbackBuffer.getMappedRange(), 0, totalFloats));
    this.readbackBuffer.unmap();
    return out;
  }

  async readState(state, names = Object.keys(state?.fields ?? {})) {
    for (const name of names) {
      if (!state.fields[name]) continue;
      await this.readField(name, state.fields[name]);
    }
  }

  runCellPass({ key, source, field, reads = [], prevReads = [], uniforms = null, needsNeighbors = false, swapAfter = true }) {
    const pipeline = this.pipeline(key, source);
    this.writeUniforms(uniforms ?? new Float32Array([0, 0, this.cellCount, 0]));
    const entries = [];
    let binding = 0;
    for (const name of reads) {
      entries.push({ binding, resource: { buffer: this.currentBuffer(name) } });
      binding++;
    }
    // Prev-bindings sit between regular reads and the output binding —
    // matches the WGSL compiler's layout (see compileCellShader).
    for (const name of prevReads) {
      entries.push({ binding, resource: { buffer: this.historyBuffer(name) } });
      binding++;
    }
    entries.push({ binding, resource: { buffer: this.nextBuffer(field) } });
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
    const bindGroup = this.device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries,
    });
    this.dispatch(pipeline, bindGroup);
    if (swapAfter) this.swap(field);
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
    this.paramsBuffer.destroy();
    this.readbackBuffer.destroy();
    for (const field of this.fields.values()) {
      for (const buffer of field.buffers) buffer.destroy();
    }
    this.fields.clear();
  }
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

function alignTo(value, alignment) {
  return Math.ceil(value / alignment) * alignment;
}

