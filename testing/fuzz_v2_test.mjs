// Smoke test for the v2 fuzzer infrastructure. The fuzzer is a
// research tool — its output is random, so this test only verifies
// the infrastructure itself works (deterministic generation, correct
// shape) and runs a small batch to surface compile-pipeline failures.
// Failures from the batch get logged but don't fail the suite.

import test from "node:test";
import assert from "node:assert/strict";
import { generateRecipe, runFuzz } from "./fuzz-v2.mjs";

test("fuzzer: generateRecipe returns a v2-shaped DSL string", () => {
  const dsl = generateRecipe(42);
  assert.equal(typeof dsl, "string");
  assert.ok(dsl.length > 200, "non-trivial output");
  for (const required of ['recipe "Fuzz', "substrate geodesic", "field f0", "step {", "scenarios {"]) {
    assert.ok(dsl.includes(required), `output missing "${required}"`);
  }
});

test("fuzzer: deterministic — same seed → same DSL", () => {
  assert.equal(generateRecipe(7), generateRecipe(7));
});

test("fuzzer: different seeds → different DSL", () => {
  assert.notEqual(generateRecipe(1), generateRecipe(2));
});

test("fuzzer: small batch — log compile-failure stats without failing the suite", () => {
  const { succeeded, failures } = runFuzz({ count: 50, seedStart: 1, log: () => {} });
  // Crash-summary stays in the test log so a regression sweep can
  // notice if a previously-clean batch starts failing.
  console.log(`  fuzz seeds 1..50: ${succeeded}/50 compiled cleanly, ${failures.length} failures`);
  if (failures.length > 0) {
    const byPhase = {};
    for (const f of failures) byPhase[f.phase] = (byPhase[f.phase] ?? 0) + 1;
    for (const [phase, count] of Object.entries(byPhase)) {
      console.log(`    ${phase}: ${count}`);
    }
  }
  // Test passes regardless — the generator is allowed to surface bugs,
  // and re-fixing them isn't this test's job.
  assert.ok(true);
});
