// Recipe audit harness — runs a recipe through the WGSL execution
// harness using its own scenario init, sweeps every numeric param
// across low / mid / high, reports stability + parameter sensitivity.
//
// Usage:
//   node testing/audit-recipe.mjs <recipe-id> [scenario] [ticks] [freq]
//
// Defaults: ticks=300 (≈5s wall-clock at simRateHz 60), freq=16
// (~2.5k cells, fast). Scenario defaults to the recipe's
// recommendedPreset when omitted.
//
// Output is stdout-only and structured: each line is a single
// audit signal. Stability check first, then per-param sweep.

import { harnessAvailable, makeHarness } from "./wgsl-harness.mjs";
import { buildDslPresetDecls } from "../visual/dsl-init-runtime.mjs";
import { createGeodesicGrid } from "../kernel/geodesic-grid.mjs";
import { createState, reallocateState } from "../kernel/kernel.mjs";

const RECIPE_ID = process.argv[2];
const SCENARIO_ARG = process.argv[3] || null;
const TICKS = Number(process.argv[4] ?? 300);
const FREQ = Number(process.argv[5] ?? 16);

if (!RECIPE_ID) {
  console.error("usage: node testing/audit-recipe.mjs <recipe-id> [scenario] [ticks] [freq]");
  process.exit(1);
}

if (!await harnessAvailable()) {
  console.error("dawn-node not available — `npm install` in field-lab-fork/");
  process.exit(1);
}

const recipeMod = await import(`../recipes/${RECIPE_ID}.mjs`);
const dsl = recipeMod.pipeline.dsl;

const scenario = SCENARIO_ARG
  ?? dsl.recipe?.recommendedPreset
  ?? dsl.presets?.[0]?.id;
if (!scenario) {
  console.error(`${RECIPE_ID}: no scenario found (no recommendedPreset and no scenarios declared)`);
  process.exit(1);
}

const params = paramDefaults(dsl);
const fieldDecls = (dsl.fields ?? []).map((f) => ({ name: f.name, type: f.type ?? "f32" }));
const fieldNames = fieldDecls.map((f) => f.name);
const fieldTypes = Object.fromEntries(fieldDecls.map((f) => [f.name, f.type]));

console.log(`# audit ${RECIPE_ID} scenario=${scenario} ticks=${TICKS} freq=${FREQ}`);
console.log(`# fields: ${fieldDecls.map((f) => `${f.name}:${f.type}`).join(", ")}`);
console.log(`# params: ${(dsl.parameters ?? []).map((p) => `${p.name}=${p.default}`).join(", ")}`);

// --- Stability run with default params -------------------------------
const baseline = await runOnce({ scenario, params, ticks: TICKS });
console.log(`\n# === STABILITY (default params) ===`);
reportRun(baseline, "  ");

// --- Per-param sensitivity sweep ------------------------------------
console.log(`\n# === PARAM SWEEPS ===`);
for (const param of dsl.parameters ?? []) {
  const sweep = await sweepParam(param, scenario, params);
  reportSweep(param, sweep);
}

console.log(`\n# === SUMMARY ===`);
const summary = audit(baseline, dsl);
for (const line of summary) console.log(`  ${line}`);

// =====================================================================
// helpers
// =====================================================================

function paramDefaults(dsl) {
  const out = {};
  for (const p of dsl.parameters ?? []) out[p.name] = p.default ?? 0;
  for (const s of dsl.settings ?? []) out[s.name] = s.default ?? 0;
  return out;
}

async function runOnce({ scenario, params, ticks }) {
  // Build the JS-side scenario runner so we can use the recipe's own
  // declared init (including spot / for each cell where / etc.).
  const presetDecls = buildDslPresetDecls(dsl.presets ?? [], dsl, (n) => params[n]);
  const decl = presetDecls.find((p) => p.id === scenario);
  if (!decl) throw new Error(`scenario not found: ${scenario}`);

  // Allocate a kernel-state struct mirroring the harness's grid.
  const topology = createGeodesicGrid({ frequency: FREQ });
  const state = createState();
  state.grid = {
    kind: "geodesic",
    frequency: topology.frequency,
    cells: topology.cellCount,
    topology,
    width: 256,
    height: 128,
  };
  reallocateState(state, { fields: fieldDecls });
  decl.run(state);

  const harness = await makeHarness({ recipeDsl: recipeMod.pipelineDsl, frequency: FREQ });
  try {
    for (const f of fieldNames) {
      harness.uploadField(f, state.fields[f]);
    }
    const samples = [];
    samples.push(await sampleAll(harness));
    for (let t = 0; t < ticks; t++) {
      await harness.tick({ dt: 1 / 60, frame: t, params });
    }
    samples.push(await sampleAll(harness));
    return { samples, ticks };
  } finally {
    harness.dispose();
  }
}

async function sampleAll(harness) {
  const out = {};
  for (const decl of fieldDecls) {
    const arr = await harness.readField(decl.name);
    out[decl.name] = stats(arr, decl.type);
  }
  return out;
}

function stats(arr, type) {
  const components = type === "vec2" ? 2 : 1;
  const n = arr.length / components;
  let nan = 0;
  if (components === 1) {
    let mn = Infinity, mx = -Infinity, sum = 0;
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i];
      if (!Number.isFinite(v)) { nan++; continue; }
      if (v < mn) mn = v;
      if (v > mx) mx = v;
      sum += v;
    }
    return { min: mn, max: mx, mean: sum / n, nan, n };
  } else {
    // vec2 — report magnitude stats
    let mn = Infinity, mx = -Infinity, sumS = 0, sumX = 0, sumY = 0;
    for (let i = 0; i < n; i++) {
      const x = arr[i * 2], y = arr[i * 2 + 1];
      if (!Number.isFinite(x) || !Number.isFinite(y)) { nan++; continue; }
      const s = Math.hypot(x, y);
      if (s < mn) mn = s;
      if (s > mx) mx = s;
      sumS += s; sumX += x; sumY += y;
    }
    return {
      min: mn, max: mx, mean: sumS / n,
      polar: Math.hypot(sumX / n, sumY / n),
      nan, n,
    };
  }
}

function reportRun(run, indent = "") {
  const final = run.samples[run.samples.length - 1];
  const initial = run.samples[0];
  for (const f of fieldNames) {
    const i = initial[f], x = final[f];
    const tag = x.nan > 0 ? " ⚠NaN" : "";
    const polar = x.polar !== undefined ? ` polar=${x.polar.toFixed(3)}` : "";
    console.log(
      `${indent}${f.padEnd(10)}  init [${fmt(i.min)}, ${fmt(i.max)}] mean=${fmt(i.mean)}` +
      `  →  final [${fmt(x.min)}, ${fmt(x.max)}] mean=${fmt(x.mean)}${polar}${tag}`
    );
  }
}

async function sweepParam(param, scenario, baseParams) {
  if (typeof param.min !== "number" || typeof param.max !== "number") return null;
  // Skip integer-1-step params with range == 1 (toggles); skip simRateHz
  // (integration-detail, not dynamics).
  if (param.name === "simRateHz") return null;
  // For sliders with range > 0, sample at 25/50/75% of the slider range.
  // The 50% may be very different from the recipe's default — that's
  // intentional: we want to see if the *default* is in a sensible
  // operating regime.
  const lo = param.min + (param.max - param.min) * 0.25;
  const mid = param.min + (param.max - param.min) * 0.50;
  const hi = param.min + (param.max - param.min) * 0.75;
  const out = { lo: null, mid: null, hi: null };
  for (const [k, v] of [["lo", lo], ["mid", mid], ["hi", hi]]) {
    const params = { ...baseParams, [param.name]: v };
    out[k] = { val: v, run: await runOnce({ scenario, params, ticks: TICKS }) };
  }
  return out;
}

function reportSweep(param, sweep) {
  if (!sweep) return;
  console.log(
    `\n  ${param.name} (${param.label ?? ""}) — slider [${param.min}, ${param.max}] default ${param.default}`
  );
  for (const [k, sv] of Object.entries(sweep)) {
    const final = sv.run.samples[sv.run.samples.length - 1];
    // Compress per-field mean/range into a one-liner.
    const cells = fieldNames.map((f) => {
      const x = final[f];
      const tag = x.nan > 0 ? "⚠" : "";
      return `${f}=[${fmt(x.min)},${fmt(x.max)}]m${fmt(x.mean)}${tag}`;
    }).join("  ");
    console.log(`    ${k}=${sv.val.toFixed(4)}  ${cells}`);
  }
}

function audit(baseline, dsl) {
  const flags = [];
  const final = baseline.samples[baseline.samples.length - 1];
  for (const f of fieldDecls) {
    const x = final[f.name];
    if (x.nan > 0) flags.push(`⚠ ${f.name}: ${x.nan} NaN cells`);
    // crude clamp-pin detection: min and max both sit at suspiciously
    // round-numbered extremes
    if (Math.abs(x.max - x.min) < 1e-8) {
      flags.push(`⚠ ${f.name}: collapsed to single value ${fmt(x.mean)}`);
    }
  }
  if (flags.length === 0) flags.push("✓ no NaN / collapse flags");
  return flags;
}

function fmt(v) {
  if (!Number.isFinite(v)) return String(v);
  if (Math.abs(v) < 1e-3 && v !== 0) return v.toExponential(1);
  if (Math.abs(v) >= 1000) return v.toExponential(1);
  return v.toFixed(3);
}
