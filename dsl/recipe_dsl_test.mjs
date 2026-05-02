import * as weather from "../recipes/weather.mjs";
import * as fitzhughNagumo from "../recipes/fitzhugh-nagumo.mjs";
import * as belousovZhabotinsky from "../recipes/belousov-zhabotinsky.mjs";
import * as kuramotoChimera from "../recipes/kuramoto-chimera.mjs";
import * as iceAlbedo from "../recipes/ice-albedo.mjs";
import * as sirEpidemic from "../recipes/sir-epidemic.mjs";
import * as klausmeier from "../recipes/klausmeier.mjs";
import * as predatorPrey from "../recipes/predator-prey.mjs";
import * as blank from "../recipes/blank.mjs";
import { compileDsl, diagnoseDsl, parseStages, parseStamps, parseTopLevelDeclarations } from "./compiler.mjs";
import { createPipelineMetadata } from "../visual/pipeline-metadata.mjs";
import { materializeRecipe, prepareRecipeState } from "../visual/recipes.mjs";
import { createState } from "../kernel/kernel.mjs";

const recipes = [
  weather,
  fitzhughNagumo,
  belousovZhabotinsky,
  kuramotoChimera,
  iceAlbedo,
  sirEpidemic,
  klausmeier,
  predatorPrey,
  blank,
];

let failed = 0;

for (const recipe of recipes) {
  const recipeName = recipe.pipeline?.dsl?.recipe?.name ?? recipe.name ?? "(unnamed recipe)";
  check(recipeName, () => {
    assert(typeof recipe.pipelineDsl === "string", "missing pipelineDsl");
    assert(!recipe.pipelineDsl.includes("code ```"), "recipe DSL contains raw code fence");

    const stages = parseStages(recipe.pipelineDsl);
    assert(stages.length > 0, "no parsed stages");

    const nodeIds = Object.keys(recipe.pipeline?.nodes ?? {});
    assert(nodeIds.length === stages.length, "compiled node count does not match parsed stage count");

    for (const stage of stages) {
      assert(recipe.pipeline.nodes[stage.id], `missing compiled node ${stage.id}`);
      assert(Array.isArray(stage.reads), `${stage.id} reads are not parsed`);
      assert(Array.isArray(stage.writes), `${stage.id} writes are not parsed`);
      assert(recipe.pipeline.nodes[stage.id].dsl?.body?.type === "dsl", `${stage.id} has no DSL IR body`);
    }
  });
}

check("runtime exposes pipeline DSL source", () => {
  const runner = createPipelineMetadata(weather);
  assert(runner.pipelineDsl() === weather.pipelineDsl, "runner.pipelineDsl() should return source text");
});

check("recipe state preparation allocates geodesic fields", () => {
  const recipe = materializeRecipe(weather);
  const state = createState();
  prepareRecipeState(recipe, state);
  assert(state.grid?.kind === "geodesic", "state grid should be geodesic");
  assert(state.fields.pressure?.length === state.grid.cells, "pressure field should match geodesic cell count");
});

check("DSL top-level declarations expose recipe control schema", () => {
  const source = `
recipe "Tiny Weather"
summary "Small recipe for schema tests."
recommendedPreset warm
grid geodesic tiles 32
planet gravity 9.81
const rainoutBase 0.024
use sim cell
use clock dt, frame
use geo x, y, i, lon, lat, u, v, px, py, pz, N, PI, TAU
use core clamp
field pressure, cloud
source moistureSource
setting simRateHz slider min 0 max 360 step 1 default 90 label "SIM RATE"
param enableForcing boolean default true label "sources / sinks"

stage grow "Grow" {
  reads pressure, cloud, moistureSource
  writes cloud
  cell {
    when enableForcing {
    add cloud = (pressure + moistureSource * rainoutBase) * dt
    }
  }
}
`;
  const schema = parseTopLevelDeclarations(source);
  assert(schema.recipe.name === "Tiny Weather", "recipe name should parse");
  assert(schema.recipe.summary === "Small recipe for schema tests.", "recipe summary should parse");
  assert(schema.recipe.recommendedPreset === "warm", "recommended preset should parse");
  assert(schema.grid.kind === "geodesic" && schema.grid.frequency === 32, "recipe geodesic grid should parse");
  assert(schema.planet.gravity === 9.81, "planet constants should parse");
  assert(schema.constants[0].name === "rainoutBase" && schema.constants[0].value === 0.024, "recipe constants should parse");
  assert(schema.imports.length === 4, "imports should parse");
  assert(schema.fields.length === 3, "expected three allocated field declarations");
  assert(schema.sources.length === 1 && schema.sources[0].name === "moistureSource", "source declarations should parse");
  assert(schema.settings.length === 1, "expected one setting declaration");
  assert(schema.settings[0].type === "number", "slider should materialize as number setting");
  assert(schema.settings[0].min === 0 && schema.settings[0].max === 360, "setting range should parse");
  assert(schema.parameters.length === 1, "expected one parameter declaration");
  assert(schema.parameters[0].type === "boolean" && schema.parameters[0].default === true, "boolean default should parse");

  const pipeline = compileDsl(source);
  assert(pipeline.dsl.fields.length === 3, "compiled DSL should retain allocated field declarations");
  assert(pipeline.dsl.settings.length === 1, "compiled DSL should retain setting declarations");
  assert(pipeline.dsl.parameters.length === 1, "compiled DSL should retain parameter declarations");
  assert(pipeline.dsl.grid.frequency === 32, "compiled DSL should retain geodesic grid declaration");
  assert(pipeline.dsl.constants[0].name === "rainoutBase", "compiled DSL should retain constants");
  assert(pipeline.dsl.sources[0].name === "moistureSource", "compiled DSL should retain source declarations");
  assert(
    pipeline.dsl.stages[0].params.join(",") === "enableForcing",
    "compiled DSL should expose per-stage param reads",
  );
});

check("DSL presets expose executable init action IR", () => {
  const pipeline = compileDsl(`
recipe "Init Test"
use init fill, spot, ellipse, region, eachCell
use sim cell
use geo x, y, i, lon, lat, u, v, px, py, pz, N, PI, TAU
use core cellNoise
field A, B

preset seeded "Seeded" {
  fill A 0
  spot A lon 0 lat 0 radius 8 amount 0.25
  ellipse B lon 0 lat 0 rx 10 ry 3 amount 0.35 angle -0.2
  region A lon -0.6..0.6 lat 0..PI/2 amount 1
  eachCell {
    let dx = lon
    when dx > 0 {
      add B = cellNoise(2) * 0.1
    }
  }
}

stage keep "Keep" {
  reads A
  writes A
  cell {
    add A = 0
  }
}
`);
  const preset = pipeline.dsl.presets[0];
  assert(preset.id === "seeded", "preset id should parse");
  assert(preset.actions.length === 5, "preset actions should parse");
  assert(preset.actions[1].type === "spot", "spot should parse");
  assert(preset.actions[2].type === "ellipse" && preset.actions[2].center === "lonlat", "spherical ellipse should parse");
  assert(preset.actions[3].type === "region", "region should parse");
  assert(preset.actions[4].type === "eachCell", "eachCell should parse");
});

check("DSL stamps expose executable stamp action IR", () => {
  const source = `
recipe "Stamp Test"
use init spot, ellipse
use sim cell
use geo x, y, i, lon, lat, u, v, px, py, pz, N, PI, TAU
field A, B

stamp paint "Paint" {
  spot A lon lon lat lat radius r amount 0.75
  ellipse B lon lon lat lat rx r * 2 ry r amount 0.5 angle 0.25
}

stage keep "Keep" {
  reads A
  writes A
  cell {
    add A = 0
  }
}
`;
  const stamps = parseStamps(source);
  assert(stamps.length === 1, "stamp should parse");
  assert(stamps[0].id === "paint" && stamps[0].label === "Paint", "stamp id and label should parse");
  assert(stamps[0].actions.length === 2, "stamp actions should parse");

  const pipeline = compileDsl(source);
  assert(pipeline.dsl.stamps.length === 1, "compiled DSL should retain stamp declarations");
  assert(pipeline.dsl.stamps[0].actions[0].type === "spot", "compiled stamp spot should parse");
  assert(pipeline.dsl.stamps[0].actions[1].type === "ellipse", "compiled stamp ellipse should parse");
  assert(pipeline.dsl.stamps[0].actions[1].center === "lonlat", "compiled stamp spherical ellipse should parse");
});

check("DSL declarations constrain fields and params when present", () => {
  let result = diagnoseDsl(`
field pressure
stage badField "Bad field" {
  reads pressure
  writes cloud
  cell {
    add cloud = pressure
  }
}
`);
  assert(!result.ok && /field cloud is not declared/.test(result.errors[0].message), "undeclared field should fail");

  result = diagnoseDsl(`
field pressure, cloud
param gain slider min 0 max 360 default 60
use sim cell
stage badParam "Bad param" {
  reads pressure, cloud
  writes cloud
  cell {
    add cloud = pressure * missing
  }
}
`);
  assert(!result.ok && /unknown identifier missing/.test(result.errors[0].message), "undeclared param should fail");
});

check("DSL imports constrain primitive and helper usage when present", () => {
  let result = diagnoseDsl(`
field pressure, cloud
param gain slider min 0 max 360 default 60
use sim cell

stage badHelper "Bad helper" {
  reads pressure, cloud
  writes cloud
  cell {
    add cloud = clamp(pressure * gain, 0, 1)
  }
}
`);
  assert(!result.ok && /core\.clamp is not imported/.test(result.errors[0].message), "missing core import should fail");

  result = diagnoseDsl(`
field pressure, cloud
use core clamp

stage badPrimitive "Bad primitive" {
  reads pressure, cloud
  writes cloud
  cell {
    add cloud = clamp(pressure, 0, 1)
  }
}
`);
  assert(!result.ok && /sim\.cell is not imported/.test(result.errors[0].message), "missing sim import should fail");
});

check("DSL imports constrain runtime and geodesic builtins", () => {
  let result = diagnoseDsl(`
field A
use sim cell

stage badClock "Bad clock" {
  reads A
  writes A
  cell {
    add A = A * dt
  }
}
`);
  assert(!result.ok && /clock\.dt is not imported/.test(result.errors[0].message), "missing clock import should fail");

  result = diagnoseDsl(`
field A
use sim cell
use clock dt

stage badGeo "Bad geo" {
  reads A
  writes A
  cell {
    add A = A + lon
  }
}
`);
  assert(!result.ok && /geo\.lon is not imported/.test(result.errors[0].message), "missing geo import should fail");

  result = diagnoseDsl(`
field A
setting simRateHz slider min 0 max 360 default 60
use sim cell
use clock dt

stage badSettingRead "Bad setting read" {
  reads A
  writes A
  cell {
    add A = A + simRateHz * dt
  }
}
`);
  assert(!result.ok && /unknown identifier simRateHz/.test(result.errors[0].message), "settings should not be stage-readable");
});

check("DSL stamps are constrained to declared fields and imported stamp primitives", () => {
  let result = diagnoseDsl(`
field cloud
use sim cell
use init spot
use geo lon, lat

stamp badField "Bad field" {
  spot pressure lon lon lat lat radius r amount 1
}

stage keep "Keep" {
  reads cloud
  writes cloud
  cell {
    add cloud = 0
  }
}
`);
  assert(!result.ok && /undeclared field pressure/.test(result.errors[0].message), "undeclared stamp field should fail");

  result = diagnoseDsl(`
field cloud
use sim cell
use init spot
use geo lon, lat

stamp badAction "Bad action" {
  fill cloud 1
}

stage keep "Keep" {
  reads cloud
  writes cloud
  cell {
    add cloud = 0
  }
}
`);
  assert(!result.ok && /stamp action fill is not supported/.test(result.errors[0].message), "unsupported stamp action should fail");

  result = diagnoseDsl(`
field cloud
use sim cell
use init spot
use geo lon, lat

stamp badImport "Bad import" {
  ellipse cloud lon lon lat lat rx r ry r amount 1
}

stage keep "Keep" {
  reads cloud
  writes cloud
  cell {
    add cloud = 0
  }
}
`);
  assert(!result.ok && /init\.ellipse is not imported/.test(result.errors[0].message), "missing stamp import should fail");
});

if (failed > 0) process.exit(1);

function check(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failed++;
    console.error(`not ok - ${name}`);
    console.error(error.stack ?? error.message);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
