import fs from "node:fs/promises";
import { recipeCstToAst } from "./cst-to-ast-v2.mjs";
import { parseDslCst } from "./cst-v2.mjs";

function ok(name) { console.log(`ok - ${name}`); }
function fail(name, error) {
  console.error(`not ok - ${name}`);
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
}

async function main() {
  const manifest = JSON.parse(await fs.readFile("recipes/manifest.json", "utf8"));
  for (const recipe of manifest.recipes) {
    const name = `strict CST projection ${recipe.id}`;
    try {
      const mod = await import(`../${recipe.path}`);
      const source = mod.pipelineDsl;
      if (!source) throw new Error(`${recipe.id}: missing pipelineDsl export`);
      const cst = parseDslCst(source);
      const tolerant = recipeCstToAst(cst);
      const strict = recipeCstToAst(cst, { strict: true });
      assertEq(strict, tolerant, `${recipe.id} strict/tolerant projection`);
      assert(strict.recipe?.name, `${recipe.id}: missing recipe name`);
      assert(strict.grid?.kind, `${recipe.id}: missing substrate`);
      assert((strict.stages ?? []).length > 0, `${recipe.id}: missing stages`);
      ok(name);
    } catch (error) {
      fail(name, error);
    }
  }
}

function assert(cond, msg = "assertion failed") {
  if (!cond) throw new Error(msg);
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
