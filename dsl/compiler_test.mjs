import { compileDsl, diagnoseDsl, parseStages } from "./compiler.mjs";

const tests = [];

test("parses named stages with reads, writes, and DSL body", () => {
  const stages = parseStages(`
    use sim cell

    stage source "Source A" {
      reads seed
      writes A
      cell {
        set A = seed + 1
      }
    }
  `);
  assert(stages.length === 1, "expected one stage");
  assert(stages[0].id === "source", "stage id");
  assert(stages[0].name === "Source A", "stage name");
  assertDeep(stages[0].reads, ["seed"], "reads");
  assertDeep(stages[0].writes, ["A"], "writes");
  assert(stages[0].body.statements[0].type === "cell", "cell body");
});

test("compileDsl exposes parsed stage IR for graph metadata", () => {
  const pipeline = compileDsl(`
    use sim cell

    stage grow "Grow" {
      reads A
      writes B
      cell {
        let doubled = A * 2
        set B = doubled
      }
    }
  `);
  assert(pipeline.dsl.stages.length === 1, "stage IR count");
  assertDeep(pipeline.dsl.stages[0].reads, ["A"], "IR reads");
  assertDeep(pipeline.dsl.stages[0].writes, ["B"], "IR writes");
  assert(pipeline.dsl.stages[0].body.type === "dsl", "IR body type");
  assert(pipeline.dsl.stages[0].body.statements[0].type === "cell", "IR statement type");
  assert(pipeline.nodes.grow.dsl.body.statements[0].actions[0].type === "let", "node carries body IR");
});

test("compileDsl exposes recipe grid metadata", () => {
  const recipe = compileDsl(`
recipe "Sphere"
grid geodesic tiles 48
field A
use sim cell

stage seed "Seed" {
  reads A
  writes A
  cell {
    add A = 1
  }
}
`);
  assert(recipe.dsl.grid.kind === "geodesic", `expected geodesic grid, got ${recipe.dsl.grid.kind}`);
  assert(recipe.dsl.grid.frequency === 48, `expected frequency 48, got ${recipe.dsl.grid.frequency}`);
  assert(recipe.dsl.grid.tiles === 48, `expected tiles 48, got ${recipe.dsl.grid.tiles}`);
});

test("block parser ignores DSL keywords in strings and comments", () => {
  const recipe = compileDsl(`
recipe "Keyword scan"
summary "Replace the preset and stage below without confusing the parser."
field A
use init fill, spot
use sim cell

// preset fake "Fake" { fill A 1 }
preset blank "Preset label mentions stage" {
  fill A 0
}

stamp brush "Stamp label mentions preset" {
  spot A lon 0 lat 0 radius 1 amount 1
}

stage hold "Stage label mentions preset" {
  reads A
  writes A
  cell {
    add A = 0
  }
}
`);
  assert(recipe.dsl.presets.length === 1, "expected one real preset");
  assert(recipe.dsl.stamps.length === 1, "expected one real stamp");
  assert(recipe.dsl.stages.length === 1, "expected one real stage");
});

test("omitted grid defaults to geodesic metadata", () => {
  const recipe = compileDsl(`
recipe "Default Grid"
field A
use sim cell

stage seed "Seed" {
  reads A
  writes A
  cell {
    add A = 1
  }
}
`);
  assert(recipe.dsl.grid.kind === "geodesic", `expected geodesic grid, got ${recipe.dsl.grid.kind}`);
  assert(recipe.dsl.grid.frequency === 64, `expected default frequency 64, got ${recipe.dsl.grid.frequency}`);
});

test("init expressions reject rectangular W/H coordinates", () => {
  assertThrows(() => compileDsl(`
recipe "Rect Init"
field A
use init eachCell

preset bad "Bad" {
  eachCell {
    set A = W + H
  }
}

stage noop "Noop" {
  reads A
  writes A
  cell {
    add A = 0
  }
}
`), "unknown identifier W");
});

test("raw JS code fences are rejected", () => {
  assertThrows(() => parseStages(`
    stage reaction "Raw JS" {
      reads A
      writes B
      code \`\`\`
        return { B };
      \`\`\`
    }
  `), "raw JS code blocks are not supported");
});

test("compileDsl derives topology from most recent field writer", () => {
  const pipeline = compileDsl(`
    use sim cell

    stage a "A" {
      reads seed
      writes x
      cell {
        set x = seed
      }
    }

    stage b "B" {
      reads x
      writes y
      cell {
        set y = x
      }
    }

    stage c "C" {
      reads x, y
      writes z
      cell {
        set z = x + y
      }
    }
  `);
  assert(Object.keys(pipeline.nodes).join(",") === "a,b,c", "node ids");
  assertDeep(pipeline.edges, [
    { from: { node: "a", port: "x" }, to: { node: "b", port: "x" } },
    { from: { node: "a", port: "x" }, to: { node: "c", port: "x" } },
    { from: { node: "b", port: "y" }, to: { node: "c", port: "y" } },
  ], "derived edges");
});

test("compileDsl derives topology from stage declarations", () => {
  const pipeline = compileDsl(`
    use sim cell

    field seed, y

    stage makeX "Make X" {
      reads seed
      declares x
      cell {
        set x = seed
      }
    }

    stage useX "Use X" {
      reads x, y
      writes y
      cell {
        add y = x
      }
    }
  `);
  assertDeep(pipeline.dsl.stages[0].declares, ["x"], "declared stage output");
  assertDeep(pipeline.dsl.declared, [{ name: "x", kind: "declared", scope: "pipeline", stage: "makeX" }], "declared pipeline summary");
  assertDeep(pipeline.edges, [
    { from: { node: "makeX", port: "x" }, to: { node: "useX", port: "x" } },
  ], "declared output edge");
});

test("validator constrains declared pipeline fields", () => {
  assertThrows(() => compileDsl(`
    use sim cell
    field seed

    stage one "One" {
      reads seed
      declares x
      cell {
        set x = seed
      }
    }

    stage two "Two" {
      reads seed
      declares x
      cell {
        set x = seed
      }
    }
  `), "Duplicate declared field: x");

  assertThrows(() => compileDsl(`
    use sim cell
    field seed, x

    stage bad "Bad" {
      reads seed
      declares x
      cell {
        set x = seed
      }
    }
  `), "declared field x conflicts with recipe field");

  assertThrows(() => compileDsl(`
    use sim cell
    field y

    stage early "Early" {
      reads x, y
      writes y
      cell {
        add y = x
      }
    }

    stage makeX "Make X" {
      reads y
      declares x
      cell {
        set x = y
      }
    }
  `), "field x is not declared");

  assertThrows(() => compileDsl(`
    use sim cell
    field seed

    stage makeX "Make X" {
      reads seed
      declares x
      cell {
        set x = seed
      }
    }

    stage writeX "Write X" {
      reads x
      writes x
      cell {
        add x = 1
      }
    }
  `), "field x is not declared");
});

test("primitive stages compile to script bodies", () => {
  const pipeline = compileDsl(`
    use sim wind, clamp, normalize

    stage wind "Wind" {
      reads pressure
      writes windU, windV, lift
      wind pressure -> windU, windV, lift strength params.windStrength
    }

    stage clamp "Clamp" {
      reads cloud, pressure
      writes cloud, pressure
      clamp cloud 0 1
      normalize pressure damping 0.997 when params.normalizePressure
    }
  `);
  assert(
    pipeline.nodes.wind.run.includes("computeWind(fields.pressure, fields.windU, fields.windV, params.windStrength);"),
    "wind primitive should call computeWind",
  );
  assert(
    pipeline.nodes.wind.run.includes("computeLift(fields.lift, fields.windU, fields.windV);"),
    "wind primitive with lift should call computeLift",
  );
  assert(
    pipeline.nodes.clamp.run.includes("if (params.normalizePressure) normalizeField(fields.pressure, 0.997);"),
    "normalize primitive should compile conditional",
  );
});

test("wind primitive can omit lift output", () => {
  const pipeline = compileDsl(`
    use sim wind

    stage wind "Wind" {
      reads pressure
      writes windU, windV
      wind pressure -> windU, windV strength 4
    }
  `);
  assert(pipeline.nodes.wind.run.includes("computeWind(fields.pressure, fields.windU, fields.windV, 4);"), "computeWind call");
  assert(!pipeline.nodes.wind.run.includes("computeLift"), "no lift call");
});

test("primitive return values use fields bag to avoid global-name collisions", () => {
  const pipeline = compileDsl(`
    use sim clamp

    stage clamp "Clamp W" {
      reads W
      writes W
      clamp W 0 1
    }
  `);
  assert(pipeline.nodes.clamp.run.includes("clampField(fields.W, 0, 1);"), "clamp uses fields.W");
  assert(pipeline.nodes.clamp.run.includes("return { W: fields.W };"), "return uses fields.W");
});

test("event blocks compile to where with bounded add/set actions", () => {
  const pipeline = compileDsl(`
    use sim event

    stage discharge "Discharge" {
      reads A, B, R
      writes A, B, R
      event when A > params.threshold and R < 0.05 {
        add B = params.amount
        set A = 0
        set R = 1
      }
    }
  `);
  const body = pipeline.nodes.discharge.run;
  assert(body.includes("where("), "event should compile to where");
  assert(body.includes("(c.field.A > c.params.threshold) && (c.field.R < 0.05)"), "condition");
  assert(body.includes("c.add(\"B\", c.params.amount);"), "add action");
  assert(body.includes("c.set(\"A\", 0);"), "set action");
  assert(body.includes("return { A: fields.A, B: fields.B, R: fields.R };"), "return writes");
});

test("cell blocks compile to direct loops with locals, add, set, and when", () => {
  const pipeline = compileDsl(`
    use sim cell
    use core max

    stage grow "Grow" {
      reads moisture, cloud, lift
      writes reaction, cloud, moisture
      cell {
        let growth = max(0, moisture + lift - 0.5)
        let net = growth * (1 - cloud)
        set reaction = net
        add cloud = net * dt
        when params.enableFeedback {
          add moisture = -growth * 0.1 * dt
        }
      }
    }
  `);
  const body = pipeline.nodes.grow.run;
  assert(body.includes("for (let y = 0, i = 0; y < H; y++)"), "cell should compile to direct loop");
  assert(body.includes("const growth = Math.max(0, ((_v_moisture + _v_lift) - 0.5));"), "local expression");
  assert(body.includes("_f_reaction[i] = net;"), "set write");
  assert(body.includes("_f_cloud[i] += (net * dt);"), "add write");
  assert(body.includes("if (params.enableFeedback"), "when block");
});

test("cell expressions expose deterministic per-cell noise", () => {
  const pipeline = compileDsl(`
    use sim cell
    use core noise

    stage stochastic "Stochastic" {
      reads moisture
      writes moisture
      cell {
        let seed = frame * 131
        add moisture = noise(seed + 11) * params.amp
      }
    }
  `);
  const body = pipeline.nodes.stochastic.run;
  assert(body.includes("const seed = (frame * 131);"), "frame local");
  assert(body.includes("hashNoise(i, (seed + 11)) * params.amp"), "noise mapping");
});

test("stage cell validation accepts geodesic coordinates", () => {
  const result = diagnoseDsl(`
    field A
    use sim cell
    use core sin, cos, noise

    stage waves "Spatial waves" {
      reads A
      writes A
      cell {
        let wave = sin(lon * 3 + lat * 2) + cos(px * 4 + py * 2 + pz)
        add A = (wave + noise(frame + i) + u + v + N * 0) * dt
      }
    }
  `);
  assert(result.ok, `expected geodesic coordinates to validate, got ${result.errors?.[0]?.message}`);
});

test("cell expressions can read recipe constants and planet constants", () => {
  const pipeline = compileDsl(`
    planet gravity 9.81
    const gain 0.25
    use sim cell

    field A

    stage scale "Scale" {
      reads A
      writes A
      cell {
        add A = (consts.gain + planet.gravity) * dt
      }
    }
  `);
  const body = pipeline.nodes.scale.run;
  assert(body.includes("consts.gain"), "const expression");
  assert(body.includes("planet.gravity"), "planet expression");
});

test("each blocks compile stencil reads and side-effect writes", () => {
  const pipeline = compileDsl(`
    use sim each
    use core sample

    stage mark "Mark" {
      reads W, R
      writes spreadMask
      each {
        when W < params.threshold and R <= 0.1 and sample(W, 1, 0) > 0.5 {
          set spreadMask = 1
        }
      }
    }
  `);
  const body = pipeline.nodes.mark.run;
  assert(body.includes("each("), "each block");
  assert(body.includes("c.sample(\"W\", 1, 0)"), "sample call");
  assert(body.includes("c.set(\"spreadMask\", 1);"), "set action");
});

test("event blocks support local bindings", () => {
  const pipeline = compileDsl(`
    use sim event

    stage swap "Swap" {
      reads A, B
      writes A, B
      event when A > 0 {
        let oldA = A
        set A = B
        set B = oldA
      }
    }
  `);
  const body = pipeline.nodes.swap.run;
  assert(body.includes("const oldA = c.field.A;"), "event let");
  assert(body.includes("c.set(\"B\", oldA);"), "event local use");
});

test("validator rejects writes to undeclared fields", () => {
  assertThrows(() => compileDsl(`
    use sim cell

    stage bad "Bad" {
      reads A
      writes A
      cell {
        add B = 1
      }
    }
  `), "writes to undeclared field B");
});

test("validator rejects unknown expression identifiers", () => {
  assertThrows(() => compileDsl(`
    use sim cell

    stage bad "Bad" {
      reads A
      writes A
      cell {
        add A = missing * dt
      }
    }
  `), "unknown identifier missing");
});

test("validator rejects bad function arity", () => {
  assertThrows(() => compileDsl(`
    use sim cell
    use core clamp

    stage bad "Bad" {
      reads A
      writes A
      cell {
        add A = clamp(A, 0)
      }
    }
  `), "clamp expects 3 args");
});

test("validator rejects samples of undeclared fields", () => {
  assertThrows(() => compileDsl(`
    use sim each
    use core sample

    stage bad "Bad" {
      reads A
      writes A
      each {
        add A = sample(B, 1, 0)
      }
    }
  `), "sample field references undeclared field B");
});

test("validator rejects stage writes and stamps to immutable sources", () => {
  assertThrows(() => compileDsl(`
    use sim cell
    source S

    stage bad "Bad" {
      reads S
      writes S
      cell {
        set S = 1
      }
    }
  `), "source S is immutable");

  assertThrows(() => compileDsl(`
    use sim cell
    use init spot
    field A
    source S

    stamp bad "Bad" {
      spot S lon lon lat lat radius r amount 1
    }

    stage keep "Keep" {
      reads S
      writes A
      cell {
        set A = S
      }
    }
  `), "immutable source S");
});

test("diagnoseDsl returns structured success and failure", () => {
  const good = diagnoseDsl(`
    use sim cell

    stage ok "OK" {
      reads A
      writes A
      cell {
        add A = A * dt
      }
    }
  `);
  assert(good.ok === true, "good diagnostic");
  assert(good.stages[0].id === "ok", "good stages");

  const bad = diagnoseDsl(`
    use sim cell

    stage bad "Bad" {
      reads A
      writes A
      cell {
        add B = 1
      }
    }
  `);
  assert(bad.ok === false, "bad diagnostic");
  assert(bad.errors[0].message.includes("writes to undeclared field B"), "bad error");
});

let failed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failed++;
    console.error(`not ok - ${name}`);
    console.error(error.stack ?? error.message);
  }
}

if (failed > 0) process.exit(1);

function test(name, fn) {
  tests.push({ name, fn });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertDeep(actual, expected, message) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${message}: expected ${e}, got ${a}`);
}

function assertThrows(fn, messagePart) {
  try {
    fn();
  } catch (error) {
    if (String(error.message).includes(messagePart)) return;
    throw new Error(`expected error containing "${messagePart}", got "${error.message}"`);
  }
  throw new Error(`expected error containing "${messagePart}"`);
}
