import fs from "node:fs/promises";
import { metricCstToAst, stageCstToAst } from "./cst-to-ast-v2.mjs";
import { parseDslCst } from "./cst-v2.mjs";
import { parseV2 } from "./parse-v2.mjs";

function ok(name) { console.log(`ok - ${name}`); }
function fail(name, error) {
  console.error(`not ok - ${name}`);
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
}

async function main() {
  const manifest = JSON.parse(await fs.readFile("recipes/manifest.json", "utf8"));
  for (const recipe of manifest.recipes) {
    const name = `CST projection parity ${recipe.id}`;
    try {
      const mod = await import(`../${recipe.path}`);
      const source = mod.pipelineDsl;
      if (!source) throw new Error(`${recipe.id}: missing pipelineDsl export`);
      const parsed = parseV2(source);
      const cst = parseDslCst(source);
      const stages = cst.blocks
        .filter((block) => block.keyword === "stage")
        .map((block) => stageCstToAst(cst, block));
      const metrics = cst.statements
        .filter((stmt) => stmt.keyword === "metric")
        .map(metricCstToAst);
      assertEq(stages, parsed.stages, `${recipe.id} stages`);
      assertEq(metrics, parsed.metrics, `${recipe.id} metrics`);
      ok(name);
    } catch (error) {
      fail(name, error);
    }
  }
}

function assertEq(actual, expected, msg = "") {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg}\n  expected: ${b}\n  actual:   ${a}`);
}

main().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exit(1);
});
