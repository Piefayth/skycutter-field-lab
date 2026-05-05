// =============================================================================
// Main WebGPU geodesic surface renderer.
//
// This intentionally does not use Three materials. The simulation runtime owns
// field storage buffers; this renderer binds those buffers directly in a small
// render pass on a canvas underneath Three's transparent overlay canvas.
// =============================================================================

const SURFACE_WGSL = (colorFn, fieldType = "f32", debugMode = "") => /* wgsl */`
struct Uniforms {
  mvp: mat4x4f,
  range: vec4f,
  light: vec4f,
};

struct VertexIn {
  @location(0) position: vec3f,
  @location(1) cell: f32,
};

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) @interpolate(flat) color: vec3f,
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
${fieldStorageDecl(fieldType)}

${colorFn}

@vertex
fn vs(input: VertexIn) -> VertexOut {
  var out: VertexOut;
  out.position = uniforms.mvp * vec4f(input.position, 1.0);
  ${debugMode === "flat" ? "out.color = vec3f(0.0, 1.0, 0.25); return out;" : ""}
  ${debugMode === "normal" ? "out.color = normalize(input.position) * 0.5 + vec3f(0.5); return out;" : ""}
  let lo = uniforms.range.x;
  let hi = uniforms.range.y;
  let span = max(hi - lo, 0.000001);
  let value = fieldLabFieldValue(u32(input.cell));
  let albedo = fieldLabColor(value, lo, span);
  let normal = normalize(input.position);
  let lightDir = normalize(vec3f(0.35, 0.55, 1.0));
  let diffuse = 0.52 + 0.48 * max(dot(normal, lightDir), 0.0);
  let facing = clamp(normal.z * 0.5 + 0.5, 0.0, 1.0);
  let rim = pow(1.0 - facing, 2.4);
  let floorColor = vec3f(0.018, 0.024, 0.030) + vec3f(0.030, 0.040, 0.050) * rim;
  out.color = max(albedo * diffuse + vec3f(0.018, 0.020, 0.022) * rim, floorColor);
  return out;
}

@fragment
fn fs(input: VertexOut) -> @location(0) vec4f {
  return vec4f(input.color, 1.0);
}
`;

const SCREEN_WGSL = /* wgsl */`
struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) color: vec3f,
};

@vertex
fn vs(@builtin(vertex_index) vertexIndex: u32) -> VertexOut {
  var positions = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f( 3.0, -1.0),
    vec2f(-1.0,  3.0)
  );
  var out: VertexOut;
  out.position = vec4f(positions[vertexIndex], 0.0, 1.0);
  out.color = vec3f(0.0, 1.0, 0.25);
  return out;
}

@fragment
fn fs(input: VertexOut) -> @location(0) vec4f {
  return vec4f(input.color, 1.0);
}
`;

export function createGeodesicSurfaceRenderer({ device, canvas, maxPixelRatio = 1 }) {
  if (!device || !canvas || !globalThis.navigator?.gpu) return null;
  return new GeodesicSurfaceRenderer({
    device,
    canvas,
    format: navigator.gpu.getPreferredCanvasFormat(),
    maxPixelRatio,
    debugMode: new URLSearchParams(globalThis.location?.search ?? "").get("surfaceDebug") ?? "",
  });
}

function normalizeSurfaceFieldType(type) {
  return type === "u32" || type === "bool" ? "u32" : "f32";
}

function surfaceFieldTypeSupported(type) {
  return type === "f32" || type === "u32" || type === "bool";
}

function fieldStorageDecl(type) {
  if (normalizeSurfaceFieldType(type) === "u32") {
    return /* wgsl */`
@group(0) @binding(1) var<storage, read> fieldValues: array<u32>;

fn fieldLabFieldValue(cell: u32) -> f32 {
  return f32(fieldValues[cell]);
}`;
  }
  return /* wgsl */`
@group(0) @binding(1) var<storage, read> fieldValues: array<f32>;

fn fieldLabFieldValue(cell: u32) -> f32 {
  return fieldValues[cell];
}`;
}

class GeodesicSurfaceRenderer {
  constructor({ device, canvas, format, maxPixelRatio, debugMode }) {
    this.device = device;
    this.canvas = canvas;
    this.context = canvas.getContext("webgpu");
    this.format = format;
    this.maxPixelRatio = Math.max(0.5, Math.min(2, Number(maxPixelRatio) || 1));
    this.pipelineCache = new Map();
    this.geometryCache = new WeakMap();
    this.bindGroupCache = new WeakMap();
    this.uniformData = new Float32Array(24);
    this.mvpMatrix = null;
    this.uniformBuffer = device.createBuffer({
      size: 96,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.width = 0;
    this.height = 0;
    this.configured = false;
    this.hasPresentedFrame = false;
    this.debugMode = debugMode;
    this.depthTexture = null;
    this.depthView = null;
  }

  render({ grid, field, viewSpec, camera }) {
    if (!this.context || !grid || !field?.buffer || !surfaceFieldTypeSupported(field.type) || !viewSpec?.gpuColor || !camera) {
      this.setVisible(false);
      return false;
    }
    this.setVisible(true);
    this.resize();
    const pipeline = this.pipelineFor(viewSpec.gpuColor, field.type);
    const geometry = this.debugMode === "screen" ? null : this.geometryFor(grid);
    let bindGroup = null;
    if (this.debugMode !== "screen") {
      this.device.queue.writeBuffer(this.uniformBuffer, 0, this.writeUniforms({ camera, range: viewSpec.gpuColor.range }));
      bindGroup = this.bindGroupFor({ pipeline, fieldBuffer: field.buffer });
    }

    const encoder = this.device.createCommandEncoder();
    const descriptor = {
      colorAttachments: [{
        view: this.context.getCurrentTexture().createView(),
        clearValue: this.debugMode === "clear"
          ? { r: 1, g: 0, b: 0.35, a: 1 }
          : { r: 0.035, g: 0.043, b: 0.059, a: 1 },
        loadOp: "clear",
        storeOp: "store",
      }],
    };
    if (this.debugMode !== "screen") {
      descriptor.depthStencilAttachment = {
        view: this.depthView,
        depthClearValue: 1,
        depthLoadOp: "clear",
        depthStoreOp: "discard",
      };
    }
    const pass = encoder.beginRenderPass(descriptor);
    pass.setPipeline(pipeline);
    if (bindGroup) pass.setBindGroup(0, bindGroup);
    if (geometry) pass.setVertexBuffer(0, geometry.buffer);
    pass.draw(this.debugMode === "screen" ? 3 : geometry.vertexCount);
    pass.end();
    this.device.queue.submit([encoder.finish()]);
    this.hasPresentedFrame = true;
    return true;
  }

  setVisible(next) {
    this.canvas.style.display = "block";
    this.canvas.style.visibility = next ? "visible" : "hidden";
    this.canvas.style.pointerEvents = next ? "auto" : "none";
  }

  hasFrame() {
    return this.hasPresentedFrame;
  }

  resize() {
    const dpr = Math.min(globalThis.devicePixelRatio || 1, this.maxPixelRatio);
    const width = Math.max(1, Math.floor(this.canvas.clientWidth * dpr));
    const height = Math.max(1, Math.floor(this.canvas.clientHeight * dpr));
    if (this.configured && this.width === width && this.height === height) return;
    this.canvas.width = width;
    this.canvas.height = height;
    this.context.configure({
      device: this.device,
      format: this.format,
      alphaMode: "opaque",
    });
    this.depthTexture?.destroy?.();
    this.depthTexture = this.device.createTexture({
      label: "field-lab-surface-depth",
      size: { width, height, depthOrArrayLayers: 1 },
      format: "depth24plus",
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.depthView = this.depthTexture.createView();
    this.width = width;
    this.height = height;
    this.configured = true;
  }

  pipelineFor(gpuColor, fieldType = "f32") {
    const normalizedFieldType = normalizeSurfaceFieldType(fieldType);
    const key = JSON.stringify({ kind: gpuColor.kind, stops: gpuColor.stops ?? [], fieldType: normalizedFieldType, debugMode: this.debugMode });
    let pipeline = this.pipelineCache.get(key);
    if (pipeline) return pipeline;
    const code = this.debugMode === "screen"
      ? SCREEN_WGSL
      : SURFACE_WGSL(colorFunction(gpuColor), normalizedFieldType, this.debugMode);
    pipeline = this.device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module: this.device.createShaderModule({ code }),
        entryPoint: "vs",
        buffers: this.debugMode === "screen" ? [] : [{
          arrayStride: 16,
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x3" },
            { shaderLocation: 1, offset: 12, format: "float32" },
          ],
        }],
      },
      fragment: {
        module: this.device.createShaderModule({ code }),
        entryPoint: "fs",
        targets: [{ format: this.format }],
      },
      primitive: {
        topology: "triangle-list",
        cullMode: this.debugMode === "screen" ? "none" : "back",
      },
      depthStencil: this.debugMode === "screen" ? undefined : {
        format: "depth24plus",
        depthWriteEnabled: true,
        depthCompare: "less",
      },
    });
    this.pipelineCache.set(key, pipeline);
    return pipeline;
  }

  bindGroupFor({ pipeline, fieldBuffer }) {
    let byPipeline = this.bindGroupCache.get(fieldBuffer);
    if (!byPipeline) {
      byPipeline = new WeakMap();
      this.bindGroupCache.set(fieldBuffer, byPipeline);
    }
    let bindGroup = byPipeline.get(pipeline);
    if (bindGroup) return bindGroup;
    bindGroup = this.device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: { buffer: fieldBuffer } },
      ],
    });
    byPipeline.set(pipeline, bindGroup);
    return bindGroup;
  }

  geometryFor(grid) {
    const cached = this.geometryCache.get(grid);
    if (cached) return cached;
    const vertices = buildSurfaceGeometry(grid);
    const buffer = this.device.createBuffer({
      size: vertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(buffer, 0, vertices);
    const geometry = { buffer, vertexCount: vertices.byteLength / 16 };
    this.geometryCache.set(grid, geometry);
    return geometry;
  }

  writeUniforms({ camera, range }) {
    camera.updateMatrixWorld();
    this.mvpMatrix ??= camera.projectionMatrix.clone();
    this.mvpMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.uniformData.set(this.mvpMatrix.elements, 0);
    const [lo, hi] = range ?? [0, 1];
    this.uniformData[16] = lo;
    this.uniformData[17] = hi;
    this.uniformData[18] = 0;
    this.uniformData[19] = 0;
    this.uniformData[20] = 0;
    this.uniformData[21] = 0;
    this.uniformData[22] = 0;
    this.uniformData[23] = 0;
    return this.uniformData;
  }
}

function colorFunction(gpuColor) {
  if (gpuColor?.kind === "wheel") return wheelFunction();
  return rampFunction(gpuColor?.stops ?? []);
}

function rampFunction(stops) {
  const normalized = normalizeRampStops(stops);
  if (normalized.length === 1) {
    return `fn fieldLabColor(value: f32, lo: f32, span: f32) -> vec3f { return vec3f(${rgbLiteral(normalized[0].color)}); }`;
  }
  if (normalized.length < 2) {
    return "fn fieldLabColor(value: f32, lo: f32, span: f32) -> vec3f { return vec3f(0.31, 0.24, 0.35); }";
  }
  const lines = [];
  for (let i = 0; i < normalized.length - 1; i++) {
    const a = normalized[i];
    const b = normalized[i + 1];
    const span = Math.max(1e-6, b.t - a.t);
    lines.push(`
  if (t <= ${floatLiteral(b.t)}) {
    let localT = clamp((t - ${floatLiteral(a.t)}) / ${floatLiteral(span)}, 0.0, 1.0);
    return mix(vec3f(${rgbLiteral(a.color)}), vec3f(${rgbLiteral(b.color)}), localT);
  }`);
  }
  const last = normalized[normalized.length - 1];
  return `fn fieldLabColor(value: f32, lo: f32, span: f32) -> vec3f {
  let t = round(clamp((value - lo) / span, 0.0, 1.0) * 2047.0) / 2047.0;
${lines.join("\n")}
  return vec3f(${rgbLiteral(last.color)});
}`;
}

function wheelFunction() {
  return /* wgsl */`
fn fieldLabColor(value: f32, lo: f32, span: f32) -> vec3f {
  let raw = (value - lo) / span;
  let h = raw - floor(raw);
  let sector = i32(floor(h * 6.0));
  let f = h * 6.0 - f32(sector);
  let q = 1.0 - f;
  if (sector == 0) { return vec3f(1.0, f, 0.0); }
  if (sector == 1) { return vec3f(q, 1.0, 0.0); }
  if (sector == 2) { return vec3f(0.0, 1.0, f); }
  if (sector == 3) { return vec3f(0.0, q, 1.0); }
  if (sector == 4) { return vec3f(f, 0.0, 1.0); }
  return vec3f(1.0, 0.0, q);
}`;
}

function normalizeRampStops(stops) {
  return (Array.isArray(stops) ? stops : [])
    .map((stop) => ({
      t: Math.max(0, Math.min(1, Number(stop?.t ?? 0))),
      color: Array.isArray(stop?.color) ? stop.color : [80, 60, 90],
    }))
    .sort((a, b) => a.t - b.t);
}

function rgbLiteral(color) {
  return [0, 1, 2]
    .map((i) => floatLiteral(Math.max(0, Math.min(255, Number(color[i] ?? 0))) / 255))
    .join(", ");
}

function floatLiteral(value) {
  return Number(value).toFixed(8);
}

function buildSurfaceGeometry(grid) {
  const adjacentCorners = buildAdjacentTriangleCenters(grid);
  const vertexCount = adjacentCorners.reduce((total, corners) => total + corners.length * 3, 0);
  const data = new ArrayBuffer(vertexCount * 16);
  const view = new DataView(data);
  let vertex = 0;
  for (let cell = 0; cell < grid.cellCount; cell++) {
    const center = positionAt(grid.positions, cell);
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
  view.setFloat32(offset + 0, position[0] * 1.006, true);
  view.setFloat32(offset + 4, position[1] * 1.006, true);
  view.setFloat32(offset + 8, position[2] * 1.006, true);
  view.setFloat32(offset + 12, cell, true);
}

function buildAdjacentTriangleCenters(grid) {
  const adjacent = Array.from({ length: grid.cellCount }, () => []);
  for (let i = 0; i < grid.triangles.length; i += 3) {
    const a = grid.triangles[i];
    const b = grid.triangles[i + 1];
    const c = grid.triangles[i + 2];
    const center = normalize(add(add(positionAt(grid.positions, a), positionAt(grid.positions, b)), positionAt(grid.positions, c)));
    adjacent[a].push(center);
    adjacent[b].push(center);
    adjacent[c].push(center);
  }
  return adjacent;
}

function sortCornersAroundCell(center, corners) {
  const ref = Math.abs(center[1]) > 0.92 ? [1, 0, 0] : [0, 1, 0];
  const u = normalize(cross(ref, center));
  const v = normalize(cross(center, u));
  return [...corners].sort((lhs, rhs) => cornerAngle(lhs, center, u, v) - cornerAngle(rhs, center, u, v));
}

function cornerAngle(corner, center, u, v) {
  const tangent = normalize(sub(corner, scale(center, dot(corner, center))));
  return Math.atan2(dot(tangent, v), dot(tangent, u));
}

function positionAt(positions, cell) {
  const offset = cell * 3;
  return [positions[offset], positions[offset + 1], positions[offset + 2]];
}

function add(a, b) {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function sub(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function scale(v, s) {
  return [v[0] * s, v[1] * s, v[2] * s];
}

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function normalize(v) {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}
