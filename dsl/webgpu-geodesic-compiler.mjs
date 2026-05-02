// =============================================================================
// WebGPU geodesic DSL compiler slice.
//
// This targets storage-buffer compute on the geodesic runtime. The first
// supported surface is `cell {}` stage bodies because those are pure
// one-invocation-per-cell programs and map cleanly away from rectangular
// textures. Stencil primitives (wind, advect, reductions) stay hand-written.
// =============================================================================

export function compileWebGpuGeodesicPipeline(dsl = {}) {
  const stages = (dsl.stages ?? []).map((stage) => ({
    id: stage.id,
    name: stage.name,
    passes: compileWebGpuGeodesicStage(stage, dsl),
  }));
  const eventCounters = stages.flatMap((stage) => stage.passes)
    .filter((pass) => pass.eventCounter)
    .map((pass) => pass.eventCounter);
  return { stages, eventCounters };
}

export function compileWebGpuGeodesicStage(stage, dsl = {}) {
  const statements = stage.body?.statements ?? [];
  if (statements.length === 1 && statements[0].type === "cell") {
    return compileWebGpuGeodesicCellStage(stage, dsl);
  }
  if (statements.length === 1 && statements[0].type === "each") {
    return compileWebGpuGeodesicEachStage(stage, dsl);
  }
  if (statements.length === 1 && statements[0].type === "event") {
    return compileWebGpuGeodesicEventStage(stage, dsl);
  }
  const passes = [];
  for (const statement of statements) {
    if (statement.type === "diffuse") {
      passes.push({ kind: "diffuse", field: statement.field, amount: statement.amount });
    } else if (statement.type === "clamp") {
      passes.push({ kind: "clamp", field: statement.field, lo: statement.lo, hi: statement.hi });
    } else if (statement.type === "wind") {
      passes.push({
        kind: "wind",
        pressure: statement.pressure,
        windU: statement.windU,
        windV: statement.windV,
        lift: statement.lift,
        strength: statement.strength,
      });
    } else if (statement.type === "advect") {
      passes.push({
        kind: "advect",
        field: statement.field,
        windU: statement.windU,
        windV: statement.windV,
        dt: statement.dt,
      });
    } else if (statement.type === "normalize") {
      passes.push({
        kind: "normalize",
        field: statement.field,
        damping: statement.damping,
        condition: statement.condition,
      });
    } else {
      throw new Error(`${stage.id}: WebGPU geodesic primitive ${statement.type} is not supported yet`);
    }
  }
  return passes;
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

export function compileWebGpuGeodesicEachStage(stage, dsl = {}) {
  const statements = stage?.body?.statements ?? [];
  if (statements.length !== 1 || statements[0].type !== "each") {
    throw new Error(`${stage?.id ?? "stage"}: WebGPU geodesic each compiler requires a single each block`);
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
      key: `${stage.id}:each:${field}`,
    }),
  }));
}

export function compileWebGpuGeodesicEventStage(stage, dsl = {}) {
  const statements = stage?.body?.statements ?? [];
  if (statements.length !== 1 || statements[0].type !== "event") {
    throw new Error(`${stage?.id ?? "stage"}: WebGPU geodesic event compiler requires a single event block`);
  }

  const reads = stage.reads ?? [];
  const outputs = stage.outputs ?? [...(stage.writes ?? []), ...(stage.declares ?? [])];
  const layout = uniformLayout(dsl);
  const eventActions = [{
    type: "when",
    condition: statements[0].condition,
    actions: statements[0].actions ?? [],
  }];
  return outputs.map((field, index) => ({
    ...compileActionPass({
      stage,
      field,
      reads,
      actions: eventActions,
      layout,
      key: `${stage.id}:event:${field}`,
      eventCounter: index === 0 ? {
        key: stage.id,
        label: stage.name ?? stage.id,
        condition: statements[0].condition,
      } : null,
    }),
  }));
}

function compileActionPass({ stage, field, reads, actions, layout, key, eventCounter = null }) {
  const passReads = readsForTarget(actions, field, reads);
  const targetActions = filterActionsForTarget(actions, field);
  const needsNeighbors = actionsUseNeighborReduce(targetActions);
  return {
    kind: "cell",
    stageId: stage.id,
    key,
    field,
    reads: passReads,
    layout,
    needsNeighbors,
    eventCounter,
    source: compileCellShader({
      stage,
      field,
      reads: passReads,
      actions: targetActions,
      layout,
      needsNeighbors,
      eventCounter,
    }),
  };
}

export function buildWebGpuGeodesicUniforms(layout, { dt = 0, frame = 0, cellCount = 0, params = {}, consts = {}, planet = {} } = {}) {
  const values = [dt, frame, cellCount, 0];
  for (const decl of layout.parameters) values.push(Number(params[decl.name] ?? decl.default ?? 0));
  for (const decl of layout.constants) values.push(Number(consts[decl.name] ?? decl.value ?? 0));
  for (const name of layout.planet) values.push(Number(planet[name] ?? 0));
  return new Float32Array(values);
}

function compileCellShader({ stage, field, reads, actions, layout, needsNeighbors = false, eventCounter = null }) {
  const readBindings = reads.map((name, index) => `@group(0) @binding(${index}) var<storage, read> f_${name}: array<f32>;`);
  const outputBinding = reads.length;
  const paramsBinding = outputBinding + 1;
  const positionsBinding = outputBinding + 2;
  const neighborsBinding = outputBinding + 3;
  const neighborCountsBinding = outputBinding + 4;
  const eventCounterBinding = outputBinding + 3 + (needsNeighbors ? 2 : 0);
  const readValues = reads.map((name) => `  let ${readVar(name)} = f_${name}[cell];`);
  const neighborBindings = needsNeighbors ? `
@group(0) @binding(${neighborsBinding}) var<storage, read> neighbors: array<i32>;
@group(0) @binding(${neighborCountsBinding}) var<storage, read> neighborCounts: array<u32>;
` : "";
  const eventCounterBindingSource = eventCounter ? `
struct EventCounter {
  value: atomic<u32>,
};
@group(0) @binding(${eventCounterBinding}) var<storage, read_write> eventCounter: EventCounter;
` : "";
  // No per-field helper functions any more — `neighbor MOD ...` reductions
  // emit their loops inline at the call site (see compileActions). The
  // previous `neighborMax_${name}` global helpers became dead.
  const neighborFns = "";
  const initial = reads.includes(field) ? readVar(field) : "0.0";
  // The buffer layout includes the neighbor arrays whenever needsNeighbors
  // is true, but if the action body happens not to reference them in any
  // emitted statement (e.g. the loop is conditional on `when`-stripped
  // branches), WGSL would warn about unused bindings. The reduction
  // emission unconditionally references both arrays, so no touch hack.
  const neighborTouch = "";
  const body = compileActions(actions, {
    reads: new Set(reads),
    target: field,
    locals: new Set(),
    layout,
  });
  const eventCount = eventCounter ? `  if (${compileExpr(eventCounter.condition, {
    reads: new Set(reads),
    target: field,
    locals: new Set(),
    layout,
  })}) {
    atomicAdd(&eventCounter.value, 1u);
  }` : "";

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
@group(0) @binding(${outputBinding}) var<storage, read_write> outputField: array<f32>;
@group(0) @binding(${paramsBinding}) var<uniform> params: Params;
@group(0) @binding(${positionsBinding}) var<storage, read> positions: array<f32>;
${neighborBindings}
${eventCounterBindingSource}

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

${neighborFns}

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
${neighborTouch}
${readValues.join("\n")}
  var outValue = ${initial};
${eventCount}
${indent(body, 2)}
  outputField[cell] = outValue;
}
`.trim();
}

function uniformLayout(dsl) {
  return {
    parameters: dsl.parameters ?? [],
    constants: dsl.constants ?? [],
    planet: Object.keys(dsl.planet ?? {}),
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
      // The bound name shadows enclosing scope inside the body, but we
      // need the field name visible to the dependency walker so the
      // surrounding stage knows it's a read. Surface both.
      for (const binding of expr.bindings ?? []) onIdentifier(binding.field);
      visitExpr(expr.body, onIdentifier);
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
  if (expr.type === "Member") return exprUsesNeighborReduce(expr.object);
  if (expr.type === "Unary") return exprUsesNeighborReduce(expr.expr);
  if (expr.type === "Binary") return exprUsesNeighborReduce(expr.left) || exprUsesNeighborReduce(expr.right);
  if (expr.type === "Conditional") return exprUsesNeighborReduce(expr.test) || exprUsesNeighborReduce(expr.consequent) || exprUsesNeighborReduce(expr.alternate);
  if (expr.type === "Call") return exprUsesNeighborReduce(expr.callee) || (expr.args ?? []).some(exprUsesNeighborReduce);
  return false;
}

const RESERVED_IDENTIFIERS = new Set([
  "true", "false", "dt", "frame", "PI", "TAU", "N", "x", "y", "u", "v", "lon", "lat", "px", "py", "pz", "i",
  "params", "consts", "planet",
  "neighbor",
  "cellNoise", "max", "min", "abs", "sin", "asin", "cos", "exp", "sqrt", "pow", "smoothstep", "clamp", "hypot",
]);

function compileActions(actions, ctx) {
  const out = [];
  // The reduction counter is shared across all actions in the stage so
  // the lifted accumulator names (`__nr_<idx>`) don't collide.
  if (ctx.nrCounter == null) ctx.nrCounter = { value: 0 };
  for (const action of actions) {
    if (action.type === "let") {
      const lifted = liftReductions(action.expr, ctx);
      out.push(...lifted.statements);
      out.push(`let ${action.name} = ${compileExpr(lifted.expr, { ...ctx, locals: new Set([...ctx.locals, action.name]) })};`);
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
  const accName = `__nr_${idx}`;
  const slot = `${accName}_slot`;
  const count = `${accName}_count`;
  const sumName = `${accName}_sum`;
  const binding = node.bindings[0];

  // Compile the body with the binding in scope as a local. The body
  // itself can reference declared fields (which read as `v_<name>`,
  // i.e. the cell's value at stage entry — same as outside the body).
  const bodyCtx = { ...ctx, locals: new Set([...ctx.locals, binding.name]) };
  const bodyWgsl = compileExpr(node.body, bodyCtx);
  const fieldRead = `f_${binding.field}[u32(neighbors[cell * 6u + ${slot}])]`;

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
  statements.push(`    let ${binding.name}: f32 = ${fieldRead};`);
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
    default:
      throw new Error(`Unsupported WebGPU geodesic expression node: ${ast.type}`);
  }
}

function compileIdentifier(name, ctx) {
  if (name === "true" || name === "false") return name;
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
  if (ctx.locals.has(name)) return name;
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
  const args = ast.args.map((arg) => compileExpr(arg, ctx));
  switch (ast.callee.name) {
    case "cellNoise": {
      // 1-arg: natural sphere scale. 2-arg: scale-multiplied sphere coords.
      const scale = args.length >= 2 ? args[1] : null;
      const coords = scale
        ? `(vec3<f32>(px, py, pz) * (${scale}))`
        : `vec3<f32>(px, py, pz)`;
      return `spatialNoise(${coords}, ${args[0]})`;
    }
    case "max":
    case "min":
    case "abs":
    case "sin":
    case "asin":
    case "cos":
    case "exp":
    case "sqrt":
    case "pow":
    case "smoothstep":
    case "clamp":
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
