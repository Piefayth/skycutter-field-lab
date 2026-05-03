import {
  blockStackAt,
  cursorContextAt,
  expectedAt,
  parseDslCst,
  statementAt,
} from "./cst-v2.mjs";

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

const SOURCE = `
recipe "CST"
substrate geodesic frequency 16
field u: f32
param speed slider 0..1 default 0.3

step {
  stage move {
    reads u
    writes u
    cell {
      let lap = sum n in neighbors { u@n - u }
      set u = u + lap * speed
    }
  }
}

views {
  palette P {
    stop 0 color [0, 0, 0]
    stop 1 color [255, 255, 255]
  }
  view u "U" { color ramp u palette P }
}
`;

test("CST records blocks, statements, symbols, and names", () => {
  const cst = parseDslCst(SOURCE);
  assert(cst.blocks.some((block) => block.keyword === "stage" && block.id === "move"));
  assert(cst.statements.some((stmt) => stmt.keyword === "reads" && stmt.role === "stageIo"));
  assertEq(cst.names.fields, ["u"]);
  assertEq(cst.names.parameters, ["speed"]);
  assertEq(cst.names.palettes, ["P"]);
});

test("CST cursor context exposes mode, stack, and current statement", () => {
  const cst = parseDslCst(SOURCE);
  const pos = SOURCE.indexOf("set u =");
  const ctx = cursorContextAt(cst, pos);
  assertEq(ctx.mode, "cellBody");
  assertEq(ctx.stack.map((block) => block.keyword), ["step", "stage", "cell"]);
  assertEq(statementAt(cst, pos).keyword, "set");
  assert(ctx.symbols.some((symbol) => symbol.kind === "local" && symbol.name === "lap"));
});

test("CST annotates expression spans and expected cursor zones", () => {
  const cst = parseDslCst(SOURCE);
  const setStmt = statementAt(cst, SOURCE.indexOf("set u ="));
  assertEq(setStmt.parts.target.name, "u");
  assertEq(setStmt.expressions.map((expr) => expr.kind), ["assignmentExpr"]);
  assertEq(expectedAt(cst, SOURCE.indexOf("reads u") + "reads ".length), ["fieldName"]);
  assertEq(expectedAt(cst, SOURCE.lastIndexOf("palette P") + "palette ".length), ["paletteName"]);
  assertEq(expectedAt(cst, SOURCE.indexOf("u + lap")), ["expression"]);
});

test("CST is tolerant of unclosed blocks", () => {
  const cst = parseDslCst("step {\\n  stage s {\\n    reads u\\n");
  assertEq(cst.errors.map((e) => e.type), ["UnclosedBlock", "UnclosedBlock"]);
  const pos = cst.source.length;
  assertEq(blockStackAt(cst, pos).map((block) => block.keyword), ["step", "stage"]);
});
