// =============================================================================
// WebGPU geodesic compute runtime.
//
// This is deliberately independent of Three/WebGL. It owns storage buffers for
// field values and topology buffers for a geodesic cell graph. Kernels dispatch
// one invocation per cell and use neighbor indices rather than texture offsets.
// =============================================================================

const WORKGROUP_SIZE = 128;
const PARAMS_BUFFER_SIZE = 4096;

export function webgpuSupported() {
  if (!globalThis.navigator?.gpu) return { ok: false, reason: "navigator.gpu unavailable" };
  const hostname = globalThis.location?.hostname;
  const isLocalhost = hostname === "localhost" || hostname === "127.0.0.1";
  if (!globalThis.isSecureContext && !isLocalhost) {
    return { ok: false, reason: "WebGPU requires a secure context" };
  }
  return { ok: true, reason: "ok" };
}

export async function createWebGpuGeodesicRuntime({ grid, fieldNames = [] }) {
  const support = webgpuSupported();
  if (!support.ok) throw new Error(`WebGPU unavailable: ${support.reason}`);
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error("WebGPU unavailable: no adapter");
  const device = await adapter.requestDevice();
  return new WebGpuGeodesicRuntime({ device, grid, fieldNames });
}

export class WebGpuGeodesicRuntime {
  constructor({ device, grid, fieldNames = [] }) {
    this.device = device;
    this.grid = grid;
    this.cellCount = grid.cellCount;
    this.dispatchCount = Math.ceil(this.cellCount / WORKGROUP_SIZE);
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
    this.readbackBuffer = device.createBuffer({
      size: this.byteLength,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    this.eventCounterReadbackBuffer = device.createBuffer({
      size: 4,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });

    for (const name of fieldNames) this.ensureField(name);
  }

  get byteLength() {
    return alignTo(this.cellCount * 4, 4);
  }

  ensureField(name) {
    if (!name) throw new Error("field name required");
    if (this.fields.has(name)) return this.fields.get(name);
    const entry = {
      buffers: [
        this.device.createBuffer({ size: this.byteLength, usage: fieldUsage() }),
        this.device.createBuffer({ size: this.byteLength, usage: fieldUsage() }),
      ],
      index: 0,
      // Allocated on demand for history-declared fields; null for the
      // common case. Holds the field's value as of the last tick
      // boundary — read by `prev(field)` in cell shaders.
      historyBuffer: null,
    };
    this.fields.set(name, entry);
    return entry;
  }

  // Allocate (idempotently) the per-tick history buffer for a field.
  // Returns the buffer. Called by the pipeline runtime at recipe load
  // for every field declared with `history N >= 1`.
  ensureHistory(name) {
    const field = this.ensureField(name);
    if (!field.historyBuffer) {
      field.historyBuffer = this.device.createBuffer({
        size: this.byteLength,
        usage: fieldUsage(),
      });
    }
    return field.historyBuffer;
  }

  historyBuffer(name) {
    const field = this.fields.get(name);
    if (!field?.historyBuffer) {
      throw new Error(`field ${name} was not allocated with history`);
    }
    return field.historyBuffer;
  }

  // Copy each named field's current buffer into its history buffer in
  // a single GPU command submission. Called at the tick boundary —
  // before any stage runs — so `prev(field)` reads the value that was
  // current at the start of the tick, regardless of how many per-pass
  // swaps happen during the tick.
  snapshotHistory(names = []) {
    if (!names.length) return;
    const encoder = this.device.createCommandEncoder();
    let didCopy = false;
    for (const name of names) {
      const field = this.fields.get(name);
      if (!field?.historyBuffer) continue;
      encoder.copyBufferToBuffer(
        field.buffers[field.index], 0,
        field.historyBuffer, 0,
        this.byteLength,
      );
      didCopy = true;
    }
    if (didCopy) this.device.queue.submit([encoder.finish()]);
  }

  currentBuffer(name) {
    const field = this.ensureField(name);
    return field.buffers[field.index];
  }

  nextBuffer(name) {
    const field = this.ensureField(name);
    return field.buffers[1 - field.index];
  }

  swap(name) {
    const field = this.ensureField(name);
    field.index = 1 - field.index;
  }

  swapFields(names = []) {
    for (const name of names) this.swap(name);
  }

  uploadField(name, values) {
    if (!values) return;
    const field = this.ensureField(name);
    this.device.queue.writeBuffer(field.buffers[field.index], 0, values.buffer, values.byteOffset, values.byteLength);
    // Initialize history slot to match. After preset apply / paint /
    // any direct upload, the next-tick prev() should see this value
    // rather than the stale previous frame's data — otherwise the
    // first tick after init produces an artificial jump.
    if (field.historyBuffer) {
      this.device.queue.writeBuffer(field.historyBuffer, 0, values.buffer, values.byteOffset, values.byteLength);
    }
  }

  uploadState(state, names = Object.keys(state?.fields ?? {})) {
    for (const name of names) this.uploadField(name, state.fields[name]);
  }

  async readField(name, out = new Float32Array(this.cellCount)) {
    const encoder = this.device.createCommandEncoder();
    encoder.copyBufferToBuffer(this.currentBuffer(name), 0, this.readbackBuffer, 0, this.cellCount * 4);
    this.device.queue.submit([encoder.finish()]);
    await this.readbackBuffer.mapAsync(GPUMapMode.READ);
    out.set(new Float32Array(this.readbackBuffer.getMappedRange(), 0, this.cellCount));
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

  runAdvect({ field, windU, windV, dt }) {
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
