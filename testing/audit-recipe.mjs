// Recipe audit harness — runs a recipe through the WGSL execution
// harness using its own scenario init, then both reports stats and
// asserts on auto-detectable failure modes:
//
//   - dead param:    lo/mid/hi sweep produces identical field stats
//   - strobing:      per-tick |Δprimary-f32-field|/range > 0.10
//   - clamp pinning: continuous field ends with both extrema sitting
//                    on suspiciously-round values (saturation against
//                    a numerical clamp)
//
// Exit code 0 if all checks pass, 1 if anything fails.
//
// Usage:
//   node testing/audit-recipe.mjs <recipe-id> [scenario] [ticks] [freq]

import { harnessAvailable, makeHarness } from "./wgsl-harness.mjs";
import { buildDslPresetDecls } from "../visual/dsl-init-runtime.mjs";
import { createGeodesicGrid } from "../kernel/geodesic-grid.mjs";
import { createState, reallocateState } from "../kernel/kernel.mjs";

const RECIPE_ID = process.argv[2];
const SCENARIO_ARG = process.argv[3] || null;
const TICKS = Number(process.argv[4] ?? 300);
const FREQ = Number(process.argv[5] ?? 16);

// Per-tick |Δfield| ÷ field range exceeding this threshold flags a
// strobing recipe — at standard frame rates the visual is unwatchable.
const STROBE_THRESHOLD = 0.10;

// Per-param sweep "different" tolerance. Two sweeps are considered
// distinct if at least one field's mean / min / max differs by more
// than this.
const SWEEP_DIFF_EPS = 0.001;

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
const fieldDecls = (dsl.fields ?? []).map((f) => ({ name: f.name, type: f.type ?? "f32", kind: f.kind ?? "field" }));
const fieldNames = fieldDecls.map((f) => f.name);

// Strobe detection samples |Δfield| every tick during a probe window.
// We only do this on the *primary* f32 field — u32 state fields cycle
// through discrete values by design and would always trip the threshold.
const primaryField = fieldDecls.find((f) => f.type === "f32");

console.log(`# audit ${RECIPE_ID} scenario=${scenario} ticks=${TICKS} freq=${FREQ}`);
console.log(`# fields: ${fieldDecls.map((f) => `${f.name}:${f.type}`).join(", ")}`);
console.log(`# params: ${(dsl.parameters ?? []).map((p) => `${p.name}=${p.default}`).join(", ")}`);

const findings = [];

// --- Stability run with default params -------------------------------
const baseline = await runOnce({ scenario, params, ticks: TICKS, sampleStrobe: !!primaryField });
console.log(`\n# === STABILITY (default params) ===`);
reportRun(baseline, "  ");

// Auto-check: strobe.
if (primaryField && baseline.strobe !== null) {
  const range = baseline.strobe.range;
  const meanD = baseline.strobe.meanDelta;
  const ratio = range > 0 ? meanD / range : 0;
  console.log(`  strobe: per-tick |Δ${primaryField.name}|/range = ${ratio.toFixed(3)} (mean Δ=${meanD.toFixed(4)}, range=${range.toFixed(3)})`);
  if (ratio > STROBE_THRESHOLD) {
    findings.push({
      kind: "strobe",
      message: `${primaryField.name} changes ${(ratio * 100).toFixed(0)}% of its range every tick — visualization will strobe at standard frame rates.`,
    });
  }
}

// Auto-check: clamp pinning on continuous (f32 / vec2) fields.
checkClampPinning(baseline, findings);

// --- Per-param sensitivity sweep ------------------------------------
console.log(`\n# === PARAM SWEEPS ===`);
for (const param of dsl.parameters ?? []) {
  const sweep = await sweepParam(param, scenario, params);
  if (!sweep) continue;
  reportSweep(param, sweep);

  // Auto-check: dead param. lo and hi sweeps must differ.
  const loFinal = sweep.lo.run.samples[sweep.lo.run.samples.length - 1];
  const hiFinal = sweep.hi.run.samples[sweep.hi.run.samples.length - 1];
  let anyDiff = false;
  for (const f of fieldNames) {
    const dl = loFinal[f]?.mean ?? 0;
    const dh = hiFinal[f]?.mean ?? 0;
    const drMin = loFinal[f]?.min ?? 0;
    const drMax = loFinal[f]?.max ?? 0;
    const drhMin = hiFinal[f]?.min ?? 0;
    const drhMax = hiFinal[f]?.max ?? 0;
    if (Math.abs(dl - dh) > SWEEP_DIFF_EPS || Math.abs(drMin - drhMin) > SWEEP_DIFF_EPS || Math.abs(drMax - drhMax) > SWEEP_DIFF_EPS) {
      anyDiff = true;
      break;
    }
  }
  if (!anyDiff) {
    findings.push({
      kind: "dead-param",
      message: `param "${param.name}" (${param.label ?? ""}) has no detectable effect at lo=${sweep.lo.val.toFixed(4)} vs hi=${sweep.hi.val.toFixed(4)}.`,
    });
  }
}

console.log(`\n# === ASSERTIONS ===`);
if (findings.length === 0) {
  console.log("  ✓ all checks passed");
  process.exit(0);
} else {
  for (const f of findings) {
    console.log(`  ✗ [${f.kind}] ${f.message}`);
  }
  process.exit(1);
}

// =====================================================================
// helpers
// =====================================================================

function paramDefaults(dsl) {
  const out = {};
  for (const p of dsl.parameters ?? []) out[p.name] = p.default ?? 0;
  for (const s of dsl.settings ?? []) out[s.name] = s.default ?? 0;
  return out;
}

async function runOnce({ scenario, params, ticks, sampleStrobe = false }) {
  const presetDecls = buildDslPresetDecls(dsl.presets ?? [], dsl, (n) => params[n]);
  const decl = presetDecls.find((p) => p.id === scenario);
  if (!decl) throw new Error(`scenario not found: ${scenario}`);

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
    let strobe = null;
    const STROBE_WINDOW = Math.min(30, Math.max(10, Math.floor(ticks / 4)));
    const STROBE_START = Math.max(0, ticks - STROBE_WINDOW);
    let strobePrev = null;
    let strobeSum = 0, strobeMax = -Infinity, strobeMin = Infinity, strobeCount = 0;
    for (let t = 0; t < ticks; t++) {
      await harness.tick({ dt: 1 / 60, frame: t, params });
      if (sampleStrobe && primaryField && t >= STROBE_START) {
        const cur = await harness.readField(primaryField.name);
        if (strobePrev !== null) {
          for (let i = 0; i < cur.length; i++) {
            const v = cur[i];
            if (Number.isFinite(v)) {
              if (v < strobeMin) strobeMin = v;
              if (v > strobeMax) strobeMax = v;
            }
            strobeSum += Math.abs(cur[i] - strobePrev[i]);
            strobeCount++;
          }
        }
        strobePrev = cur;
      }
    }
    samples.push(await sampleAll(harness));
    if (sampleStrobe && primaryField && strobeCount > 0) {
      strobe = {
        meanDelta: strobeSum / strobeCount,
        range: strobeMax - strobeMin,
      };
    }
    return { samples, ticks, strobe };
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
  if (param.name === "simRateHz") return null;
  const lo = param.min + (param.max - param.min) * 0.25;
  const mid = param.min + (param.max - param.min) * 0.50;
  const hi = param.min + (param.max - param.min) * 0.75;
  const out = { lo: null, mid: null, hi: null };
  for (const [k, v] of [["lo", lo], ["mid", mid], ["hi", hi]]) {
    const p = { ...baseParams, [param.name]: v };
    out[k] = { val: v, run: await runOnce({ scenario, params: p, ticks: TICKS }) };
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
    const cells = fieldNames.map((f) => {
      const x = final[f];
      const tag = x.nan > 0 ? "⚠" : "";
      return `${f}=[${fmt(x.min)},${fmt(x.max)}]m${fmt(x.mean)}${tag}`;
    }).join("  ");
    console.log(`    ${k}=${sv.val.toFixed(4)}  ${cells}`);
  }
}

function checkClampPinning(baseline, findings) {
  // Continuous (f32 / vec2) fields whose final-tick min and max BOTH
  // sit on suspiciously-round values are saturating against a hard
  // clamp. u32 fields are skipped — their discrete values are by design.
  const final = baseline.samples[baseline.samples.length - 1];
  for (const f of fieldDecls) {
    if (f.kind === "source" || f.type === "u32" || f.type === "bool") continue;
    const x = final[f.name];
    if (!x || x.n === 0) continue;
    const rounded = Math.round(x.max);
    const isRound = Math.abs(x.max - rounded) < 1e-3 && [0.5, 1, 2, 4, 8, 16, 100].includes(Math.abs(rounded));
    if (!isRound) continue;
    const minRounded = Math.round(x.min);
    const minIsRound = Math.abs(x.min - minRounded) < 1e-3 && [0, -0.5, 0.5, -1, 1, -8, 8].includes(minRounded);
    if (minIsRound && minRounded !== rounded) {
      findings.push({
        kind: "clamp-pin",
        message: `${f.name} is pinned to both clamps ([${fmt(x.min)}, ${fmt(x.max)}]) at end of default run.`,
      });
    }
  }
}

function fmt(v) {
  if (!Number.isFinite(v)) return String(v);
  if (Math.abs(v) < 1e-3 && v !== 0) return v.toExponential(1);
  if (Math.abs(v) >= 1000) return v.toExponential(1);
  return v.toFixed(3);
}
