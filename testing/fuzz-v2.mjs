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
//     and `@upstream` are deliberately excluded (their cross-stage
//     constraints — single-writer-per-step, reads-before-writes —
//     are tangled enough that enforcing them in the generator
//     reproduces the validator's complexity). Targeted strategies
//     for those constructs are worth their own subgenerator.
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

const MATH_FUNCS_1 = ["sin", "cos", "exp", "abs", "sqrt", "wrapAngle"];
const MATH_FUNCS_2 = ["pow", "atan2", "min", "max"];
const BIN_OPS = ["+", "-", "*", "/"];
const REDUCE_OPS = ["sum", "mean", "max", "min"];

class FuzzCtx {
  constructor(seed) {
    this.seed = seed;
    this.rng = makeRng(seed);
    this.fields = [];     // [{ name, type }]
    this.params = [];     // [{ name }]
    this.consts = [];     // [{ name, value }]
    this.palettes = [];
  }

  scalarFields() { return this.fields.filter(f => f.type === "f32"); }
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
// from the *allowed-fields* set (i.e. the enclosing stage's `reads`
// clause), plus all params, consts, locals, or numeric literals.
// Bounded by `depth` to avoid runaway nesting.
//
// scope:
//   .allowedFields — field names in the enclosing stage's `reads`
//   .locals        — `let`-bound names declared earlier in the body
//   .neighborBound — name of the neighbor coord if inside a reduction,
//                    else null (controls whether `f@n` is in scope)
//   .prevAllowed   — fields that may legally appear as `f@prev`
function genCellExpr(ctx, scope, depth = 0) {
  const r = ctx.rng;
  const leafBias = 0.35 + depth * 0.18;
  if (depth >= 3 || r() < leafBias) {
    const scalars = [
      ...scope.allowedFields,
      ...ctx.params.map(p => p.name),
      ...ctx.consts.map(c => c.name),
      ...scope.locals,
    ];
    if (scalars.length === 0 || maybe(r, 0.35)) {
      return round(r() * 4 - 1).toString();
    }
    return pick(r, scalars);
  }
  const choice = r();
  if (choice < 0.30) {
    const op = pick(r, BIN_OPS);
    const lhs = genCellExpr(ctx, scope, depth + 1);
    const rhs = genCellExpr(ctx, scope, depth + 1);
    if (op === "/") {
      return `(${lhs}) / max(abs(${rhs}), 0.001)`;
    }
    return `(${lhs} ${op} ${rhs})`;
  }
  if (choice < 0.50) {
    const fn = pick(r, MATH_FUNCS_1);
    return `${fn}(${genCellExpr(ctx, scope, depth + 1)})`;
  }
  if (choice < 0.65) {
    const fn = pick(r, MATH_FUNCS_2);
    const a = genCellExpr(ctx, scope, depth + 1);
    const b = genCellExpr(ctx, scope, depth + 1);
    return `${fn}(${a}, ${b})`;
  }
  if (choice < 0.78) {
    const x = genCellExpr(ctx, scope, depth + 1);
    const lo = round(-(0.5 + r() * 1.5));
    const hi = round(0.5 + r() * 4);
    return `clamp(${x}, ${lo}, ${hi})`;
  }
  // f@prev — only at the top level of an expression, only for
  // fields in scope, and only when the enclosing stage allows it.
  if (choice < 0.85 && scope.prevAllowed.length > 0) {
    return pick(r, scope.prevAllowed) + "@prev";
  }
  // f@n — only inside a neighbor reduction; otherwise the validator
  // rejects @n as out of scope.
  if (choice < 0.92 && scope.neighborBound && scope.allowedFields.length > 0) {
    return pick(r, scope.allowedFields) + `@${scope.neighborBound}`;
  }
  // Neighbor reduction — only at top level of a *non-reduction* scope.
  if (!scope.neighborBound && scope.allowedFields.length > 0 && depth <= 1) {
    return genNeighborReduce(ctx, scope, depth + 1);
  }
  // Fallback to a leaf.
  return round(r() * 2).toString();
}

function genNeighborReduce(ctx, parentScope, depth) {
  const r = ctx.rng;
  const op = pick(r, REDUCE_OPS);
  const innerScope = { ...parentScope, neighborBound: "n" };
  // Body must produce a scalar; common idiom is `f@n - f` (Laplacian).
  const f = pick(r, parentScope.allowedFields);
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

function genStage(ctx, name) {
  const r = ctx.rng;
  const f32s = ctx.scalarFields();
  if (f32s.length === 0) return null;
  const numWrites = intIn(r, 1, Math.min(2, f32s.length));
  const writes = [];
  while (writes.length < numWrites) {
    const f = pick(r, f32s);
    if (!writes.includes(f.name)) writes.push(f.name);
  }
  // Reads: writes + maybe one extra
  const reads = [...writes];
  if (f32s.length > writes.length && maybe(r, 0.4)) {
    const extra = f32s.find(f => !reads.includes(f.name));
    if (extra) reads.push(extra.name);
  }
  // Body — generates 0-2 lets and one set/add per write field. The
  // expression scope only sees fields in `reads`.
  //
  // @prev is intentionally NOT generated here: history fields carry
  // cross-stage invariants (single writer per step, reads-before-
  // write ordering) that the basic generator can't coordinate
  // without becoming as complex as the validator. A targeted
  // history-field strategy is worth its own subgenerator later.
  const body = [];
  const scope = {
    allowedFields: reads,
    locals: [],
    neighborBound: null,
    prevAllowed: [],
  };
  const numLets = intIn(r, 0, 2);
  for (let i = 0; i < numLets; i++) {
    const lname = `t${i}`;
    body.push(`let ${lname} = ${genCellExpr(ctx, scope)}`);
    scope.locals.push(lname);
  }
  for (const w of writes) {
    const verb = maybe(r, 0.5) && reads.includes(w) ? "add" : "set";
    if (verb === "add") {
      body.push(`add ${w} = (${genCellExpr(ctx, scope)}) * dt`);
    } else {
      body.push(`set ${w} = clamp(${genCellExpr(ctx, scope)}, -10, 10)`);
    }
  }
  // Sometimes wrap a set/add inside a `when` to exercise the
  // conditional path. Only one level of nesting; the predicate is a
  // simple comparison.
  if (maybe(r, 0.25) && body.length > 0) {
    const lastIdx = body.length - 1;
    const last = body[lastIdx];
    if (last.startsWith("set ") || last.startsWith("add ")) {
      const predField = pick(r, reads);
      const threshold = round(r() * 2 - 1, 2);
      body[lastIdx] = `when ${predField} > ${threshold} { ${last} }`;
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
    const choice = r();
    if (f.type === "vec2") {
      const vx = round(r() * 2 - 1, 2);
      const vy = round(r() * 2 - 1, 2);
      lines.push(`set ${f.name} = vec2(${vx}, ${vy})`);
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
  const moreFields = intIn(r, 0, 2);
  for (let i = 0; i < moreFields; i++) {
    const name = `f${i + 1}`;
    const type = maybe(r, 0.85) ? "f32" : "vec2";
    ctx.fields.push({ name, type });
    lines.push(`field ${name}: ${type}`);
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

  // Step + stages
  const numStages = intIn(r, 1, 2);
  const stages = [];
  for (let i = 0; i < numStages; i++) {
    const s = genStage(ctx, `stg${i}`);
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

  // Metrics
  const numMetrics = intIn(r, 1, 2);
  for (let i = 0; i < numMetrics; i++) {
    const op = pick(r, REDUCE_OPS);
    const f = pick(r, ctx.scalarFields());
    if (op === "count") {
      lines.push(`metric m${i} = count cells where ${f.name} > 0`);
    } else {
      lines.push(`metric m${i} = ${op} cells { ${f.name} }`);
    }
  }
  lines.push("");

  // Views (always 1 ramp; sometimes 1 wheel; never expr — strict
  // expr-body validation is its own surface that needs targeted
  // coverage rather than getting incidentally fuzzed here).
  const palette = "P0";
  ctx.palettes.push({ name: palette });
  const f0 = ctx.fields.find(f => f.type === "f32");
  lines.push("views {");
  lines.push(`  palette ${palette} {`);
  lines.push(`    stop 0 color [${intIn(r, 0, 60)}, ${intIn(r, 0, 60)}, ${intIn(r, 0, 60)}]`);
  if (maybe(r, 0.4)) {
    lines.push(`    stop 0.5 color [${intIn(r, 80, 200)}, ${intIn(r, 80, 200)}, ${intIn(r, 80, 200)}]`);
  }
  lines.push(`    stop 1 color [${intIn(r, 200, 255)}, ${intIn(r, 200, 255)}, ${intIn(r, 200, 255)}]`);
  lines.push(`  }`);
  lines.push(`  view v0 "Field" {`);
  lines.push(`    color ramp ${f0.name} range [-2, 2] palette ${palette}`);
  lines.push(`  }`);
  if (maybe(r, 0.4) && ctx.scalarFields().length > 1) {
    const other = ctx.scalarFields().find(f => f.name !== f0.name);
    if (other) {
      lines.push(`  view v1 "Other" {`);
      lines.push(`    color wheel ${other.name}`);
      lines.push(`  }`);
    }
  }
  lines.push("}");
  lines.push("");

  // Scenarios — at least one
  lines.push("scenarios {");
  lines.push(`  scenario init "Initial state" {`);
  for (const ln of genInitBody(ctx)) lines.push(`    ${ln}`);
  lines.push(`  }`);
  if (maybe(r, 0.5)) {
    lines.push(`  scenario blank "Blank" {`);
    for (const f of ctx.fields) {
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

export function runFuzz({ count = 100, seedStart = 1, wgsl = false, log = console.log } = {}) {
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
    const { phase, error } = compileOnce(dsl, { wgsl });
    if (phase === "ok") { succeeded++; continue; }
    failures.push({ phase, seed, dsl, error: error.message, stack: error.stack });
  }
  log(`fuzz: ${succeeded}/${count} compiled cleanly (${failures.length} failures)`);
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
  const count = parseInt(parseFlag(args, "--count", "100"), 10);
  const show = args.includes("--show");
  const wgsl = args.includes("--wgsl");

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
  const { succeeded, failures } = runFuzz({ count, seedStart, wgsl });

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
