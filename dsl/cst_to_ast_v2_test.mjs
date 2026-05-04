import {
  cellActionsCstToAst,
  expressionCstToAst,
  metricCstToAst,
  recipeCstToAst,
  stageCstToAst,
} from "./cst-to-ast-v2.mjs";
import { parseDslCst } from "./cst-v2.mjs";

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

test("CST expression projection handles arithmetic/calls/members", () => {
  assertExpressionProjection("clamp(wind.x * 2 + u, -1, 1)", {
    type: "Call",
    callee: { type: "Identifier", name: "clamp" },
    args: [
      {
        type: "Binary",
        op: "+",
        left: {
          type: "Binary",
          op: "*",
          left: {
            type: "Member",
            object: { type: "Identifier", name: "wind" },
            prop: "x",
          },
          right: { type: "Number", value: "2" },
        },
        right: { type: "Identifier", name: "u" },
      },
      { type: "Unary", op: "-", expr: { type: "Number", value: "1" } },
      { type: "Number", value: "1" },
    ],
  });
});

test("CST expression projection handles ternary + prev", () => {
  assertExpressionProjection("u > 0 ? u@prev : -u", {
    type: "Conditional",
    test: {
      type: "Binary",
      op: ">",
      left: { type: "Identifier", name: "u" },
      right: { type: "Number", value: "0" },
    },
    consequent: {
      type: "CoordRead",
      field: "u",
      coord: { kind: "prev", depth: 1 },
    },
    alternate: {
      type: "Unary",
      op: "-",
      expr: { type: "Identifier", name: "u" },
    },
  });
});

test("CST expression projection handles neighbor reductions", () => {
  assertExpressionProjection("sum n in neighbors { u@n - u }", {
    type: "NeighborReduce",
    op: "sum",
    coord: "n",
    source: { kind: "neighbors" },
    body: {
      type: "Binary",
      op: "-",
      left: {
        type: "CoordRead",
        field: "u",
        coord: { kind: "neighbor", binding: "n" },
      },
      right: { type: "Identifier", name: "u" },
    },
  });
});

test("CST expression projection handles ring and disk reductions", () => {
  assertExpressionProjection("mean n in ring(2) { u@n }", {
    type: "NeighborReduce",
    op: "mean",
    coord: "n",
    source: { kind: "ring", radius: 2 },
    body: {
      type: "CoordRead",
      field: "u",
      coord: { kind: "neighbor", binding: "n" },
    },
  });
  assertExpressionProjection("sum n in disk(3) { u@n - u }", {
    type: "NeighborReduce",
    op: "sum",
    coord: "n",
    source: { kind: "disk", radius: 3 },
    body: {
      type: "Binary",
      op: "-",
      left: {
        type: "CoordRead",
        field: "u",
        coord: { kind: "neighbor", binding: "n" },
      },
      right: { type: "Identifier", name: "u" },
    },
  });
});

test("CST expression projection handles metric kernel reductions", () => {
  assertExpressionProjection("mean n in kernel bell(center, 0.03) { u@n }", {
    type: "NeighborReduce",
    op: "mean",
    coord: "n",
    source: {
      kind: "kernel",
      kernel: "bell",
      center: { kind: "param", name: "center" },
      width: { kind: "literal", value: 0.03 },
    },
    body: {
      type: "CoordRead",
      field: "u",
      coord: { kind: "neighbor", binding: "n" },
    },
  });
});

test("CST expression projection handles upstream coord reads", () => {
  assertExpressionProjection("u@upstream(wind.x, wind.y, dt)", {
    type: "CoordRead",
    field: "u",
    coord: {
      kind: "upstream",
      velX: {
        type: "Member",
        object: { type: "Identifier", name: "wind" },
        prop: "x",
      },
      velY: {
        type: "Member",
        object: { type: "Identifier", name: "wind" },
        prop: "y",
      },
      dt: { type: "Identifier", name: "dt" },
    },
  });
});

test("CST cell-action projection handles let/set/add/when", () => {
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
  const cst = parseDslCst(source);
  const cellBlock = cst.blocks.find((block) => block.keyword === "cell");
  const actual = cellActionsCstToAst(cst, cellBlock);
  const expected = recipeCstToAst(cst, { strict: true }).stages[0].body.statements[0].actions;
  assertEq(actual, expected);
});

test("CST stage projection handles reads/writes/cell", () => {
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
  const cst = parseDslCst(source);
  const actual = stageCstToAst(cst, cst.blocks.find((block) => block.keyword === "stage"));
  const expected = recipeCstToAst(cst, { strict: true }).stages[0];
  assertEq(actual, expected);
});

test("CST stage projection handles edge flux blocks", () => {
  const source = `
recipe "Projection"
substrate geodesic frequency 16
field water: f32
field height: f32
step {
  stage runoff {
    reads water, height
    writes water
    edge n in neighbors {
      let drop = max(height - height@n, 0)
      flux water = water * drop
    }
  }
}`;
  const cst = parseDslCst(source);
  const actual = stageCstToAst(cst, cst.blocks.find((block) => block.keyword === "stage"));
  assertEq(actual.body.statements[0].type, "edge");
  assertEq(actual.body.statements[0].coord, "n");
  assertEq(actual.body.statements[0].actions.map((a) => a.type), ["let", "flux"]);
});

test("CST metric projection handles body and predicate", () => {
  const source = `
recipe "Projection"
substrate geodesic frequency 16
field u: f32
step { stage s { reads u; writes u; cell { set u = u } } }
metric active = count cells where abs(u) > 0.1
metric energy = sum cells { u * u + u@prev }
`;
  const cst = parseDslCst(source);
  const actual = cst.statements
    .filter((stmt) => stmt.keyword === "metric")
    .map(metricCstToAst);
  const expected = recipeCstToAst(cst, { strict: true }).metrics;
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

function assertExpressionProjection(expr, expected) {
  const source = recipeWithSetExpr(expr);
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
