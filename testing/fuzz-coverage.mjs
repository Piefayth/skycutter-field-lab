// One-shot coverage probe — wraps the fuzzer in a node:test shell so
// `node --experimental-test-coverage` reports which lines of the v2
// pipeline our generated programs actually exercise. Not run by the
// regular suite (filename doesn't match *_test.mjs).
//
// Usage:
//   node --experimental-test-coverage \
//        --test-coverage-include='dsl/**' \
//        --test testing/fuzz-coverage.mjs
//
// Drives the full static pipeline: parse → validate → typecheck →
// WGSL emit. Without wgsl: true the WGSL emitter shows ~13% from
// incidental imports only.

import test from "node:test";
import { runFuzz } from "./fuzz-v2.mjs";
import { runNegativeFuzz } from "./negative-fuzz-v2.mjs";
import { runMutationalFuzz } from "./mutational-fuzz-v2.mjs";

test("generative fuzz 500 seeds — happy-path coverage", async () => {
  await runFuzz({ count: 500, seedStart: 1, wgsl: true, log: () => {} });
});

test("negative fuzz 500 seeds — validator rejection branches", () => {
  runNegativeFuzz({ count: 500, seedStart: 1, log: () => {} });
});

test("mutational fuzz 500 seeds — shipped-recipe surface", async () => {
  await runMutationalFuzz({ count: 500, depth: 3, seedStart: 1, log: () => {} });
});
