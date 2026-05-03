import {
  cellActionsCstToAst,
  expressionCstToAst,
  metricCstToAst,
  recipeCstToAst,
  stageCstToAst,
} from "./cst-to-ast-v2.mjs";
import { parseDslCst } from "./cst-v2.mjs";
import { parseV2 } from "./parse-v2.mjs";

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

function assertEq(actual, expected, msg = "") {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg}\n  expected: ${b}\n  actual:   ${a}`);
}

test("CST expression projection matches parse-v2 for arithmetic/calls/members", () => {
  assertProjectionParity("clamp(wind.x * 2 + u, -1, 1)");
});

test("CST expression projection matches parse-v2 for ternary + prev", () => {
  assertProjectionParity("u > 0 ? u@prev : -u");
});

test("CST expression projection matches parse-v2 for neighbor reductions", () => {
  assertProjectionParity("sum n in neighbors { u@n - u }");
});

test("CST expression projection matches parse-v2 for upstream coord reads", () => {
  assertProjectionParity("u@upstream(wind.x, wind.y, dt)");
});

test("CST cell-action projection matches parse-v2 for let/set/add/when", () => {
  const source = `
recipe "Projection"
substrate geodesic frequency 16
field u: f32
field wind: vec2
step {
  stage s {
    reads u, wind
    writes u
    cell {
      let lap = sum n in neighbors { u@n - u }
      add u = lap * 0.1
      when u > 1 {
        set u = clamp(u@prev, 0, 1)
      }
    }
  }
}`;
  const expected = parseV2(source).stages[0].body.statements[0].actions;
  const cst = parseDslCst(source);
  const cellBlock = cst.blocks.find((block) => block.keyword === "cell");
  const actual = cellActionsCstToAst(cst, cellBlock);
  assertEq(actual, expected);
});

test("CST stage projection matches parse-v2 for reads/writes/cell", () => {
  const source = `
recipe "Projection"
substrate geodesic frequency 16
field u: f32
field v: f32
step {
  stage s "Step label" {
    reads u previous, v
    writes u
    cell {
      set u = u@prev + v
    }
  }
}`;
  const expected = parseV2(source).stages[0];
  const cst = parseDslCst(source);
  const actual = stageCstToAst(cst, cst.blocks.find((block) => block.keyword === "stage"));
  assertEq(actual, expected);
});

test("CST metric projection matches parse-v2 for body and predicate", () => {
  const source = `
recipe "Projection"
substrate geodesic frequency 16
field u: f32
step { stage s { reads u; writes u; cell { set u = u } } }
metric active = count cells where abs(u) > 0.1
metric energy = sum cells { u * u + u@prev }
`;
  const expected = parseV2(source).metrics;
  const cst = parseDslCst(source);
  const actual = cst.statements
    .filter((stmt) => stmt.keyword === "metric")
    .map(metricCstToAst);
  assertEq(actual, expected);
});

test("strict CST projection rejects missing required recipe structure", () => {
  assertStrictProjectionError(`
substrate geodesic frequency 16
field u: f32
step { stage s { reads u; writes u; cell { set u = u } } }
`, "recipe must declare");
  assertStrictProjectionError(`
recipe "Missing substrate"
field u: f32
step { stage s { reads u; writes u; cell { set u = u } } }
`, "substrate");
  assertStrictProjectionError(`
recipe "Missing step"
substrate geodesic frequency 16
field u: f32
`, "at least one stage");
});

test("strict CST projection rejects misplaced grouped declarations", () => {
  assertStrictProjectionError(`
recipe "Bad"
substrate geodesic frequency 16
field u: f32
scenario blank { set u = 0 }
step { stage s { reads u; writes u; cell { set u = u } } }
`, "scenario");
  assertStrictProjectionError(`
recipe "Bad"
substrate geodesic frequency 16
field u: f32
views { scenario blank { set u = 0 } }
step { stage s { reads u; writes u; cell { set u = u } } }
`, "views section");
});

test("strict CST projection rejects malformed stage bodies", () => {
  assertStrictProjectionError(`
recipe "Bad"
substrate geodesic frequency 16
field u: f32
step { }
`, "at least one stage");
  assertStrictProjectionError(`
recipe "Bad"
substrate geodesic frequency 16
field u: f32
step { stage s { reads u; writes u } }
`, "missing cell");
  assertStrictProjectionError(`
recipe "Bad"
substrate geodesic frequency 16
field u: f32
step { stage s { reads u; writes u; diffuse u by 0.1 } }
`, "no longer a stage primitive");
});

function assertProjectionParity(expr) {
  const source = recipeWithSetExpr(expr);
  const expected = firstSetExpr(parseV2(source));
  const cst = parseDslCst(source);
  const stmt = cst.statements.find((s) => s.keyword === "set");
  const actual = expressionCstToAst(stmt.expressions[0].node);
  assertEq(actual, expected, expr);
}

function recipeWithSetExpr(expr) {
  return `
recipe "Projection"
substrate geodesic frequency 16
field u: f32
field wind: vec2
step {
  stage s {
    reads u, wind
    writes u
    cell { set u = ${expr} }
  }
}`;
}

function firstSetExpr(schema) {
  return schema.stages[0].body.statements[0].actions[0].expr;
}

function assertStrictProjectionError(source, expectedMessage) {
  try {
    recipeCstToAst(parseDslCst(source), { strict: true });
  } catch (error) {
    if (!String(error.message).includes(expectedMessage)) {
      throw new Error(`expected error containing ${JSON.stringify(expectedMessage)}, got ${error.message}`);
    }
    return;
  }
  throw new Error(`expected strict CST projection error containing ${JSON.stringify(expectedMessage)}`);
}
