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

test("fuzz 500 seeds for coverage measurement", async () => {
  await runFuzz({ count: 500, seedStart: 1, wgsl: true, log: () => {} });
});
