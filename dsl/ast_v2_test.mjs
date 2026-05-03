import {
  blockStackAt,
  cursorContextForAst,
  defaultFoldRanges,
  foldRangeForLine,
  lineIndentDepth,
  parseDslAst,
} from "./ast-v2.mjs";

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
recipe "AST"
substrate geodesic frequency 16
field u: f32

views {
  palette MONO {
    stop 0 color [0, 0, 0]
    stop 1 color [255, 255, 255]
  }
  view u "U" {
    color ramp u palette MONO
  }
}

stamps {
}

scenarios {
  scenario blank {
    set u = 0
  }
}

step {
  stage hold {
    reads u
    writes u
    cell { set u = u }
  }
}
`;

test("AST scanner extracts names without requiring a valid compile", () => {
  const ast = parseDslAst(SOURCE.replace("step {", "step { // half typed is still okay"));
  assertEq(ast.names.fields, ["u"]);
  assertEq(ast.names.palettes, ["MONO"]);
  assertEq(ast.names.views, ["u"]);
  assertEq(ast.names.scenarios, ["blank"]);
});

test("AST scanner exposes fold ranges for grouped DSL sections", () => {
  const ast = parseDslAst(SOURCE);
  assertEq(defaultFoldRanges(ast).length, 3);
  const viewsLine = lineRange(SOURCE, "views {");
  const range = foldRangeForLine(ast, viewsLine.from, viewsLine.to);
  assert(range?.from > viewsLine.from, "fold should start after the opening brace");
  assert(SOURCE[range.to] === "}", "fold should end at the closing brace");
});

test("AST scanner reports block context at a cursor", () => {
  const ast = parseDslAst(SOURCE);
  const pos = SOURCE.indexOf("color ramp");
  assertEq(blockStackAt(ast, pos).map((b) => b.keyword), ["views", "view"]);
});

test("AST scanner classifies scenario for-each bodies as init cell body", () => {
  const source = `
scenarios {
  scenario seeded {
    for each cell where lat > 0 {
      set u = cellRand()
    }
  }
}`;
  const ast = parseDslAst(source);
  const pos = source.indexOf("set u");
  const ctx = cursorContextForAst(ast, pos);
  assertEq(ctx.mode, "initCellBody");
  assertEq(ctx.stack.map((b) => b.keyword), ["scenarios", "scenario", "for"]);
});

test("AST scanner derives indentation depth from block scope", () => {
  const ast = parseDslAst(SOURCE);
  assertEq(lineIndentDepth(ast, SOURCE, lineRange(SOURCE, "views {").from), 0);
  assertEq(lineIndentDepth(ast, SOURCE, lineRange(SOURCE, "  palette MONO {").from), 1);
  assertEq(lineIndentDepth(ast, SOURCE, lineRange(SOURCE, "    stop 0").from), 2);
  assertEq(lineIndentDepth(ast, SOURCE, lineRange(SOURCE, "  }").from), 1);
});

function lineRange(source, needle) {
  const at = source.indexOf(needle);
  if (at < 0) throw new Error(`missing ${needle}`);
  const from = source.lastIndexOf("\n", at) + 1;
  const next = source.indexOf("\n", at);
  return { from, to: next < 0 ? source.length : next };
}
