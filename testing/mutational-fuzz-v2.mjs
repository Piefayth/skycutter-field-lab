// =============================================================================
// Mutational fuzzer seeded from shipped recipes.
//
// The generative fuzzer (fuzz-v2.mjs) produces a narrow shape — no
// derived fields, no expr-views, no `for each cell { region/ellipse }`
// init verbs, no multi-stage history, no Coriolis-style coupled
// kinetics, no clamp/wrap/composite views. The shipped recipes use
// all of those. This fuzzer takes those recipes as seeds and applies
// random text-level mutations, surfacing pipeline behaviour the
// generator can't reach.
//
// Mutations are intentionally simple string transforms (swap a
// numeric constant, flip a binary op, substitute a math fn, swap
// set ↔ add). Most preserve validity; the rest produce ill-formed
// recipes that exercise rejection paths the generator never hits.
//
// Outcomes bucket as:
//   ok            — mutated recipe still compiled (valid mutation,
//                   exercises the same pipeline lines as the seed)
//   rejected      — compileV2 threw with a recognizable validator
//                   message (mutation broke the recipe in a way the
//                   validator catches — also useful coverage)
//   internal      — compileV2 threw with TypeError / RangeError /
//                   "Cannot read"-shaped errors (compiler crashed
//                   on unexpected input — real bug surface)
//
// CLI:
//   node testing/mutational-fuzz-v2.mjs                      # 200 seeds × 1 mutation
//   node testing/mutational-fuzz-v2.mjs --count 500 --depth 3
//   node testing/mutational-fuzz-v2.mjs --show               # dump internal-error samples
// =============================================================================

import fs from "node:fs/promises";
import { compileV2 } from "../dsl/compile-v2.mjs";
import { makeRng } from "./fuzz-v2.mjs";

async function loadRecipeSeeds() {
  const manifest = JSON.parse(await fs.readFile("recipes/manifest.json", "utf8"));
  const seeds = [];
  for (const entry of manifest.recipes) {
    const mod = await import(`../${entry.path}`);
    if (typeof mod.pipelineDsl === "string") {
      seeds.push({ id: entry.id, dsl: mod.pipelineDsl });
    }
  }
  return seeds;
}

function pickIdx(rng, n) { return Math.floor(rng() * n); }
function pick(rng, arr) { return arr[pickIdx(rng, arr.length)]; }

// -- Mutations ----------------------------------------------------------------
// Each takes (dsl: string, rng) and returns either the mutated string
// or null (the seed didn't have the surface this mutation needs).
const MUTATIONS = [
  {
    name: "perturb-numeric",
    apply(dsl, rng) {
      // Decimal literals in the body — avoid integers (often type
      // arities like `frequency 32` which would change substrate
      // size and break correctness uniformly across the recipe).
      const re = /(?<![A-Za-z_.])(-?\d+\.\d+)(?![A-Za-z_])/g;
      const matches = [...dsl.matchAll(re)];
      if (matches.length === 0) return null;
      const target = matches[pickIdx(rng, matches.length)];
      const orig = parseFloat(target[1]);
      const scale = pick(rng, [0.1, 0.5, 2, 10, -1, 1.001]);
      const replacement = (orig * scale).toFixed(4);
      return dsl.slice(0, target.index) + replacement + dsl.slice(target.index + target[1].length);
    },
  },
  {
    name: "swap-binary-op",
    apply(dsl, rng) {
      // Whole-token binary ops — leading + trailing space disambiguates
      // from things like `--`, comments, or attribute syntax.
      const OPS = [" + ", " - ", " * "];
      const positions = [];
      for (const op of OPS) {
        let i = 0;
        while ((i = dsl.indexOf(op, i)) !== -1) { positions.push({ idx: i, op }); i += op.length; }
      }
      if (positions.length === 0) return null;
      const target = positions[pickIdx(rng, positions.length)];
      const replacements = OPS.filter((o) => o !== target.op);
      return dsl.slice(0, target.idx) + pick(rng, replacements) + dsl.slice(target.idx + target.op.length);
    },
  },
  {
    name: "swap-math-fn",
    apply(dsl, rng) {
      const SWAPS = { sin: "cos", cos: "sin", sqrt: "abs", abs: "sqrt", exp: "abs", min: "max", max: "min" };
      const re = new RegExp(`\\b(${Object.keys(SWAPS).join("|")})\\(`, "g");
      const matches = [...dsl.matchAll(re)];
      if (matches.length === 0) return null;
      const target = matches[pickIdx(rng, matches.length)];
      const replaced = SWAPS[target[1]] + "(";
      return dsl.slice(0, target.index) + replaced + dsl.slice(target.index + target[0].length);
    },
  },
  {
    name: "swap-set-add",
    apply(dsl, rng) {
      const re = /(\bset |\badd )(\w+)( = )/g;
      const matches = [...dsl.matchAll(re)];
      if (matches.length === 0) return null;
      const target = matches[pickIdx(rng, matches.length)];
      const newVerb = target[1].trim() === "set" ? "add " : "set ";
      return dsl.slice(0, target.index) + newVerb + target[2] + target[3] + dsl.slice(target.index + target[0].length);
    },
  },
  {
    name: "swap-reduction-op",
    apply(dsl, rng) {
      // `sum n in neighbors { ... }` ↔ `mean n in disk(2) { ... }` etc.
      const SWAPS = { sum: "mean", mean: "sum", max: "min", min: "max" };
      const re = new RegExp(`\\b(${Object.keys(SWAPS).join("|")})( n in (?:neighbors|ring\\(2\\)|disk\\(2\\)|disk\\(3\\)))\\b`, "g");
      const matches = [...dsl.matchAll(re)];
      if (matches.length === 0) return null;
      const target = matches[pickIdx(rng, matches.length)];
      return dsl.slice(0, target.index) + SWAPS[target[1]] + target[2] + dsl.slice(target.index + target[0].length);
    },
  },
];

// Distinguish a normal validator/parser error from a compiler internal
// crash. Validator messages are structured ("field X: Y", "stage Y:
// Z", "expected ... got ...", "type ..."); internal crashes show up
// as TypeError / RangeError / undefined-method messages. Heuristic
// but practical — refine if it misclassifies real bugs.
const INTERNAL_PATTERNS = [
  /Cannot read prop/i,
  /is not a function/i,
  /undefined/,                                  // bare "undefined" in message
  /^TypeError/,
  /^RangeError/,
];

function classifyError(err) {
  if (!err) return "ok";
  const msg = err.message ?? String(err);
  const errName = err.name ?? "Error";
  if (errName === "TypeError" || errName === "RangeError") return "internal";
  for (const re of INTERNAL_PATTERNS) {
    if (re.test(msg)) return "internal";
  }
  return "rejected";
}

export async function runMutationalFuzz({ count = 200, depth = 1, seedStart = 1, log = console.log } = {}) {
  const seeds = await loadRecipeSeeds();
  const stats = { ok: 0, rejected: 0, internal: 0, noMutationApplicable: 0 };
  const byMutation = Object.fromEntries(MUTATIONS.map(m => [m.name, { ok: 0, rejected: 0, internal: 0 }]));
  const samples = { internal: [], ok: [] };

  for (let i = 0; i < count; i++) {
    const fuzzSeed = seedStart + i;
    const rng = makeRng(fuzzSeed);
    const seed = seeds[pickIdx(rng, seeds.length)];
    let dsl = seed.dsl;
    const applied = [];
    for (let d = 0; d < depth; d++) {
      const mutation = MUTATIONS[pickIdx(rng, MUTATIONS.length)];
      const result = mutation.apply(dsl, rng);
      if (result !== null) {
        dsl = result;
        applied.push(mutation.name);
      }
    }
    if (applied.length === 0) {
      stats.noMutationApplicable++;
      continue;
    }

    let outcome, err;
    try {
      compileV2(dsl);
      outcome = "ok";
    } catch (e) {
      err = e;
      outcome = classifyError(e);
    }

    stats[outcome]++;
    for (const name of applied) byMutation[name][outcome]++;

    if (outcome === "internal") {
      samples.internal.push({ fuzzSeed, base: seed.id, applied, error: err.message, dsl });
    }
  }

  log(`mutational fuzz (${count} runs × depth ${depth}):`);
  log(`  ok=${stats.ok}  rejected=${stats.rejected}  internal=${stats.internal}  no-op=${stats.noMutationApplicable}`);
  log(`  per-mutation:`);
  for (const m of MUTATIONS) {
    const s = byMutation[m.name];
    log(`    ${pad(m.name, 22)} ok=${num(s.ok)}  rejected=${num(s.rejected)}  internal=${num(s.internal)}`);
  }
  return { stats, byMutation, samples };
}

function pad(s, n) { return s + " ".repeat(Math.max(0, n - s.length)); }
function num(n) { return String(n).padStart(4); }

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const count = parseInt(arg(args, "--count", "200"), 10);
  const depth = parseInt(arg(args, "--depth", "1"), 10);
  const show = args.includes("--show");

  const { samples } = await runMutationalFuzz({ count, depth });
  if (show && samples.internal.length > 0) {
    console.log(`\n=== ${samples.internal.length} internal compiler errors ===`);
    for (const s of samples.internal.slice(0, 3)) {
      console.log(`\n--- fuzzSeed=${s.fuzzSeed} base=${s.base} mutations=${s.applied.join("→")} ---`);
      console.log(`  ${s.error}`);
    }
  }
}

function arg(args, name, fallback) {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  return args[i + 1] ?? fallback;
}
