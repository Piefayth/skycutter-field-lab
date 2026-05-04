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

test("source declarations and source references participate in completion", () => {
  const sourceType = `
recipe "S"
substrate geodesic frequency 16
source mask: @@
field u: f32
step { stage hold { reads u; writes u; cell { set u = u } } }
`;
  assertEq(labels(sourceType, "@@"), ["f32", "vec2", "u32", "bool"]);

  const reads = `
recipe "S"
substrate geodesic frequency 16
source mask: f32
field u: f32
step {
  stage hold {
    reads @@
    writes u
    cell { set u = u }
  }
}`;
  assertEq(labels(reads, "@@", "m"), ["mask"]);

  const stamp = `
recipe "S"
substrate geodesic frequency 16
source mask: f32
field u: f32
stamps {
  stamp paint {
    spot @@
  }
}
step { stage hold { reads u; writes u; cell { set u = u } } }
`;
  assertEq(labels(stamp, "@@", "m"), ["mask"]);

  const setAt = stamp.replace("spot @@", "set @@");
  assertEq(labels(setAt, "@@", "m"), ["mask"]);

  const afterTarget = stamp.replace("spot @@", "set mask @@");
  assertEq(labels(afterTarget, "@@", "a"), ["at"]);
});

test("views section offers view declarations", () => {
  const source = `
views {
  @@
}`;
  assertEq(labels(source, "@@").filter((label) => ["palette", "view", "overlay"].includes(label)), ["palette", "view", "overlay"]);
});

test("stamp body offers stroke phase blocks", () => {
  const source = `
recipe "S"
substrate geodesic frequency 16
field u: f32
stamps {
  stamp ripple {
    @@
  }
}
step { stage hold { reads u; writes u; cell { set u = u } } }
`;
  assertEq(labels(source, "@@").filter((label) => label === "on"), ["on"]);

  const phase = source.replace("@@", "on @@");
  assertEq(labels(phase, "@@"), ["press", "drag"]);
});

test("expr view set target offers color channels", () => {
  const source = `
recipe "V"
substrate geodesic frequency 16
field u: f32
views {
  view composite {
    color expr {
      set @@
    }
  }
}
step { stage hold { reads u; writes u; cell { set u = u } } }
`;
  assertEq(labels(source, "@@", "r"), ["red"]);
});

test("view body offers particle trail clauses", () => {
  const source = `
recipe "V"
substrate geodesic frequency 16
field u: f32
field wind: vec2
views {
  palette MONO {
    stop 0 color [0, 0, 0]
    stop 1 color [255, 255, 255]
  }
  view flow {
    color ramp u palette MONO
    @@
  }
}
step { stage hold { reads u, wind; writes u, wind; cell { set u = u; set wind = wind } } }
`;
  assertEq(labels(source, "@@", "p"), ["particles"]);
  const afterParticles = source.replace("@@", "particles @@");
  assertEq(labels(afterParticles, "@@", "a"), ["advect"]);
  const afterAdvect = source.replace("@@", "particles advect=@@");
  assertEq(labels(afterAdvect, "@@", "w"), ["wind"]);
  const afterField = source.replace("@@", "particles advect=wind @@");
  const particleKnobs = labels(afterField, "@@", "s");
  if (!particleKnobs.includes("size")) throw new Error(`expected particle knobs to include size; got ${JSON.stringify(particleKnobs)}`);
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
