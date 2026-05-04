// =============================================================================
// Negative fuzzer — exercises the validator's REJECTION branches.
//
// The generative fuzzer (fuzz-v2.mjs) produces only valid recipes,
// which means the entire "this program is invalid" surface of the
// validator stays cold (~50% of validate-v2.mjs by line). This
// fuzzer takes valid recipes and applies a small set of targeted
// malformations, then asserts compilation fails with an expected
// error pattern. It buckets results into:
//
//   caught       — compile failed with the expected pattern (good)
//   missed       — compile *succeeded* despite the malformation
//                  (potential validator gap — record for review)
//   wrong-error  — compile failed but the error didn't match the
//                  expected pattern (validator-robustness issue —
//                  not necessarily a bug, but worth examining)
//   skipped      — mutation didn't apply (recipe lacked the
//                  required surface)
//
// CLI:
//   node testing/negative-fuzz-v2.mjs                 # 100 seeds
//   node testing/negative-fuzz-v2.mjs --count 500
//   node testing/negative-fuzz-v2.mjs --show          # dump samples
// =============================================================================

import { compileV2 } from "../dsl/compile-v2.mjs";
import { generateRecipe, makeRng } from "./fuzz-v2.mjs";

// Each mutation: a string transform that produces an invalid
// recipe + the error pattern compileV2 should reject it with.
// Mutations may return null when the input recipe doesn't have
// the surface the mutation needs (e.g. drop-reads when there's
// no `reads` line); those count as `skipped`.
const MUTATIONS = [
  {
    name: "rename-field-decl",
    description: "rename a field declaration only — references become undeclared",
    apply: (dsl) => {
      // Find the first `field fN: TYPE` line; suffix `_ZZZ` to the
      // declared name. References in stages / scenarios / metrics /
      // views still say the original name → unknown-identifier
      // errors.
      const m = /^(field )(f\d+)(:[^\n]*)$/m.exec(dsl);
      if (!m) return null;
      const mutated = dsl.replace(m[0], `${m[1]}${m[2]}_ZZZ${m[3]}`);
      return { mutated, expected: /unknown (identifier|field|name)|undeclared|references unknown/i };
    },
  },
  {
    name: "drop-reads-line",
    description: "remove a `reads` clause from a stage — body refers to fields not in reads",
    apply: (dsl) => {
      // Find a `reads` line + the cell body that follows. We only
      // want to mutate when removing the reads clause will actually
      // break the recipe — i.e. when the body references at least
      // one of the listed fields. Recipes whose body references no
      // fields (only params/consts) survive the mutation, which
      // would falsely register as a validator miss.
      const re = /^( +)reads ([^\n]+)\n([\s\S]*?)cell\s*\{([\s\S]*?)\n\1\}/m;
      const m = re.exec(dsl);
      if (!m) return null;
      const readFields = m[2].split(/\s*,\s*/).map(s => s.trim()).filter(Boolean);
      const cellBody = m[4];
      // We want references where the field is *read*, not the LHS
      // of a set/add (`set f2 = ...` mentions f2 but doesn't read it).
      // Negative-lookbehind blocks the write-target case.
      const referenced = readFields.filter(name =>
        new RegExp(`(?<!set |add )\\b${name}\\b`).test(cellBody)
      );
      if (referenced.length === 0) return null;     // mutation would be a no-op
      const mutated = dsl.replace(m[0], m[0].replace(/^( +)reads [^\n]+\n/m, ""));
      return { mutated, expected: /(reads|unknown identifier|missing)/i };
    },
  },
  {
    name: "drop-writes-line",
    description: "remove a `writes` clause — stage assigns to an unannounced output",
    apply: (dsl) => {
      const m = /^( +)writes [^\n]+\n/m.exec(dsl);
      if (!m) return null;
      const mutated = dsl.replace(m[0], "");
      return { mutated, expected: /(writes|missing|undeclared)/i };
    },
  },
  {
    name: "swap-field-type",
    description: "change a field's declared type from f32 to vec2 — body becomes type-incoherent",
    apply: (dsl) => {
      // Pick a non-first f32 field — first field is always f32 and
      // the metric/view/scenario boilerplate assumes scalar shape, so
      // mutating that one explodes in the JS-side renderer rather
      // than the validator.
      const matches = [...dsl.matchAll(/^field (f\d+): f32$/mg)];
      if (matches.length < 2) return null;
      const target = matches[matches.length - 1];
      const mutated = dsl.replace(target[0], `field ${target[1]}: vec2`);
      return { mutated, expected: /(type|vec2|scalar)/i };
    },
  },
  {
    name: "rename-palette-ref",
    description: "rename the palette in `view ... palette FOO` — undefined palette",
    apply: (dsl) => {
      // Find the view's `palette FOO` reference (single-line form,
      // ends with the name then newline or `}`). Mutate the
      // reference only — palette declaration stays as-is.
      const m = /(palette )(P\d+)(\s*\n)/.exec(dsl);
      if (!m) return null;
      const mutated = dsl.replace(m[0], `${m[1]}${m[2]}_BOGUS${m[3]}`);
      return { mutated, expected: /(palette|undefined|unknown|undeclared)/i };
    },
  },
  {
    name: "non-bool-when",
    description: "replace a `when BOOL_EXPR { ... }` with `when SCALAR { ... }`",
    apply: (dsl) => {
      // Find a when block with a parenthesized predicate; replace the
      // predicate with a bare numeric literal.
      const m = /when \([^{}\n]+\) \{ /.exec(dsl);
      if (!m) return null;
      const mutated = dsl.replace(m[0], "when 0.5 { ");
      return { mutated, expected: /(non-bool|bool|condition|when)/i };
    },
  },
  {
    name: "nested-stencil-upstream",
    description: "put a neighbor reduction inside upstream(...) velocity — unsupported nested stencil lowering",
    apply: (dsl) => {
      const m = /upstream\(([^()\n{}]*),\s*([^()\n{}]*)\)/.exec(dsl);
      if (!m) return null;
      const field = /field\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*f32/.exec(dsl)?.[1] ?? "f0";
      const replacement = `upstream(vec2(mean n in neighbors { ${field}@n - ${field} }, 0), ${m[2]})`;
      const mutated = dsl.slice(0, m.index) + replacement + dsl.slice(m.index + m[0].length);
      return { mutated, expected: /upstream.*neighbor reduction|neighbor reduction.*upstream|compute it into a field/i };
    },
  },
  {
    name: "duplicate-field",
    description: "declare the same field twice — name-uniqueness violation",
    apply: (dsl) => {
      const m = /^field f0: f32$/m.exec(dsl);
      if (!m) return null;
      const mutated = dsl.replace(m[0], `${m[0]}\nfield f0: f32`);
      return { mutated, expected: /(duplicate|already|declared|unique)/i };
    },
  },
  {
    name: "reserved-keyword-field",
    description: "rename a field to a WGSL reserved keyword (`var`, `fn`, etc.)",
    apply: (dsl) => {
      const m = /^field (f\d+):/m.exec(dsl);
      if (!m) return null;
      // `var` is a hard-reserved WGSL keyword; the validator should
      // catch this at recipe load.
      const mutated = dsl.replace(m[0], `field var:`);
      return { mutated, expected: /(reserved|keyword|forbidden)/i };
    },
  },
];

function pick(rng, arr) { return arr[Math.floor(rng() * arr.length)]; }

export function runNegativeFuzz({ count = 100, seedStart = 1, log = console.log } = {}) {
  const stats = {};
  for (const m of MUTATIONS) stats[m.name] = { caught: 0, missed: 0, wrongError: 0, skipped: 0 };
  const samples = { missed: [], wrongError: [] };

  for (let i = 0; i < count; i++) {
    const seed = seedStart + i;
    const dsl = generateRecipe(seed);
    const mrng = makeRng(seed ^ 0xCAFEBABE);
    const mutation = pick(mrng, MUTATIONS);
    const result = mutation.apply(dsl);
    if (!result) {
      stats[mutation.name].skipped++;
      continue;
    }

    let errMsg = null;
    try {
      compileV2(result.mutated);
    } catch (e) {
      errMsg = e.message;
    }

    if (!errMsg) {
      stats[mutation.name].missed++;
      samples.missed.push({ seed, mutation: mutation.name, dsl: result.mutated });
    } else if (result.expected.test(errMsg)) {
      stats[mutation.name].caught++;
    } else {
      stats[mutation.name].wrongError++;
      samples.wrongError.push({ seed, mutation: mutation.name, expected: String(result.expected), got: errMsg });
    }
  }

  log("negative fuzz results:");
  log(`  ${pad("mutation", 26)} caught  missed  wrong  skipped`);
  for (const m of MUTATIONS) {
    const s = stats[m.name];
    log(`  ${pad(m.name, 26)} ${num(s.caught)}  ${num(s.missed)}  ${num(s.wrongError)}  ${num(s.skipped)}`);
  }
  return { stats, samples };
}

function pad(s, n) { return s + " ".repeat(Math.max(0, n - s.length)); }
function num(n) { return String(n).padStart(6); }

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const count = parseInt(arg(args, "--count", "200"), 10);
  const seedStart = parseInt(arg(args, "--seed", "1"), 10);
  const show = args.includes("--show");

  const { samples } = runNegativeFuzz({ count, seedStart });

  if (show && samples.missed.length > 0) {
    console.log(`\n=== ${samples.missed.length} missed mutations (validator should have caught these) ===`);
    for (const s of samples.missed.slice(0, 3)) {
      console.log(`\n--- seed=${s.seed} mutation=${s.mutation} ---`);
      console.log(s.dsl);
    }
  }
  if (show && samples.wrongError.length > 0) {
    console.log(`\n=== ${samples.wrongError.length} wrong-error mutations ===`);
    for (const s of samples.wrongError.slice(0, 3)) {
      console.log(`\n--- seed=${s.seed} mutation=${s.mutation} ---`);
      console.log(`  expected: ${s.expected}`);
      console.log(`  got:      ${s.got}`);
    }
  }
}

function arg(args, name, fallback) {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  return args[i + 1] ?? fallback;
}
