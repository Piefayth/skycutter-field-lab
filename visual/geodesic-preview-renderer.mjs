// =============================================================================
// WebGPU geodesic thumbnail renderer.
//
// Pipeline graph previews use this shared renderer for all geodesic field
// canvases. It draws the same cell-tile shape language as the main globe,
// avoiding the gaps caused by the old CPU "cell-center splat" thumbnail path.
// =============================================================================

const PREVIEW_WGSL = /* wgsl */`
struct Uniforms {
  right: vec4f,
  up: vec4f,
  forward: vec4f,
  accent: vec4f,
  range: vec4f,
};

struct VertexIn {
  @location(0) position: vec3f,
  @location(1) cell: u32,
};

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) @interpolate(flat) cell: u32,
  @location(1) z: f32,
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var<storage, read> fieldValues: array<f32>;

@vertex
fn vs(input: VertexIn) -> VertexOut {
  let x = dot(input.position, uniforms.right.xyz);
  let y = dot(input.position, uniforms.up.xyz);
  let z = dot(input.position, uniforms.forward.xyz);
  let depth = 1.0 - clamp((z + 1.0) * 0.5, 0.0, 1.0);

  var out: VertexOut;
  out.position = vec4f(x * 0.94, y * 0.94, depth, 1.0);
  out.cell = input.cell;
  out.z = z;
  return out;
}

@fragment
fn fs(input: VertexOut) -> @location(0) vec4f {
  if (input.z < -0.035) {
    discard;
  }
  let lo = uniforms.range.x;
  let hi = uniforms.range.y;
  let span = max(hi - lo, 0.000001);
  let value = fieldValues[input.cell];
  let t = clamp((value - lo) / span, 0.0, 1.0);
  let base = (10.0 + t * 38.0) / 255.0;
  let shade = 0.58 + max(input.z, 0.0) * 0.42;
  return vec4f((vec3f(base) + uniforms.accent.rgb * t * 0.78) * shade, 1.0);
}
`;

let rendererPromise = null;
let renderer = null;
let rendererUnavailable = false;

export function renderGeodesicPreviewGpu(canvas, { field, topology, accent, range, view, width, height }) {
  if (rendererUnavailable || !globalThis.navigator?.gpu || !field || !topology) return false;
  if (renderer) return renderer.render(canvas, { field, topology, accent, range, view, width, height });
  rendererPromise ??= createRenderer()
    .then((value) => { renderer = value; return value; })
    .catch((error) => {
      console.warn("WebGPU geodesic preview renderer unavailable", error);
      rendererUnavailable = true;
      rendererPromise = null;
      return null;
    });
  return false;
}

async function createRenderer() {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error("no WebGPU adapter");
  const device = await adapter.requestDevice();
  const format = navigator.gpu.getPreferredCanvasFormat();
  return new GeodesicPreviewRenderer({ device, format });
}

class GeodesicPreviewRenderer {
  constructor({ device, format }) {
    this.device = device;
    this.format = format;
    this.pipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module: device.createShaderModule({ code: PREVIEW_WGSL }),
        entryPoint: "vs",
        buffers: [{
          arrayStride: 16,
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x3" },
            { shaderLocation: 1, offset: 12, format: "uint32" },
          ],
        }],
      },
      fragment: {
        module: device.createShaderModule({ code: PREVIEW_WGSL }),
        entryPoint: "fs",
        targets: [{ format }],
      },
      primitive: {
        topology: "triangle-list",
        cullMode: "none",
      },
      depthStencil: {
        format: "depth24plus",
        depthWriteEnabled: true,
        depthCompare: "less",
      },
    });
    this.uniformBuffer = device.createBuffer({
      size: 80,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.fieldBuffer = null;
    this.bindGroup = null;
    this.fieldByteLength = 0;
    this.geometryCache = new WeakMap();
    this.canvasState = new WeakMap();
  }

  render(canvas, { field, topology, accent, range, view, width, height }) {
    const context = canvas.getContext("webgpu");
    if (!context) return false;
    const sizeChanged = canvas.width !== width || canvas.height !== height;
    if (sizeChanged) {
      canvas.width = width;
      canvas.height = height;
    }
    const state = this.configureCanvas(canvas, context, width, height, sizeChanged);
    const geometry = this.geometryFor(topology);
    this.ensureFieldBuffer(field.byteLength);
    this.device.queue.writeBuffer(this.fieldBuffer, 0, field.buffer, field.byteOffset, field.byteLength);
    this.device.queue.writeBuffer(this.uniformBuffer, 0, uniformsFor({ accent, range, view }));

    const bindGroup = this.bindGroupForFieldBuffer();

    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: context.getCurrentTexture().createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        loadOp: "clear",
        storeOp: "store",
      }],
      depthStencilAttachment: {
        view: state.depthTexture.createView(),
        depthClearValue: 1,
        depthLoadOp: "clear",
        depthStoreOp: "discard",
      },
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.setVertexBuffer(0, geometry.buffer);
    pass.draw(geometry.vertexCount);
    pass.end();
    this.device.queue.submit([encoder.finish()]);
    return true;
  }

  configureCanvas(canvas, context, width, height, force = false) {
    let state = this.canvasState.get(canvas);
    if (!state || force || state.width !== width || state.height !== height) {
      context.configure({
        device: this.device,
        format: this.format,
        alphaMode: "premultiplied",
      });
      state?.depthTexture?.destroy?.();
      state = {
        width,
        height,
        depthTexture: this.device.createTexture({
          size: [Math.max(1, width), Math.max(1, height)],
          format: "depth24plus",
          usage: GPUTextureUsage.RENDER_ATTACHMENT,
        }),
      };
      this.canvasState.set(canvas, state);
    }
    return state;
  }

  ensureFieldBuffer(byteLength) {
    const needed = alignTo(byteLength, 4);
    if (this.fieldBuffer && this.fieldByteLength >= needed) return;
    this.fieldBuffer?.destroy?.();
    this.fieldByteLength = needed;
    this.fieldBuffer = this.device.createBuffer({
      size: needed,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.bindGroup = null;
  }

  bindGroupForFieldBuffer() {
    this.bindGroup ??= this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: { buffer: this.fieldBuffer } },
      ],
    });
    return this.bindGroup;
  }

  geometryFor(topology) {
    const cached = this.geometryCache.get(topology);
    if (cached) return cached;
    const vertices = buildPreviewGeometry(topology);
    const buffer = this.device.createBuffer({
      size: vertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(buffer, 0, vertices);
    const geometry = { buffer, vertexCount: vertices.byteLength / 16 };
    this.geometryCache.set(topology, geometry);
    return geometry;
  }
}

function uniformsFor({ accent, range, view }) {
  const right = normalizeVec3(view?.right, [1, 0, 0]);
  const up = normalizeVec3(view?.up, [0, 1, 0]);
  const forward = normalizeVec3(view?.forward, [0, 0, 1]);
  const data = new Float32Array(20);
  data.set([right[0], right[1], right[2], 0], 0);
  data.set([up[0], up[1], up[2], 0], 4);
  data.set([forward[0], forward[1], forward[2], 0], 8);
  data.set([accent.r / 255, accent.g / 255, accent.b / 255, 0], 12);
  data.set([range.min, range.max, 0, 0], 16);
  return data;
}

function buildPreviewGeometry(topology) {
  const adjacentCorners = buildAdjacentTriangleCenters(topology);
  const vertexCount = adjacentCorners.reduce((total, corners) => total + corners.length * 3, 0);
  const data = new ArrayBuffer(vertexCount * 16);
  const view = new DataView(data);
  let vertex = 0;
  for (let cell = 0; cell < topology.cellCount; cell++) {
    const center = positionAt(topology.positions, cell);
    const corners = sortCornersAroundCell(center, adjacentCorners[cell]);
    for (let i = 0; i < corners.length; i++) {
      writeVertex(view, vertex++, center, cell);
      writeVertex(view, vertex++, corners[i], cell);
      writeVertex(view, vertex++, corners[(i + 1) % corners.length], cell);
    }
  }
  return data;
}

function writeVertex(view, vertex, position, cell) {
  const offset = vertex * 16;
  view.setFloat32(offset + 0, position[0], true);
  view.setFloat32(offset + 4, position[1], true);
  view.setFloat32(offset + 8, position[2], true);
  view.setUint32(offset + 12, cell, true);
}

function buildAdjacentTriangleCenters(topology) {
  const adjacent = Array.from({ length: topology.cellCount }, () => []);
  for (let i = 0; i < topology.triangles.length; i += 3) {
    const a = topology.triangles[i];
    const b = topology.triangles[i + 1];
    const c = topology.triangles[i + 2];
    const center = normalizeVec3(addVec3(addVec3(positionAt(topology.positions, a), positionAt(topology.positions, b)), positionAt(topology.positions, c)));
    adjacent[a].push(center);
    adjacent[b].push(center);
    adjacent[c].push(center);
  }
  return adjacent;
}

function sortCornersAroundCell(center, corners) {
  const ref = Math.abs(center[1]) > 0.92 ? [1, 0, 0] : [0, 1, 0];
  const u = normalizeVec3(crossVec3(ref, center));
  const v = normalizeVec3(crossVec3(center, u));
  return [...corners].sort((lhs, rhs) => cornerAngle(lhs, center, u, v) - cornerAngle(rhs, center, u, v));
}

function cornerAngle(corner, center, u, v) {
  const tangent = normalizeVec3(subVec3(corner, scaleVec3(center, dotVec3(corner, center))));
  return Math.atan2(dotVec3(tangent, v), dotVec3(tangent, u));
}

function positionAt(positions, cell) {
  const offset = cell * 3;
  return [positions[offset + 0], positions[offset + 1], positions[offset + 2]];
}

function normalizeVec3(value, fallback = [0, 0, 1]) {
  const x = Number(value?.[0]);
  const y = Number(value?.[1]);
  const z = Number(value?.[2]);
  const len = Math.hypot(x, y, z);
  if (!Number.isFinite(len) || len < 1e-6) return fallback;
  return [x / len, y / len, z / len];
}

function addVec3(a, b) {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function subVec3(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function scaleVec3(v, scale) {
  return [v[0] * scale, v[1] * scale, v[2] * scale];
}

function dotVec3(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function crossVec3(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function alignTo(value, alignment) {
  return Math.ceil(value / alignment) * alignment;
}
