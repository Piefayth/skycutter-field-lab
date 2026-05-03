// Recipe-level smoke test: import every recipe declared in
// recipes/manifest.json and verify its pipeline compiles. Catches
// regressions in v2 conversion across the whole recipe corpus.
//
// Once all recipes have been converted to v2 syntax, this file replaces
// the equivalent role of the v1 recipe_dsl_test smoke checks.

import fs from "node:fs/promises";
import { compileWebGpuGeodesicPipeline } from "./webgpu-geodesic-compiler.mjs";

function ok(name) { console.log(`ok - ${name}`); }
function fail(name, error) {
  console.error(`not ok - ${name}`);
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
}

async function loadManifest() {
  const data = JSON.parse(await fs.readFile("recipes/manifest.json", "utf8"));
  return data.recipes;
}

async function main() {
  const recipes = await loadManifest();
  for (const r of recipes) {
    const name = `recipe ${r.id} (${r.path})`;
    try {
      const m = await import(`../${r.path}`);
      const pipeline = m.pipeline;
      if (!pipeline?.dsl) throw new Error(`${r.id}: pipeline.dsl missing`);
      // Verify it lowers to WGSL passes via the existing geodesic compiler.
      const compiled = compileWebGpuGeodesicPipeline(pipeline.dsl);
      if (!Array.isArray(compiled.stages) || compiled.stages.length === 0) {
        throw new Error(`${r.id}: produced no compute stages`);
      }
      ok(name);
    } catch (error) {
      fail(name, error);
    }
  }
}

main().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exit(1);
});
