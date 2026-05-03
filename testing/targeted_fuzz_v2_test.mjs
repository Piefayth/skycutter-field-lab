import test from "node:test";
import assert from "node:assert/strict";
import {
  generateTargetedRecipe,
  runTargetedFuzz,
  targetedFamilies,
} from "./targeted-fuzz-v2.mjs";

test("targeted fuzzer exposes named high-risk recipe families", () => {
  const families = targetedFamilies();
  assert.ok(families.length >= 5, "expected several targeted families");
  assert.ok(families.some((f) => f.name === "metric-history-upstream"));
  assert.ok(families.some((f) => f.name === "integer-bool-fields"));
});

test("targeted fuzzer generation is deterministic per family + seed", () => {
  const a = generateTargetedRecipe(17, "vec2-stamps-regions");
  const b = generateTargetedRecipe(17, "vec2-stamps-regions");
  assert.equal(a.family, "vec2-stamps-regions");
  assert.equal(a.dsl, b.dsl);
  assert.match(a.dsl, /field wind: vec2/);
  assert.match(a.dsl, /ellipse wind/);
});

test("targeted fuzzer small WGSL batch compiles cleanly", async () => {
  const count = targetedFamilies().length;
  const { succeeded, failures } = await runTargetedFuzz({
    count,
    seedStart: 1,
    wgsl: true,
    log: () => {},
  });
  assert.equal(failures.length, 0, failures[0]?.error);
  assert.equal(succeeded, count);
});
