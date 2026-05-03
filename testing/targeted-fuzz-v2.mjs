// =============================================================================
// Targeted v2 fuzz recipes.
//
// The broad generator in fuzz-v2.mjs is entropy-heavy. This file is
// shape-heavy: each recipe family deliberately exercises a high-risk DSL
// surface that tends to be underrepresented in random generation.
//
// CLI:
//   node testing/targeted-fuzz-v2.mjs
//   node testing/targeted-fuzz-v2.mjs --count 50 --wgsl
//   node testing/targeted-fuzz-v2.mjs --count 20 --execute
//   node testing/targeted-fuzz-v2.mjs --family metric-history-upstream --show
// =============================================================================

import { compileV2 } from "../dsl/compile-v2.mjs";
import { compileWebGpuGeodesicPipeline } from "../dsl/webgpu-geodesic-compiler.mjs";
import { makeRng } from "./fuzz-v2.mjs";
import { bucketKey, featureVectorFromAst } from "./fuzz-features-v2.mjs";

const TARGET_FAMILIES = [
  {
    name: "metric-history-upstream",
    doc: "metric bodies with @prev + @upstream; history field has a real writer",
    generate: recipeMetricHistoryUpstream,
  },
  {
    name: "expr-view-conditionals",
    doc: "render expr views with lets, root RGB assignments, and conditional overrides",
    generate: recipeExprViewConditionals,
  },
  {
    name: "vec2-stamps-regions",
    doc: "vec2 fields through scenario/stamp spot, ellipse, region, and cell math",
    generate: recipeVec2StampsRegions,
  },
  {
    name: "integer-bool-fields",
    doc: "u32/bool storage, bool writes, count metrics, and integer read/write casts",
    generate: recipeIntegerBoolFields,
  },
  {
    name: "multi-stage-ordering",
    doc: "multi-stage last-write/read-after-write patterns without history fields",
    generate: recipeMultiStageOrdering,
  },
];

export function targetedFamilies() {
  return TARGET_FAMILIES.map(({ name, doc }) => ({ name, doc }));
}

export function generateTargetedRecipe(seed, familyName = null) {
  const family = familyName
    ? TARGET_FAMILIES.find((f) => f.name === familyName)
    : TARGET_FAMILIES[(Math.max(1, seed) - 1) % TARGET_FAMILIES.length];
  if (!family) {
    throw new Error(`unknown targeted fuzz family "${familyName}"`);
  }
  return {
    family: family.name,
    dsl: family.generate(seed),
  };
}

export async function runTargetedFuzz({
  count = TARGET_FAMILIES.length * 10,
  seedStart = 1,
  family = null,
  wgsl = false,
  execute = false,
  log = console.log,
} = {}) {
  let harnessApi = null;
  if (execute) {
    const mod = await import("./wgsl-harness.mjs");
    if (!await mod.harnessAvailable()) {
      log("targeted fuzz: --execute requested but dawn-node not available; run `npm install`");
      return { succeeded: 0, failures: [], featureStats: {} };
    }
    harnessApi = mod;
    wgsl = true;
  }

  const failures = [];
  const byFamily = {};
  const featureStats = {};
  let succeeded = 0;

  for (let i = 0; i < count; i++) {
    const seed = seedStart + i;
    const generated = generateTargetedRecipe(seed, family);
    byFamily[generated.family] ??= { ok: 0, failed: 0 };

    let compiled;
    try {
      compiled = compileV2(generated.dsl).dsl;
      if (wgsl) compileWebGpuGeodesicPipeline(compiled);
      const vec = featureVectorFromAst(compiled);
      const key = bucketKey(vec);
      featureStats[key] = (featureStats[key] ?? 0) + 1;
    } catch (err) {
      byFamily[generated.family].failed++;
      failures.push({
        phase: "compile",
        seed,
        family: generated.family,
        dsl: generated.dsl,
        error: err.message,
        stack: err.stack,
      });
      continue;
    }

    if (execute) {
      const exec = await executeCompiled(compiled, seed, harnessApi);
      if (exec.phase !== "ok") {
        byFamily[generated.family].failed++;
        failures.push({
          phase: "execute",
          seed,
          family: generated.family,
          dsl: generated.dsl,
          error: exec.error.message,
          stack: exec.error.stack,
        });
        continue;
      }
    }

    byFamily[generated.family].ok++;
    succeeded++;
  }

  log(`targeted fuzz: ${succeeded}/${count} ${execute ? "executed" : wgsl ? "compiled+wgsl" : "compiled"} cleanly (${failures.length} failures)`);
  for (const f of TARGET_FAMILIES) {
    const s = byFamily[f.name];
    if (s) log(`  ${pad(f.name, 26)} ok=${num(s.ok)} failed=${num(s.failed)}`);
  }
  log(`  feature buckets: ${Object.keys(featureStats).length}`);

  return { succeeded, failures, byFamily, featureStats };
}

async function executeCompiled(compiled, seed, harnessApi) {
  const h = await harnessApi.makeHarness({ dsl: compiled, frequency: compiled.grid?.frequency ?? 16 });
  const rng = makeRng(seed ^ 0x5174A7);
  try {
    for (const field of compiled.fields ?? []) {
      const components = field.type === "vec2" ? 2 : 1;
      const Ctor = (field.type === "u32" || field.type === "bool") ? Uint32Array : Float32Array;
      const arr = new Ctor(h.cellCount * components);
      for (let i = 0; i < arr.length; i++) {
        if (Ctor === Uint32Array) arr[i] = Math.floor(rng() * 3);
        else arr[i] = (rng() - 0.5) * 0.5;
      }
      h.uploadField(field.name, arr);
    }
    await h.tick({ dt: 1 / 60 });
    for (const field of compiled.fields ?? []) {
      const data = await h.readField(field.name);
      for (let i = 0; i < data.length; i++) {
        if (!Number.isFinite(data[i])) {
          return { phase: "execute", error: new Error(`field ${field.name}[${i}] = ${data[i]} after one tick`) };
        }
      }
    }
    return { phase: "ok" };
  } catch (error) {
    return { phase: "execute", error };
  } finally {
    h.dispose();
  }
}

function recipeMetricHistoryUpstream(seed) {
  const rng = makeRng(seed);
  const speed = fixed(0.08 + rng() * 0.18);
  const damping = fixed(0.01 + rng() * 0.08);
  return `recipe "Target metric history upstream ${seed}"
summary "Targeted fuzz: metrics read history and upstream samples."

substrate geodesic frequency 16

field u: f32
field wind: vec2
field speedField: f32 derived

param speed slider 0..0.3 step 0.01 default ${speed} label "SPEED"
param damping slider 0..0.2 step 0.01 default ${damping} label "DAMPING"

step {
  stage advectWave {
    reads u previous, wind
    writes u
    cell {
      let lap = mean n in neighbors { u@n - u }
      let adv = u@upstream(wind.x * speed, wind.y * speed, dt)
      set u = clamp(1.4 * u - 0.4 * u@prev + speed * lap + damping * (adv - u), -4, 4)
    }
  }

  stage deriveSpeed {
    reads wind
    writes speedField
    cell {
      set speedField = length(wind)
    }
  }
}

metric previousEnergy = mean cells { abs(u - u@prev) }
metric upstreamPeak = max cells { abs(u@upstream(wind.x, wind.y, dt)) + speedField }

views {
  palette U {
    stop 0 color [30, 60, 180]
    stop 0.5 color [235, 235, 235]
    stop 1 color [220, 70, 50]
  }
  view u "U" { color ramp u range [-2, 2] palette U }
}

stamps {
  stamp kick "Kick" {
    spot u at brush.pos, radius=brush.r, amount=1
  }
}

scenarios {
  scenario init "Init" {
    set u = 0
    set wind = vec2(${fixed(rng() * 0.2)}, ${fixed(rng() * 0.2)})
    spot u at lon=0, lat=0, radius=0.2, amount=1
  }
}`;
}

function recipeExprViewConditionals(seed) {
  const rng = makeRng(seed);
  const shift = fixed(rng() * 0.4 - 0.2);
  return `recipe "Target expr view conditionals ${seed}"
summary "Targeted fuzz: color expr view with conditionals and vec2 reads."

substrate geodesic frequency 16

field u: f32
field wind: vec2
field lit: f32 derived

param gain slider 0..2 step 0.01 default ${fixed(0.8 + rng() * 0.6)} label "GAIN"
param invert toggle default ${rng() > 0.5 ? "true" : "false"} label "INVERT"

step {
  stage flow {
    reads u, wind
    writes u, wind
    cell {
      let g = gradient(u)
      set wind = wind * 0.9 + g * 0.1
      add u = (mean n in neighbors { u@n - u } + wind.x * 0.05) * dt
    }
  }

  stage deriveLit {
    reads u
    writes lit
    cell {
      set lit = clamp(u * gain + ${shift}, 0, 1)
    }
  }
}

metric brightness = mean cells { lit }

views {
  view composite "Composite" {
    color expr {
      let mag = clamp(length(wind), 0, 1)
      set red = lit * 255
      set green = mag * 180 + 20
      set blue = (1 - lit) * 220
      when invert {
        set red = (1 - lit) * 255
        set blue = lit * 220
      }
      when mag > 0.5 {
        set green = 255
      }
    }
  }
}

stamps {
  stamp impulse "Impulse" {
    spot wind at brush.pos, radius=brush.r, amount=vec2(1, -1)
  }
}

scenarios {
  scenario init "Init" {
    for each cell {
      set u = sin(lon * ${2 + Math.floor(rng() * 4)}) * 0.25 + 0.5
      set wind = vec2(cos(lat), sin(lon)) * 0.1
    }
  }
}`;
}

function recipeVec2StampsRegions(seed) {
  const rng = makeRng(seed);
  return `recipe "Target vec2 stamps regions ${seed}"
summary "Targeted fuzz: vec2 amounts through spot, ellipse, and region actions."

substrate geodesic frequency 16

field wind: vec2
field density: f32
field curlProxy: f32 derived

param decay slider 0..1 step 0.01 default ${fixed(0.02 + rng() * 0.1)} label "DECAY"

step {
  stage relax {
    reads wind, density
    writes wind, density
    cell {
      let pull = gradient(density)
      set wind = wind * (1 - decay) + pull * dt
      add density = -divergence(wind) * dt
    }
  }

  stage derive {
    reads wind
    writes curlProxy
    cell {
      set curlProxy = wind.x - wind.y
    }
  }
}

metric windMean = mean cells { length(wind) }
metric windyCells = count cells where length(wind) > 0.2

views {
  palette D {
    stop 0 color [20, 30, 55]
    stop 1 color [230, 245, 255]
  }
  view density "Density" { color ramp density range [-1, 1] palette D }
  view curl "Curl proxy" { color wheel curlProxy range [-1, 1] }
}

stamps {
  stamp east "Push east" {
    spot wind at brush.pos, radius=brush.r, amount=vec2(1, 0)
  }
  stamp vortex "Vortex block" {
    ellipse wind at lon=0, lat=0, rx=0.3, ry=0.12, amount=vec2(0, 1), angle=${fixed(rng() * 1.5)}
  }
}

scenarios {
  scenario init "Init" {
    set wind = vec2(0, 0)
    set density = 0
    region wind at lonMin=-0.5, lonMax=0.5, latMin=-0.4, latMax=0.4, amount=vec2(${fixed(0.2 + rng() * 0.4)}, ${fixed(rng() * 0.4 - 0.2)})
    ellipse density at lon=1, lat=0, rx=0.25, ry=0.1, amount=1, angle=0.5
  }
}`;
}

function recipeIntegerBoolFields(seed) {
  const rng = makeRng(seed);
  const threshold = fixed(1.5 + rng());
  return `recipe "Target integer bool fields ${seed}"
summary "Targeted fuzz: u32 and bool storage paths."

substrate geodesic frequency 16

field state: u32
field alive: bool
field heat: f32
field edge: u32 derived

param threshold slider 0..6 step 1 default ${threshold} label "THRESHOLD"

step {
  stage automaton {
    reads state, alive, heat
    writes state, alive, heat, edge
    cell {
      let neighborsAlive = sum n in neighbors { alive@n }
      set alive = neighborsAlive > threshold
      set state = wrapAngle(state + neighborsAlive + 1)
      set edge = neighborsAlive > 0 ? 1 : 0
      add heat = (neighborsAlive - heat) * dt
    }
  }
}

metric active = count cells where alive > 0
metric meanState = mean cells { state }
metric edgeCount = sum cells { edge }

views {
  palette HEAT {
    stop 0 color [5, 5, 15]
    stop 1 color [240, 200, 80]
  }
  view heat "Heat" { color ramp heat range [0, 6] palette HEAT }
  view state "State" { color wheel state range [0, 6] }
}

stamps {
  stamp setAlive "Set alive" {
    spot alive at brush.pos, radius=brush.r, amount=1
  }
}

scenarios {
  scenario init "Init" {
    for each cell {
      set state = abs(cellRand(${2 + Math.floor(rng() * 9)}) * 5)
      set alive = state > 2
      set heat = state
    }
  }
}`;
}

function recipeMultiStageOrdering(seed) {
  const rng = makeRng(seed);
  return `recipe "Target multi stage ordering ${seed}"
summary "Targeted fuzz: source-order stage reads and repeated writes."

substrate geodesic frequency 16

field a: f32
field b: f32
field c: f32 derived

param rate slider 0..2 step 0.01 default ${fixed(0.4 + rng())} label "RATE"

step {
  stage seedA {
    reads a
    writes a
    cell {
      add a = (mean n in neighbors { a@n - a }) * rate * dt
    }
  }

  stage transfer {
    reads a, b
    writes b
    cell {
      set b = clamp(b + (a - b) * 0.25, -2, 2)
    }
  }

  stage overwriteA {
    reads a, b
    writes a, c
    cell {
      set c = abs(a - b)
      set a = clamp(a * 0.75 + b * 0.25, -2, 2)
    }
  }
}

metric gap = max cells { c }
metric averageA = mean cells { a }

views {
  palette AB {
    stop 0 color [50, 80, 180]
    stop 0.5 color [230, 230, 230]
    stop 1 color [220, 90, 60]
  }
  view a "A" { color ramp a range [-1, 1] palette AB }
  view c "Gap" { color ramp c range [0, 1] palette AB }
}

stamps {
  stamp bump "Bump A" {
    spot a at brush.pos, radius=brush.r, amount=1
  }
}

scenarios {
  scenario init "Init" {
    for each cell {
      set a = sin(lon * ${2 + Math.floor(rng() * 5)}) * cos(lat)
      set b = cos(lon)
    }
  }
}`;
}

function fixed(n) {
  return Number(n.toFixed(3));
}

function pad(s, n) { return s + " ".repeat(Math.max(0, n - s.length)); }
function num(n) { return String(n).padStart(4); }

function arg(args, name, fallback) {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  return args[i + 1] ?? fallback;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const count = parseInt(arg(args, "--count", String(TARGET_FAMILIES.length * 10)), 10);
  const seedStart = parseInt(arg(args, "--seed", "1"), 10);
  const family = arg(args, "--family", "");
  const wgsl = args.includes("--wgsl") || args.includes("--execute");
  const execute = args.includes("--execute");
  const show = args.includes("--show");
  const list = args.includes("--list");

  if (list) {
    for (const f of targetedFamilies()) console.log(`${pad(f.name, 26)} ${f.doc}`);
    process.exit(0);
  }

  if (show) {
    const generated = generateTargetedRecipe(seedStart, family || null);
    console.log(`# family=${generated.family} seed=${seedStart}`);
    console.log(generated.dsl);
    process.exit(0);
  }

  const { failures } = await runTargetedFuzz({
    count,
    seedStart,
    family: family || null,
    wgsl,
    execute,
  });

  if (failures.length > 0) {
    const byMsg = new Map();
    for (const f of failures) {
      const key = f.error.slice(0, 100);
      const bucket = byMsg.get(key) ?? { count: 0, sample: f };
      bucket.count++;
      byMsg.set(key, bucket);
    }
    console.log("\ntop targeted-fuzz failures:");
    for (const [msg, { count, sample }] of [...byMsg.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 8)) {
      console.log(`  [${count}x] ${msg}`);
      console.log(`       family=${sample.family} seed=${sample.seed} phase=${sample.phase}`);
    }
    process.exit(1);
  }
}
