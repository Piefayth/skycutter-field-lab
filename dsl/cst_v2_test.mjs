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
  assert(!cst.blocks.some((block) => block.keyword === "?"));
  assertEq(cst.root.statements.find((stmt) => stmt.keyword === "recipe").text, "recipe \"CST\"");
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
  assertEq(expectedAt(cst, SOURCE.indexOf("geodesic")), ["substrateKind"]);
  assertEq(expectedAt(cst, SOURCE.indexOf("reads u") + "reads ".length), ["fieldName"]);
  assertEq(expectedAt(cst, SOURCE.lastIndexOf("palette P") + "palette ".length), ["paletteName"]);
  assertEq(expectedAt(cst, SOURCE.indexOf("u + lap")), ["expression"]);
});

test("CST reports directive-specific expected zones", () => {
  const source = `
recipe "Zones"
substrate geodesic frequency 16
field u: f32
param speed slider 0..1 step 0.1 default 0.3 label "Speed"
step { stage s { reads u; writes u; cell { set u = u } } }
metric peak = max cells { abs(u) }
views {
  palette P { stop 0 color [0, 0, 0]; stop 1 color [255, 255, 255] }
  view u "U" { color ramp u range [0, 1] palette P }
}
scenarios { scenario blank { set u = 0 } }
`;
  const cst = parseDslCst(source);
  assertEq(expectedAt(cst, source.indexOf("slider")), ["paramWidget"]);
  assertEq(expectedAt(cst, source.indexOf("step 0.1")), ["paramModifier"]);
  assertEq(expectedAt(cst, source.indexOf("max cells")), ["metricReduction"]);
  assertEq(expectedAt(cst, source.indexOf("ramp u") + "ramp ".length), ["fieldName"]);
  assertEq(expectedAt(cst, source.indexOf("range [0") + "range [".length), ["expression"]);
});

test("CST expression spans record identifiers, coord reads, and reduction binders", () => {
  const cst = parseDslCst(SOURCE);
  const letStmt = statementAt(cst, SOURCE.indexOf("let lap"));
  const expr = letStmt.expressions[0];
  assertEq(expr.node.type, "ExprNeighborReduce");
  assertEq(expr.node.body.type, "ExprBinary");
  assertEq(expr.coordReads.map((read) => `${read.field}@${read.coord}`), ["u@n"]);
  assertEq(expr.reductions.map((reduction) => `${reduction.op}:${reduction.binder}`), ["sum:n"]);
  assert(cst.references.some((ref) => ref.role === "coordField" && ref.name === "u"));
  assert(cst.references.some((ref) => ref.role === "coord" && ref.name === "n"));
  assertEq(expectedAt(cst, SOURCE.indexOf("u@n") + "u@".length), ["coordName"]);
  const ctx = cursorContextAt(cst, SOURCE.indexOf("u@n - u"));
  assert(ctx.symbols.some((symbol) => symbol.kind === "binder" && symbol.name === "n"));
});

test("CST parses expression nodes for calls members coord reads and ternaries", () => {
  const source = `field u: f32\nfield wind: vec2\nstep { stage s { reads u, wind; writes u; cell { set u = wind.x > 0 ? clamp(u@prev, 0, 1) : u@upstream(wind.x, wind.y, dt) } } }`;
  const cst = parseDslCst(source);
  const stmt = statementAt(cst, source.indexOf("set u ="));
  const node = stmt.expressions[0].node;
  assertEq(node.type, "ExprConditional");
  assertEq(node.test.type, "ExprBinary");
  assertEq(node.consequent.type, "ExprCall");
  assertEq(node.consequent.args[0].type, "ExprCoordRead");
  assertEq(node.alternate.type, "ExprCoordRead");
  assertEq(node.alternate.coord, "upstream");
  assertEq(node.alternate.args.length, 3);
});

test("CST expression parser tolerates missing right-hand side", () => {
  const source = `field u: f32\nstep { stage s { reads u; writes u; cell { set u = u + } } }`;
  const cst = parseDslCst(source);
  const stmt = statementAt(cst, source.indexOf("set u ="));
  const node = stmt.expressions[0].node;
  assertEq(node.type, "ExprBinary");
  assertEq(node.right.type, "ExprMissing");
});

test("CST reports coord-name expectation for incomplete coord reads", () => {
  const source = `field u: f32\nstep { stage s { reads u; writes u; cell { set u = u@ } } }`;
  const cst = parseDslCst(source);
  assertEq(expectedAt(cst, source.indexOf("u@") + "u@".length), ["coordName"]);
});

test("CST is tolerant of unclosed blocks", () => {
  const cst = parseDslCst("step {\\n  stage s {\\n    reads u\\n");
  assertEq(cst.errors.map((e) => e.type), ["UnclosedBlock", "UnclosedBlock"]);
  const pos = cst.source.length;
  assertEq(blockStackAt(cst, pos).map((block) => block.keyword), ["step", "stage"]);
});
