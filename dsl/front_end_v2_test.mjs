import { parseRecipeSource } from "./front-end-v2.mjs";

function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
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

const VALID = `
recipe "Front"
substrate geodesic frequency 16
field u: f32
step { stage s { reads u; writes u; cell { set u = u } } }
`;

test("front-end returns tolerant CST and strict compiler AST together", () => {
  const parsed = parseRecipeSource(VALID);
  assert(parsed.ok);
  assert(parsed.cst.blocks.some((block) => block.keyword === "stage"));
  assertEq(parsed.ast.recipe.name, "Front");
});

test("front-end tolerant mode returns CST even when strict parse fails", () => {
  const parsed = parseRecipeSource("step {\\n  stage s {\\n    reads u\\n", { tolerant: true });
  assert(!parsed.ok);
  assert(parsed.cst.blocks.some((block) => block.keyword === "stage"));
  assert(parsed.errors.some((error) => error.type === "UnclosedBlock"));
  assert(parsed.errors.some((error) => error.type === "StrictParseError"));
});

test("front-end strict mode throws with CST attached", () => {
  try {
    parseRecipeSource("field u: nope");
  } catch (error) {
    assert(error.cst, "strict error should retain tolerant CST");
    assert(error.errors.some((e) => e.type === "StrictParseError"));
    return;
  }
  throw new Error("expected strict parse to throw");
});
