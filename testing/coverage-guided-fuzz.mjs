// =============================================================================
// Coverage-guided / diversity-driven fuzz layer.
//
// Real AFL-style coverage-guided fuzzing tracks per-edge coverage in
// a bitmap and treats "first time we hit edge E" as a signal to
// preserve the input. We don't have edge instrumentation here, so
// this layer uses a structural-feature proxy extracted from the v2
// compiler AST: a feature vector per generated recipe summarises
// which surface-level constructs it uses (vec2 fields, gradient /
// divergence, @prev / @upstream, neighbor reductions, ternary, when,
// derived fields, expr views, etc.). Recipes with previously-unseen
// feature vectors are kept as "seeds" — programs that exercise a
// structurally-novel slice of the pipeline.
//
// Two phases:
//   1. SURVEY     — generate N random recipes, bucket by feature
//                   vector, report the diversity histogram.
//   2. EXPLOIT    — take one representative per bucket as a seed,
//                   apply M mutations to each (using the mutational
//                   fuzzer's library), keep any mutation that lands
//                   in a previously-unseen bucket. Iterate until the
//                   bucket-count stabilises.
//
// With --corpus PATH, writes a corpus.json sketch listing seeds +
// their feature vectors. Useful for asking "what shapes are we
// missing?" before writing the next entropy batch.
//
// CLI:
//   node testing/coverage-guided-fuzz.mjs                     # default 1000 survey
//   node testing/coverage-guided-fuzz.mjs --survey 2000 --exploit 500
//   node testing/coverage-guided-fuzz.mjs --corpus /tmp/corpus.json
// =============================================================================

import fs from "node:fs/promises";
import { compileV2 } from "../dsl/compile-v2.mjs";
import { generateRecipe, makeRng } from "./fuzz-v2.mjs";
import { FEATURE_NAMES, bucketKey, featureVectorFromAst } from "./fuzz-features-v2.mjs";

// Reduce a feature vector to a presence-only bucket key. We treat
// "uses this feature at all" as the bucket axis; exact counts mostly
// retread the same compiler lines. Adjust to (count > 0 ? 1 : 0)
// for presence; binary keys explode to 2^(features) buckets but
// most are unreachable so the realised set is much smaller.
// Survey: generate N programs, bucket by presence-vector. Returns
// { buckets: Map<key, { seed, vec, dsl }>, perFeature: histogram }.
function survey({ count, seedStart = 1, log = console.log }) {
  const buckets = new Map();
  const perFeature = Object.fromEntries(FEATURE_NAMES.map(f => [f, 0]));
  let compileFailures = 0;

  for (let i = 0; i < count; i++) {
    const seed = seedStart + i;
    const dsl = generateRecipe(seed);
    let compiled;
    try { compiled = compileV2(dsl); } catch { compileFailures++; continue; }
    const vec = featureVectorFromAst(compiled.dsl);
    for (const [k, v] of Object.entries(vec)) if (v > 0) perFeature[k]++;
    const key = bucketKey(vec);
    if (!buckets.has(key)) buckets.set(key, { seed, vec, dsl });
  }

  log(`survey: ${count} seeds → ${buckets.size} unique presence-buckets (${compileFailures} compile failures)`);
  log(`feature presence (count of seeds containing each):`);
  const sorted = Object.entries(perFeature).sort((a, b) => b[1] - a[1]);
  for (const [name, n] of sorted) {
    const pct = ((n / count) * 100).toFixed(1);
    log(`  ${pad(name, 18)} ${pct.padStart(5)}%  (${n}/${count})`);
  }
  return { buckets, perFeature };
}

// Exploit: treat the survey corpus as starting seeds. For each, apply
// random mutations and keep any mutant whose feature vector lands in
// a previously-unseen bucket. Run M total mutation attempts.
function exploit({ corpus, attempts, seedStart, log = console.log }) {
  const buckets = new Map(corpus);
  const seeds = [...corpus.values()];
  const startCount = buckets.size;

  const rng = makeRng(seedStart);

  for (let i = 0; i < attempts; i++) {
    const seed = seeds[Math.floor(rng() * seeds.length)];
    const mutated = mutate(seed.dsl, rng);
    if (!mutated) continue;
    let compiled;
    try { compiled = compileV2(mutated); } catch { continue; }
    const vec = featureVectorFromAst(compiled.dsl);
    const key = bucketKey(vec);
    if (!buckets.has(key)) {
      buckets.set(key, { seed: -1, vec, dsl: mutated, fromMutation: true });
      seeds.push(buckets.get(key));
    }
  }

  log(`exploit: ${attempts} mutation attempts → ${buckets.size - startCount} new buckets discovered (${buckets.size} total)`);
  return buckets;
}

// Lightweight inline mutation set (subset of mutational-fuzz-v2's
// mutations — keeps this file standalone and avoids needing the
// recipe-loading manifest path).
function mutate(dsl, rng) {
  const ops = [
    () => {
      const re = /(?<![A-Za-z_.])(-?\d+\.\d+)(?![A-Za-z_])/g;
      const matches = [...dsl.matchAll(re)];
      if (!matches.length) return null;
      const m = matches[Math.floor(rng() * matches.length)];
      const v = parseFloat(m[1]) * (rng() < 0.5 ? 0.5 : 2);
      return dsl.slice(0, m.index) + v.toFixed(4) + dsl.slice(m.index + m[1].length);
    },
    () => {
      const re = /\b(sin|cos|sqrt|abs|exp|min|max)\b/g;
      const matches = [...dsl.matchAll(re)];
      if (!matches.length) return null;
      const m = matches[Math.floor(rng() * matches.length)];
      const swaps = { sin: "cos", cos: "sin", sqrt: "abs", abs: "sqrt", exp: "abs", min: "max", max: "min" };
      return dsl.slice(0, m.index) + swaps[m[1]] + dsl.slice(m.index + m[1].length);
    },
    () => {
      const re = /\b(sum|mean|max|min)( n in neighbors)\b/g;
      const matches = [...dsl.matchAll(re)];
      if (!matches.length) return null;
      const m = matches[Math.floor(rng() * matches.length)];
      const swaps = { sum: "mean", mean: "sum", max: "min", min: "max" };
      return dsl.slice(0, m.index) + swaps[m[1]] + m[2] + dsl.slice(m.index + m[0].length);
    },
  ];
  return ops[Math.floor(rng() * ops.length)]();
}

function pad(s, n) { return s + " ".repeat(Math.max(0, n - s.length)); }

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const surveyCount = parseInt(arg(args, "--survey", "1000"), 10);
  const exploitCount = parseInt(arg(args, "--exploit", "500"), 10);
  const corpusPath = arg(args, "--corpus", "");

  console.log("=== survey phase ===");
  const { buckets } = survey({ count: surveyCount });

  console.log("\n=== exploit phase ===");
  const finalBuckets = exploit({ corpus: buckets, attempts: exploitCount, seedStart: surveyCount });

  if (corpusPath) {
    const corpus = [...finalBuckets.values()].map(({ seed, vec, dsl, fromMutation = false }) => ({
      seed,
      fromMutation,
      vec,
      dsl,
    }));
    await fs.writeFile(corpusPath, JSON.stringify({ generatedAt: new Date().toISOString(), corpus }, null, 2));
    console.log(`\nwrote corpus: ${corpusPath} (${corpus.length} entries)`);
  }
}

function arg(args, name, fallback) {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  return args[i + 1] ?? fallback;
}
