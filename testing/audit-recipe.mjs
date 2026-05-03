// Recipe audit harness — runs a recipe through the WGSL execution
// harness using its own scenario init, then both REPORTS and ASSERTS:
//
//   Auto-detected (no author input):
//     - dead param: lo/mid/hi sweep produces identical field stats
//     - strobing:   per-tick |Δfield|/range > strobe threshold
//     - clamp pinning: final-tick max sits exactly on a hard clamp
//
//   Author-declared (optional `export const audit` in the recipe):
//     - conserved fields:  total mean stays within ε of initial
//     - bounded fields:    field never leaves [lo, hi] over the run
//     - monotonic effects: param at lo vs hi moves a field's stat in
//                          the predicted direction
//
// Exit code 0 if all checks pass, 1 if any auto/declared assertion
// fails. Print-style output is unchanged so the existing one-shot
// "what's happening in this recipe" use still works.
//
// Usage:
//   node testing/audit-recipe.mjs <recipe-id> [scenario] [ticks] [freq]

import { harnessAvailable, makeHarness } from "./wgsl-harness.mjs";
import { buildDslPresetDecls } from "../visual/dsl-init-runtime.mjs";
import { createGeodesicGrid } from "../kernel/geodesic-grid.mjs";
import { createState, reallocateState } from "../kernel/kernel.mjs";

const RECIPE_ID = process.argv[2];
const SCENARIO_ARG = process.argv[3] || null;
const TICKS_ARG = Number(process.argv[4] ?? 300);
const FREQ_ARG = Number(process.argv[5] ?? 16);

// Per-tick |Δfield| ÷ field range exceeding this threshold flags a
// strobing recipe — at standard frame rates the visual is unwatchable.
// 0.10 catches the CML pre-fix; recipes with deliberate strobe (none
// today) can opt out via author-declared audit.allowStrobe.
const STROBE_THRESHOLD = 0.10;

// Conservation tolerance: total field mean drift relative to the
// initial mean. 5% is loose enough to accommodate explicit-Euler
// numerical drift on closed-sphere conservation laws but tight enough
// to catch a real conservation break (forest-fire pre-fix lost ~50%
// to clamp creation).
const CONSERVATION_EPS = 0.05;

// Per-param sweep "different" tolerance. Two sweeps are considered
// distinct if at least one field's mean differs by more than this.
const SWEEP_DIFF_EPS = 0.001;

// Bounded-field overrun tolerance — accommodates round-off on the
// declared bound.
const BOUND_EPS = 0.01;

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
const declaredAudit = recipeMod.audit ?? {};
// Recipes whose interesting dynamics emerge slowly (Turing patterns,
// sandpile criticality, Eden saturation) can opt into a longer audit
// window. Recipes whose patterns need finer mesh (Turing wavenumbers
// don't fit in coarse meshes) can opt into a higher audit frequency.
// CLI arg always wins, otherwise the recipe's declared override,
// otherwise the default.
const TICKS = process.argv[4] ? TICKS_ARG : (declaredAudit.ticks ?? TICKS_ARG);
const FREQ = process.argv[5] ? FREQ_ARG : (declaredAudit.frequency ?? FREQ_ARG);

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

// Strobe detection samples |Δfield| every tick during a probe window.
// We only do this on the *primary* f32 field — u32 state fields cycle
// through discrete values by design (cyclic-CA, Greenberg-Hastings,
// sandpile, etc.) and would always trip the threshold.
const primaryField = fieldDecls.find((f) => f.type === "f32");

console.log(`# audit ${RECIPE_ID} scenario=${scenario} ticks=${TICKS} freq=${FREQ}`);
console.log(`# fields: ${fieldDecls.map((f) => `${f.name}:${f.type}`).join(", ")}`);
console.log(`# params: ${(dsl.parameters ?? []).map((p) => `${p.name}=${p.default}`).join(", ")}`);

const findings = [];   // accumulates {kind, severity, message} for the final summary

// --- Stability run with default params -------------------------------
const baseline = await runOnce({ scenario, params, ticks: TICKS, sampleStrobe: !!primaryField });
console.log(`\n# === STABILITY (default params) ===`);
reportRun(baseline, "  ");

// Auto-check 1: strobe detection on the primary field.
if (primaryField && baseline.strobe !== null) {
  const range = baseline.strobe.range;
  const meanD = baseline.strobe.meanDelta;
  const ratio = range > 0 ? meanD / range : 0;
  const allowed = declaredAudit.allowStrobe === true;
  console.log(`  strobe: per-tick |Δ${primaryField.name}|/range = ${ratio.toFixed(3)} (mean Δ=${meanD.toFixed(4)}, range=${range.toFixed(3)})`);
  if (ratio > STROBE_THRESHOLD && !allowed) {
    findings.push({
      kind: "strobe",
      severity: "fail",
      message: `${primaryField.name} changes ${(ratio * 100).toFixed(0)}% of its range every tick — visualization will strobe at standard frame rates. Declare audit.allowStrobe=true if this is intentional, otherwise lower simRateHz default or render an EMA envelope field.`,
    });
  }
}

// Auto-check 2: clamp pinning. We don't have access to declared
// clamps, but we can flag suspiciously round extrema (max sitting at
// 1.0, 8.0, etc with at least one cell exactly on the boundary).
checkClampPinning(baseline, findings);

// Author-declared 3: conservation. Total mean drift must stay within
// CONSERVATION_EPS of initial.
if (Array.isArray(declaredAudit.conserved)) {
  for (const fieldName of declaredAudit.conserved) {
    const init = baseline.samples[0][fieldName];
    const final = baseline.samples[baseline.samples.length - 1][fieldName];
    if (!init || !final) {
      findings.push({ kind: "conserved", severity: "fail", message: `audit.conserved names "${fieldName}" but the recipe doesn't declare that field` });
      continue;
    }
    const drift = Math.abs(final.mean - init.mean) / Math.max(Math.abs(init.mean), 1e-6);
    if (drift > CONSERVATION_EPS) {
      findings.push({
        kind: "conserved",
        severity: "fail",
        message: `${fieldName} declared conserved but mean drifted ${(drift * 100).toFixed(1)}% (${fmt(init.mean)} → ${fmt(final.mean)})`,
      });
    }
  }
}

// Author-declared 4: bounded fields.
if (declaredAudit.bounded && typeof declaredAudit.bounded === "object") {
  for (const [fieldName, range] of Object.entries(declaredAudit.bounded)) {
    if (!Array.isArray(range) || range.length !== 2) {
      findings.push({ kind: "bounded", severity: "fail", message: `audit.bounded.${fieldName} must be [lo, hi]` });
      continue;
    }
    const [lo, hi] = range;
    for (let i = 0; i < baseline.samples.length; i++) {
      const s = baseline.samples[i][fieldName];
      if (!s) continue;
      if (s.min < lo - BOUND_EPS) {
        findings.push({ kind: "bounded", severity: "fail", message: `${fieldName} bounded to [${lo}, ${hi}] but went to ${fmt(s.min)} at sample ${i}` });
        break;
      }
      if (s.max > hi + BOUND_EPS) {
        findings.push({ kind: "bounded", severity: "fail", message: `${fieldName} bounded to [${lo}, ${hi}] but went to ${fmt(s.max)} at sample ${i}` });
        break;
      }
    }
  }
}

// --- Per-param sensitivity sweep ------------------------------------
console.log(`\n# === PARAM SWEEPS ===`);
const sweepResults = new Map();
for (const param of dsl.parameters ?? []) {
  const sweep = await sweepParam(param, scenario, params);
  sweepResults.set(param.name, sweep);
  if (!sweep) continue;
  reportSweep(param, sweep);

  // Auto-check 5: dead-param detection. lo and hi sweeps must differ
  // in at least one field's mean by more than SWEEP_DIFF_EPS.
  // audit.allowedDeadParams names params whose effect is real but not
  // visible to a global-stat audit window — e.g. params that only
  // govern spatial transport / structure that the audit's min/max/mean
  // can't see. Each entry should be accompanied by a comment in the
  // recipe explaining WHY (forces author to justify rather than mask).
  const exempt = new Set(declaredAudit.allowedDeadParams ?? []);
  if (exempt.has(param.name)) continue;
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
      severity: "fail",
      message: `param "${param.name}" (${param.label ?? ""}) has no detectable effect at lo=${sweep.lo.val.toFixed(4)} vs hi=${sweep.hi.val.toFixed(4)}. Either remove the slider or wire it into the cell body.`,
    });
  }
}

// Author-declared 6: monotonic param effects. Each entry:
//   { param: "DIFF", on: "u", effect: "decrease-range" }
// effect ∈ "increase-mean" | "decrease-mean" | "increase-range" |
// "decrease-range". We evaluate against the lo/hi sweep already
// collected above.
if (Array.isArray(declaredAudit.monotonic)) {
  for (const entry of declaredAudit.monotonic) {
    const sweep = sweepResults.get(entry.param);
    if (!sweep) {
      findings.push({ kind: "monotonic", severity: "fail", message: `audit.monotonic refers to unknown param "${entry.param}"` });
      continue;
    }
    const lo = sweep.lo.run.samples[sweep.lo.run.samples.length - 1][entry.on];
    const hi = sweep.hi.run.samples[sweep.hi.run.samples.length - 1][entry.on];
    if (!lo || !hi) {
      findings.push({ kind: "monotonic", severity: "fail", message: `audit.monotonic.${entry.param}: field "${entry.on}" not declared` });
      continue;
    }
    const passed = checkMonotonic(entry.effect, lo, hi);
    if (!passed) {
      findings.push({
        kind: "monotonic",
        severity: "fail",
        message: `${entry.param} declared "${entry.effect}" on ${entry.on} — but lo→hi moved mean ${fmt(lo.mean)}→${fmt(hi.mean)}, range [${fmt(lo.min)},${fmt(lo.max)}]→[${fmt(hi.min)},${fmt(hi.max)}].`,
      });
    }
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
    // Strobe sample: probe in the second half of the run (after
    // any transient dynamics have settled).
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
    const cells = fieldNames.map((f) => {
      const x = final[f];
      const tag = x.nan > 0 ? "⚠" : "";
      return `${f}=[${fmt(x.min)},${fmt(x.max)}]m${fmt(x.mean)}${tag}`;
    }).join("  ");
    console.log(`    ${k}=${sv.val.toFixed(4)}  ${cells}`);
  }
}

function checkClampPinning(baseline, findings) {
  // Round-number boundary heuristic on continuous (f32 / vec2) fields.
  // Skipped: u32 fields (discrete by design), and any field listed in
  // audit.allowedClampPins (recipe-author opts out for fields that are
  // mathematically bounded — e.g. cos/sin outputs to [-1, 1], or
  // diagnostic projections of u32 state to a 0..1 ramp).
  const allowed = new Set(declaredAudit.allowedClampPins ?? []);
  const final = baseline.samples[baseline.samples.length - 1];
  for (const f of fieldDecls) {
    if (f.type === "u32" || f.type === "bool") continue;
    if (allowed.has(f.name)) continue;
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
        severity: "fail",
        message: `${f.name} is pinned to both clamps ([${fmt(x.min)}, ${fmt(x.max)}]) at end of default run — dynamics are saturating. Lower default rate / coupling, or widen the clamp. (Add to audit.allowedClampPins if intentional.)`,
      });
    }
  }
}

function checkMonotonic(effect, lo, hi) {
  const loRange = lo.max - lo.min;
  const hiRange = hi.max - hi.min;
  switch (effect) {
    case "increase-mean": return hi.mean > lo.mean + SWEEP_DIFF_EPS;
    case "decrease-mean": return hi.mean < lo.mean - SWEEP_DIFF_EPS;
    case "increase-range": return hiRange > loRange + SWEEP_DIFF_EPS;
    case "decrease-range": return hiRange < loRange - SWEEP_DIFF_EPS;
    default: return false;
  }
}

function fmt(v) {
  if (!Number.isFinite(v)) return String(v);
  if (Math.abs(v) < 1e-3 && v !== 0) return v.toExponential(1);
  if (Math.abs(v) >= 1000) return v.toExponential(1);
  return v.toFixed(3);
}
