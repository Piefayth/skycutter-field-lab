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
    this.eventCounters = new Map();
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
    this.eventCounterReadbackBuffer = device.createBuffer({
      size: 4,
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

  ensureEventCounter(key) {
    if (!key) throw new Error("event counter key required");
    if (this.eventCounters.has(key)) return this.eventCounters.get(key);
    const buffer = this.device.createBuffer({
      size: 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
    this.eventCounters.set(key, buffer);
    return buffer;
  }

  resetEventCounter(key) {
    const buffer = this.ensureEventCounter(key);
    this.device.queue.writeBuffer(buffer, 0, new Uint32Array([0]));
  }

  resetEventCounters(keys = []) {
    for (const key of keys) this.resetEventCounter(key);
  }

  async readEventCounters(counters = []) {
    const out = {};
    for (const counter of counters) {
      const buffer = this.eventCounters.get(counter.key);
      if (!buffer) {
        out[counter.label] = 0;
        continue;
      }
      const encoder = this.device.createCommandEncoder();
      encoder.copyBufferToBuffer(buffer, 0, this.eventCounterReadbackBuffer, 0, 4);
      this.device.queue.submit([encoder.finish()]);
      await this.eventCounterReadbackBuffer.mapAsync(GPUMapMode.READ);
      out[counter.label] = new Uint32Array(this.eventCounterReadbackBuffer.getMappedRange(), 0, 1)[0];
      this.eventCounterReadbackBuffer.unmap();
    }
    return out;
  }

  runDiffuse({ field, amount }) {
    const pipeline = this.pipeline("diffuse", DIFFUSE_WGSL);
    this.writeParams(amount);
    const bindGroup = this.device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.currentBuffer(field) } },
        { binding: 1, resource: { buffer: this.nextBuffer(field) } },
        { binding: 2, resource: { buffer: this.neighborsBuffer } },
        { binding: 3, resource: { buffer: this.neighborCountsBuffer } },
        { binding: 4, resource: { buffer: this.paramsBuffer } },
      ],
    });
    this.dispatch(pipeline, bindGroup);
    this.swap(field);
  }

  runAddConstant({ field, amount }) {
    const pipeline = this.pipeline("addConstant", ADD_CONSTANT_WGSL);
    this.writeParams(amount);
    const bindGroup = this.device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.currentBuffer(field) } },
        { binding: 1, resource: { buffer: this.nextBuffer(field) } },
        { binding: 2, resource: { buffer: this.paramsBuffer } },
      ],
    });
    this.dispatch(pipeline, bindGroup);
    this.swap(field);
  }

  runClamp({ field, lo, hi }) {
    const pipeline = this.pipeline("clamp", CLAMP_WGSL);
    this.writeUniforms(new Float32Array([lo, hi, this.cellCount, 0]));
    const bindGroup = this.device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.currentBuffer(field) } },
        { binding: 1, resource: { buffer: this.nextBuffer(field) } },
        { binding: 2, resource: { buffer: this.paramsBuffer } },
      ],
    });
    this.dispatch(pipeline, bindGroup);
    this.swap(field);
  }

  runWind({ pressure, windU, windV, lift = null, strength }) {
    const pipeline = this.pipeline("wind", WIND_WGSL);
    this.writeUniforms(new Float32Array([strength, this.cellCount, 0, 0]));
    const bindGroup = this.device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.currentBuffer(pressure) } },
        { binding: 1, resource: { buffer: this.nextBuffer(windU) } },
        { binding: 2, resource: { buffer: this.nextBuffer(windV) } },
        { binding: 3, resource: { buffer: this.neighborsBuffer } },
        { binding: 4, resource: { buffer: this.neighborCountsBuffer } },
        { binding: 5, resource: { buffer: this.positionsBuffer } },
        { binding: 6, resource: { buffer: this.paramsBuffer } },
      ],
    });
    this.dispatch(pipeline, bindGroup);
    this.swap(windU);
    this.swap(windV);
    if (lift) this.runLift({ windU, windV, lift });
  }

  runAdvect({ field, windU, windV, wind, dt }) {
    // Two binding shapes:
    //   - legacy: two scalar wind fields (windU, windV).
    //   - v2 vec2: a single vec2 wind field that bundles east/north.
    // The kernels are functionally identical; the bindings + sample
    // path differ. v2 recipes use the vec2 form via
    // `advect FIELD by WINDVEC dt EXPR`; v1 recipes (weather) keep the
    // two-scalar `advect FIELD by U, V dt EXPR`.
    if (wind) return this.runAdvectVec2({ field, wind, dt });
    const pipeline = this.pipeline("advect", ADVECT_WGSL);
    this.writeUniforms(new Float32Array([dt, this.cellCount, 0, 0]));
    const bindGroup = this.device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.currentBuffer(field) } },
        { binding: 1, resource: { buffer: this.currentBuffer(windU) } },
        { binding: 2, resource: { buffer: this.currentBuffer(windV) } },
        { binding: 3, resource: { buffer: this.nextBuffer(field) } },
        { binding: 4, resource: { buffer: this.neighborsBuffer } },
        { binding: 5, resource: { buffer: this.neighborCountsBuffer } },
        { binding: 6, resource: { buffer: this.positionsBuffer } },
        { binding: 7, resource: { buffer: this.paramsBuffer } },
      ],
    });
    this.dispatch(pipeline, bindGroup);
    this.swap(field);
  }

  runAdvectVec2({ field, wind, dt }) {
    const pipeline = this.pipeline("advectVec2", ADVECT_VEC2_WGSL);
    this.writeUniforms(new Float32Array([dt, this.cellCount, 0, 0]));
    const bindGroup = this.device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.currentBuffer(field) } },
        { binding: 1, resource: { buffer: this.currentBuffer(wind) } },
        { binding: 2, resource: { buffer: this.nextBuffer(field) } },
        { binding: 3, resource: { buffer: this.neighborsBuffer } },
        { binding: 4, resource: { buffer: this.neighborCountsBuffer } },
        { binding: 5, resource: { buffer: this.positionsBuffer } },
        { binding: 6, resource: { buffer: this.paramsBuffer } },
      ],
    });
    this.dispatch(pipeline, bindGroup);
    this.swap(field);
  }

  runLift({ windU, windV, lift }) {
    const pipeline = this.pipeline("lift", LIFT_WGSL);
    this.writeUniforms(new Float32Array([this.cellCount, 0, 0, 0]));
    const bindGroup = this.device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.currentBuffer(windU) } },
        { binding: 1, resource: { buffer: this.currentBuffer(windV) } },
        { binding: 2, resource: { buffer: this.nextBuffer(lift) } },
        { binding: 3, resource: { buffer: this.neighborsBuffer } },
        { binding: 4, resource: { buffer: this.neighborCountsBuffer } },
        { binding: 5, resource: { buffer: this.positionsBuffer } },
        { binding: 6, resource: { buffer: this.paramsBuffer } },
      ],
    });
    this.dispatch(pipeline, bindGroup);
    this.swap(lift);
  }

  runCellPass({ key, source, field, reads = [], prevReads = [], uniforms = null, needsNeighbors = false, eventCounter = null, swapAfter = true }) {
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
    if (eventCounter) {
      entries.push({ binding, resource: { buffer: this.ensureEventCounter(eventCounter.key) } });
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

  writeParams(amount) {
    this.device.queue.writeBuffer(this.paramsBuffer, 0, new Float32Array([amount, this.cellCount, 0, 0]));
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
    this.eventCounterReadbackBuffer.destroy();
    for (const buffer of this.eventCounters.values()) buffer.destroy();
    for (const field of this.fields.values()) {
      for (const buffer of field.buffers) buffer.destroy();
    }
    this.fields.clear();
    this.eventCounters.clear();
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

const DIFFUSE_WGSL = `
struct Params {
  amount: f32,
  cellCount: f32,
  pad0: f32,
  pad1: f32,
};

@group(0) @binding(0) var<storage, read> inputField: array<f32>;
@group(0) @binding(1) var<storage, read_write> outputField: array<f32>;
@group(0) @binding(2) var<storage, read> neighbors: array<i32>;
@group(0) @binding(3) var<storage, read> neighborCounts: array<u32>;
@group(0) @binding(4) var<uniform> params: Params;

@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let cell = id.x;
  if (cell >= u32(params.cellCount)) {
    return;
  }
  let count = neighborCounts[cell];
  var sum = 0.0;
  for (var slot = 0u; slot < count; slot = slot + 1u) {
    let neighbor = neighbors[cell * 6u + slot];
    sum = sum + inputField[u32(neighbor)];
  }
  let average = sum / f32(count);
  let amount = clamp(params.amount, 0.0, 0.24);
  outputField[cell] = inputField[cell] + (average - inputField[cell]) * amount;
}
`;

const ADD_CONSTANT_WGSL = `
struct Params {
  amount: f32,
  cellCount: f32,
  pad0: f32,
  pad1: f32,
};

@group(0) @binding(0) var<storage, read> inputField: array<f32>;
@group(0) @binding(1) var<storage, read_write> outputField: array<f32>;
@group(0) @binding(2) var<uniform> params: Params;

@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let cell = id.x;
  if (cell >= u32(params.cellCount)) {
    return;
  }
  outputField[cell] = inputField[cell] + params.amount;
}
`;

const CLAMP_WGSL = `
struct Params {
  lo: f32,
  hi: f32,
  cellCount: f32,
  pad0: f32,
};

@group(0) @binding(0) var<storage, read> inputField: array<f32>;
@group(0) @binding(1) var<storage, read_write> outputField: array<f32>;
@group(0) @binding(2) var<uniform> params: Params;

@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let cell = id.x;
  if (cell >= u32(params.cellCount)) {
    return;
  }
  outputField[cell] = clamp(inputField[cell], params.lo, params.hi);
}
`;

const WIND_WGSL = `
struct Params {
  strength: f32,
  cellCount: f32,
  pad0: f32,
  pad1: f32,
};

@group(0) @binding(0) var<storage, read> pressureField: array<f32>;
@group(0) @binding(1) var<storage, read_write> windUField: array<f32>;
@group(0) @binding(2) var<storage, read_write> windVField: array<f32>;
@group(0) @binding(3) var<storage, read> neighbors: array<i32>;
@group(0) @binding(4) var<storage, read> neighborCounts: array<u32>;
@group(0) @binding(5) var<storage, read> positions: array<f32>;
@group(0) @binding(6) var<uniform> params: Params;

fn position(cell: u32) -> vec3<f32> {
  let offset = cell * 3u;
  return vec3<f32>(positions[offset + 0u], positions[offset + 1u], positions[offset + 2u]);
}

fn eastBasis(p: vec3<f32>) -> vec3<f32> {
  let e = vec3<f32>(-p.z, 0.0, p.x);
  let len = length(e);
  if (len < 0.0001) {
    return vec3<f32>(1.0, 0.0, 0.0);
  }
  return e / len;
}

@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let cell = id.x;
  if (cell >= u32(params.cellCount)) {
    return;
  }
  let p = position(cell);
  let east = eastBasis(p);
  let north = normalize(cross(p, east));
  let center = pressureField[cell];
  let count = neighborCounts[cell];
  var grad = vec3<f32>(0.0, 0.0, 0.0);
  for (var slot = 0u; slot < count; slot = slot + 1u) {
    let neighbor = u32(neighbors[cell * 6u + slot]);
    let q = position(neighbor);
    let tangent = q - p * dot(q, p);
    let len2 = max(dot(tangent, tangent), 0.000001);
    grad = grad + tangent * ((pressureField[neighbor] - center) / len2);
  }
  grad = grad / f32(count);
  let dpdx = dot(grad, east);
  let dpdy = dot(grad, north);
  let coriolis = clamp(p.y, -1.0, 1.0) * 0.65;
  windUField[cell] = (-dpdx + coriolis * dpdy) * params.strength;
  windVField[cell] = (-dpdy - coriolis * dpdx) * params.strength;
}
`;

const LIFT_WGSL = `
struct Params {
  cellCount: f32,
  pad0: f32,
  pad1: f32,
  pad2: f32,
};

@group(0) @binding(0) var<storage, read> windUField: array<f32>;
@group(0) @binding(1) var<storage, read> windVField: array<f32>;
@group(0) @binding(2) var<storage, read_write> liftField: array<f32>;
@group(0) @binding(3) var<storage, read> neighbors: array<i32>;
@group(0) @binding(4) var<storage, read> neighborCounts: array<u32>;
@group(0) @binding(5) var<storage, read> positions: array<f32>;
@group(0) @binding(6) var<uniform> params: Params;

fn position(cell: u32) -> vec3<f32> {
  let offset = cell * 3u;
  return vec3<f32>(positions[offset + 0u], positions[offset + 1u], positions[offset + 2u]);
}

fn eastBasis(p: vec3<f32>) -> vec3<f32> {
  let e = vec3<f32>(-p.z, 0.0, p.x);
  let len = length(e);
  if (len < 0.0001) {
    return vec3<f32>(1.0, 0.0, 0.0);
  }
  return e / len;
}

@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let cell = id.x;
  if (cell >= u32(params.cellCount)) {
    return;
  }
  let p = position(cell);
  let east = eastBasis(p);
  let north = normalize(cross(p, east));
  let centerVelocity = east * windUField[cell] + north * windVField[cell];
  let count = neighborCounts[cell];
  var divergence = 0.0;
  for (var slot = 0u; slot < count; slot = slot + 1u) {
    let neighbor = u32(neighbors[cell * 6u + slot]);
    let q = position(neighbor);
    let tangent = q - p * dot(q, p);
    let len2 = max(dot(tangent, tangent), 0.000001);
    let ne = eastBasis(q);
    let nn = normalize(cross(q, ne));
    let neighborVelocity = ne * windUField[neighbor] + nn * windVField[neighbor];
    divergence = divergence + dot(neighborVelocity - centerVelocity, tangent) / len2;
  }
  liftField[cell] = clamp(-(divergence / f32(count)) * 0.7, -1.0, 1.0);
}
`;

// Vec2 variant of the advect kernel — single wind buffer storing east
// (.x) and north (.y) components per cell. Identical math to
// ADVECT_WGSL, just with different bindings + sample path.
const ADVECT_VEC2_WGSL = `
struct Params {
  dt: f32,
  cellCount: f32,
  pad0: f32,
  pad1: f32,
};

@group(0) @binding(0) var<storage, read> inputField: array<f32>;
@group(0) @binding(1) var<storage, read> windField: array<vec2<f32>>;
@group(0) @binding(2) var<storage, read_write> outputField: array<f32>;
@group(0) @binding(3) var<storage, read> neighbors: array<i32>;
@group(0) @binding(4) var<storage, read> neighborCounts: array<u32>;
@group(0) @binding(5) var<storage, read> positions: array<f32>;
@group(0) @binding(6) var<uniform> params: Params;

fn position(cell: u32) -> vec3<f32> {
  let offset = cell * 3u;
  return vec3<f32>(positions[offset + 0u], positions[offset + 1u], positions[offset + 2u]);
}

fn eastBasis(p: vec3<f32>) -> vec3<f32> {
  let e = vec3<f32>(-p.z, 0.0, p.x);
  let len = length(e);
  if (len < 0.0001) {
    return vec3<f32>(1.0, 0.0, 0.0);
  }
  return e / len;
}

@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let cell = id.x;
  if (cell >= u32(params.cellCount)) {
    return;
  }
  let p = position(cell);
  let east = eastBasis(p);
  let north = normalize(cross(p, east));
  let w = windField[cell];
  let velocity = east * w.x + north * w.y;
  let back = normalize(p - velocity * params.dt * 15.0);
  var weightSum = 0.0;
  var valueSum = 0.0;
  let selfD2 = max(0.000001, 2.0 * (1.0 - dot(back, p)));
  let selfWeight = 1.0 / (selfD2 * selfD2);
  weightSum = weightSum + selfWeight;
  valueSum = valueSum + inputField[cell] * selfWeight;
  let count = neighborCounts[cell];
  for (var slot = 0u; slot < count; slot = slot + 1u) {
    let neighbor = u32(neighbors[cell * 6u + slot]);
    let d2 = max(0.000001, 2.0 * (1.0 - dot(back, position(neighbor))));
    let weight = 1.0 / (d2 * d2);
    weightSum = weightSum + weight;
    valueSum = valueSum + inputField[neighbor] * weight;
  }
  outputField[cell] = valueSum / weightSum;
}
`;

const ADVECT_WGSL = `
struct Params {
  dt: f32,
  cellCount: f32,
  pad0: f32,
  pad1: f32,
};

@group(0) @binding(0) var<storage, read> inputField: array<f32>;
@group(0) @binding(1) var<storage, read> windUField: array<f32>;
@group(0) @binding(2) var<storage, read> windVField: array<f32>;
@group(0) @binding(3) var<storage, read_write> outputField: array<f32>;
@group(0) @binding(4) var<storage, read> neighbors: array<i32>;
@group(0) @binding(5) var<storage, read> neighborCounts: array<u32>;
@group(0) @binding(6) var<storage, read> positions: array<f32>;
@group(0) @binding(7) var<uniform> params: Params;

fn position(cell: u32) -> vec3<f32> {
  let offset = cell * 3u;
  return vec3<f32>(positions[offset + 0u], positions[offset + 1u], positions[offset + 2u]);
}

fn eastBasis(p: vec3<f32>) -> vec3<f32> {
  let e = vec3<f32>(-p.z, 0.0, p.x);
  let len = length(e);
  if (len < 0.0001) {
    return vec3<f32>(1.0, 0.0, 0.0);
  }
  return e / len;
}

@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let cell = id.x;
  if (cell >= u32(params.cellCount)) {
    return;
  }
  let p = position(cell);
  let east = eastBasis(p);
  let north = normalize(cross(p, east));
  let velocity = east * windUField[cell] + north * windVField[cell];
  let back = normalize(p - velocity * params.dt * 15.0);
  var weightSum = 0.0;
  var valueSum = 0.0;
  let selfD2 = max(0.000001, 2.0 * (1.0 - dot(back, p)));
  let selfWeight = 1.0 / (selfD2 * selfD2);
  weightSum = weightSum + selfWeight;
  valueSum = valueSum + inputField[cell] * selfWeight;
  let count = neighborCounts[cell];
  for (var slot = 0u; slot < count; slot = slot + 1u) {
    let neighbor = u32(neighbors[cell * 6u + slot]);
    let d2 = max(0.000001, 2.0 * (1.0 - dot(back, position(neighbor))));
    let weight = 1.0 / (d2 * d2);
    weightSum = weightSum + weight;
    valueSum = valueSum + inputField[neighbor] * weight;
  }
  outputField[cell] = valueSum / weightSum;
}
`;
