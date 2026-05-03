// =============================================================================
// Generative fuzzer for v2 DSL.
//
// Builds syntactically-valid recipes from a seeded PRNG and runs them
// through the compile pipeline. Surfaces latent bugs in parse /
// validate / typecheck / compile / WGSL-emit. Not a regression test —
// the generated programs are random; failures must be reproduced via
// `--seed N`.
//
// CLI:
//   node testing/fuzz-v2.mjs                    # 100 seeds, report stats
//   node testing/fuzz-v2.mjs --count 1000       # more iterations
//   node testing/fuzz-v2.mjs --seed 42 --show   # one seed, print the DSL
//   node testing/fuzz-v2.mjs --wgsl             # also try WGSL emission
//
// API:
//   import { generateRecipe, runFuzz } from "../testing/fuzz-v2.mjs";
//   const dsl = generateRecipe(42);
//   const { failures, succeeded } = runFuzz({ count: 1000 });
//
// Design notes:
//   - The generator pre-tracks every name in scope (fields, params,
//     consts, palettes, scenarios). Generated expressions reference
//     only declared names so the typical compile path is exercised.
//     Anything that fails to compile is therefore either a real bug
//     in the pipeline or a legitimate validator rejection of a
//     pattern the generator should learn to avoid.
//   - The first field is always `f32` to guarantee something
//     scalar-shaped to compute against (metrics, views).
//   - Scope is intentionally narrower than the full grammar — `@prev`
//     is still narrower than the full grammar, but it deliberately
//     touches the v2-heavy surfaces that have had bugs historically:
//     `@prev`, `@upstream`, vec2 stencil helpers, derived fields,
//     stamps, and expr views.
// =============================================================================

import { compileV2 } from "../dsl/compile-v2.mjs";
import { compileWebGpuGeodesicPipeline } from "../dsl/webgpu-geodesic-compiler.mjs";

// Seedable PRNG. mulberry32 — small, deterministic, fine for fuzz.
export function makeRng(seed) {
  let s = (seed >>> 0) || 1;
  return function rng() {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];
const intIn = (rng, lo, hi) => Math.floor(rng() * (hi - lo + 1)) + lo;
const maybe = (rng, p = 0.5) => rng() < p;
const round = (n, places = 3) => Number(n.toFixed(places));

// Numeric leaf with special-value bias. Uniform random covers the
// "boring" middle of the float line; tests rarely fail there. The
// interesting bugs cluster around boundary values: 0 / -0 (sign
// quirks, divide-by-zero), exact integers (cast paths), π / TAU
// (trig identities), very large (overflow / Inf), very small
// (underflow / denormals). Mix all of those into the leaf
// distribution at ~25% combined; otherwise fall back to uniform.
const SPECIAL_NUMERIC_LEAVES = [
  "0",
  "-0",
  "1",
  "-1",
  "PI",
  "TAU",
  "1e-30",       // denormal-ish; survives multiply-by-small
  "1e10",        // large but finite
  "0.0001",
  "100",
];
function genNumericLeaf(rng) {
  if (rng() < 0.25) return pick(rng, SPECIAL_NUMERIC_LEAVES);
  return round(rng() * 4 - 1).toString();
}

function genSimpleScalarLeaf(ctx, scope) {
  const leaves = [
    ...scope.scalarReads,
    ...ctx.params.map(p => p.name),
    ...ctx.consts.map(c => c.name),
  ];
  if (leaves.length === 0 || maybe(ctx.rng, 0.35)) return genNumericLeaf(ctx.rng);
  return pick(ctx.rng, leaves);
}

const MATH_FUNCS_1 = ["sin", "cos", "exp", "abs", "sqrt", "wrapAngle"];
const MATH_FUNCS_2 = ["pow", "atan2", "min", "max"];
const BIN_OPS = ["+", "-", "*", "/"];
const REDUCE_OPS = ["sum", "mean", "max", "min"];
// Comparison ops produce a bool from two scalars. v2 surface accepts
// the C-flavour symbols directly; the parser also has `and`/`or`/`not`
// keyword forms but the symbols match what shipped recipes use.
const CMP_OPS = ["==", "!=", "<", "<=", ">", ">="];

class FuzzCtx {
  constructor(seed) {
    this.seed = seed;
    this.rng = makeRng(seed);
    this.fields = [];     // [{ name, type }]
    this.params = [];     // [{ name }]
    this.consts = [];     // [{ name, value }]
    this.palettes = [];
    this.derivedField = null;
    this.rngField = null;
  }

  scalarFields() { return this.fields.filter(f => f.type === "f32"); }
  vec2Fields()   { return this.fields.filter(f => f.type === "vec2"); }
  scalarNames() {
    return [
      ...this.scalarFields().map(f => f.name),
      ...this.params.map(p => p.name),
      ...this.consts.map(c => c.name),
    ];
  }
}

// -- Expression generators -----------------------------------------------------

// Generate an f32-valued cell-stage expression. May reference fields
// from the stage's `reads` clause (split into scalar + vec2), plus
// params, consts, locals, or numeric literals. Bounded by `depth`
// to avoid runaway nesting.
//
// scope:
//   .scalarReads   — f32 field names in the enclosing stage's `reads`
//   .vec2Reads     — vec2 field names in the same `reads` clause
//   .locals        — `let`-bound names declared earlier in the body
//   .neighborBound — name of the neighbor coord if inside a reduction,
//                    else null (controls whether `f@n` is in scope)
//   .allowPrev     — true if the enclosing stage may use `field@prev`
//                    (single-stage recipes only — multi-stage recipes
//                    have cross-stage history-field invariants the
//                    generator deliberately doesn't try to satisfy)
function genCellExpr(ctx, scope, depth = 0) {
  const r = ctx.rng;
  const leafBias = 0.35 + depth * 0.18;
  if (depth >= 3 || r() < leafBias) {
    // Scalar leaf candidates: scalar fields, params, consts, locals,
    // and vec2 component access (.x / .y / length(...)) for any vec2
    // field in scope. The vec2 access patterns are how we exercise
    // the WGSL emitter's vec2-read codepaths from within scalar-typed
    // expressions.
    const leaves = [
      ...scope.scalarReads,
      ...ctx.params.map(p => p.name),
      ...ctx.consts.map(c => c.name),
      ...scope.locals,
    ];
    for (const v of scope.vec2Reads) {
      leaves.push(`${v}.x`, `${v}.y`, `length(${v})`);
    }
    if (leaves.length === 0 || maybe(r, 0.35)) {
      return genNumericLeaf(r);
    }
    return pick(r, leaves);
  }
  const choice = r();
  if (choice < 0.28) {
    const op = pick(r, BIN_OPS);
    const lhs = genCellExpr(ctx, scope, depth + 1);
    const rhs = genCellExpr(ctx, scope, depth + 1);
    if (op === "/") {
      return `(${lhs}) / max(abs(${rhs}), 0.001)`;
    }
    return `(${lhs} ${op} ${rhs})`;
  }
  if (choice < 0.46) {
    const fn = pick(r, MATH_FUNCS_1);
    let arg = genCellExpr(ctx, scope, depth + 1);
    // WGSL's parser does compile-time const-eval for math intrinsics
    // and rejects sqrt(negative-literal). Wrap in abs() so the
    // generator can produce the full math zoo without tripping that
    // edge case (sqrt(|x|) is always well-defined for real x).
    if (fn === "sqrt") arg = `abs(${arg})`;
    return `${fn}(${arg})`;
  }
  if (choice < 0.60) {
    const fn = pick(r, MATH_FUNCS_2);
    let a = genCellExpr(ctx, scope, depth + 1);
    const b = genCellExpr(ctx, scope, depth + 1);
    if (fn === "pow") a = `abs(${a})`;
    return `${fn}(${a}, ${b})`;
  }
  if (choice < 0.72) {
    const x = genCellExpr(ctx, scope, depth + 1);
    const lo = round(-(0.5 + r() * 1.5));
    const hi = round(0.5 + r() * 4);
    return `clamp(${x}, ${lo}, ${hi})`;
  }
  // divergence(vec2_field) — scalar result. Only on bare field names
  // (the validator rejects let-locals inside stencil args).
  if (choice < 0.79 && scope.vec2Reads.length > 0) {
    return `divergence(${pick(r, scope.vec2Reads)})`;
  }
  // f@prev — only when allowPrev (single-stage recipe) and field
  // is one this stage *writes* (history needs a writer or the
  // validator rejects).
  if (choice < 0.85 && scope.allowPrev && scope.prevAllowedFields.length > 0) {
    return pick(r, scope.prevAllowedFields) + "@prev";
  }
  // Semi-Lagrangian upstream sample. Keep it out of predicate-only
  // contexts so failures point at @upstream lowering, not at "stencil
  // expression used where only a simple predicate was expected".
  if (choice < 0.89 && !scope.disallowReductions && scope.scalarReads.length > 0) {
    const field = pick(r, scope.scalarReads);
    const vx = scope.vec2Reads.length > 0 ? `${pick(r, scope.vec2Reads)}.x` : genSimpleScalarLeaf(ctx, scope);
    const vy = scope.vec2Reads.length > 0 ? `${pick(r, scope.vec2Reads)}.y` : genSimpleScalarLeaf(ctx, scope);
    return `${field}@upstream(${vx}, ${vy}, dt)`;
  }
  // f@n — only inside a neighbor reduction; the validator rejects
  // @n as out of scope outside one.
  if (choice < 0.92 && scope.neighborBound && scope.scalarReads.length > 0) {
    return pick(r, scope.scalarReads) + `@${scope.neighborBound}`;
  }
  // Ternary — `cond ? a : b` produces a scalar from a bool predicate
  // and two scalar branches. Stays at the deeper levels only so we
  // don't drown the body in conditionals.
  if (choice < 0.97 && depth <= 1) {
    const cond = genBoolExpr(ctx, scope, depth + 1);
    const a = genCellExpr(ctx, scope, depth + 1);
    const b = genCellExpr(ctx, scope, depth + 1);
    return `((${cond}) ? (${a}) : (${b}))`;
  }
  // Neighbor reduction — only at top level of a *non-reduction* scope,
  // and never inside a predicate (when / where clauses use the
  // simple expression grammar which doesn't accept reductions).
  if (!scope.neighborBound && !scope.disallowReductions && scope.scalarReads.length > 0 && depth <= 1) {
    return genNeighborReduce(ctx, scope, depth + 1);
  }
  return genNumericLeaf(r);
}

// Generate a bool-typed expression. Used for `when` predicates,
// `count cells where` clauses, and ternary conditions. Forms:
//   - comparison:   scalar OP scalar  (==, !=, <, <=, >, >=)
//   - logical AND:  bool and bool
//   - logical OR:   bool or bool
//   - logical NOT:  not bool
// The shipped recipes use the keyword forms (`and`, `or`, `not`); the
// generator follows suit so the parser exercises that path.
function genBoolExpr(ctx, scope, depth = 0) {
  const r = ctx.rng;
  // Predicates use a stricter expression grammar than cell bodies —
  // neighbor reductions, @prev / @upstream / @n, etc. don't parse
  // in `when` or `where` contexts. Force a predicate-flavoured
  // sub-scope so the leaf generator avoids those branches.
  scope = { ...scope, disallowReductions: true };
  if (depth >= 2 || r() < 0.55) {
    return genCmpExpr(ctx, scope, depth);
  }
  const choice = r();
  if (choice < 0.45) {
    const lhs = genBoolExpr(ctx, scope, depth + 1);
    const rhs = genBoolExpr(ctx, scope, depth + 1);
    return `(${lhs} and ${rhs})`;
  }
  if (choice < 0.80) {
    const lhs = genBoolExpr(ctx, scope, depth + 1);
    const rhs = genBoolExpr(ctx, scope, depth + 1);
    return `(${lhs} or ${rhs})`;
  }
  return `(not (${genBoolExpr(ctx, scope, depth + 1)}))`;
}

function genCmpExpr(ctx, scope, depth) {
  const r = ctx.rng;
  const op = pick(r, CMP_OPS);
  const lhs = genCellExpr(ctx, scope, depth + 1);
  const rhs = genCellExpr(ctx, scope, depth + 1);
  return `(${lhs} ${op} ${rhs})`;
}

// Generate a vec2-valued expression for vec2 field assignments.
// Forms: bare vec2 field (with optional @prev), gradient(scalar),
// vec2(scalar, scalar) constructor.
function genVec2Expr(ctx, scope, depth = 0) {
  const r = ctx.rng;
  const choice = r();
  // Bare vec2 field with optional @prev. @prev only when the
  // stage writes this field (else "history field has no writing
  // stage").
  if (scope.vec2Reads.length > 0 && choice < 0.30) {
    const f = pick(r, scope.vec2Reads);
    const writesThisVec2 = scope.prevAllowedVec2?.includes(f);
    if (scope.allowPrev && writesThisVec2 && maybe(r, 0.4)) return `${f}@prev`;
    return f;
  }
  // gradient(scalar_field) — produces vec2 from a scalar field's
  // tangent-frame gradient. Bare field name only (no let-locals).
  if (scope.scalarReads.length > 0 && choice < 0.55) {
    return `gradient(${pick(r, scope.scalarReads)})`;
  }
  // vec2 constructor over two scalar expressions.
  return `vec2(${genCellExpr(ctx, scope, depth + 1)}, ${genCellExpr(ctx, scope, depth + 1)})`;
}

function genNeighborReduce(ctx, parentScope, depth) {
  const r = ctx.rng;
  const op = pick(r, REDUCE_OPS);
  const innerScope = { ...parentScope, neighborBound: "n" };
  // Body must produce a scalar; common idiom is `f@n - f` (Laplacian).
  const f = pick(r, parentScope.scalarReads);
  const shape = r();
  let body;
  if (shape < 0.5) {
    body = `${f}@n - ${f}`;
  } else if (shape < 0.85) {
    body = `${f}@n`;
  } else {
    body = `(${f}@n - ${f}) * ${round(0.5 + r(), 2)}`;
  }
  return `(${op} n in neighbors { ${body} })`;
}

// -- Stage generation ----------------------------------------------------------

// Generate one stage. Writes can target any declared field type
// (f32 or vec2); the body generator dispatches on the target's type
// to produce shape-correct expressions.
//
// allowPrev: only true when the recipe has exactly one stage, since
// multi-stage recipes carry cross-stage history-field invariants
// (single-writer-per-step, reads-before-write ordering) the
// generator deliberately doesn't try to satisfy.
function genStage(ctx, name, { allowPrev = false } = {}) {
  const r = ctx.rng;
  const allFields = ctx.fields;
  if (allFields.length === 0) return null;
  const numWrites = intIn(r, 1, Math.min(2, allFields.length));
  const writes = [];
  while (writes.length < numWrites) {
    const f = pick(r, allFields);
    if (!writes.includes(f.name)) writes.push(f.name);
  }
  // If this recipe has a derived field, force the first stage to
  // write it. The validator requires every derived field to have a
  // stage writer, while scenarios/stamps must leave it alone.
  if (name === "stg0" && ctx.derivedField && !writes.includes(ctx.derivedField.name)) {
    if (writes.length < Math.min(2, allFields.length)) writes.push(ctx.derivedField.name);
    else writes[writes.length - 1] = ctx.derivedField.name;
  }
  // Bias the first stage toward touching vec2 fields when the recipe
  // has them. Vec2/stencil bugs are disproportionately expensive, and
  // purely random write selection leaves gradient/divergence cold.
  const vec2Candidate = allFields.find(f => f.type === "vec2");
  if (name === "stg0" && vec2Candidate && maybe(r, 0.55) && !writes.includes(vec2Candidate.name)) {
    if (writes.length < Math.min(2, allFields.length)) writes.push(vec2Candidate.name);
    else writes[0] = vec2Candidate.name;
  }
  const useStatefulRng = Boolean(ctx.rngField) && maybe(r, 0.45);
  if (useStatefulRng && !writes.includes(ctx.rngField.name)) writes.push(ctx.rngField.name);
  if (name === "stg0" && ctx.derivedField && !writes.includes(ctx.derivedField.name)) {
    writes.push(ctx.derivedField.name);
  }
  // Reads: writes + maybe one extra (mixed types are fine)
  const reads = [...writes];
  if (allFields.length > writes.length && maybe(r, 0.5)) {
    const extra = allFields.find(f => !reads.includes(f.name));
    if (extra) reads.push(extra.name);
  }
  if (useStatefulRng && !reads.includes(ctx.rngField.name)) reads.push(ctx.rngField.name);
  const fieldType = (name) => allFields.find(f => f.name === name).type;
  const scalarReads = reads.filter(n => fieldType(n) === "f32");
  const vec2Reads   = reads.filter(n => fieldType(n) === "vec2");

  // @prev is allowed only on fields this stage *writes*. The
  // validator enforces that any history-using field has exactly one
  // writer per step; a single-stage recipe that reads-without-writing
  // a field would still fail because `@prev` allocates a history
  // buffer with no writer.
  const prevAllowedSet = allowPrev
    ? new Set(writes.filter(n => fieldType(n) === "f32"))
    : new Set();
  const prevAllowedVec2Set = allowPrev
    ? new Set(writes.filter(n => fieldType(n) === "vec2"))
    : new Set();

  const body = [];
  const scope = {
    scalarReads,
    vec2Reads,
    locals: [],
    neighborBound: null,
    allowPrev,
    prevAllowedFields: [...prevAllowedSet],
    prevAllowedVec2:   [...prevAllowedVec2Set],
  };
  const numLets = intIn(r, 0, 2);
  if (useStatefulRng) {
    body.push(`let draw = rand01(${ctx.rngField.name})`);
    scope.locals.push("draw");
  }
  for (let i = 0; i < numLets; i++) {
    const lname = `t${i}`;
    body.push(`let ${lname} = ${genCellExpr(ctx, scope)}`);
    scope.locals.push(lname);
  }
  for (const w of writes) {
    const wType = fieldType(w);
    if (useStatefulRng && w === ctx.rngField.name) {
      body.push(`set ${w} = rngNext(${w})`);
      continue;
    }
    const verb = maybe(r, 0.5) && reads.includes(w) ? "add" : "set";
    if (wType === "vec2") {
      const expr = scope.scalarReads.length > 0 && maybe(r, 0.35)
        ? `gradient(${pick(r, scope.scalarReads)})`
        : genVec2Expr(ctx, scope);
      // vec2 fields use vec2-shaped writes — `add v = vec2(...) * dt`
      // broadcasts dt across both components.
      if (verb === "add") {
        body.push(`add ${w} = (${expr}) * dt`);
      } else {
        body.push(`set ${w} = ${expr}`);
      }
    } else {
      if (verb === "add") {
        body.push(`add ${w} = (${genCellExpr(ctx, scope)}) * dt`);
      } else {
        body.push(`set ${w} = clamp(${genCellExpr(ctx, scope)}, -10, 10)`);
      }
    }
  }
  // Sometimes wrap a set/add inside a `when` to exercise the
  // conditional path. Predicate is a full bool expression — exercises
  // the comparison + logical (and/or/not) parser branches.
  if (maybe(r, 0.30) && body.length > 0 && (scalarReads.length > 0 || vec2Reads.length > 0)) {
    const lastIdx = body.length - 1;
    const last = body[lastIdx];
    if (last.startsWith("set ") || last.startsWith("add ")) {
      body[lastIdx] = `when ${genBoolExpr(ctx, scope)} { ${last} }`;
    }
  }
  return { name, reads, writes, body };
}

// -- Init body generation (scenarios) ------------------------------------------

function genInitBody(ctx) {
  const r = ctx.rng;
  const lines = [];
  // Initialize every declared field.
  for (const f of ctx.fields) {
    if (f.derived) continue;
    const choice = r();
    if (f.type === "vec2") {
      const vx = round(r() * 2 - 1, 2);
      const vy = round(r() * 2 - 1, 2);
      lines.push(`set ${f.name} = vec2(${vx}, ${vy})`);
    } else if (f.type === "u32") {
      lines.push(`set ${f.name} = ${intIn(r, 1, 16777215)}`);
    } else if (f.type === "bool") {
      lines.push(`set ${f.name} = ${maybe(r, 0.5) ? "true" : "false"}`);
    } else if (choice < 0.5) {
      lines.push(`set ${f.name} = ${round(r() * 2, 3)}`);
    } else if (choice < 0.85) {
      // spot
      lines.push(`set ${f.name} = 0`);
      const lon = round(r() * 2 - 1, 2);
      const lat = round(r() * 1.5 - 0.75, 2);
      const radius = round(0.05 + r() * 0.3, 2);
      const amount = round(0.3 + r() * 0.7, 2);
      lines.push(`spot ${f.name} at lon=${lon}, lat=${lat}, radius=${radius}, amount=${amount}`);
    } else {
      // for each cell
      lines.push(`for each cell {`);
      lines.push(`  set ${f.name} = sin(lon * ${intIn(r, 1, 6)}) * 0.5`);
      lines.push(`}`);
    }
  }
  return lines;
}

// -- Top-level generator -------------------------------------------------------

export function generateRecipe(seed) {
  const ctx = new FuzzCtx(seed);
  const r = ctx.rng;
  const lines = [];

  lines.push(`recipe "Fuzz ${seed}"`);
  if (maybe(r, 0.7)) lines.push(`summary "v2 DSL fuzz seed ${seed}"`);
  lines.push("");
  lines.push(`substrate geodesic frequency ${pick(r, [16, 32])}`);
  lines.push("");

  // Consts
  const numConsts = intIn(r, 0, 2);
  for (let i = 0; i < numConsts; i++) {
    const name = `K${i}`;
    const value = round(r() * 4 + 0.1, 3);
    ctx.consts.push({ name, value });
    lines.push(`const ${name} = ${value}`);
  }
  if (numConsts) lines.push("");

  // Fields. First is always f32 (so we always have something scalar).
  ctx.fields.push({ name: "f0", type: "f32" });
  lines.push(`field f0: f32`);
  const moreFields = intIn(r, 1, 3);
  for (let i = 0; i < moreFields; i++) {
    const name = `f${i + 1}`;
    const type = maybe(r, 0.65) ? "f32" : "vec2";
    const field = { name, type, derived: false };
    ctx.fields.push(field);
  }
  const derivedCandidates = ctx.fields.filter((f) => f.name !== "f0" && f.type === "f32");
  if (derivedCandidates.length > 0 && maybe(r, 0.35)) {
    ctx.derivedField = pick(r, derivedCandidates);
    ctx.derivedField.derived = true;
  }
  for (const field of ctx.fields.slice(1)) {
    lines.push(`field ${field.name}: ${field.type}${field.derived ? " derived" : ""}`);
  }
  if (maybe(r, 0.35)) {
    ctx.rngField = { name: "rng", type: "u32", derived: false };
    ctx.fields.push(ctx.rngField);
    lines.push(`field rng: u32`);
  }
  lines.push("");

  // Params
  const numParams = intIn(r, 1, 3);
  for (let i = 0; i < numParams; i++) {
    const name = `p${i}`;
    ctx.params.push({ name });
    const lo = pick(r, [0, 0.1]);
    const hi = pick(r, [1, 2, 5]);
    const def = round((lo + hi) / 2, 3);
    const step = round((hi - lo) / 100, 4);
    lines.push(`param ${name} slider ${lo}..${hi} step ${step} default ${def} label "${name.toUpperCase()}"`);
  }
  lines.push("");

  // Step + stages.
  //
  // @prev usage requires single-stage recipes — multi-stage @prev
  // brings the whole single-writer-per-step / reads-before-write
  // ordering soup, which the generator deliberately doesn't try
  // to satisfy. So decide stage count first, then enable @prev only
  // when stages == 1.
  const numStages = intIn(r, 1, 2);
  const allowPrev = numStages === 1;
  const stages = [];
  for (let i = 0; i < numStages; i++) {
    const s = genStage(ctx, `stg${i}`, { allowPrev });
    if (s) stages.push(s);
  }
  if (stages.length === 0) {
    // Fallback: identity stage on f0
    stages.push({ name: "stg0", reads: ["f0"], writes: ["f0"], body: ["set f0 = clamp(f0, -1, 1)"] });
  }
  lines.push("step {");
  for (const stg of stages) {
    lines.push(`  stage ${stg.name} {`);
    lines.push(`    reads ${stg.reads.join(", ")}`);
    lines.push(`    writes ${stg.writes.join(", ")}`);
    lines.push(`    cell {`);
    for (const ln of stg.body) lines.push(`      ${ln}`);
    lines.push(`    }`);
    lines.push(`  }`);
  }
  lines.push("}");
  lines.push("");

  // Metrics. Mix the full reduction zoo:
  //   - sum / mean / max / min   with a scalar body, optionally
  //                              gated by `where PRED`
  //   - count                    where PRED only (no body)
  // Predicates use the bool expression generator → exercises the
  // comparison/logical/ternary parser branches in metric context.
  const metricScope = {
    scalarReads: ctx.scalarFields().map(f => f.name),
    vec2Reads: ctx.vec2Fields().map(f => f.name),
    locals: [],
    neighborBound: null,
    allowPrev: false,
    prevAllowedFields: [],
    prevAllowedVec2: [],
  };
  const numMetrics = intIn(r, 1, 3);
  for (let i = 0; i < numMetrics; i++) {
    const useCount = maybe(r, 0.3);
    if (useCount) {
      lines.push(`metric m${i} = count cells where ${genBoolExpr(ctx, metricScope)}`);
      continue;
    }
    const op = pick(r, REDUCE_OPS);
    const body = ctx.scalarFields().length > 0
      ? pick(r, ctx.scalarFields()).name
      : "1";
    if (maybe(r, 0.3)) {
      lines.push(`metric m${i} = ${op} cells where ${genBoolExpr(ctx, metricScope)} { ${body} }`);
    } else {
      lines.push(`metric m${i} = ${op} cells { ${body} }`);
    }
  }
  lines.push("");

  // Views. Always one ramp, sometimes inline stops / wheel / expr.
  // Expr view bodies use the legal render-time subset only: fields,
  // params, consts, length(vec2), scalar math, and root red/green/blue
  // assignments.
  const palette = "P0";
  ctx.palettes.push({ name: palette });
  const f0 = ctx.fields.find(f => f.type === "f32");
  lines.push("views {");
  const inlineRampStops = maybe(r, 0.30);
  if (!inlineRampStops) {
    lines.push(`  palette ${palette} {`);
    lines.push(`    stop 0 color [${intIn(r, 0, 60)}, ${intIn(r, 0, 60)}, ${intIn(r, 0, 60)}]`);
    if (maybe(r, 0.4)) {
      lines.push(`    stop 0.5 color [${intIn(r, 80, 200)}, ${intIn(r, 80, 200)}, ${intIn(r, 80, 200)}]`);
    }
    lines.push(`    stop 1 color [${intIn(r, 200, 255)}, ${intIn(r, 200, 255)}, ${intIn(r, 200, 255)}]`);
    lines.push(`  }`);
  }
  lines.push(`  view v0 "Field" {`);
  if (inlineRampStops) {
    lines.push(`    color ramp ${f0.name} range [-2, 2] stops {`);
    lines.push(`      stop 0 color [${intIn(r, 0, 60)}, ${intIn(r, 0, 60)}, ${intIn(r, 0, 60)}]`);
    lines.push(`      stop 1 color [${intIn(r, 200, 255)}, ${intIn(r, 200, 255)}, ${intIn(r, 200, 255)}]`);
    lines.push(`    }`);
  } else {
    lines.push(`    color ramp ${f0.name} range [-2, 2] palette ${palette}`);
  }
  lines.push(`  }`);
  if (maybe(r, 0.4) && ctx.scalarFields().length > 1) {
    const other = ctx.scalarFields().find(f => f.name !== f0.name);
    if (other) {
      lines.push(`  view v1 "Other" {`);
      lines.push(`    color wheel ${other.name}`);
      lines.push(`  }`);
    }
  }
  if (maybe(r, 0.35)) {
    const v = ctx.vec2Fields()[0];
    lines.push(`  view vExpr "Composite" {`);
    lines.push(`    color expr {`);
    if (v) {
      lines.push(`      let mag = clamp(length(${v.name}), 0, 1)`);
      lines.push(`      set red = clamp(${f0.name}, 0, 1) * 255`);
      lines.push(`      set green = mag * 255`);
      lines.push(`      set blue = abs(${f0.name}) * 80`);
    } else {
      lines.push(`      let lit = clamp(${f0.name}, 0, 1)`);
      lines.push(`      set red = lit * 255`);
      lines.push(`      set green = sin(lit * PI) * 120 + 80`);
      lines.push(`      set blue = abs(${f0.name}) * 80`);
    }
    lines.push(`    }`);
    lines.push(`  }`);
  }
  lines.push("}");
  lines.push("");

  // Stamps — exercise brush-scoped init action validation. Target f0
  // specifically because it is guaranteed scalar and non-derived.
  if (maybe(r, 0.45)) {
    lines.push("stamps {");
    lines.push(`  stamp tap "Tap" {`);
    lines.push(`    spot f0 at brush.pos, radius=brush.r, amount=${round(0.2 + r() * 0.8, 2)}`);
    lines.push(`  }`);
    lines.push("}");
    lines.push("");
  }

  // Scenarios — at least one
  lines.push("scenarios {");
  lines.push(`  scenario init "Initial state" {`);
  for (const ln of genInitBody(ctx)) lines.push(`    ${ln}`);
  lines.push(`  }`);
  if (maybe(r, 0.5)) {
    lines.push(`  scenario blank "Blank" {`);
    for (const f of ctx.fields) {
      if (f.derived) continue;
      const z = f.type === "vec2" ? "vec2(0, 0)" : "0";
      lines.push(`    set ${f.name} = ${z}`);
    }
    lines.push(`  }`);
  }
  lines.push("}");

  return lines.join("\n");
}

// -- Runner --------------------------------------------------------------------

// Compile a generated DSL through the full pipeline. Each phase is
// separately catchable so failures get categorized.
function compileOnce(dsl, { wgsl } = {}) {
  let result;
  try {
    result = compileV2(dsl);
  } catch (err) {
    return { phase: "compileV2", error: err };
  }
  if (wgsl) {
    try {
      compileWebGpuGeodesicPipeline(result.dsl);
    } catch (err) {
      return { phase: "wgsl", error: err };
    }
  }
  return { phase: "ok", result };
}

// Execute a compiled DSL on a real GPU for one tick and verify the
// outputs aren't NaN/Inf. Uses the same seeded PRNG as the generator
// so initial field values are deterministic per seed (failures
// reproducible). Returns the same { phase, error } shape as
// compileOnce — phase "execute" if anything goes wrong, "ok" if every
// post-tick field value is finite.
//
// The harness is constructed and disposed per recipe — dawn-node
// devices are cheap (sub-ms), and per-recipe isolation means a
// recipe that wedges its device can't poison the next iteration.
async function executeOnce(compiled, seed, { harness: harnessApi }) {
  const { makeHarness } = harnessApi;
  let harness;
  const fieldDecls = compiled.fields ?? [];
  // Deterministic-per-seed init RNG. Separate from the generator's
  // RNG so adding execute later doesn't shift the generator's
  // PRNG stream.
  const initRng = makeRng(seed ^ 0x1F4ED7);
  try {
    harness = await makeHarness({ dsl: compiled, frequency: 16 });
  } catch (err) {
    return { phase: "execute", error: err };
  }
  try {
    for (const f of fieldDecls) {
      const components = f.type === "vec2" ? 2 : 1;
      const Ctor = (f.type === "u32" || f.type === "bool") ? Uint32Array : Float32Array;
      const arr = new Ctor(harness.cellCount * components);
      for (let i = 0; i < arr.length; i++) {
        if (Ctor === Uint32Array) arr[i] = Math.floor(initRng() * 4);
        else arr[i] = (initRng() - 0.5) * 0.5;
      }
      harness.uploadField(f.name, arr);
    }
    await harness.tick();
    for (const f of fieldDecls) {
      const data = await harness.readField(f.name);
      for (let i = 0; i < data.length; i++) {
        if (!Number.isFinite(data[i])) {
          return {
            phase: "execute",
            error: new Error(`field ${f.name}[${i}] = ${data[i]} after one tick (NaN/Inf)`),
          };
        }
      }
    }
    return { phase: "ok" };
  } catch (err) {
    return { phase: "execute", error: err };
  } finally {
    try { harness.dispose(); } catch (_) { /* idempotent */ }
  }
}

export async function runFuzz({ count = 100, seedStart = 1, wgsl = false, execute = false, log = console.log } = {}) {
  // The execute path needs the harness module loaded lazily — only
  // when --execute is set, so static fuzz runs don't pay the cost
  // of a dawn-node import.
  let harnessApi = null;
  if (execute) {
    const mod = await import("./wgsl-harness.mjs");
    if (!await mod.harnessAvailable()) {
      log("fuzz: --execute requested but dawn-node not available; run `npm install`");
      return { succeeded: 0, failures: [] };
    }
    harnessApi = mod;
  }
  const failures = [];
  let succeeded = 0;
  for (let i = 0; i < count; i++) {
    const seed = seedStart + i;
    let dsl = null;
    try {
      dsl = generateRecipe(seed);
    } catch (err) {
      failures.push({ phase: "generate", seed, dsl: null, error: err.message, stack: err.stack });
      continue;
    }
    // Execute mode forces wgsl=true since execute needs the WGSL
    // emitter to succeed first.
    const { phase, error, result } = compileOnce(dsl, { wgsl: wgsl || execute });
    if (phase !== "ok") {
      failures.push({ phase, seed, dsl, error: error.message, stack: error.stack });
      continue;
    }
    if (!execute) { succeeded++; continue; }
    const exec = await executeOnce(result.dsl, seed, { harness: harnessApi });
    if (exec.phase === "ok") { succeeded++; continue; }
    failures.push({ phase: exec.phase, seed, dsl, error: exec.error.message, stack: exec.error.stack });
  }
  log(`fuzz: ${succeeded}/${count} ${execute ? "executed" : "compiled"} cleanly (${failures.length} failures)`);
  return { succeeded, failures };
}

// -- CLI -----------------------------------------------------------------------

function parseFlag(args, name, fallback) {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  const v = args[i + 1];
  return v === undefined ? true : v;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const seed = parseInt(parseFlag(args, "--seed", "0"), 10);
  const execute = args.includes("--execute");
  const wgsl = args.includes("--wgsl") || execute;
  // Execute mode is GPU-bound (~10-30ms/iteration on dawn-node) so
  // default to a smaller count than static-compile mode.
  const defaultCount = execute ? 30 : 100;
  const count = parseInt(parseFlag(args, "--count", String(defaultCount)), 10);
  const show = args.includes("--show");

  if (seed > 0 && show) {
    // Single-seed display mode
    const dsl = generateRecipe(seed);
    console.log(`# seed ${seed}\n${dsl}`);
    const { phase, error } = compileOnce(dsl, { wgsl });
    if (phase === "ok") console.log(`\n# compiled cleanly`);
    else console.log(`\n# failed at ${phase}: ${error.message}`);
    process.exit(phase === "ok" ? 0 : 1);
  }

  const seedStart = seed > 0 ? seed : 1;
  const { succeeded, failures } = await runFuzz({ count, seedStart, wgsl, execute });

  if (failures.length === 0) {
    console.log("no failures");
    process.exit(0);
  }

  // Bucket failures by phase
  const byPhase = {};
  for (const f of failures) byPhase[f.phase] = (byPhase[f.phase] ?? 0) + 1;
  console.log(`\nfailures by phase:`);
  for (const [phase, n] of Object.entries(byPhase)) console.log(`  ${phase}: ${n}`);

  // Bucket failures by error message (first 80 chars)
  const byMsg = new Map();
  for (const f of failures) {
    const key = f.error.slice(0, 80);
    const bucket = byMsg.get(key) ?? { count: 0, sample: f };
    bucket.count++;
    byMsg.set(key, bucket);
  }
  console.log(`\ntop error patterns:`);
  const sorted = [...byMsg.entries()].sort((a, b) => b[1].count - a[1].count);
  for (const [msg, { count, sample }] of sorted.slice(0, 8)) {
    console.log(`  [${count}×] ${msg}${msg.length === 80 ? "…" : ""}`);
    console.log(`         seed=${sample.seed}, phase=${sample.phase}`);
  }
  if (show) {
    console.log(`\nsample failure DSL (seed=${sorted[0][1].sample.seed}):\n`);
    console.log(sorted[0][1].sample.dsl);
  }
  process.exit(0);
}
