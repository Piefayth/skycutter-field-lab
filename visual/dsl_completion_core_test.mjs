import {
  blankStructuralOptionsForSource,
  completionOptionsForSource,
} from "./dsl-completion-core.mjs";

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

function labels(source, needle, prefix = "") {
  const pos = source.indexOf(needle);
  if (pos < 0) throw new Error(`missing cursor marker ${needle}`);
  const clean = source.replace(needle, "");
  return completionOptionsForSource(clean, pos, prefix).map((option) => option.label);
}

const SOURCE = `
recipe "Complete"
substrate geodesic frequency 16
field u: f32
field v: f32
param speed slider 0..1 default 0.2 label "SPEED"

views {
  palette MONO {
    stop 0 color [0, 0, 0]
    stop 1 color [255, 255, 255]
  }
  view u "U" {
    color ramp u range [0, 1] palette MONO
  }
}

stamps {
  stamp paint {
    spot u at brush.pos, radius=brush.r, amount=1
  }
}

scenarios {
  scenario blank {
    set u = 0
  }
}

step {
  stage hold {
    reads u, v
    writes u
    cell {
      let lap = sum n in neighbors { u@n - u }
      @@
    }
  }
}
`;

test("cell body offers only cell action words for a bare prefix", () => {
  assertEq(labels(SOURCE, "@@"), ["let", "set", "add", "when"]);
  assertEq(labels(SOURCE, "@@", "s"), ["set"]);
});

test("blank structural popup only opens at canonical indentation", () => {
  const pos = SOURCE.indexOf("@@");
  const clean = SOURCE.replace("@@", "");
  assertEq(blankStructuralOptionsForSource(clean, pos).map((option) => option.label), ["let", "set", "add", "when"]);

  const underIndented = clean.replace("      \n    }\n  }\n}", "    \n    }\n  }\n}");
  const underIndentedPos = underIndented.indexOf("    \n    }\n  }\n}");
  assertEq(blankStructuralOptionsForSource(underIndented, underIndentedPos + 4).map((option) => option.label), []);

  const overIndented = clean.replace("      \n    }\n  }\n}", "        \n    }\n  }\n}");
  const overIndentedPos = overIndented.indexOf("        \n    }\n  }\n}");
  assertEq(blankStructuralOptionsForSource(overIndented, overIndentedPos + 8).map((option) => option.label), []);
});

test("set target position offers declared fields", () => {
  const source = SOURCE.replace("@@", "set @@");
  assertEq(labels(source, "@@", "u"), ["u"]);
});

test("stage body offers stage clauses", () => {
  const source = `
recipe "S"
substrate geodesic frequency 16
field u: f32
step {
  stage hold {
    @@
  }
}`;
  assertEq(labels(source, "@@").filter((label) => ["reads", "writes", "cell"].includes(label)), ["reads", "writes", "cell"]);
});

test("views section offers view declarations", () => {
  const source = `
views {
  @@
}`;
  assertEq(labels(source, "@@").filter((label) => ["palette", "view", "overlay"].includes(label)), ["palette", "view", "overlay"]);
});

test("palette reference offers declared palettes", () => {
  const source = SOURCE.replace("color ramp u range [0, 1] palette MONO", "color ramp u range [0, 1] palette @@");
  assertEq(labels(source, "@@", "M"), ["MONO"]);
});

test("import line offers importable builtins", () => {
  const source = `
recipe "I"
import s@@
`;
  const options = completionOptionsForSource(source.replace("@@", ""), source.indexOf("@@"), "s").map((option) => option.label);
  if (!options.includes("sin") || !options.includes("sqrt")) {
    throw new Error(`expected import suggestions to include sin and sqrt; got ${options.join(", ")}`);
  }
});
