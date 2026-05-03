// Smoke test for the v2 fuzzer infrastructure. The fuzzer is a
// research tool — its output is random, so this test only verifies
// the infrastructure itself works (deterministic generation, correct
// shape) and runs a small batch to surface compile-pipeline failures.
// Failures from the batch get logged but don't fail the suite.

import test from "node:test";
import assert from "node:assert/strict";
import { generateRecipe, runFuzz } from "./fuzz-v2.mjs";
import { bucketKey, featureVectorFromSource } from "./fuzz-features-v2.mjs";

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

test("fuzzer: small batch — log compile-failure stats without failing the suite", async () => {
  const { succeeded, failures } = await runFuzz({ count: 50, seedStart: 1, log: () => {} });
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

test("fuzzer features: extracted from v2 AST, not source regexes", () => {
  const dsl = `recipe "Features"
substrate geodesic frequency 16
field u: f32
field state: u32
field rng: u32
field alive: bool
field wind: vec2
field d: f32 derived

step {
  stage s {
    reads u, wind, rng
    writes u, d, rng
    cell {
      let g = gradient(u)
      let r = rand01(rng)
      when u > 0 and not false {
        set d = divergence(wind)
      }
      set u = u@upstream(wind.x, wind.y, dt) + (u@prev > 0 ? r : 0)
      set rng = rngNext(rng)
    }
  }
}

metric active = count cells where u > 0

views {
  view custom "Custom" {
    color expr {
      set red = length(wind)
      set green = 0
      set blue = 0
    }
  }
}

stamps {
  stamp tap "Tap" {
    spot u at brush.pos, radius=brush.r, amount=1
    ellipse wind at lon=0, lat=0, rx=0.2, ry=0.1, amount=vec2(1, 0), angle=0
  }
}

scenarios {
  scenario init "Init" {
    region u at lonMin=-1, lonMax=1, latMin=-0.5, latMax=0.5, amount=1
    for each cell {
      set u = sin(lon)
      set state = abs(cellRand(3) * 4)
      set alive = state > 1
    }
  }
}`;
  const vec = featureVectorFromSource(dsl);
  for (const name of [
    "vec2Field", "u32Field", "boolField", "derivedField", "gradient", "divergence", "prevRead",
    "upstreamRead", "ternary", "when", "countWhere", "memberDotXY",
    "lengthCall", "logicalAnd", "logicalNot", "exprView", "stamp",
    "ellipseAction", "regionAction", "scenarioEachCell", "statefulRng",
  ]) {
    assert.ok(vec[name] > 0, `expected ${name} to be present`);
  }
  assert.ok(bucketKey(vec).includes("upstreamRead:1"));
});
