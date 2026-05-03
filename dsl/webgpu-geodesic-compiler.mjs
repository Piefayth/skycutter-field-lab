// =============================================================================
// WebGPU geodesic DSL compiler slice.
//
// V2 has exactly one stage shape: `cell { … }`. Every kernel operation
// (diffusion, advection, gradient/divergence, reductions, history reads)
// is expressed as a per-cell expression body — the parser rejects v1's
// `wind`/`advect`/`diffuse`/`clamp`/`normalize` statement forms and the
// `each`/`event` stage shapes with redirect messages.
// =============================================================================

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
  // `field@prev` reads the named field's value as of the tick boundary.
  // The runtime keeps a separate `f_<name>_prev` buffer per history-
  // declared field; the compiler emits an additional binding for each
  // such field used by this pass. The set of prev-read field names is
  // intersected with `reads` because a stage that doesn't already read
  // a field shouldn't be allowed to peek at its prev value either —
  // that would silently bypass the `reads` declaration.
  const prevReads = collectPrevReads(targetActions).filter((name) => passReads.includes(name));
  return {
    kind: "cell",
    stageId: stage.id,
    key,
    field,
    reads: passReads,
    prevReads,
    layout,
    needsNeighbors,
    source: compileCellShader({
      stage,
      field,
      reads: passReads,
      prevReads,
      actions: targetActions,
      layout,
      needsNeighbors,
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

// Map field type → WGSL storage element type. Used by the cell shader
// to emit `array<f32>` vs `array<vec2<f32>>` etc. for storage buffer
// bindings, and to type the per-cell read locals.
function wgslElemType(fieldType) {
  if (fieldType === "vec2") return "vec2<f32>";
  return "f32";
}

function compileCellShader({ stage, field, reads, prevReads = [], actions, layout, needsNeighbors = false }) {
  const fieldTypes = layout.fieldTypes ?? {};
  const typeOf = (name) => fieldTypes[name] ?? "f32";
  const readBindings = reads.map((name, index) =>
    `@group(0) @binding(${index}) var<storage, read> f_${name}: array<${wgslElemType(typeOf(name))}>;`,
  );
  // Prev-read bindings sit between the regular reads and the output
  // binding so existing binding indices for params / positions /
  // neighbors only need to shift by `prevReads.length`.
  const prevReadBindings = prevReads.map(
    (name, index) => `@group(0) @binding(${reads.length + index}) var<storage, read> f_${name}_prev: array<${wgslElemType(typeOf(name))}>;`,
  );
  const outputBinding = reads.length + prevReads.length;
  const paramsBinding = outputBinding + 1;
  const positionsBinding = outputBinding + 2;
  const neighborsBinding = outputBinding + 3;
  const neighborCountsBinding = outputBinding + 4;
  // Per-cell read locals carry an explicit type annotation so vec2
  // fields don't get implicitly inferred as f32 (which would silently
  // collapse to the .x component on use).
  const readValues = reads.map((name) =>
    `  let ${readVar(name)}: ${wgslElemType(typeOf(name))} = f_${name}[cell];`,
  );
  const neighborBindings = needsNeighbors ? `
@group(0) @binding(${neighborsBinding}) var<storage, read> neighbors: array<i32>;
@group(0) @binding(${neighborCountsBinding}) var<storage, read> neighborCounts: array<u32>;
` : "";
  // Initial value for the per-cell `outValue` accumulator. For vec2
  // fields not in reads, default to vec2<f32>(0.0, 0.0); for f32, 0.0.
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
  };
  const body = compileActions(actions, ctx);
  // Tangent-frame stencil helpers are emitted only when the body uses
  // gradient / divergence. eastBasis + position are shared helpers
  // each operator depends on; emit once if either set is non-empty.
  const stencilHelperSource = emitStencilHelpers(ctx, typeOf);

  return `
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

fn hashLattice(c: vec3<i32>, seed: f32) -> f32 {
  var x = bitcast<u32>(c.x) * 73856093u ^ bitcast<u32>(c.y) * 19349663u ^ bitcast<u32>(c.z) * 83492791u;
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
  outputField[cell] = outValue;
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

// Walk the action body for v2 `field@prev` reads — CoordRead nodes with
// coord.kind === "prev". Returns the distinct field names (source-order).
// Legacy v1 `prev(IDENT)` Call shape is also recognized so the same
// helper works for any leftover v1-style AST.
function collectPrevReads(actions) {
  const out = [];
  const seen = new Set();
  function visitAction(action) {
    if (!action) return;
    if (action.expr) walkExpr(action.expr);
    if (action.condition) walkExpr(action.condition);
    if (action.actions) action.actions.forEach(visitAction);
  }
  function walkExpr(expr) {
    if (!expr) return;
    if (expr.type === "CoordRead" && expr.coord?.kind === "prev") {
      if (!seen.has(expr.field)) {
        seen.add(expr.field);
        out.push(expr.field);
      }
      return;
    }
    if (expr.type === "Call" && expr.callee?.type === "Identifier" && expr.callee.name === "prev") {
      const arg = expr.args?.[0];
      if (arg?.type === "Identifier" && !seen.has(arg.name)) {
        seen.add(arg.name);
        out.push(arg.name);
      }
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
  if (expr.type === "NeighborReduce") return true;
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

// Tangent-frame stencil helpers — emitted only when the cell body
// uses gradient(...) or divergence(...). Per-field functions look up
// the WGSL storage type via `typeOf(name)` so a divergence helper for
// a vec2 wind field reads `array<vec2<f32>>` correctly.
function emitStencilHelpers(ctx, typeOf) {
  const grads = [...(ctx.usedGradients ?? [])];
  const divs = [...(ctx.usedDivergences ?? [])];
  const upstreams = [...(ctx.usedUpstreams ?? [])];
  if (grads.length === 0 && divs.length === 0 && upstreams.length === 0) return "";
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
  "cellNoise", "cellRand", "wrapAngle", "max", "min", "abs", "sin", "asin", "cos", "exp", "sqrt", "pow", "smoothstep", "clamp", "hypot",
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
        out.push(`outValue = outValue + ${compileExpr(lifted.expr, ctx)};`);
      }
    } else if (action.type === "set") {
      if (action.field === ctx.target) {
        const lifted = liftReductions(action.expr, ctx);
        out.push(...lifted.statements);
        out.push(`outValue = ${compileExpr(lifted.expr, ctx)};`);
      }
    } else if (action.type === "when") {
      const lifted = liftReductions(action.condition, ctx);
      out.push(...lifted.statements);
      out.push(`if (${compileExpr(lifted.expr, ctx)}) {`);
      out.push(indent(compileActions(action.actions ?? [], { ...ctx, locals: new Set(ctx.locals) }), 2));
      out.push("}");
    } else {
      throw new Error(`Unsupported WebGPU geodesic cell action: ${action.type}`);
    }
  }
  return out.join("\n");
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
    return { ...expr, args: expr.args.map((arg) => rewriteWithLifts(arg, ctx, statements)) };
  }
  if (expr.type === "Member") {
    return { ...expr, object: rewriteWithLifts(expr.object, ctx, statements) };
  }
  return expr;
}

function emitReduction(node, ctx, statements) {
  const idx = ctx.nrCounter.value++;
  const accName = `nr_${idx}`;
  const slot = `${accName}_slot`;
  const count = `${accName}_count`;
  const neighborIdx = `${accName}_n`;
  const sumName = `${accName}_sum`;
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

  if (node.op === "sum") {
    statements.push(`var ${accName}: f32 = 0.0;`);
  } else if (node.op === "max") {
    statements.push(`var ${accName}: f32 = -1.0e38;`);
  } else if (node.op === "min") {
    statements.push(`var ${accName}: f32 = 1.0e38;`);
  } else if (node.op === "mean") {
    statements.push(`var ${sumName}: f32 = 0.0;`);
    statements.push(`var ${accName}: f32 = 0.0;`);
  } else {
    throw new Error(`Unsupported neighbor reduction op: ${node.op}`);
  }
  statements.push(`{`);
  statements.push(`  let ${count}: u32 = neighborCounts[cell];`);
  statements.push(`  for (var ${slot}: u32 = 0u; ${slot} < ${count}; ${slot} = ${slot} + 1u) {`);
  // Resolve neighbor cell index once per slot, then bind each requested
  // field's value at that neighbor. Multi-binding lets v2's
  // cell-centered reductions read multiple fields per neighbor in one
  // pass — `sum n in neighbors { u@n + v@n - u - v }` becomes
  // bindings = [{name: _n_u, field: u}, {name: _n_v, field: v}].
  statements.push(`    let ${neighborIdx}: u32 = u32(neighbors[cell * 6u + ${slot}]);`);
  for (const b of bindings) {
    statements.push(`    let ${b.name}: f32 = f_${b.field}[${neighborIdx}];`);
  }
  if (node.op === "sum") {
    statements.push(`    ${accName} = ${accName} + (${bodyWgsl});`);
  } else if (node.op === "max" || node.op === "min") {
    statements.push(`    ${accName} = ${node.op}(${accName}, (${bodyWgsl}));`);
  } else if (node.op === "mean") {
    statements.push(`    ${sumName} = ${sumName} + (${bodyWgsl});`);
  }
  statements.push(`  }`);
  if (node.op === "mean") {
    statements.push(`  ${accName} = select(0.0, ${sumName} / f32(${count}), ${count} > 0u);`);
  }
  statements.push(`}`);

  return { type: "Identifier", name: accName };
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
  switch (coord.kind) {
    case "prev":
      return `f_${ast.field}_prev[cell]`;
    case "neighbor": {
      const resolver = ctx.coordReadResolver;
      const local = resolver?.(ast.field, coord.binding);
      if (!local) {
        throw new Error(
          `compileCoordRead: \`${ast.field}@${coord.binding}\` is not in scope of any \`<op> ${coord.binding} in neighbors { ... }\` reduction`,
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

function compileCall(ast, ctx) {
  if (ast.callee.type !== "Identifier") throw new Error("Unsupported WebGPU geodesic call target");
  // Special case: prev(IDENT) reads from the field's history binding,
  // not its current-tick read variable. Intercepted before generic
  // arg compilation — otherwise the inner Identifier would lower to
  // the current-tick read (the bug the agent's review caught).
  if (ast.callee.name === "prev") {
    const arg = ast.args[0];
    if (arg?.type !== "Identifier") {
      throw new Error("prev requires a bare field identifier");
    }
    return `f_${arg.name}_prev[cell]`;
  }
  const args = ast.args.map((arg) => compileExpr(arg, ctx));
  // Vector constructors. `vec2(x, y)` lowers to the WGSL constructor;
  // future `vec3(x, y, z)` extends similarly. Catches a common authoring
  // case before the generic math-fn path (which would error: vec2 is
  // not in MATH_FUNCTIONS).
  if (ast.callee.name === "vec2") {
    if (args.length !== 2) {
      throw new Error(`vec2(x, y) takes exactly 2 args; got ${args.length}`);
    }
    return `vec2<f32>(${args.join(", ")})`;
  }
  // Tangent-frame differential operators. The argument is a bare field
  // identifier; the compiler emits a per-(field) helper function in
  // the shader prelude (see compileCellShader's stencilHelperSource).
  // The helper computes the operator over the cell's neighbors using
  // the position / east-basis helpers also emitted in the prelude.
  if (ast.callee.name === "gradient" || ast.callee.name === "divergence") {
    const arg = ast.args[0];
    if (arg?.type !== "Identifier") {
      throw new Error(`${ast.callee.name} requires a bare field identifier`);
    }
    const fieldName = arg.name;
    if (ast.callee.name === "gradient") {
      ctx.usedGradients ??= new Set();
      ctx.usedGradients.add(fieldName);
      return `_gradient_${fieldName}(cell)`;
    }
    ctx.usedDivergences ??= new Set();
    ctx.usedDivergences.add(fieldName);
    return `_divergence_${fieldName}(cell)`;
  }
  switch (ast.callee.name) {
    case "cellNoise": {
      // 1-arg: natural sphere scale. 2-arg: scale-multiplied sphere coords.
      const scale = args.length >= 2 ? args[1] : null;
      const coords = scale
        ? `(vec3<f32>(px, py, pz) * (${scale}))`
        : `vec3<f32>(px, py, pz)`;
      return `spatialNoise(${coords}, ${args[0]})`;
    }
    case "cellRand":
      // Pure per-cell hash on (cell index, seed). No spatial coherence.
      return `hashNoise(f32(i), ${args[0]})`;
    case "wrapAngle":
      // atan2(sin x, cos x) collapses any input range to [-π, π] without
      // a floor / mod sign-handling dance.
      return `atan2(sin(${args[0]}), cos(${args[0]}))`;
    case "max":
    case "min":
    case "abs":
    case "sin":
    case "asin":
    case "cos":
    case "atan2":
    case "exp":
    case "sqrt":
    case "pow":
    case "smoothstep":
    case "clamp":
    case "length":
      // WGSL `length` is polymorphic: scalars return abs, vectors
      // return magnitude. Both work, so emit identically.
      return `${ast.callee.name}(${args.join(", ")})`;
    case "hypot":
      return `length(vec2<f32>(${args.join(", ")}))`;
    default:
      throw new Error(`Unsupported WebGPU geodesic function: ${ast.callee.name}`);
  }
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
