// =============================================================================
// WebGPU geodesic DSL compiler slice.
//
// V2 has exactly one stage shape: `cell { … }`. Every kernel operation
// (diffusion, advection, gradient/divergence, reductions, history reads)
// is expressed as a per-cell expression body — the parser rejects v1's
// `wind`/`advect`/`diffuse`/`clamp`/`normalize` statement forms and the
// `each`/`event` stage shapes with redirect messages.
//
// Math-fn dispatch routes through the unified MATH_FUNCTIONS registry
// in dsl-spec.mjs — adding a new math fn means adding one entry there;
// the compiler picks it up via the `wgsl` callback in compileCall.
// =============================================================================

import { MATH_FUNCTIONS } from "./dsl-spec.mjs";

export function compileWebGpuGeodesicPipeline(dsl = {}) {
  const stages = (dsl.stages ?? []).map((stage) => ({
    id: stage.id,
    name: stage.name,
    passes: compileWebGpuGeodesicStage(stage, dsl),
  }));
  return { stages };
}

export function compileWebGpuGeodesicStage(stage, dsl = {}) {
  // Thin wrapper over compileWebGpuGeodesicCellStage. Kept as a separate
  // export so callers can stay agnostic of the stage shape — historically
  // this dispatched between cell / each / event; v2 only has `cell`.
  return compileWebGpuGeodesicCellStage(stage, dsl);
}

export function compileWebGpuGeodesicCellStage(stage, dsl = {}) {
  const statements = stage?.body?.statements ?? [];
  if (statements.length !== 1 || statements[0].type !== "cell") {
    throw new Error(`${stage?.id ?? "stage"}: WebGPU geodesic compiler currently supports a single cell block`);
  }

  const reads = stage.reads ?? [];
  const outputs = stage.outputs ?? [...(stage.writes ?? []), ...(stage.declares ?? [])];
  const layout = uniformLayout(dsl);
  return outputs.map((field) => ({
    ...compileActionPass({
      stage,
      field,
      reads,
      actions: statements[0].actions ?? [],
      layout,
      key: `${stage.id}:${field}`,
    }),
  }));
}

function compileActionPass({ stage, field, reads, actions, layout, key }) {
  const passReads = readsForTarget(actions, field, reads);
  const targetActions = filterActionsForTarget(actions, field);
  const needsNeighbors = actionsUseNeighborReduce(targetActions);
  const kernelSpecs = collectKernelSpecsFromActions(targetActions, layout);
  // `field@prev` reads the named field's value as of the tick boundary.
  // The runtime keeps a separate `f_<name>_prev` buffer per history-
  // declared field; the compiler emits an additional binding for each
  // such field used by this pass. The set of prev-read field names is
  // intersected with `reads` because a stage that doesn't already read
  // a field shouldn't be allowed to peek at its prev value either —
  // that would silently bypass the `reads` declaration.
  const prevReads = collectPrevReads(targetActions).filter((entry) => passReads.includes(entry.field));
  return {
    kind: "cell",
    stageId: stage.id,
    key,
    field,
    reads: passReads,
    prevReads,
    layout,
    needsNeighbors,
    kernelSpecs,
    source: compileCellShader({
      stage,
      field,
      reads: passReads,
      prevReads,
      actions: targetActions,
      layout,
      needsNeighbors,
      kernelSpecs,
    }),
  };
}

// =============================================================================
// V2 metric kernels.
//
// A metric is a top-level scalar reduction over the post-step state:
//
//   metric peak = max cells { abs(u) }
//   metric active = count cells where abs(u) > 0.1
//   metric energy = sum cells { 0.5*v*v + 0.5*c*c * sum n in neighbors { (u@n - u)*(u@n - u) } }
//
// Compilation produces TWO WGSL kernels per metric primitive:
//
//   1. per-cell pass: evaluates the metric expression at every cell and
//      writes the result to a scratch buffer. Predicate-gated cells
//      contribute the op's identity element (0 for sum/count, ±FLT_MAX
//      for max/min) so they don't bias the reduction.
//
//   2. reduce pass: workgroup-tree reduction over the scratch buffer.
//      Run repeatedly with halving input length until one scalar remains.
//      Same shader handles all input sizes — the input length comes from
//      a uniform.
//
// `mean` is sugar over (sum, count): the compiler emits both primitives
// and the JS readback layer divides. This keeps the GPU kernels uniform
// (one per op) and lets `mean cells where pred { expr }` work naturally
// with any predicate.
//
// The per-cell pass piggybacks on the existing cell-stage shader template
// — the metric body becomes a synthetic `cell { set _metric = ... }`
// statement targeting a scratch field. That gives metrics access to
// neighbor reductions, prev() reads, params, position helpers, math
// functions — every feature a stage cell body has.
// =============================================================================

const METRIC_SCRATCH_PSEUDO_FIELD = "_metric_scratch";

// Map a metric op to the underlying primitive op(s) the runtime computes.
// Most are 1:1; `mean` decomposes into [sum, count] and the JS layer
// divides on readback.
export function expandMetricPrimitives(op) {
  if (op === "mean") return ["sum", "count"];
  return [op];
}

// Identity element for the workgroup tree-reduce. Cells filtered out by
// `where` predicates get this value, so they can't bias the result.
function metricIdentity(primOp) {
  switch (primOp) {
    case "sum":
    case "count":
      return "0.0";
    case "max":
      return "-1.0e38";
    case "min":
      return "1.0e38";
    default:
      throw new Error(`metric: unknown primitive op ${primOp}`);
  }
}

export function compileWebGpuMetric(metric, dsl = {}) {
  const primitives = expandMetricPrimitives(metric.op).map((primOp) =>
    compileMetricPrimitive(metric, primOp, dsl),
  );
  return {
    id: metric.id,
    op: metric.op,
    primitives,
  };
}

function compileMetricPrimitive(metric, primOp, dsl) {
  // Build a synthetic stage shaped like a cell body that writes a
  // single scratch field. The body expression is:
  //
  //   primOp = sum/max/min:  pred ? <metric.body> : <identity>
  //   primOp = count:         pred ? 1.0 : 0.0
  //
  // `pred` defaults to true if the metric has no `where` clause.
  const identity = metricIdentity(primOp);
  const trueLit = { type: "Identifier", name: "true" };
  const predicate = metric.predicate ?? trueLit;
  const innerBody = primOp === "count"
    ? { type: "Number", value: "1.0" }
    : metric.body;
  if (primOp !== "count" && !innerBody) {
    throw new Error(`metric ${metric.id}: ${primOp} requires a body expression`);
  }
  // Conditional value: `pred ? inner : identity`. We compile the
  // identity as a number literal (string is fine — compileExpr accepts
  // it as a Number node).
  const valueExpr = {
    type: "Conditional",
    test: predicate,
    consequent: innerBody,
    alternate: { type: "Number", value: identity },
  };
  // Synthesize a stage that the existing cell-shader compiler can
  // consume. The "field" is a pseudo-name reserved for metric scratch;
  // the WGSL shader's outputField binding is the metric's scratch buffer.
  const reads = [...collectExprFieldReads(valueExpr, new Set(
    (dsl.fields ?? []).map((f) => f.name).filter(Boolean),
  ))];
  const synthStage = {
    id: `_metric_${metric.id}_${primOp}`,
    name: `metric ${metric.id} (${primOp})`,
    reads,
    writes: [METRIC_SCRATCH_PSEUDO_FIELD],
    declares: [],
    body: {
      statements: [{
        type: "cell",
        actions: [{
          type: "set",
          field: METRIC_SCRATCH_PSEUDO_FIELD,
          expr: valueExpr,
        }],
      }],
    },
  };
  // Reuse compileWebGpuGeodesicCellStage so neighbor reductions, prev
  // reads, and all the position helpers come for free. The pseudo-field
  // is just a name — at dispatch time the runtime binds the metric
  // scratch buffer in the outputField slot.
  const passes = compileWebGpuGeodesicCellStage(synthStage, dsl);
  if (passes.length !== 1) {
    throw new Error(`metric ${metric.id}: synthesized stage produced ${passes.length} passes (expected 1)`);
  }
  const pass = passes[0];
  return {
    primOp,
    perCellSource: pass.source,
    reads: pass.reads,
    prevReads: pass.prevReads,
    needsNeighbors: pass.needsNeighbors,
    kernelSpecs: pass.kernelSpecs ?? [],
    layout: pass.layout,
    identity,
  };
}

// Walk an expression to find every bare-identifier or @-coord reference
// to a declared field. Used to wire up the synthetic stage's `reads`
// list. Locals introduced by `let` aren't tracked here (the cell-shader
// compiler does that itself); we just need the surface field deps.
function collectExprFieldReads(ast, declaredFields, out = new Set()) {
  if (!ast || typeof ast !== "object") return out;
  if (ast.type === "Identifier" && declaredFields.has(ast.name)) {
    out.add(ast.name);
  }
  // V2 CoordRead — `field@<coord>` reads `field` regardless of coord kind
  // (prev / neighbor / future kinds). Surface the field as a read.
  if (ast.type === "CoordRead" && declaredFields.has(ast.field)) {
    out.add(ast.field);
  }
  // Legacy v1 prev() Call form, kept so any leftover non-CoordRead AST
  // still classifies correctly.
  if (ast.type === "Call" && ast.callee?.name === "prev"
      && ast.args?.[0]?.type === "Identifier"
      && declaredFields.has(ast.args[0].name)) {
    out.add(ast.args[0].name);
  }
  if (ast.type === "NeighborReduce") {
    for (const b of ast.bindings ?? []) {
      if (b.field && declaredFields.has(b.field)) out.add(b.field);
    }
    collectExprFieldReads(ast.body, declaredFields, out);
    return out;
  }
  for (const key of Object.keys(ast)) {
    const v = ast[key];
    if (Array.isArray(v)) v.forEach((c) => collectExprFieldReads(c, declaredFields, out));
    else if (v && typeof v === "object") collectExprFieldReads(v, declaredFields, out);
  }
  return out;
}

// WGSL for the workgroup tree-reduce. `length` comes from a uniform so
// the same shader handles every pass (cellCount → ceil(N/128) → … → 1).
export function metricReduceShader(primOp) {
  const identity = metricIdentity(primOp);
  let combine;
  switch (primOp) {
    case "sum":   combine = "a + b"; break;
    case "count": combine = "a + b"; break;
    case "max":   combine = "max(a, b)"; break;
    case "min":   combine = "min(a, b)"; break;
    default: throw new Error(`metric: unknown primitive op ${primOp}`);
  }
  return `
struct ReduceParams {
  length: u32,
  pad0: u32,
  pad1: u32,
  pad2: u32,
};

@group(0) @binding(0) var<storage, read> input: array<f32>;
@group(0) @binding(1) var<storage, read_write> output: array<f32>;
@group(0) @binding(2) var<uniform> params: ReduceParams;

var<workgroup> shared_data: array<f32, 128>;

fn combine(a: f32, b: f32) -> f32 {
  return ${combine};
}

@compute @workgroup_size(128)
fn main(@builtin(local_invocation_id) lid: vec3<u32>,
        @builtin(workgroup_id) wid: vec3<u32>) {
  let idx = wid.x * 128u + lid.x;
  shared_data[lid.x] = select(${identity}, input[idx], idx < params.length);
  workgroupBarrier();
  for (var stride: u32 = 64u; stride > 0u; stride = stride >> 1u) {
    if (lid.x < stride) {
      shared_data[lid.x] = combine(shared_data[lid.x], shared_data[lid.x + stride]);
    }
    workgroupBarrier();
  }
  if (lid.x == 0u) {
    output[wid.x] = shared_data[0];
  }
}
`.trim();
}

export function buildWebGpuGeodesicUniforms(layout, { dt = 0, frame = 0, cellCount = 0, params = {}, consts = {}, planet = {} } = {}) {
  const values = [dt, frame, cellCount, 0];
  for (const decl of layout.parameters) values.push(Number(params[decl.name] ?? decl.default ?? 0));
  for (const decl of layout.constants) values.push(Number(consts[decl.name] ?? decl.value ?? 0));
  for (const name of layout.planet) values.push(Number(planet[name] ?? 0));
  return new Float32Array(values);
}

// Map field type → WGSL storage element type. Drives the storage
// binding's `array<...>` shape and the per-cell read local's type.
//
// u32 and bool fields share Uint32 storage on both sides of the wire
// (bool is DSL-level sugar — `true` reads as 1, `false` as 0). On
// read into a per-cell expression we cast to f32 so the rest of the
// arithmetic just works in f32 land; on write we cast back to u32 via
// `u32(round(outValue))`. This keeps the type-system surface small
// (everything in expressions is f32-or-vec2) while letting recipes
// declare integer-storage fields for cellular automata, count
// histories, state machines, etc.
function wgslElemType(fieldType) {
  if (fieldType === "vec2") return "vec2<f32>";
  if (fieldType === "u32" || fieldType === "bool") return "u32";
  return "f32";
}

// Per-cell read of a field. Integer-storage fields cast to f32 so the
// downstream expression compiles in pure f32 / vec2 land.
function wgslReadCell(fieldName, fieldType) {
  if (fieldType === "u32" || fieldType === "bool") return `f32(f_${fieldName}[cell])`;
  return `f_${fieldName}[cell]`;
}

// Per-cell read of a field at a neighbor / arbitrary index. Same
// integer-cast as wgslReadCell, just at a different index.
function wgslReadAt(fieldName, fieldType, indexExpr) {
  if (fieldType === "u32" || fieldType === "bool") return `f32(f_${fieldName}[${indexExpr}])`;
  return `f_${fieldName}[${indexExpr}]`;
}

// Per-cell write of a (possibly cast) f32 value into a field. For
// integer-storage fields we round-and-cast so 0.49 doesn't write 0
// when the user clearly meant "almost-1 means 1" — the round is the
// same convention WGSL spec uses for f32→u32 on `select` results.
// outValue is always f32 (or vec2<f32>) at the point we call this.
function wgslWriteOutput(fieldType, valueExpr) {
  if (fieldType === "u32" || fieldType === "bool") return `outputField[cell] = u32(round(${valueExpr}));`;
  return `outputField[cell] = ${valueExpr};`;
}

function compileCellShader({ stage, field, reads, prevReads = [], actions, layout, needsNeighbors = false, kernelSpecs = [] }) {
  const fieldTypes = layout.fieldTypes ?? {};
  const typeOf = (name) => fieldTypes[name] ?? "f32";
  const readBindings = reads.map((name, index) =>
    `@group(0) @binding(${index}) var<storage, read> f_${name}: array<${wgslElemType(typeOf(name))}>;`,
  );
  // Prev-read bindings sit between the regular reads and the output
  // binding so existing binding indices for params / positions /
  // neighbors only need to shift by `prevReads.length`. The buffer
  // name encodes the depth so a single field with multiple history
  // depths gets distinct bindings (e.g. `f_u_prev_1`, `f_u_prev_2`).
  const prevReadBindings = prevReads.map(
    ({ field: name, depth }, index) => `@group(0) @binding(${reads.length + index}) var<storage, read> f_${name}_prev_${depth}: array<${wgslElemType(typeOf(name))}>;`,
  );
  const outputBinding = reads.length + prevReads.length;
  const paramsBinding = outputBinding + 1;
  const positionsBinding = outputBinding + 2;
  const neighborsBinding = outputBinding + 3;
  const neighborCountsBinding = outputBinding + 4;
  const kernelStartBinding = outputBinding + 3 + (needsNeighbors ? 2 : 0);
  // Per-cell read locals carry an explicit type annotation. vec2
  // fields surface as `vec2<f32>` so member access (.x/.y) compiles.
  // u32 / bool fields cast on read into f32 so the rest of the cell
  // body operates in pure f32-or-vec2 land — wgslReadCell handles
  // the cast.
  const readValues = reads.map((name) => {
    const t = typeOf(name);
    // u32/bool fields read as f32; the cell body never sees the
    // integer type, only its f32 representation.
    const localType = (t === "u32" || t === "bool") ? "f32" : wgslElemType(t);
    return `  let ${readVar(name)}: ${localType} = ${wgslReadCell(name, t)};`;
  });
  const neighborBindings = needsNeighbors ? `
@group(0) @binding(${neighborsBinding}) var<storage, read> neighbors: array<i32>;
@group(0) @binding(${neighborCountsBinding}) var<storage, read> neighborCounts: array<u32>;
` : "";
  const kernelBindings = kernelSpecs.map((spec, index) => {
    const base = kernelStartBinding + index * 2;
    return [
      `@group(0) @binding(${base}) var<storage, read> k_${spec.id}_offsets: array<u32>;`,
      `@group(0) @binding(${base + 1}) var<storage, read> k_${spec.id}_entries: array<MetricKernelEntry>;`,
    ].join("\n");
  }).join("\n");
  // Initial value for the per-cell `outValue` accumulator. For vec2
  // fields not in reads, default to vec2<f32>(0.0, 0.0); for f32 / u32
  // / bool, 0.0. (Integer-storage fields use f32 outValue throughout
  // the cell body — the cast happens on the final write to
  // outputField, not in outValue itself.)
  const fieldType = typeOf(field);
  const zeroLiteral = fieldType === "vec2" ? "vec2<f32>(0.0, 0.0)" : "0.0";
  const initial = reads.includes(field) ? readVar(field) : zeroLiteral;
  // Compile the cell body. compileActions records gradient/divergence
  // calls in ctx so we can emit the per-field helper functions
  // afterwards in the prelude.
  const ctx = {
    reads: new Set(reads),
    target: field,
    locals: new Set(),
    layout,
    usedGradients: new Set(),
    usedDivergences: new Set(),
    usedUpstreams: new Set(),
    kernelSpecs,
  };
  const body = compileActions(actions, ctx);
  // Tangent-frame stencil helpers are emitted only when the body uses
  // gradient / divergence. eastBasis + position are shared helpers
  // each operator depends on; emit once if either set is non-empty.
  const stencilHelperSource = emitStencilHelpers(ctx, typeOf);

  return `
struct MetricKernelEntry {
  index: u32,
  weight: f32,
};

struct Params {
  dt: f32,
  frame: f32,
  cellCount: f32,
  pad0: f32,
${layout.parameters.map((decl) => `  p_${decl.name}: f32,`).join("\n")}
${layout.constants.map((decl) => `  c_${decl.name}: f32,`).join("\n")}
${layout.planet.map((name) => `  planet_${name}: f32,`).join("\n")}
};

${readBindings.join("\n")}
${prevReadBindings.join("\n")}
@group(0) @binding(${outputBinding}) var<storage, read_write> outputField: array<${wgslElemType(fieldType)}>;
@group(0) @binding(${paramsBinding}) var<uniform> params: Params;
@group(0) @binding(${positionsBinding}) var<storage, read> positions: array<f32>;
${neighborBindings}
${kernelBindings}

const PI: f32 = 3.141592653589793;
const TAU: f32 = 6.283185307179586;

fn hashNoise(i: f32, seed: f32) -> f32 {
  var x = u32(i32(i) + 1) ^ ((u32(i32(floor(seed))) + 1013904223u) * 1664525u);
  x = x ^ (x >> 16u);
  x = x * 2246822519u;
  x = x ^ (x >> 13u);
  x = x * 3266489917u;
  x = x ^ (x >> 16u);
  return (f32(x) / 4294967295.0) * 2.0 - 1.0;
}

fn rngState24(state: f32) -> u32 {
  return u32(round(state)) & 0x00ffffffu;
}

fn rngHash24(state: f32) -> u32 {
  var x = rngState24(state) + 0x9e3779b9u;
  x = x ^ (x >> 16u);
  x = x * 2246822519u;
  x = x ^ (x >> 13u);
  x = x * 3266489917u;
  x = x ^ (x >> 16u);
  return x & 0x00ffffffu;
}

fn rngRand01(state: f32) -> f32 {
  return f32(rngHash24(state)) / 16777215.0;
}

fn rngNext24(state: f32) -> f32 {
  let x = rngState24(state);
  return f32(((1664525u * x) + 1013904223u) & 0x00ffffffu);
}

fn hashLattice(c: vec3<i32>, seed: f32) -> f32 {
  var x = (bitcast<u32>(c.x) * 73856093u) ^ (bitcast<u32>(c.y) * 19349663u) ^ (bitcast<u32>(c.z) * 83492791u);
  x = x ^ ((bitcast<u32>(i32(floor(seed))) + 1013904223u) * 1664525u);
  x = x ^ (x >> 16u);
  x = x * 2246822519u;
  x = x ^ (x >> 13u);
  x = x * 3266489917u;
  x = x ^ (x >> 16u);
  return (f32(x) / 4294967295.0) * 2.0 - 1.0;
}

fn lerpNoise(a: f32, b: f32, t: f32) -> f32 {
  return a + (b - a) * t;
}

fn spatialNoise(p: vec3<f32>, seed: f32) -> f32 {
  let q = p * 4.0 + vec3<f32>(seed * 0.013, seed * 0.021, seed * 0.034);
  let base = vec3<i32>(floor(q));
  let f = fract(q);
  let s = f * f * (vec3<f32>(3.0) - 2.0 * f);
  let n000 = hashLattice(base + vec3<i32>(0, 0, 0), seed);
  let n100 = hashLattice(base + vec3<i32>(1, 0, 0), seed);
  let n010 = hashLattice(base + vec3<i32>(0, 1, 0), seed);
  let n110 = hashLattice(base + vec3<i32>(1, 1, 0), seed);
  let n001 = hashLattice(base + vec3<i32>(0, 0, 1), seed);
  let n101 = hashLattice(base + vec3<i32>(1, 0, 1), seed);
  let n011 = hashLattice(base + vec3<i32>(0, 1, 1), seed);
  let n111 = hashLattice(base + vec3<i32>(1, 1, 1), seed);
  let nx00 = lerpNoise(n000, n100, s.x);
  let nx10 = lerpNoise(n010, n110, s.x);
  let nx01 = lerpNoise(n001, n101, s.x);
  let nx11 = lerpNoise(n011, n111, s.x);
  let nxy0 = lerpNoise(nx00, nx10, s.y);
  let nxy1 = lerpNoise(nx01, nx11, s.y);
  return lerpNoise(nxy0, nxy1, s.z);
}

${stencilHelperSource}

@compute @workgroup_size(128)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let cell = id.x;
  if (cell >= u32(params.cellCount)) {
    return;
  }
  let posOffset = cell * 3u;
  let sx = positions[posOffset + 0u];
  let sy = positions[posOffset + 1u];
  let sz = positions[posOffset + 2u];
  let lon = atan2(sz, sx);
  let lat = asin(clamp(sy, -1.0, 1.0));
  let x = (lon + PI) / TAU;
  let y = lat / PI + 0.5;
  let u = x;
  let v = y;
  let px = sx;
  let py = sy;
  let pz = sz;
  let i = f32(cell);
  let N = params.cellCount;
${readValues.join("\n")}
  var outValue = ${initial};
${indent(body, 2)}
  ${wgslWriteOutput(fieldType, "outValue")}
}
`.trim();
}

function uniformLayout(dsl) {
  // fieldTypes is consumed by compileCellShader to type its storage
  // bindings (`array<f32>` vs `array<vec2<f32>>`) and the per-cell
  // read locals. Defaults to f32 for any field missing from this map.
  const fieldTypes = Object.fromEntries(
    (dsl.fields ?? [])
      .filter((decl) => decl?.name && decl.type)
      .map((decl) => [decl.name, decl.type]),
  );
  return {
    parameters: dsl.parameters ?? [],
    constants: dsl.constants ?? [],
    planet: Object.keys(dsl.planet ?? {}),
    fieldTypes,
  };
}

function readsForTarget(actions, target, reads) {
  const readSet = new Set(reads);
  const deps = targetDependencies(actions, target, readSet);
  if (readSet.has(target)) deps.fields.add(target);
  return reads.filter((name) => deps.fields.has(name));
}

function filterActionsForTarget(actions, target) {
  const deps = targetDependencies(actions, target, new Set());
  return filterActionList(actions, target, deps.locals);
}

function targetDependencies(actions, target, readSet) {
  const letExprs = new Map();
  collectLetExprs(actions, letExprs);
  const locals = new Set();
  const fields = new Set();
  collectTargetDeps(actions, target, { locals, fields, readSet, conditions: [] });

  let changed = true;
  while (changed) {
    changed = false;
    for (const local of [...locals]) {
      const expr = letExprs.get(local);
      if (!expr) continue;
      const refs = exprRefs(expr, readSet);
      for (const name of refs.locals) {
        if (!locals.has(name)) {
          locals.add(name);
          changed = true;
        }
      }
      for (const name of refs.fields) fields.add(name);
    }
  }
  return { locals, fields };
}

function collectLetExprs(actions, out) {
  for (const action of actions) {
    if (action.type === "let") out.set(action.name, action.expr);
    else if (action.type === "when") collectLetExprs(action.actions ?? [], out);
  }
}

function collectTargetDeps(actions, target, ctx) {
  for (const action of actions) {
    if (action.type === "add" || action.type === "set") {
      if (action.field !== target) continue;
      collectExprDeps(action.expr, ctx);
      for (const condition of ctx.conditions) collectExprDeps(condition, ctx);
    } else if (action.type === "when") {
      collectTargetDeps(action.actions ?? [], target, {
        ...ctx,
        conditions: [...ctx.conditions, action.condition],
      });
    }
  }
}

function collectExprDeps(expr, ctx) {
  const refs = exprRefs(expr, ctx.readSet);
  for (const name of refs.locals) ctx.locals.add(name);
  for (const name of refs.fields) ctx.fields.add(name);
}

function exprRefs(expr, readSet) {
  const locals = new Set();
  const fields = new Set();
  visitExpr(expr, (name) => {
    if (readSet.has(name)) fields.add(name);
    else if (!RESERVED_IDENTIFIERS.has(name)) locals.add(name);
  });
  return { locals, fields };
}

function visitExpr(expr, onIdentifier) {
  if (!expr) return;
  switch (expr.type) {
    case "Identifier":
      onIdentifier(expr.name);
      break;
    case "Member":
      visitExpr(expr.object, onIdentifier);
      break;
    case "Unary":
      visitExpr(expr.expr, onIdentifier);
      break;
    case "Binary":
      visitExpr(expr.left, onIdentifier);
      visitExpr(expr.right, onIdentifier);
      break;
    case "Conditional":
      visitExpr(expr.test, onIdentifier);
      visitExpr(expr.consequent, onIdentifier);
      visitExpr(expr.alternate, onIdentifier);
      break;
    case "Call":
      visitExpr(expr.callee, onIdentifier);
      for (const arg of expr.args ?? []) visitExpr(arg, onIdentifier);
      break;
    case "NeighborReduce":
      // Legacy v1-shape: bindings carried on the node. v2 shape derives
      // bindings from CoordRead nodes inside the body, which the
      // CoordRead case below visits.
      for (const binding of expr.bindings ?? []) onIdentifier(binding.field);
      visitExpr(expr.body, onIdentifier);
      break;
    case "CoordRead":
      // CoordRead is a per-cell field read at some coordinate. The
      // surrounding stage / metric needs to know the field is read, so
      // we surface it as an Identifier hit.
      onIdentifier(expr.field);
      // Continuous-position coords (`@upstream`) carry expressions for
      // the velocity components and dt; their identifiers must be
      // walked so the pass's read set picks up vector fields like the
      // klausmeier `slope` referenced via `slope.x` / `slope.y`.
      if (expr.coord?.kind === "upstream") {
        visitExpr(expr.coord.velX, onIdentifier);
        visitExpr(expr.coord.velY, onIdentifier);
        visitExpr(expr.coord.dt, onIdentifier);
      }
      break;
  }
}

function filterActionList(actions, target, locals) {
  const out = [];
  for (const action of actions) {
    if (action.type === "let") {
      if (locals.has(action.name)) out.push(action);
    } else if (action.type === "add" || action.type === "set") {
      if (action.field === target) out.push(action);
    } else if (action.type === "when") {
      const nested = filterActionList(action.actions ?? [], target, locals);
      if (nested.length > 0) out.push({ ...action, actions: nested });
    }
  }
  return out;
}

// Walk the action body for v2 `field@prev` and `field@prev(N)` reads
// (and the legacy v1 `prev(IDENT)` Call shape). Returns ordered
// `{ field, depth }` entries, one per distinct (field, depth) pair —
// each pair gets its own bind slot so the cell pass can read multiple
// history depths of the same field independently.
function collectPrevReads(actions) {
  const out = [];
  const seen = new Set();
  function add(field, depth) {
    const key = `${field}@${depth}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ field, depth });
  }
  function visitAction(action) {
    if (!action) return;
    if (action.expr) walkExpr(action.expr);
    if (action.condition) walkExpr(action.condition);
    if (action.actions) action.actions.forEach(visitAction);
  }
  function walkExpr(expr) {
    if (!expr) return;
    if (expr.type === "CoordRead" && expr.coord?.kind === "prev") {
      add(expr.field, expr.coord.depth ?? 1);
      return;
    }
    if (expr.type === "Call" && expr.callee?.type === "Identifier" && expr.callee.name === "prev") {
      const arg = expr.args?.[0];
      if (arg?.type === "Identifier") add(arg.name, 1);
      return;
    }
    if (expr.type === "Member") walkExpr(expr.object);
    else if (expr.type === "Unary") walkExpr(expr.expr);
    else if (expr.type === "Binary") { walkExpr(expr.left); walkExpr(expr.right); }
    else if (expr.type === "Conditional") { walkExpr(expr.test); walkExpr(expr.consequent); walkExpr(expr.alternate); }
    else if (expr.type === "Call") {
      walkExpr(expr.callee);
      (expr.args ?? []).forEach(walkExpr);
    }
    else if (expr.type === "NeighborReduce") walkExpr(expr.body);
  }
  (actions ?? []).forEach(visitAction);
  return out;
}

function actionsUseNeighborReduce(actions) {
  for (const action of actions ?? []) {
    if (action.condition && exprUsesNeighborReduce(action.condition)) return true;
    if (action.expr && exprUsesNeighborReduce(action.expr)) return true;
    if (actionsUseNeighborReduce(action.actions)) return true;
  }
  return false;
}

function exprUsesNeighborReduce(expr) {
  if (!expr) return false;
  if (expr.type === "NeighborReduce") {
    if (expr.source?.kind === "kernel") return exprUsesNeighborReduce(expr.body);
    return true;
  }
  // gradient / divergence are stencil reads — they need the neighbor
  // topology buffers for the same reason a NeighborReduce does.
  if (expr.type === "Call" && expr.callee?.type === "Identifier"
      && (expr.callee.name === "gradient" || expr.callee.name === "divergence")) {
    return true;
  }
  // Continuous-position CoordRead (`field@upstream(...)`) gathers from
  // self + neighbors via inverse-distance weighting.
  if (expr.type === "CoordRead" && expr.coord?.kind === "upstream") return true;
  if (expr.type === "Member") return exprUsesNeighborReduce(expr.object);
  if (expr.type === "Unary") return exprUsesNeighborReduce(expr.expr);
  if (expr.type === "Binary") return exprUsesNeighborReduce(expr.left) || exprUsesNeighborReduce(expr.right);
  if (expr.type === "Conditional") return exprUsesNeighborReduce(expr.test) || exprUsesNeighborReduce(expr.consequent) || exprUsesNeighborReduce(expr.alternate);
  if (expr.type === "Call") return exprUsesNeighborReduce(expr.callee) || (expr.args ?? []).some(exprUsesNeighborReduce);
  return false;
}

function collectKernelSpecsFromActions(actions, layout) {
  const byKey = new Map();
  function walkAction(action) {
    if (!action) return;
    if (action.condition) walkExpr(action.condition);
    if (action.expr) walkExpr(action.expr);
    for (const child of action.actions ?? []) walkAction(child);
  }
  function walkExpr(expr) {
    if (!expr || typeof expr !== "object") return;
    if (expr.type === "NeighborReduce") {
      if (expr.source?.kind === "kernel") {
        const key = kernelSourceKey(expr.source);
        if (!byKey.has(key)) byKey.set(key, kernelSpecFromSource(expr.source, byKey.size, layout));
      }
      walkExpr(expr.body);
      return;
    }
    if (expr.type === "Member") walkExpr(expr.object);
    else if (expr.type === "Unary") walkExpr(expr.expr);
    else if (expr.type === "Binary") { walkExpr(expr.left); walkExpr(expr.right); }
    else if (expr.type === "Conditional") { walkExpr(expr.test); walkExpr(expr.consequent); walkExpr(expr.alternate); }
    else if (expr.type === "Call") {
      walkExpr(expr.callee);
      for (const arg of expr.args ?? []) walkExpr(arg);
    }
    else if (expr.type === "CoordRead" && expr.coord?.kind === "upstream") {
      walkExpr(expr.coord.velX);
      walkExpr(expr.coord.velY);
      walkExpr(expr.coord.dt);
    }
  }
  for (const action of actions ?? []) walkAction(action);
  return [...byKey.values()];
}

function kernelSpecFromSource(source, index, layout) {
  return {
    id: `kernel_${index}`,
    key: kernelSourceKey(source),
    kind: "kernel",
    kernel: "bell",
    center: kernelArgSpec(source.center, layout),
    width: kernelArgSpec(source.width, layout),
  };
}

function kernelArgSpec(arg, layout) {
  if (arg?.kind === "literal") return { kind: "literal", value: Number(arg.value) };
  if (arg?.kind === "param") {
    const decl = layout.parameters.find((item) => item.name === arg.name);
    return { kind: "param", name: arg.name, default: Number(decl?.default ?? 0) };
  }
  return { kind: "unknown" };
}

function kernelSourceKey(source) {
  return `bell:${kernelArgKey(source.center)}:${kernelArgKey(source.width)}`;
}

function kernelArgKey(arg) {
  if (arg?.kind === "literal") return `lit:${Number(arg.value)}`;
  if (arg?.kind === "param") return `param:${arg.name}`;
  return "unknown";
}

// Tangent-frame stencil helpers — emitted only when the cell body
// uses gradient(...) or divergence(...). Per-field functions look up
// the WGSL storage type via `typeOf(name)` so a divergence helper for
// a vec2 wind field reads `array<vec2<f32>>` correctly.
function emitStencilHelpers(ctx, typeOf) {
  const grads = [...(ctx.usedGradients ?? [])];
  const divs = [...(ctx.usedDivergences ?? [])];
  const upstreams = [...(ctx.usedUpstreams ?? [])];
  // The expression-arg gradient/divergence path also depends on the
  // shared `_stencil_position` / `_stencil_eastBasis` helpers, so
  // emit them whenever the inline lift was used even if no per-(
  // field) helpers fire.
  const inlineUsed = ctx.usedStencilInline === true;
  if (grads.length === 0 && divs.length === 0 && upstreams.length === 0 && !inlineUsed) return "";
  const blocks = [];
  // Shared helpers — emitted once per shader.
  blocks.push(`
fn _stencil_position(cell: u32) -> vec3<f32> {
  let off = cell * 3u;
  return vec3<f32>(positions[off + 0u], positions[off + 1u], positions[off + 2u]);
}

fn _stencil_eastBasis(p: vec3<f32>) -> vec3<f32> {
  let e = vec3<f32>(-p.z, 0.0, p.x);
  let len = length(e);
  if (len < 0.0001) {
    return vec3<f32>(1.0, 0.0, 0.0);
  }
  return e / len;
}
`.trim());
  // Per-(field) gradient helper — input must be a scalar f32 field.
  for (const fieldName of grads) {
    const t = typeOf(fieldName);
    if (t !== "f32") {
      throw new Error(`gradient(${fieldName}) requires a scalar (f32) field; got ${t}`);
    }
    blocks.push(`
fn _gradient_${fieldName}(cell: u32) -> vec2<f32> {
  let p = _stencil_position(cell);
  let east = _stencil_eastBasis(p);
  let north = normalize(cross(p, east));
  let center = f_${fieldName}[cell];
  let count = neighborCounts[cell];
  var acc = vec3<f32>(0.0, 0.0, 0.0);
  for (var slot: u32 = 0u; slot < count; slot = slot + 1u) {
    let n = u32(neighbors[cell * 6u + slot]);
    let q = _stencil_position(n);
    let tan = q - p * dot(q, p);
    let len2 = max(dot(tan, tan), 0.000001);
    acc = acc + tan * ((f_${fieldName}[n] - center) / len2);
  }
  acc = acc / f32(count);
  return vec2<f32>(dot(acc, east), dot(acc, north));
}
`.trim());
  }
  // Per-(field) upstream-sample helper — semi-Lagrangian backwards
  // walk along the cell's tangent velocity. Input field must be f32
  // for now (vec2 sampling is a future extension).
  for (const fieldName of upstreams) {
    const t = typeOf(fieldName);
    if (t !== "f32") {
      throw new Error(`${fieldName}@upstream(...) requires a scalar (f32) field; got ${t}`);
    }
    blocks.push(`
fn _upstream_${fieldName}(cell: u32, velX: f32, velY: f32, dt: f32) -> f32 {
  let p = _stencil_position(cell);
  let east = _stencil_eastBasis(p);
  let north = normalize(cross(p, east));
  let velocity = east * velX + north * velY;
  // Walk backward along velocity, project back to the unit sphere.
  // \`velocity * dt\` is the walk distance in sphere-radians: with
  // velocity in (sphere-radians per simulation second) and dt in
  // simulation seconds, one tick of unit-magnitude velocity moves
  // the sample point one sphere-radian along the tangent direction.
  let back = normalize(p - velocity * dt);
  // Inverse-distance² weighting over self + neighbors. Same shape
  // as the legacy ADVECT_WGSL kernel.
  var weightSum = 0.0;
  var valueSum = 0.0;
  let selfD2 = max(0.000001, 2.0 * (1.0 - dot(back, p)));
  let selfWeight = 1.0 / (selfD2 * selfD2);
  weightSum = weightSum + selfWeight;
  valueSum = valueSum + f_${fieldName}[cell] * selfWeight;
  let count = neighborCounts[cell];
  for (var slot: u32 = 0u; slot < count; slot = slot + 1u) {
    let n = u32(neighbors[cell * 6u + slot]);
    let q = _stencil_position(n);
    let d2 = max(0.000001, 2.0 * (1.0 - dot(back, q)));
    let weight = 1.0 / (d2 * d2);
    weightSum = weightSum + weight;
    valueSum = valueSum + f_${fieldName}[n] * weight;
  }
  return valueSum / weightSum;
}
`.trim());
  }
  // Per-(field) divergence helper — input must be a vec2 field.
  for (const fieldName of divs) {
    const t = typeOf(fieldName);
    if (t !== "vec2") {
      throw new Error(`divergence(${fieldName}) requires a vec2 field; got ${t}`);
    }
    blocks.push(`
fn _divergence_${fieldName}(cell: u32) -> f32 {
  let p = _stencil_position(cell);
  let east = _stencil_eastBasis(p);
  let north = normalize(cross(p, east));
  let centerVec = f_${fieldName}[cell];
  let centerWorld = east * centerVec.x + north * centerVec.y;
  let count = neighborCounts[cell];
  var div = 0.0;
  for (var slot: u32 = 0u; slot < count; slot = slot + 1u) {
    let nIdx = u32(neighbors[cell * 6u + slot]);
    let q = _stencil_position(nIdx);
    let tan = q - p * dot(q, p);
    let len2 = max(dot(tan, tan), 0.000001);
    let neast = _stencil_eastBasis(q);
    let nnorth = normalize(cross(q, neast));
    let neighborVec = f_${fieldName}[nIdx];
    let neighborWorld = neast * neighborVec.x + nnorth * neighborVec.y;
    div = div + dot(neighborWorld - centerWorld, tan) / len2;
  }
  return div / f32(count);
}
`.trim());
  }
  return blocks.join("\n\n");
}

const RESERVED_IDENTIFIERS = new Set([
  "true", "false", "dt", "frame", "PI", "TAU", "N", "x", "y", "u", "v", "lon", "lat", "px", "py", "pz", "i",
  "params", "consts", "planet",
  "neighbor", "prev",
  ...MATH_FUNCTIONS.map((fn) => fn.name),
]);

function compileActions(actions, ctx) {
  const out = [];
  // The reduction counter is shared across all actions in the stage so
  // the lifted accumulator names (`nr_<idx>`) don't collide. Single
  // underscore prefix only — WGSL reserves `__`-prefixed identifiers
  // and silently fails shader compilation if you sneak one through.
  if (ctx.nrCounter == null) ctx.nrCounter = { value: 0 };
  for (const action of actions) {
    if (action.type === "let") {
      const lifted = liftReductions(action.expr, ctx);
      out.push(...lifted.statements);
      out.push(`let ${action.name} = ${compileExpr(lifted.expr, ctx)};`);
      ctx.locals.add(action.name);
    } else if (action.type === "add") {
      if (action.field === ctx.target) {
        const lifted = liftReductions(action.expr, ctx);
        out.push(...lifted.statements);
        out.push(`outValue = outValue + ${compileAssignmentExpr(lifted.expr, ctx)};`);
      }
    } else if (action.type === "set") {
      if (action.field === ctx.target) {
        const lifted = liftReductions(action.expr, ctx);
        out.push(...lifted.statements);
        out.push(`outValue = ${compileAssignmentExpr(lifted.expr, ctx)};`);
      }
    } else if (action.type === "when") {
      const lifted = liftReductions(action.condition, ctx);
      out.push(...lifted.statements);
      out.push(`if (${compileExpr(lifted.expr, ctx)}) {`);
      const childCtx = { ...ctx, locals: new Set(ctx.locals) };
      out.push(indent(compileActions(action.actions ?? [], childCtx), 2));
      if (childCtx.usedStencilInline) ctx.usedStencilInline = true;
      out.push("}");
    } else {
      throw new Error(`Unsupported WebGPU geodesic cell action: ${action.type}`);
    }
  }
  return out.join("\n");
}

function compileAssignmentExpr(expr, ctx) {
  const compiled = compileExpr(expr, ctx);
  const fieldType = ctx.layout?.fieldTypes?.[ctx.target] ?? "f32";
  if ((fieldType === "u32" || fieldType === "bool") && expressionProducesBool(expr, ctx)) {
    return `select(0.0, 1.0, ${compiled})`;
  }
  return compiled;
}

function expressionProducesBool(expr, ctx) {
  if (!expr || typeof expr !== "object") return false;
  if (expr.type === "Identifier") {
    if (expr.name === "true" || expr.name === "false") return true;
    const paramDecl = ctx.layout?.parameters?.find((item) => item.name === expr.name);
    return paramDecl?.type === "boolean";
  }
  if (expr.type === "Unary") return expr.op === "!" || expr.op === "not";
  if (expr.type === "Binary") {
    return ["==", "!=", "<", "<=", ">", ">=", "&&", "||", "and", "or"].includes(expr.op);
  }
  if (expr.type === "Conditional") {
    return expressionProducesBool(expr.consequent, ctx) && expressionProducesBool(expr.alternate, ctx);
  }
  return false;
}

// Lift `NeighborReduce` nodes out of an expression — they can't compile
// to a single WGSL expression because they need a loop. For each one,
// emit a pre-statement reduction loop into `statements` and replace the
// node with an Identifier referring to the lifted accumulator.
//
// Nested reductions (a reduction inside another reduction's body) aren't
// supported on the geodesic substrate — we don't have neighbor-of-
// neighbor access — and the validator rejects them, so this function
// can assume the body is reduction-free and lift in a single pass.
function liftReductions(expr, ctx) {
  const statements = [];
  const rewritten = rewriteWithLifts(expr, ctx, statements);
  return { expr: rewritten, statements };
}

function rewriteWithLifts(expr, ctx, statements) {
  if (!expr) return expr;
  if (expr.type === "NeighborReduce") {
    return emitReduction(expr, ctx, statements);
  }
  if (expr.type === "Binary") {
    return {
      ...expr,
      left: rewriteWithLifts(expr.left, ctx, statements),
      right: rewriteWithLifts(expr.right, ctx, statements),
    };
  }
  if (expr.type === "Unary") {
    return { ...expr, expr: rewriteWithLifts(expr.expr, ctx, statements) };
  }
  if (expr.type === "Conditional") {
    return {
      ...expr,
      test: rewriteWithLifts(expr.test, ctx, statements),
      consequent: rewriteWithLifts(expr.consequent, ctx, statements),
      alternate: rewriteWithLifts(expr.alternate, ctx, statements),
    };
  }
  if (expr.type === "Call") {
    // gradient(EXPR) / divergence(EXPR) where EXPR isn't a bare field
    // identifier: lift to an inline statement-block that builds the
    // operator over the full expression, instead of rejecting at
    // compileCall. Bare-field calls fall through unchanged (they're
    // handled by the existing per-(field) helper-fn emission path).
    if (expr.callee?.type === "Identifier"
        && (expr.callee.name === "gradient" || expr.callee.name === "divergence")) {
      const arg = expr.args?.[0];
      if (arg && arg.type !== "Identifier") {
        return emitDifferentialOnExpression(expr.callee.name, arg, ctx, statements);
      }
    }
    return { ...expr, args: expr.args.map((arg) => rewriteWithLifts(arg, ctx, statements)) };
  }
  if (expr.type === "Member") {
    return { ...expr, object: rewriteWithLifts(expr.object, ctx, statements) };
  }
  return expr;
}

// gradient/divergence on an arbitrary cell-evaluable expression.
// Synthesises an inline statement block that evaluates the expression
// at the cell ("center") and at each neighbor, then assembles the
// tangent-frame stencil from those values. The expression is compiled
// twice — once with field reads pointing at `cell`, once with them
// pointing at the neighbor index — using the new
// ctx.fieldReadOverride hook in compileIdentifier.
//
// Constraints (enforced by the type checker upstream):
//   - gradient(EXPR): EXPR must produce f32 → returns vec2
//   - divergence(EXPR): EXPR must produce vec2 → returns f32
//
// Local references (`let` bindings) and reduction accumulators inside
// the expression resolve to their existing names — they're already in
// scope at the call site, and they're per-cell-uniform values that
// don't need re-evaluation at neighbors. Field references are the
// only thing that gets re-pointed.
function emitDifferentialOnExpression(opName, expr, ctx, statements) {
  const fieldType = ctx.layout?.fieldTypes ?? {};
  const idx = ctx.nrCounter.value++;
  const accName = `de_${idx}`;
  const indexLocal = `${accName}_n`;

  // The override re-points field reads. centerCtx evaluates at `cell`
  // (which is the current cell's WGSL local — the cell-shader's `let
  // cell = id.x` from the entry point), neighborCtx at `${indexLocal}`.
  const overrideForIndex = (indexExpr) => (name) => {
    const ftype = fieldType[name] ?? "f32";
    return wgslReadAt(name, ftype, indexExpr);
  };
  // currentCell is consumed by compileCall's gradient/divergence
  // branch when emitting the helper-fn invocation, so a nested
  // `gradient(c)` inside this expression evaluates at the right
  // cell — `_gradient_c(cell)` for self, `_gradient_c(de_0_n)` for
  // each neighbor.
  const centerCtx = {
    ...ctx,
    fieldReadOverride: overrideForIndex("cell"),
    currentCell: "cell",
  };
  const neighborCtx = {
    ...ctx,
    fieldReadOverride: overrideForIndex(indexLocal),
    currentCell: indexLocal,
  };
  const centerWgsl = compileExpr(expr, centerCtx);
  const neighborWgsl = compileExpr(expr, neighborCtx);

  // The op's return shape determines the accumulator's WGSL type and
  // the gather formula. gradient sums tangent · scalarDelta / |tan|²;
  // divergence accumulates per-component tangent-frame differences.
  if (opName === "gradient") {
    statements.push(`var ${accName}: vec2<f32>;`);
    statements.push(`{`);
    statements.push(`  let p = _stencil_position(cell);`);
    statements.push(`  let east = _stencil_eastBasis(p);`);
    statements.push(`  let north = normalize(cross(p, east));`);
    statements.push(`  let center: f32 = ${centerWgsl};`);
    statements.push(`  let count = neighborCounts[cell];`);
    statements.push(`  var acc = vec3<f32>(0.0, 0.0, 0.0);`);
    statements.push(`  for (var slot: u32 = 0u; slot < count; slot = slot + 1u) {`);
    statements.push(`    let ${indexLocal}: u32 = u32(neighbors[cell * 6u + slot]);`);
    statements.push(`    let q = _stencil_position(${indexLocal});`);
    statements.push(`    let tan = q - p * dot(q, p);`);
    statements.push(`    let len2 = max(dot(tan, tan), 0.000001);`);
    statements.push(`    let neighborVal: f32 = ${neighborWgsl};`);
    statements.push(`    acc = acc + tan * ((neighborVal - center) / len2);`);
    statements.push(`  }`);
    statements.push(`  acc = acc / f32(count);`);
    statements.push(`  ${accName} = vec2<f32>(dot(acc, east), dot(acc, north));`);
    statements.push(`}`);
    return { type: "Identifier", name: accName };
  }
  if (opName === "divergence") {
    statements.push(`var ${accName}: f32;`);
    statements.push(`{`);
    statements.push(`  let p = _stencil_position(cell);`);
    statements.push(`  let east = _stencil_eastBasis(p);`);
    statements.push(`  let north = normalize(cross(p, east));`);
    statements.push(`  let centerV: vec2<f32> = ${centerWgsl};`);
    statements.push(`  let count = neighborCounts[cell];`);
    statements.push(`  var divAcc: f32 = 0.0;`);
    statements.push(`  for (var slot: u32 = 0u; slot < count; slot = slot + 1u) {`);
    statements.push(`    let ${indexLocal}: u32 = u32(neighbors[cell * 6u + slot]);`);
    statements.push(`    let q = _stencil_position(${indexLocal});`);
    statements.push(`    let tan = q - p * dot(q, p);`);
    statements.push(`    let len2 = max(dot(tan, tan), 0.000001);`);
    statements.push(`    let neighborV: vec2<f32> = ${neighborWgsl};`);
    statements.push(`    let dEast: f32 = dot(tan, east);`);
    statements.push(`    let dNorth: f32 = dot(tan, north);`);
    statements.push(`    divAcc = divAcc + ((neighborV.x - centerV.x) * dEast + (neighborV.y - centerV.y) * dNorth) / len2;`);
    statements.push(`  }`);
    statements.push(`  ${accName} = divAcc / f32(count);`);
    statements.push(`  // Stencil helpers _stencil_position / _stencil_eastBasis`);
    statements.push(`  // get emitted into the prelude when ctx.usedStencil flag is set.`);
    statements.push(`}`);
    // Mark the stencil prelude as needed; emitStencilHelpers checks
    // this set in addition to the bare-field gradient/divergence
    // sets.
    ctx.usedStencilInline = true;
    return { type: "Identifier", name: accName };
  }
  throw new Error(`unsupported differential op: ${opName}`);
}

function emitReduction(node, ctx, statements) {
  const idx = ctx.nrCounter.value++;
  const accName = `nr_${idx}`;
  const slot = `${accName}_slot`;
  const count = `${accName}_count`;
  const neighborIdx = `${accName}_n`;
  const sumName = `${accName}_sum`;
  const source = normalizeNeighborSource(node.source);
  // The reduction's bindings come from one of two sources:
  //   - v2 CoordRead-shaped body: walk the body for every
  //     `CoordRead { coord: { kind: "neighbor", binding: node.coord } }`,
  //     collect distinct fields, synthesize one local per field
  //     (`_n_<field>`). The compiler then resolves CoordRead → the
  //     local at compile-expression time via `ctx.coordReadResolver`.
  //   - legacy v1-shape body: the parser pre-built `node.bindings`
  //     with `{ name, field }` entries; the body uses bare Identifier
  //     references to the synthetic names.
  // Both paths produce identical WGSL.
  let bindings;
  if (node.coord) {
    const fieldNames = collectNeighborFields(node.body, node.coord);
    if (fieldNames.length === 0) {
      throw new Error(`emitReduction: reduction over coord ${node.coord} reads no fields`);
    }
    bindings = fieldNames.map((field) => ({
      name: `_${node.coord}_${field}`,
      field,
    }));
  } else {
    bindings = node.bindings ?? [];
    if (bindings.length === 0) {
      throw new Error("emitReduction: NeighborReduce has no bindings");
    }
  }

  // Build a per-reduction CoordRead resolver: given a field name, return
  // the WGSL identifier that holds that field's value at the current
  // neighbor cell. Stacks with the outer ctx.coordReadResolver so a
  // body inside this reduction can also reference `u@prev` from the
  // surrounding cell.
  const coordReadResolver = makeCoordReadResolver({
    parent: ctx.coordReadResolver,
    neighborCoord: node.coord,
    bindingByField: new Map(bindings.map((b) => [b.field, b.name])),
  });

  const bodyLocals = new Set(ctx.locals);
  for (const b of bindings) bodyLocals.add(b.name);
  const bodyCtx = { ...ctx, locals: bodyLocals, coordReadResolver };
  const bodyWgsl = compileExpr(node.body, bodyCtx);

  // Detect the body's WGSL type. vec2 sum/mean reductions need a
  // vec2 accumulator; f32 keeps the original f32 path. The type
  // checker already rejected vec2 max/min upstream.
  const bodyType = inferReductionBodyType(node.body, bindings, ctx);
  const isVec2 = bodyType === "vec2";
  const wgslType = isVec2 ? "vec2<f32>" : "f32";
  const zeroLit = isVec2 ? "vec2<f32>(0.0, 0.0)" : "0.0";
  const fieldTypes = ctx.layout?.fieldTypes ?? {};

  const emitCandidate = (indexExpr, indent = "    ") => {
    statements.push(`${indent}let ${neighborIdx}: u32 = ${indexExpr};`);
    for (const b of bindings) {
      const fieldType = fieldTypes[b.field] ?? "f32";
      // Per-neighbor binding's local type — vec2 stays vec2<f32>, u32/
      // bool cast to f32 (so the body's expression stays in f32 land
      // even when the field is integer-stored).
      const localType = (fieldType === "u32" || fieldType === "bool") ? "f32" : wgslElemType(fieldType);
      statements.push(`${indent}let ${b.name}: ${localType} = ${wgslReadAt(b.field, fieldType, neighborIdx)};`);
    }
    if (node.op === "sum") {
      statements.push(`${indent}${accName} = ${accName} + (${bodyWgsl});`);
    } else if (node.op === "max" || node.op === "min") {
      statements.push(`${indent}${accName} = ${node.op}(${accName}, (${bodyWgsl}));`);
    } else if (node.op === "mean") {
      statements.push(`${indent}${sumName} = ${sumName} + (${bodyWgsl});`);
    }
  };

  if (node.op === "sum") {
    statements.push(`var ${accName}: ${wgslType} = ${zeroLit};`);
  } else if (node.op === "max") {
    statements.push(`var ${accName}: f32 = -1.0e38;`);
  } else if (node.op === "min") {
    statements.push(`var ${accName}: f32 = 1.0e38;`);
  } else if (node.op === "mean") {
    statements.push(`var ${sumName}: ${wgslType} = ${zeroLit};`);
    statements.push(`var ${accName}: ${wgslType} = ${zeroLit};`);
  } else {
    throw new Error(`Unsupported neighbor reduction op: ${node.op}`);
  }
  statements.push(`{`);
  if (source.kind === "neighbors") {
    statements.push(`  let ${count}: u32 = neighborCounts[cell];`);
    statements.push(`  for (var ${slot}: u32 = 0u; ${slot} < ${count}; ${slot} = ${slot} + 1u) {`);
    // Resolve neighbor cell index once per slot, then bind each requested
    // field's value at that neighbor. Multi-binding lets v2's
    // cell-centered reductions read multiple fields per neighbor in one
    // pass — `sum n in neighbors { u@n + v@n - u - v }` becomes
    // bindings = [{name: _n_u, field: u}, {name: _n_v, field: v}].
    //
    // Each binding's WGSL type matches the field's declared type, so
    // a vec2 field surfaces as `vec2<f32>` per-neighbor and downstream
    // member access (`heading@n.x` → `_n_heading.x`) compiles. Without
    // the per-field type lookup the bound local was always emitted as
    // `f32` and any vec2 field with a `.x`/`.y` access in the body
    // produced "expected f32, got vec2" at WGSL parse time.
    emitCandidate(`u32(neighbors[cell * 6u + ${slot}])`);
    statements.push(`  }`);
  } else if (source.kind === "ring" || source.kind === "disk") {
    const radius = source.radius;
    const targetCheck = source.kind === "ring"
      ? `${accName}_candidate_dist == ${radius}u`
      : `${accName}_candidate_dist >= 1u && ${accName}_candidate_dist <= ${radius}u`;
    statements.push(`  var ${count}: u32 = 0u;`);
    statements.push(`  var ${accName}_nodes: array<u32, 64>;`);
    statements.push(`  var ${accName}_dist: array<u32, 64>;`);
    statements.push(`  var ${accName}_total: u32 = 1u;`);
    statements.push(`  var ${accName}_cursor: u32 = 0u;`);
    statements.push(`  ${accName}_nodes[0] = cell;`);
    statements.push(`  ${accName}_dist[0] = 0u;`);
    statements.push(`  loop {`);
    statements.push(`    if (${accName}_cursor >= ${accName}_total) { break; }`);
    statements.push(`    let ${accName}_base: u32 = ${accName}_nodes[${accName}_cursor];`);
    statements.push(`    let ${accName}_base_dist: u32 = ${accName}_dist[${accName}_cursor];`);
    statements.push(`    ${accName}_cursor = ${accName}_cursor + 1u;`);
    statements.push(`    if (${accName}_base_dist >= ${radius}u) { continue; }`);
    statements.push(`    let ${accName}_base_count: u32 = neighborCounts[${accName}_base];`);
    statements.push(`    for (var ${slot}: u32 = 0u; ${slot} < ${accName}_base_count; ${slot} = ${slot} + 1u) {`);
    statements.push(`      let ${accName}_candidate: u32 = u32(neighbors[${accName}_base * 6u + ${slot}]);`);
    statements.push(`      var ${accName}_seen: bool = false;`);
    statements.push(`      for (var ${accName}_seen_i: u32 = 0u; ${accName}_seen_i < ${accName}_total; ${accName}_seen_i = ${accName}_seen_i + 1u) {`);
    statements.push(`        if (${accName}_nodes[${accName}_seen_i] == ${accName}_candidate) { ${accName}_seen = true; }`);
    statements.push(`      }`);
    statements.push(`      if (!${accName}_seen && ${accName}_total < 64u) {`);
    statements.push(`        let ${accName}_candidate_dist: u32 = ${accName}_base_dist + 1u;`);
    statements.push(`        ${accName}_nodes[${accName}_total] = ${accName}_candidate;`);
    statements.push(`        ${accName}_dist[${accName}_total] = ${accName}_candidate_dist;`);
    statements.push(`        ${accName}_total = ${accName}_total + 1u;`);
    statements.push(`        if (${targetCheck}) {`);
    statements.push(`          ${count} = ${count} + 1u;`);
    emitCandidate(`${accName}_candidate`, "          ");
    statements.push(`        }`);
    statements.push(`      }`);
    statements.push(`    }`);
    statements.push(`  }`);
  } else if (source.kind === "kernel") {
    const kernel = kernelSpecForSource(source, ctx);
    const weight = `${accName}_w`;
    const weightSum = `${accName}_weight_sum`;
    if (node.op !== "sum" && node.op !== "mean") {
      throw new Error(`Unsupported weighted kernel reduction op: ${node.op}`);
    }
    if (node.op === "mean") statements.push(`  var ${weightSum}: f32 = 0.0;`);
    statements.push(`  let ${accName}_start: u32 = k_${kernel.id}_offsets[cell];`);
    statements.push(`  let ${accName}_end: u32 = k_${kernel.id}_offsets[cell + 1u];`);
    statements.push(`  for (var ${slot}: u32 = ${accName}_start; ${slot} < ${accName}_end; ${slot} = ${slot} + 1u) {`);
    statements.push(`    let ${accName}_entry: MetricKernelEntry = k_${kernel.id}_entries[${slot}];`);
    statements.push(`    let ${weight}: f32 = ${accName}_entry.weight;`);
    const before = statements.length;
    emitCandidate(`${accName}_entry.index`);
    for (let i = before; i < statements.length; i++) {
      if (node.op === "sum" && statements[i].includes(`${accName} = ${accName} + (`)) {
        statements[i] = statements[i].replace(`(${bodyWgsl})`, `((${bodyWgsl}) * ${weight})`);
      } else if (node.op === "mean" && statements[i].includes(`${sumName} = ${sumName} + (`)) {
        statements[i] = statements[i].replace(`(${bodyWgsl})`, `((${bodyWgsl}) * ${weight})`);
      }
    }
    if (node.op === "mean") statements.push(`    ${weightSum} = ${weightSum} + ${weight};`);
    statements.push(`  }`);
  }
  if (node.op === "mean") {
    // Divide by count, with the empty-neighbor guard. WGSL's `select`
    // takes the same type for both branches, so the zero literal
    // matches the accumulator type. Vec2 / f32 → vec2 (component-
    // wise) is fine.
    if (source.kind === "kernel") {
      statements.push(`  ${accName} = select(${zeroLit}, ${sumName} / ${accName}_weight_sum, ${accName}_weight_sum > 0.0);`);
    } else {
      statements.push(`  ${accName} = select(${zeroLit}, ${sumName} / f32(${count}), ${count} > 0u);`);
    }
  }
  statements.push(`}`);

  return { type: "Identifier", name: accName };
}

function normalizeNeighborSource(source) {
  if (!source || source.kind === "neighbors") return { kind: "neighbors", radius: 1 };
  if (source.kind === "ring" || source.kind === "disk") {
    return { kind: source.kind, radius: source.radius };
  }
  if (source.kind === "kernel") return source;
  throw new Error(`Unsupported neighbor reduction source: ${source.kind}`);
}

function kernelSpecForSource(source, ctx) {
  const key = kernelSourceKey(source);
  const spec = (ctx.kernelSpecs ?? []).find((item) => item.key === key);
  if (!spec) throw new Error(`Kernel source not registered: ${key}`);
  return spec;
}

// Reduction body type is dictated by the data flowing through it.
// We need just enough type inference to choose between f32 and
// vec2 accumulators — a full re-run of the typechecker is overkill.
// Cases:
//   - CoordRead → field's declared type
//   - Member access (.x / .y) → always f32 (component extract)
//   - Identifier of a per-neighbor binding → bound field's type
//   - Identifier of self-field → field's declared type
//   - Call: vec2(...)/gradient(...) → vec2; length/divergence/most → f32
//   - Binary with any vec2 operand → vec2
//   - Unary / Conditional → recurse on operand / branches
// Anything else falls through to f32 (the safe default).
function inferReductionBodyType(ast, bindings, ctx) {
  if (!ast || typeof ast !== "object") return "f32";
  const fieldTypes = ctx.layout?.fieldTypes ?? {};
  // Field's expression type — u32/bool fields surface as f32 in cell
  // bodies (the WGSL compiler casts on read), so the reduction body's
  // accumulator follows that f32 view rather than the declared
  // storage type.
  const exprFieldType = (name) => {
    const t = fieldTypes[name];
    if (t === "vec2") return "vec2";
    return "f32";
  };
  const bindingType = (name) => {
    const binding = bindings.find((b) => b.name === name);
    if (!binding) return null;
    return exprFieldType(binding.field);
  };
  switch (ast.type) {
    case "Number":
      return "f32";
    case "Identifier": {
      // Per-neighbor binding (`_n_<field>`) — type matches the field
      // (in expression-space, where u32/bool surface as f32).
      const fromBinding = bindingType(ast.name);
      if (fromBinding) return fromBinding;
      // Self-field reference inside the reduction body.
      if (fieldTypes[ast.name]) return exprFieldType(ast.name);
      return "f32";
    }
    case "Member":
      // .x / .y on a vec2 always yields a scalar component.
      return "f32";
    case "Unary":
      return inferReductionBodyType(ast.expr, bindings, ctx);
    case "Binary": {
      const lt = inferReductionBodyType(ast.left, bindings, ctx);
      const rt = inferReductionBodyType(ast.right, bindings, ctx);
      return lt === "vec2" || rt === "vec2" ? "vec2" : "f32";
    }
    case "Conditional":
      return inferReductionBodyType(ast.consequent, bindings, ctx);
    case "Call": {
      const name = ast.callee?.name;
      if (name === "vec2" || name === "gradient") return "vec2";
      // length, divergence, dot, plus all the scalar math fns.
      return "f32";
    }
    case "CoordRead":
      return exprFieldType(ast.field);
    default:
      return "f32";
  }
}

function compileExpr(ast, ctx) {
  switch (ast.type) {
    case "Number":
      return wgslNumber(ast.value);
    case "Identifier":
      return compileIdentifier(ast.name, ctx);
    case "Member":
      return compileMember(ast, ctx);
    case "Unary":
      return `(${ast.op}${compileExpr(ast.expr, ctx)})`;
    case "Binary":
      return compileBinary(ast, ctx);
    case "Conditional":
      return `select(${compileExpr(ast.alternate, ctx)}, ${compileExpr(ast.consequent, ctx)}, ${compileExpr(ast.test, ctx)})`;
    case "Call":
      return compileCall(ast, ctx);
    case "CoordRead":
      return compileCoordRead(ast, ctx);
    default:
      throw new Error(`Unsupported WebGPU geodesic expression node: ${ast.type}`);
  }
}

// Coordinate-query lowering. The CoordRead AST node is the v2 unifying
// primitive — every `field@<coord>` syntax compiles through here. New
// coord kinds (continuous-position sampling, antipode, prev with
// non-1 offset) extend by adding cases.
function compileCoordRead(ast, ctx) {
  const coord = ast.coord;
  const fieldTypes = ctx.layout?.fieldTypes ?? {};
  const fieldType = fieldTypes[ast.field] ?? "f32";
  // Integer-storage fields cast to f32 on read; vec2/f32 surface
  // directly. wgslReadAt centralises the cast so a future bool/u32
  // history field reads as f32 in the per-cell expression just like
  // current-tick reads do.
  switch (coord.kind) {
    case "prev":
      return wgslReadAt(`${ast.field}_prev_${coord.depth ?? 1}`, fieldType, "cell");
    case "neighbor": {
      const resolver = ctx.coordReadResolver;
      const local = resolver?.(ast.field, coord.binding);
      if (!local) {
        throw new Error(
          `compileCoordRead: \`${ast.field}@${coord.binding}\` is not in scope of any \`<op> ${coord.binding} in neighbors|ring(k)|disk(k) { ... }\` reduction`,
        );
      }
      return local;
    }
    case "upstream": {
      // Continuous-position semi-Lagrangian sample. The compiler emits
      // a per-(field) helper function in the prelude (see
      // emitStencilHelpers); the call site passes the back-walk
      // parameters (east-velocity, north-velocity, dt).
      ctx.usedUpstreams ??= new Set();
      ctx.usedUpstreams.add(ast.field);
      const vx = compileExpr(coord.velX, ctx);
      const vy = compileExpr(coord.velY, ctx);
      const dt = compileExpr(coord.dt, ctx);
      return `_upstream_${ast.field}(cell, ${vx}, ${vy}, ${dt})`;
    }
    default:
      throw new Error(`compileCoordRead: unsupported coord kind "${coord.kind}"`);
  }
}

function makeCoordReadResolver({ parent, neighborCoord, bindingByField }) {
  return function resolve(field, coordName) {
    if (coordName === neighborCoord) {
      const local = bindingByField.get(field);
      if (!local) {
        throw new Error(`coord-read: reduction over ${coordName} doesn't bind field "${field}"`);
      }
      return local;
    }
    if (parent) return parent(field, coordName);
    return null;
  };
}

// Walk a NeighborReduce body for every CoordRead with the matching
// neighbor binding; return the distinct field names (preserves first-seen
// order for stable WGSL output / test goldens).
function collectNeighborFields(ast, coord) {
  const seen = new Set();
  const out = [];
  function walk(node) {
    if (!node || typeof node !== "object") return;
    if (node.type === "CoordRead" && node.coord?.kind === "neighbor" && node.coord.binding === coord) {
      if (!seen.has(node.field)) {
        seen.add(node.field);
        out.push(node.field);
      }
      return;
    }
    if (node.type === "NeighborReduce") {
      // Don't dive into another reduction's body — it has its own coord
      // scope and any inner CoordReads belong to it, not us.
      return;
    }
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") walk(v);
    }
  }
  walk(ast);
  return out;
}

function compileIdentifier(name, ctx) {
  if (name === "true" || name === "false") return name;
  if (ctx.locals.has(name)) return name;
  if (name === "dt") return "params.dt";
  if (name === "frame") return "params.frame";
  // Field-read override hook. By default a bare field name lowers to
  // the per-cell `v_<name>` local that compileCellShader pre-loads;
  // the override (set by the gradient/divergence-of-expression lift
  // path) replaces that with a custom per-cell-OR-neighbor read so
  // the same expression can be re-evaluated at any point on the
  // mesh. Stays untouched in the normal cell-body compile path.
  if (ctx.fieldReadOverride && ctx.reads.has(name)) {
    const override = ctx.fieldReadOverride(name);
    if (override) return override;
  }
  if (ctx.reads.has(name)) return readVar(name);
  // Bare param / const / planet references. Recipe-level uniqueness
  // (validateNameUniqueness) guarantees only one of these matches per
  // name. Each lives in the WGSL `Params` struct under a kind-prefixed
  // field; emit the right access here. Boolean params still get the
  // `(p_X != 0.0)` cast since the buffer is a `f32` either way.
  const paramDecl = ctx.layout.parameters.find((item) => item.name === name);
  if (paramDecl) {
    const value = `params.p_${name}`;
    return paramDecl.type === "boolean" ? `(${value} != 0.0)` : value;
  }
  if (ctx.layout.constants.find((item) => item.name === name)) return `params.c_${name}`;
  if (ctx.layout.planet.includes(name)) return `params.planet_${name}`;
  if (name === "PI" || name === "TAU" || name === "N") return name;
  if (name === "x" || name === "y" || name === "u" || name === "v" || name === "lon" || name === "lat" || name === "px" || name === "py" || name === "pz" || name === "i") return name;
  return name;
}

function compileMember(ast, ctx) {
  // The `params.` / `consts.` / `planet.` namespace forms are rejected
  // by the validator now — bare names are the only way in. Any other
  // member access falls through to plain JS-like `obj.prop`.
  return `${compileExpr(ast.object, ctx)}.${ast.prop}`;
}

function compileBinary(ast, ctx) {
  const left = compileExpr(ast.left, ctx);
  const right = compileExpr(ast.right, ctx);
  if (ast.op === "??") return `select(${right}, ${left}, ${left} == ${left})`;
  return `(${left} ${ast.op} ${right})`;
}

// Math-fn registry → name lookup. Built once at module load so per-call
// dispatch is a single Map.get rather than an array scan over
// MATH_FUNCTIONS. Adding a new fn = one entry in dsl-spec.MATH_FUNCTIONS;
// no edit here.
const MATH_BY_NAME = new Map(MATH_FUNCTIONS.map((fn) => [fn.name, fn]));

function compileCall(ast, ctx) {
  if (ast.callee.type !== "Identifier") throw new Error("Unsupported WebGPU geodesic call target");
  const name = ast.callee.name;
  // Special case: prev(IDENT) reads from the field's history binding,
  // not its current-tick read variable. Intercepted before generic
  // arg compilation — otherwise the inner Identifier would lower to
  // the current-tick read.
  if (name === "prev") {
    const arg = ast.args[0];
    if (arg?.type !== "Identifier") {
      throw new Error("prev requires a bare field identifier");
    }
    const fieldTypes = ctx.layout?.fieldTypes ?? {};
    const fieldType = fieldTypes[arg.name] ?? "f32";
    return wgslReadAt(`${arg.name}_prev_1`, fieldType, "cell");
  }
  // Tangent-frame differential operators. With a bare field identifier
  // the compiler emits a per-(field) helper function in the shader
  // prelude (see emitStencilHelpers). With an arbitrary expression
  // arg the lift in rewriteWithLifts has already replaced the call
  // with an Identifier referring to a synthesized accumulator, so by
  // the time we get here the arg is always an Identifier.
  //
  // The helper-fn call uses ctx.currentCell instead of hardcoded
  // "cell" so that when the compile is happening inside the
  // emitDifferentialOnExpression neighbor-eval loop, a nested
  // `gradient(c)` resolves to `_gradient_c(<neighborIdx>)` rather
  // than `_gradient_c(cell)`.
  if (name === "gradient" || name === "divergence") {
    const arg = ast.args[0];
    if (arg?.type !== "Identifier") {
      throw new Error(`${name} requires a bare field identifier (compiler bug — non-Identifier args should have been lifted by rewriteWithLifts)`);
    }
    const fieldName = arg.name;
    const cellExpr = ctx.currentCell ?? "cell";
    if (name === "gradient") {
      ctx.usedGradients ??= new Set();
      ctx.usedGradients.add(fieldName);
      return `_gradient_${fieldName}(${cellExpr})`;
    }
    ctx.usedDivergences ??= new Set();
    ctx.usedDivergences.add(fieldName);
    return `_divergence_${fieldName}(${cellExpr})`;
  }
  // Generic math-fn dispatch via the registry. Everything else flows
  // through here, including new fns added later — no switch update.
  const args = ast.args.map((arg) => compileExpr(arg, ctx));
  const fn = MATH_BY_NAME.get(name);
  if (fn?.wgsl) {
    if (fn.arity && !fn.arity.includes(args.length)) {
      throw new Error(`${name} expects ${fn.arity.join(" or ")} args; got ${args.length}`);
    }
    return fn.wgsl(args);
  }
  throw new Error(`Unsupported WebGPU geodesic function: ${name}`);
}

function wgslNumber(value) {
  const text = String(value);
  return /[.eE]/.test(text) ? text : `${text}.0`;
}

function readVar(name) {
  return `v_${name}`;
}

function indent(source, spaces) {
  const pad = " ".repeat(spaces);
  return source
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => `${pad}${line}`)
    .join("\n");
}
