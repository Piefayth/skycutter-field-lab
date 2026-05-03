// Field Lab DSL v2 type checker.
//
// Lightweight scalar/vec2/bool type inference + assignment-mismatch
// checking for v2 stages, scenarios, stamps, and metric bodies. The
// reviewer flagged the absence of this layer: `set u = wind` (vec2
// assigned to f32 field) and `metric m = sum cells { wind }` (vec2
// inside a scalar reduction) compiled without complaint and only blew
// up at WGSL pipeline creation time with a cryptic shader-compile
// error. This module catches those at recipe-load time, with a clear
// DSL-level error message.
//
// Scope is intentionally minimal:
//   - Three types: "f32", "vec2", "bool"
//   - Field types come from the recipe's field declarations
//   - Params, consts, planet constants, geo builtins, clock builtins
//     are all f32
//   - Locals (`let name = expr`) inherit type from the RHS
//   - vec2 is supported via:
//       - vec2 fields,
//       - the `vec2(x, y)` constructor,
//       - `gradient(scalarField)` (vec2),
//       - `length(vec2)` (f32),
//       - `divergence(vec2Field)` (f32),
//       - `.x` / `.y` member access on a vec2 (f32),
//       - arithmetic mixing scalars and vec2s with WGSL-compatible
//         broadcast semantics,
//       - CoordRead (`field@<coord>`) inheriting the field's type.
//
// Anything we can't classify yields type "unknown" and falls through —
// the type checker NEVER errors on its own ignorance. It only fires
// when it has both source and target types and they don't match.

import { MATH_FUNCTIONS } from "./dsl-spec.mjs";

const KNOWN_TYPES = new Set(["f32", "vec2", "vec3", "bool", "unknown"]);

// Registry-backed math-fn dispatch. Each MATH_FUNCTIONS entry's
// argTypes / returnType drives the per-call type check; adding a new
// fn = one entry there, no edit here.
const MATH_BY_NAME = new Map(MATH_FUNCTIONS.map((fn) => [fn.name, fn]));

const F32_BUILTINS = new Set([
  "dt", "frame", "lon", "lat", "x", "y", "u", "v",
  "px", "py", "pz", "i", "N", "PI", "TAU", "r", "z",
]);

// Domain-specific builtins with extra-typecheck validation. Their
// signatures are in the registry; these constants are referenced by
// the typeOfCall special-case branches that need to inspect the
// declared type of the field-id argument.
const GRADIENT_BUILTIN = "gradient";
const DIVERGENCE_BUILTIN = "divergence";

// =============================================================================
// Public entry point
// =============================================================================

export function typecheckV2(schema) {
  const ctx = buildContext(schema);
  for (const stage of schema.stages ?? []) {
    typecheckStage(stage, ctx);
  }
  for (const stamp of schema.stamps ?? []) {
    typecheckScenarioOrStamp(stamp, ctx, "stamp");
  }
  for (const preset of schema.presets ?? []) {
    typecheckScenarioOrStamp(preset, ctx, "scenario");
  }
  for (const metric of schema.metrics ?? []) {
    typecheckMetric(metric, ctx);
  }
}

// =============================================================================
// Context
// =============================================================================

// Map a field's declared storage type to the type it surfaces with
// inside expressions. u32 / bool fields are integer-stored on the wire
// but cell-body arithmetic operates on the value as f32 (the WGSL
// compiler emits `f32(...)` casts on read and `u32(round(...))` casts
// on write). vec2 stays vec2; everything else f32.
function expressionTypeOf(declaredType) {
  if (declaredType === "vec2") return "vec2";
  if (declaredType === "vec3") return "vec3";
  return "f32";
}

function buildContext(schema) {
  // Preserve each field's *declared* type — checkFieldAssignment looks
  // it up to know whether to allow a bool RHS (for u32/bool storage,
  // bool is a natural source: `set alive = neighbors == 3`).
  const fieldTypes = new Map();
  for (const decl of schema.fields ?? []) {
    if (!decl?.name) continue;
    fieldTypes.set(decl.name, decl.type ?? "f32");
  }
  return { schema, fieldTypes };
}

// =============================================================================
// Stage walker
// =============================================================================

function typecheckStage(stage, ctx) {
  const label = `stage "${stage.id}"`;
  for (const statement of stage.body?.statements ?? []) {
    if (statement.type !== "cell") continue;
    typecheckActionList(statement.actions ?? [], new Map(), ctx, label);
  }
}

// =============================================================================
// Stamp / scenario walker
// =============================================================================

function typecheckScenarioOrStamp(decl, ctx, kind) {
  const label = `${kind} "${decl.id}"`;
  for (const action of decl.actions ?? []) {
    if (action.type === "fill") {
      checkFieldAssignment(action.field, action.value, ctx, `${label} fill`);
    } else if (action.type === "spot" || action.type === "ellipse" || action.type === "region") {
      // Position / size / angle args are always scalar.
      const positionalKeys = ["lon", "lat", "radius", "rx", "ry", "angle", "lonMin", "lonMax", "latMin", "latMax"];
      for (const key of positionalKeys) {
        const expr = action[key];
        if (!expr) continue;
        const t = typeOfExpr(expr, new Map(), ctx, `${label} ${action.type} ${key}`);
        if (t === "vec2" || t === "vec3") throwTypeError(`${label} ${action.type} ${key}: expected scalar, got ${t}`);
        if (t === "bool") throwTypeError(`${label} ${action.type} ${key}: expected scalar, got bool`);
      }
      // The `amount` expression must match the targeted field's type.
      // The runtime (visual/dsl-init-runtime.mjs:addGeodesicBlobAtVector)
      // explicitly rejects scalar amounts for vec2 fields and vec2
      // amounts for scalar fields — there is no broadcast. Catch the
      // mismatch here at recipe load instead of letting it surface as
      // a runtime error mid-paint.
      if (action.amount) {
        checkFieldAssignment(
          action.field,
          action.amount,
          ctx,
          `${label} ${action.type} amount on "${action.field}"`,
        );
      }
    } else if (action.type === "eachCell") {
      // `for each cell where PRED { … }`: type-check the optional
      // predicate as bool, then walk the body. Same shape as a `when`
      // condition but at the iteration boundary.
      if (action.predicate) {
        const t = typeOfExpr(action.predicate, new Map(), ctx, `${label} for each cell where`);
        if (t !== "bool" && t !== "unknown") {
          throwTypeError(`${label} for each cell where: expected bool predicate, got ${t}`);
        }
      }
      typecheckActionList(action.actions ?? [], new Map(), ctx, `${label} for each cell`);
    }
    // Other action types (e.g. raw set/add at scenario top level for
    // single-field assignments) flow through the same cell-action
    // checker.
  }
  // Scenarios also accept top-level cell-style actions (`set field = expr`).
  // The parser flattens those into the same `actions` array; if any are
  // cell-action shapes, run them through typecheckActionList too.
  const cellActions = (decl.actions ?? []).filter(
    (a) => a.type === "set" || a.type === "add" || a.type === "let" || a.type === "when",
  );
  if (cellActions.length > 0) {
    typecheckActionList(cellActions, new Map(), ctx, `${label} top-level`);
  }
}

// =============================================================================
// Cell-action list walker
// =============================================================================

function typecheckActionList(actions, locals, ctx, label) {
  for (const action of actions) {
    if (action.type === "let") {
      const t = typeOfExpr(action.expr, locals, ctx, `${label} let ${action.name}`);
      // Locals can be of any inferred type; record it for later refs.
      locals.set(action.name, t);
    } else if (action.type === "set" || action.type === "add") {
      checkFieldAssignment(action.field, action.expr, ctx, `${label} ${action.type} ${action.field}`, locals);
    } else if (action.type === "when") {
      const condType = typeOfExpr(action.condition, locals, ctx, `${label} when condition`);
      if (condType !== "bool" && condType !== "unknown") {
        throwTypeError(`${label} when condition: expected bool, got ${condType}`);
      }
      typecheckActionList(action.actions ?? [], new Map(locals), ctx, `${label} when`);
    }
  }
}

function checkFieldAssignment(fieldName, expr, ctx, label, locals = new Map()) {
  const declaredType = ctx.fieldTypes.get(fieldName);
  if (!declaredType) {
    // Field not declared — let the v1 validator surface that. Type
    // checker stays out of identifier resolution.
    return;
  }
  const fieldType = expressionTypeOf(declaredType);
  const exprType = typeOfExpr(expr, locals, ctx, label);
  if (exprType === "unknown") return;
  // Bool RHS is acceptable for integer-storage fields (u32 / bool).
  // The WGSL emit casts to u32 on write, and bool→u32 is the natural
  // mapping (`true` → 1, `false` → 0). For f32 fields we still
  // require explicit ternary.
  const integerStored = declaredType === "u32" || declaredType === "bool";
  if (integerStored && exprType === "bool") return;
  if (exprType !== fieldType) {
    throwTypeError(
      `${label}: type mismatch — assigning ${exprType} to ${fieldType} field "${fieldName}". ` +
      (fieldType === "f32" && exprType === "vec2"
        ? `Take a component (e.g. \`${fieldName} = ${stringifyExprBest(expr)}.x\`), ` +
          `or use \`length(...)\` / \`divergence(...)\` to reduce to a scalar.`
        : fieldType === "vec2" && exprType === "f32"
          ? `Wrap the scalar with \`vec2(x, y)\`, or assign to a scalar field instead.`
          : `Adjust the right-hand side or the field's type to match.`),
    );
  }
}

// =============================================================================
// Metric walker
// =============================================================================

function typecheckMetric(metric, ctx) {
  const label = `metric "${metric.id}"`;
  if (metric.body) {
    const t = typeOfExpr(metric.body, new Map(), ctx, label);
    if (t === "vec2") {
      throwTypeError(
        `${label}: ${metric.op} body produces a vec2. Reductions sum scalars over the grid; ` +
        `take a component (\`.x\` / \`.y\`) or call \`length(...)\` to get a scalar magnitude.`,
      );
    }
    if (t === "bool" && metric.op !== "count") {
      // validateMetrics already flags this for the obvious top-level
      // boolean shapes; the type checker catches subtler cases (a let
      // bound to a comparison, then referenced).
      throwTypeError(
        `${label}: ${metric.op} body produces a bool. Use \`count cells where <pred>\` ` +
        `for "fraction of cells matching", or \`mean cells { <pred> ? 1 : 0 }\`.`,
      );
    }
  }
  if (metric.predicate) {
    const t = typeOfExpr(metric.predicate, new Map(), ctx, `${label} where`);
    if (t !== "bool" && t !== "unknown") {
      throwTypeError(`${label} where clause: expected bool predicate, got ${t}`);
    }
  }
}

// =============================================================================
// Type inference for expressions
// =============================================================================

function typeOfExpr(ast, locals, ctx, label) {
  if (!ast || typeof ast !== "object") return "unknown";
  switch (ast.type) {
    case "Number":
      return "f32";
    case "Identifier":
      return typeOfIdentifier(ast.name, locals, ctx);
    case "Member":
      return typeOfMember(ast, locals, ctx, label);
    case "Unary":
      return typeOfUnary(ast, locals, ctx, label);
    case "Binary":
      return typeOfBinary(ast, locals, ctx, label);
    case "Conditional":
      return typeOfConditional(ast, locals, ctx, label);
    case "Call":
      return typeOfCall(ast, locals, ctx, label);
    case "NeighborReduce":
      // Neighbor reductions over a per-cell expression collapse to a
      // scalar regardless of body — vec2 reduction isn't implemented
      // in the kernel emitter today (it would need component-wise
      // accumulators). Reject vec2 bodies here so the failure is at
      // recipe load, not WGSL emit time.
      return typeOfNeighborReduce(ast, locals, ctx, label);
    case "CoordRead": {
      // Walk coord-arg expressions so vec2/scalar mismatches inside
      // `field@upstream(velX, velY, dt)` are caught at recipe load.
      // Without this, `set u = u@upstream(some_vec2, 0, dt)` would
      // compile clean and only fail at WGSL emit time.
      if (ast.coord?.kind === "upstream") {
        const argLabel = `${label} (${ast.field}@upstream args)`;
        const tx = typeOfExpr(ast.coord.velX, locals, ctx, argLabel);
        const ty = typeOfExpr(ast.coord.velY, locals, ctx, argLabel);
        const tdt = typeOfExpr(ast.coord.dt, locals, ctx, argLabel);
        for (const [t, name] of [[tx, "velX"], [ty, "velY"], [tdt, "dt"]]) {
          if (t === "vec2") throwTypeError(`${argLabel}: ${name} must be a scalar, got vec2`);
          if (t === "bool") throwTypeError(`${argLabel}: ${name} must be a scalar, got bool`);
        }
      }
      const declared = ctx.fieldTypes.get(ast.field);
      return declared ? expressionTypeOf(declared) : "unknown";
    }
    default:
      return "unknown";
  }
}

function typeOfIdentifier(name, locals, ctx) {
  if (name === "true" || name === "false") return "bool";
  if (locals.has(name)) return locals.get(name);
  // Field reads surface as the field's *expression* type — u32/bool
  // fields carry as f32 inside expressions (the WGSL emit casts on
  // read). vec2 fields stay vec2.
  if (ctx.fieldTypes.has(name)) return expressionTypeOf(ctx.fieldTypes.get(name));
  if (F32_BUILTINS.has(name)) return "f32";
  const paramType = paramTypeOf(name, ctx);
  if (paramType) return paramType;
  if (constOrPlanet(name, ctx)) return "f32";
  return "unknown";
}

// Toggle params surface in the recipe AST with `type === "boolean"` —
// the DSL treats them as bool (`when enabled { ... }`) even though they
// pack as f32 0/1 on the wire. Slider params are scalar.
function paramTypeOf(name, ctx) {
  for (const p of ctx.schema.parameters ?? []) {
    if (p?.name !== name) continue;
    return p.type === "boolean" ? "bool" : "f32";
  }
  return null;
}

function constOrPlanet(name, ctx) {
  for (const c of ctx.schema.constants ?? []) if (c?.name === name) return true;
  if (ctx.schema.planet && Object.prototype.hasOwnProperty.call(ctx.schema.planet, name)) return true;
  return false;
}

function typeOfMember(ast, locals, ctx, label) {
  const objType = typeOfExpr(ast.object, locals, ctx, label);
  if (objType === "vec2") {
    if (ast.prop === "x" || ast.prop === "y") return "f32";
    throwTypeError(`${label}: vec2 has no member "${ast.prop}" (only .x / .y)`);
  }
  if (objType === "vec3") {
    if (ast.prop === "x" || ast.prop === "y" || ast.prop === "z") return "f32";
    throwTypeError(`${label}: vec3 has no member "${ast.prop}" (only .x / .y / .z)`);
  }
  // Brush.* / similar struct-shaped builtins are scalar-component
  // accesses; we don't model them yet, fall through.
  return "unknown";
}

function typeOfUnary(ast, locals, ctx, label) {
  const operandType = typeOfExpr(ast.expr, locals, ctx, label);
  if (ast.op === "!") {
    if (operandType !== "bool" && operandType !== "unknown") {
      throwTypeError(`${label}: \`!\` expects bool, got ${operandType}`);
    }
    return "bool";
  }
  if (ast.op === "-" || ast.op === "+") {
    if (operandType === "bool") {
      throwTypeError(`${label}: unary \`${ast.op}\` is not defined on bool`);
    }
    return operandType === "unknown" ? "unknown" : operandType;
  }
  return "unknown";
}

function typeOfBinary(ast, locals, ctx, label) {
  const op = ast.op;
  const leftType = typeOfExpr(ast.left, locals, ctx, label);
  const rightType = typeOfExpr(ast.right, locals, ctx, label);

  if (op === "&&" || op === "||") {
    if (leftType !== "bool" && leftType !== "unknown") {
      throwTypeError(`${label}: \`${op}\` expects bool on the left, got ${leftType}`);
    }
    if (rightType !== "bool" && rightType !== "unknown") {
      throwTypeError(`${label}: \`${op}\` expects bool on the right, got ${rightType}`);
    }
    return "bool";
  }

  if (op === "==" || op === "!=" || op === "<" || op === ">" || op === "<=" || op === ">=") {
    for (const t of [leftType, rightType]) {
      if (t === "vec2" || t === "vec3") {
        throwTypeError(`${label}: comparison \`${op}\` is not defined on ${t} (compare per-component instead, e.g. \`v.x ${op} ...\`)`);
      }
      if (t === "bool") {
        throwTypeError(`${label}: comparison \`${op}\` is not defined on bool`);
      }
    }
    return "bool";
  }

  // Arithmetic +, -, *, /
  if (leftType === "bool" || rightType === "bool") {
    throwTypeError(`${label}: arithmetic \`${op}\` is not defined on bool`);
  }
  // Mixing vec2 and vec3 doesn't broadcast cleanly — reject explicitly.
  if ((leftType === "vec2" && rightType === "vec3") || (leftType === "vec3" && rightType === "vec2")) {
    throwTypeError(`${label}: cannot mix vec2 and vec3 in \`${op}\` — extract components or use a uniform vec type`);
  }
  // Same-vec arithmetic.
  if (leftType === "vec2" && rightType === "vec2") return "vec2";
  if (leftType === "vec3" && rightType === "vec3") return "vec3";
  // Vec * scalar / scalar * vec broadcasts (WGSL supports both for + - * /).
  if (leftType === "vec2" && rightType === "f32") return "vec2";
  if (leftType === "f32" && rightType === "vec2") return "vec2";
  if (leftType === "vec3" && rightType === "f32") return "vec3";
  if (leftType === "f32" && rightType === "vec3") return "vec3";
  if (leftType === "f32" && rightType === "f32") return "f32";
  // unknown propagates the vec type if exactly one side is known.
  if (leftType === "vec2" || rightType === "vec2") return "vec2";
  if (leftType === "vec3" || rightType === "vec3") return "vec3";
  return "unknown";
}

function typeOfConditional(ast, locals, ctx, label) {
  const testType = typeOfExpr(ast.test, locals, ctx, label);
  if (testType !== "bool" && testType !== "unknown") {
    throwTypeError(`${label}: ternary test expects bool, got ${testType}`);
  }
  const consType = typeOfExpr(ast.consequent, locals, ctx, label);
  const altType = typeOfExpr(ast.alternate, locals, ctx, label);
  if (consType === "unknown") return altType;
  if (altType === "unknown") return consType;
  if (consType !== altType) {
    throwTypeError(`${label}: ternary branches have different types (${consType} vs ${altType})`);
  }
  return consType;
}

function typeOfCall(ast, locals, ctx, label) {
  const callee = ast.callee;
  if (callee?.type !== "Identifier") return "unknown";
  const name = callee.name;
  const args = ast.args ?? [];

  // gradient and divergence accept either a bare field identifier
  // (compiled via the per-(field) helper-fn path) or an arbitrary
  // cell-evaluable expression (lifted to an inline statement block
  // by emitDifferentialOnExpression). Both forms validate the
  // argument's *type*: gradient wants f32, divergence wants vec2.
  // Expression args additionally have to be free of let-bound
  // locals — the lift evaluates the expression at every neighbor,
  // and a local would resolve to its cell-uniform value at every
  // neighbor (silently wrong stencil result). If you need an
  // intermediate, promote it to a derived field or inline the
  // expression directly.
  if (name === GRADIENT_BUILTIN) {
    if (args.length !== 1) {
      throwTypeError(`${label}: gradient(...) expects 1 argument, got ${args.length}`);
    }
    if (args[0].type === "Identifier") {
      // Bare-field form. Identifier could be a local (rejected) or
      // a declared field (the only sensible form).
      const idName = args[0].name;
      if (locals.has(idName)) {
        throwTypeError(stencilLocalsError(label, "gradient", idName));
      }
      const ftype = ctx.fieldTypes.get(idName);
      if (ftype === "vec2") {
        throwTypeError(`${label}: gradient(${idName}) — gradient is only defined on scalar (f32) fields`);
      }
    } else {
      assertNoLocalsInStencilArg(args[0], locals, label, "gradient");
      const argType = typeOfExpr(args[0], locals, ctx, label);
      if (argType !== "f32" && argType !== "unknown") {
        throwTypeError(`${label}: gradient(...) expects a scalar (f32) argument, got ${argType}`);
      }
    }
    return "vec2";
  }
  if (name === DIVERGENCE_BUILTIN) {
    if (args.length !== 1) {
      throwTypeError(`${label}: divergence(...) expects 1 argument, got ${args.length}`);
    }
    if (args[0].type === "Identifier") {
      const idName = args[0].name;
      if (locals.has(idName)) {
        throwTypeError(stencilLocalsError(label, "divergence", idName));
      }
      const ftype = ctx.fieldTypes.get(idName);
      if (ftype && ftype !== "vec2") {
        throwTypeError(`${label}: divergence(${idName}) — divergence is only defined on vec2 fields`);
      }
    } else {
      assertNoLocalsInStencilArg(args[0], locals, label, "divergence");
      const argType = typeOfExpr(args[0], locals, ctx, label);
      if (argType !== "vec2" && argType !== "unknown") {
        throwTypeError(`${label}: divergence(...) expects a vec2 argument, got ${argType}`);
      }
    }
    return "f32";
  }

  // Generic registry-backed dispatch. Each MATH_FUNCTIONS entry's
  // argTypes / returnType drives the type check; future fns drop one
  // entry in dsl-spec.mjs and flow through here automatically.
  const fn = MATH_BY_NAME.get(name);
  if (fn) {
    if (fn.arity && !fn.arity.includes(args.length)) {
      throwTypeError(`${label}: ${name}(...) expects ${fn.arity.join(" or ")} arguments, got ${args.length}`);
    }
    for (let i = 0; i < args.length; i++) {
      const t = typeOfExpr(args[i], locals, ctx, label);
      // Match each arg against argTypes[i], with `argTypes` cycled
      // when shorter than args (covers variadic-style fns where every
      // arg has the same type, e.g. `min(a, b)` declared as ["f32",
      // "f32"] but the parser sees `min(a)` too — registry's arity
      // gates the count).
      const expected = fn.argTypes?.[Math.min(i, fn.argTypes.length - 1)] ?? "any";
      if (expected === "any") continue;
      if (expected === "fieldId") {
        if (args[i]?.type !== "Identifier") {
          throwTypeError(`${label}: ${name}(...) argument ${i + 1} must be a bare field identifier`);
        }
        continue;
      }
      if (t !== expected && t !== "unknown") {
        throwTypeError(`${label}: ${name}(...) argument ${i + 1} must be a ${expected}, got ${t}`);
      }
    }
    return fn.returnType ?? "unknown";
  }

  // Unknown function — let the v1 validator's identifier check surface
  // it. Walk args anyway to type-check inside them.
  for (const arg of args) typeOfExpr(arg, locals, ctx, label);
  return "unknown";
}

function typeOfNeighborReduce(ast, locals, ctx, label) {
  const bodyLabel = `${label} ${ast.op}-reduction`;
  if (ast.source?.kind === "kernel" && (ast.op === "max" || ast.op === "min")) {
    throwTypeError(`${bodyLabel}: weighted kernel reductions support sum/mean only; max/min do not have weighted semantics`);
  }
  // Legacy v1-shape bindings — pre-neighbor field name + value name.
  // The v2 shape uses CoordRead inside the body and doesn't go through
  // this branch.
  const innerLocals = new Map(locals);
  for (const binding of ast.bindings ?? []) {
    const declared = ctx.fieldTypes.get(binding.field);
    if (declared === "vec2") {
      throwTypeError(`${bodyLabel}: binding "${binding.name}" is bound to vec2 field "${binding.field}" — v1-shape bindings only carry scalar values`);
    }
    innerLocals.set(binding.name, declared ? expressionTypeOf(declared) : "unknown");
  }
  const bodyType = typeOfExpr(ast.body, innerLocals, ctx, bodyLabel);
  if (bodyType === "bool") {
    throwTypeError(`${bodyLabel}: neighbor reduction body produces a bool — reductions accumulate numeric values`);
  }
  // Vec2 bodies are now allowed for `sum` and `mean` — accumulator is
  // `vec2<f32>(0, 0)` and the per-neighbor value adds component-wise.
  // `max` / `min` over vec2 has no clean meaning (component-wise max
  // is rarely what you want — does pyramid.x = max(a.x, b.x), .y =
  // max(a.y, b.y) get you anywhere?), so reject those explicitly with
  // a redirect.
  if (bodyType === "vec2") {
    if (ast.op === "max" || ast.op === "min") {
      throwTypeError(`${bodyLabel}: ${ast.op} over a vec2 isn't well-defined — split into per-component reductions or take \`length(...)\` if you want magnitude`);
    }
    return "vec2";
  }
  return "f32";
}

// =============================================================================
// Diagnostics helpers
// =============================================================================

function throwTypeError(message) {
  throw new Error(message);
}

// Stencil-arg validation: gradient(...) and divergence(...) get
// evaluated at every neighbor of the cell, so any free identifier
// inside the argument expression has to make sense at neighbor
// positions too. Local `let`-bindings DON'T — they're computed once
// per cell and would resolve to the cell-uniform value at every
// neighbor evaluation, silently producing the wrong stencil result.
// Walk the argument expression and reject any reference to a name
// that's currently in the locals scope.
function assertNoLocalsInStencilArg(ast, locals, label, opName) {
  if (!ast || typeof ast !== "object") return;
  if (ast.type === "Identifier" && locals.has(ast.name)) {
    throwTypeError(stencilLocalsError(label, opName, ast.name));
  }
  // NeighborReduce introduces its own bindings — stop descending so
  // we don't complain about the reduction's own coord name. (And the
  // user shouldn't be putting reductions inside stencil args anyway;
  // that has its own validity issues.)
  if (ast.type === "NeighborReduce") return;
  for (const k of Object.keys(ast)) {
    const v = ast[k];
    if (Array.isArray(v)) v.forEach((c) => assertNoLocalsInStencilArg(c, locals, label, opName));
    else if (v && typeof v === "object") assertNoLocalsInStencilArg(v, locals, label, opName);
  }
}

function stencilLocalsError(label, opName, localName) {
  return (
    `${label}: ${opName}(...) argument references local "${localName}". ` +
    `Locals are computed once per cell, so they'd evaluate to the same ` +
    `value at every neighbor and produce a wrong stencil result. Either ` +
    `inline the expression directly into ${opName}(...), or promote ` +
    `"${localName}" to a derived field with its own stage so the value ` +
    `exists per-neighbor.`
  );
}

// Best-effort source-string for an expression — used to build helpful
// "did you mean .x?" suggestions in error messages. Not a faithful
// printer; just enough for a one-line hint.
function stringifyExprBest(ast) {
  if (!ast || typeof ast !== "object") return "...";
  switch (ast.type) {
    case "Number":     return String(ast.value);
    case "Identifier": return ast.name;
    case "Member":     return `${stringifyExprBest(ast.object)}.${ast.prop}`;
    case "Call": {
      const name = ast.callee?.type === "Identifier" ? ast.callee.name : "fn";
      return `${name}(...)`;
    }
    case "CoordRead":  return `${ast.field}@${ast.coord?.kind ?? "?"}`;
    default:           return "...";
  }
}

// Smoke check for KNOWN_TYPES — keeps the literal set in sync with the
// switch arms above. Triggered on module import; fails fast if a future
// refactor drops a type without updating the predicate.
for (const t of ["f32", "vec2", "bool", "unknown"]) {
  if (!KNOWN_TYPES.has(t)) throw new Error(`typecheck-v2: KNOWN_TYPES out of sync with checker (missing "${t}")`);
}
