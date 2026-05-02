import { createGeodesicGrid } from "../kernel/geodesic-grid.mjs";
import { compileDsl } from "../dsl/compiler.mjs";
import { pipelineDsl as weatherDsl } from "../recipes/weather.mjs";
import {
  buildWebGpuGeodesicUniforms,
  compileWebGpuGeodesicCellStage,
} from "../dsl/webgpu-geodesic-compiler.mjs";
import { createWebGpuGeodesicPipeline } from "./webgpu-geodesic-pipeline-runtime.mjs";
import { createWebGpuGeodesicRuntime, webgpuSupported } from "./webgpu-geodesic-runtime.mjs";

export async function runWebGpuGeodesicChecks({ frequency = 24 } = {}) {
  const support = webgpuSupported();
  if (!support.ok) return { ok: false, reason: support.reason, results: [] };

  const grid = createGeodesicGrid({ frequency });
  const primitive = await runPrimitiveParity(grid);
  const wind = await runWindParity(grid);
  const dslCell = await runDslCellParity(grid);
  const pipeline = await runPipelineParity({ frequency });
  const weather = await runWeatherSmoke({ frequency });
  return {
    ok: primitive.maxDiff <= 1e-6 && wind.maxDiff <= 1e-5 && dslCell.maxDiff <= 1e-6 && pipeline.maxDiff <= 1e-6 && weather.ok,
    reason: "ok",
    grid: {
      frequency: grid.frequency,
      cellCount: grid.cellCount,
      triangleCount: grid.triangleCount,
    },
    results: [
      { name: "diffuse/add parity", epsilon: 1e-6, ...primitive },
      { name: "wind/lift parity", epsilon: 1e-5, ...wind },
      { name: "DSL cell parity", epsilon: 1e-6, ...dslCell },
      { name: "DSL pipeline parity", epsilon: 1e-6, ...pipeline },
      { name: "Weather geodesic smoke", ...weather },
    ],
  };
}

async function runWindParity(grid) {
  const pressure = seedField(grid);
  const cpuU = new Float32Array(grid.cellCount);
  const cpuV = new Float32Array(grid.cellCount);
  const cpuLift = new Float32Array(grid.cellCount);
  const gpuU = new Float32Array(grid.cellCount);
  const gpuV = new Float32Array(grid.cellCount);
  const gpuLift = new Float32Array(grid.cellCount);
  const runtime = await createWebGpuGeodesicRuntime({ grid, fieldNames: ["pressure", "windU", "windV", "lift"] });
  try {
    runtime.uploadField("pressure", pressure);
    windCpu({ pressure, windU: cpuU, windV: cpuV, lift: cpuLift, grid, strength: 2.1 });
    runtime.runWind({ pressure: "pressure", windU: "windU", windV: "windV", lift: "lift", strength: 2.1 });
    await runtime.readField("windU", gpuU);
    await runtime.readField("windV", gpuV);
    await runtime.readField("lift", gpuLift);
    return compareMany([cpuU, cpuV, cpuLift], [gpuU, gpuV, gpuLift]);
  } finally {
    runtime.dispose();
  }
}

async function runPrimitiveParity(grid) {
  const cpu = seedField(grid);
  const gpu = new Float32Array(cpu);
  const runtime = await createWebGpuGeodesicRuntime({ grid, fieldNames: ["A"] });
  try {
    runtime.uploadField("A", gpu);
    const steps = [
      { op: "diffuse", amount: 0.15 },
      { op: "add", amount: 0.0125 },
      { op: "diffuse", amount: 0.22 },
      { op: "clamp", lo: -0.72, hi: 0.58 },
      { op: "diffuse", amount: 0.07 },
    ];
    for (const step of steps) {
      if (step.op === "diffuse") {
        diffuseCpu(cpu, grid, step.amount);
        runtime.runDiffuse({ field: "A", amount: step.amount });
      } else if (step.op === "add") {
        addCpu(cpu, step.amount);
        runtime.runAddConstant({ field: "A", amount: step.amount });
      } else if (step.op === "clamp") {
        clampCpu(cpu, step.lo, step.hi);
        runtime.runClamp({ field: "A", lo: step.lo, hi: step.hi });
      }
    }
    await runtime.readField("A", gpu);
    return compare(cpu, gpu);
  } finally {
    runtime.dispose();
  }
}

async function runDslCellParity(grid) {
  const recipe = compileDsl(`
recipe "GPU cell parity"
use sim cell
use clock dt, frame
field A, B
param gain slider min 0 max 2 step 0.1 default 1
param enabled boolean default true
const bias 0.025

stage push "Push" {
  reads A, B
  writes A
  cell {
    when enabled {
      let strength = gain + bias
      add A = (B - A) * strength * dt
    }
  }
}
`);
  const gridA = seedField(grid);
  const gridB = seedFieldB(grid);
  const cpu = new Float32Array(gridA);
  const gpu = new Float32Array(gridA);
  const stage = recipe.dsl.stages[0];
  const [pass] = compileWebGpuGeodesicCellStage(stage, recipe.dsl);
  const runtime = await createWebGpuGeodesicRuntime({ grid, fieldNames: ["A", "B"] });
  try {
    runtime.uploadField("A", gpu);
    runtime.uploadField("B", gridB);
    const dt = 0.35;
    const gain = 1.2;
    for (let cell = 0; cell < grid.cellCount; cell++) {
      cpu[cell] += (gridB[cell] - cpu[cell]) * (gain + 0.025) * dt;
    }
    runtime.runCellPass({
      key: pass.key,
      source: pass.source,
      field: pass.field,
      reads: pass.reads,
      uniforms: buildWebGpuGeodesicUniforms(pass.layout, {
        dt,
        frame: 0,
        cellCount: grid.cellCount,
        params: { gain, enabled: 1 },
        consts: { bias: 0.025 },
      }),
    });
    await runtime.readField("A", gpu);
    return compare(cpu, gpu);
  } finally {
    runtime.dispose();
  }
}

async function runPipelineParity({ frequency }) {
  const pipeline = compileDsl(`
recipe "GPU geodesic pipeline parity"
grid geodesic tiles ${frequency}
use sim cell, wind, advect, diffuse, clamp
use clock dt, frame
field A, B, pressure
param gain slider min 0 max 2 step 0.1 default 1
param windStrength slider min 0 max 4 step 0.1 default 2
param diffusion slider min 0 max 1 step 0.01 default 0.15

stage wind "Wind" {
  reads pressure
  declares windU, windV, lift
  wind pressure -> windU, windV, lift strength windStrength
}

stage carry "Carry" {
  reads A, windU, windV
  writes A
  advect A by windU, windV dt dt * 0.2
}

stage push "Push" {
  reads A, B, lift
  writes A
  cell {
    add A = ((B - A) * gain + lift * 0.02) * dt
  }
}

stage smooth "Smooth" {
  reads A
  writes A
  diffuse A amount diffusion * dt
}

stage bound "Bound" {
  reads A
  writes A
  clamp A -0.7 0.7
}
`);
  const runner = await createWebGpuGeodesicPipeline({
    pipeline,
    getParams: () => ({ gain: 1.2, windStrength: 2.0, diffusion: 0.4 }),
    getFrame: () => 3,
  });
  const grid = runner.grid;
  const cpu = seedField(grid);
  const gpu = new Float32Array(cpu);
  const fieldB = seedFieldB(grid);
  const pressure = seedField(grid);
  const windU = new Float32Array(grid.cellCount);
  const windV = new Float32Array(grid.cellCount);
  const lift = new Float32Array(grid.cellCount);
  const state = { fields: { A: gpu, B: fieldB, pressure, windU, windV, lift } };
  try {
    runner.uploadState(state);
    const dt = 0.25;
    windCpu({ pressure, windU, windV, lift, grid, strength: 2.0 });
    advectCpu({ field: cpu, windU, windV, grid, dt: dt * 0.2 });
    for (let cell = 0; cell < grid.cellCount; cell++) {
      cpu[cell] += ((fieldB[cell] - cpu[cell]) * 1.2 + lift[cell] * 0.02) * dt;
    }
    diffuseCpu(cpu, grid, 0.4 * dt);
    clampCpu(cpu, -0.7, 0.7);
    runner.runTick(dt);
    await runner.readState(state, ["A"]);
    return compare(cpu, gpu);
  } finally {
    runner.dispose();
  }
}

async function runWeatherSmoke({ frequency }) {
  const pipeline = compileDsl(weatherDsl.replace(/^grid\s+geodesic\s+.*$/m, `grid geodesic tiles ${frequency}`));
  const params = Object.fromEntries((pipeline.dsl.parameters ?? []).map((decl) => [decl.name, decl.default ?? 0]));
  const runner = await createWebGpuGeodesicPipeline({
    pipeline,
    getParams: () => params,
    getFrame: () => 0,
  });
  const state = { fields: {} };
  try {
    for (const name of runner.fieldNames) state.fields[name] = seedNamedWeatherField(runner.grid, name);
    runner.uploadState(state);
    runner.runTick(1 / 30);
    await runner.readState(state, ["pressure", "moisture", "cloud", "temperature", "catalyst", "exhaustion", "lift", "reaction"]);
    let maxAbs = 0;
    for (const field of Object.values(state.fields)) {
      for (const value of field) {
        if (!Number.isFinite(value)) return { ok: false, reason: "non-finite output" };
        maxAbs = Math.max(maxAbs, Math.abs(value));
      }
    }
    return { ok: true, reason: "ok", maxAbs };
  } finally {
    runner.dispose();
  }
}

function seedField(grid) {
  const field = new Float32Array(grid.cellCount);
  for (let i = 0; i < grid.cellCount; i++) {
    const x = grid.positions[i * 3 + 0];
    const y = grid.positions[i * 3 + 1];
    const z = grid.positions[i * 3 + 2];
    field[i] = Math.sin(x * 4.7 + y * 2.1) * 0.6 + Math.cos(z * 3.3 - x) * 0.25;
  }
  return field;
}

function diffuseCpu(field, grid, amount) {
  const before = new Float32Array(field);
  const a = Math.max(0, Math.min(1, amount));
  for (let cell = 0; cell < grid.cellCount; cell++) {
    let sum = 0;
    const count = grid.neighborCounts[cell];
    for (let slot = 0; slot < count; slot++) {
      const neighbor = grid.neighbors[cell * grid.maxNeighbors + slot];
      sum += before[neighbor];
    }
    const average = sum / count;
    field[cell] = before[cell] + (average - before[cell]) * a;
  }
}

function addCpu(field, amount) {
  for (let i = 0; i < field.length; i++) field[i] += amount;
}

function clampCpu(field, lo, hi) {
  for (let i = 0; i < field.length; i++) field[i] = Math.max(lo, Math.min(hi, field[i]));
}

function advectCpu({ field, windU, windV, grid, dt }) {
  const before = new Float32Array(field);
  for (let cell = 0; cell < grid.cellCount; cell++) {
    const p = position(grid, cell);
    const east = eastBasis(p);
    const north = normalize(cross(p, east));
    const back = normalize([
      p[0] - (east[0] * windU[cell] + north[0] * windV[cell]) * dt * 15,
      p[1] - (east[1] * windU[cell] + north[1] * windV[cell]) * dt * 15,
      p[2] - (east[2] * windU[cell] + north[2] * windV[cell]) * dt * 15,
    ]);
    let weightSum = 0;
    let valueSum = 0;
    const selfD2 = Math.max(0.000001, 2 * (1 - dot(back, p)));
    const selfWeight = 1 / (selfD2 * selfD2);
    weightSum += selfWeight;
    valueSum += before[cell] * selfWeight;
    for (let slot = 0; slot < grid.neighborCounts[cell]; slot++) {
      const neighbor = grid.neighbors[cell * grid.maxNeighbors + slot];
      const d2 = Math.max(0.000001, 2 * (1 - dot(back, position(grid, neighbor))));
      const weight = 1 / (d2 * d2);
      weightSum += weight;
      valueSum += before[neighbor] * weight;
    }
    field[cell] = valueSum / weightSum;
  }
}

function windCpu({ pressure, windU, windV, lift, grid, strength }) {
  for (let cell = 0; cell < grid.cellCount; cell++) {
    const p = position(grid, cell);
    const east = eastBasis(p);
    const north = normalize(cross(p, east));
    const center = pressure[cell];
    const count = grid.neighborCounts[cell];
    let gx = 0;
    let gy = 0;
    let gz = 0;
    for (let slot = 0; slot < count; slot++) {
      const neighbor = grid.neighbors[cell * grid.maxNeighbors + slot];
      const q = position(grid, neighbor);
      const dotQp = dot(q, p);
      const tx = q[0] - p[0] * dotQp;
      const ty = q[1] - p[1] * dotQp;
      const tz = q[2] - p[2] * dotQp;
      const len2 = Math.max(tx * tx + ty * ty + tz * tz, 0.000001);
      const k = (pressure[neighbor] - center) / len2;
      gx += tx * k;
      gy += ty * k;
      gz += tz * k;
    }
    gx /= count;
    gy /= count;
    gz /= count;
    const dpdx = gx * east[0] + gy * east[1] + gz * east[2];
    const dpdy = gx * north[0] + gy * north[1] + gz * north[2];
    const coriolis = Math.max(-1, Math.min(1, p[1])) * 0.65;
    windU[cell] = (-dpdx + coriolis * dpdy) * strength;
    windV[cell] = (-dpdy - coriolis * dpdx) * strength;
  }
  liftCpu({ windU, windV, lift, grid });
}

function liftCpu({ windU, windV, lift, grid }) {
  for (let cell = 0; cell < grid.cellCount; cell++) {
    const p = position(grid, cell);
    const east = eastBasis(p);
    const north = normalize(cross(p, east));
    const cv = [
      east[0] * windU[cell] + north[0] * windV[cell],
      east[1] * windU[cell] + north[1] * windV[cell],
      east[2] * windU[cell] + north[2] * windV[cell],
    ];
    const count = grid.neighborCounts[cell];
    let divergence = 0;
    for (let slot = 0; slot < count; slot++) {
      const neighbor = grid.neighbors[cell * grid.maxNeighbors + slot];
      const q = position(grid, neighbor);
      const dotQp = dot(q, p);
      const tangent = [q[0] - p[0] * dotQp, q[1] - p[1] * dotQp, q[2] - p[2] * dotQp];
      const len2 = Math.max(dot(tangent, tangent), 0.000001);
      const ne = eastBasis(q);
      const nn = normalize(cross(q, ne));
      const nv = [
        ne[0] * windU[neighbor] + nn[0] * windV[neighbor],
        ne[1] * windU[neighbor] + nn[1] * windV[neighbor],
        ne[2] * windU[neighbor] + nn[2] * windV[neighbor],
      ];
      divergence += dot([nv[0] - cv[0], nv[1] - cv[1], nv[2] - cv[2]], tangent) / len2;
    }
    lift[cell] = Math.max(-1, Math.min(1, -(divergence / count) * 0.7));
  }
}

function position(grid, cell) {
  const offset = cell * 3;
  return [grid.positions[offset], grid.positions[offset + 1], grid.positions[offset + 2]];
}

function eastBasis(p) {
  const e = [-p[2], 0, p[0]];
  const len = Math.hypot(...e);
  return len < 0.0001 ? [1, 0, 0] : [e[0] / len, e[1] / len, e[2] / len];
}

function cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function normalize(v) {
  const len = Math.hypot(...v) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function seedFieldB(grid) {
  const field = new Float32Array(grid.cellCount);
  for (let i = 0; i < grid.cellCount; i++) {
    const x = grid.positions[i * 3 + 0];
    const y = grid.positions[i * 3 + 1];
    const z = grid.positions[i * 3 + 2];
    field[i] = Math.cos(x * 2.2 - z * 5.1) * 0.35 + Math.sin(y * 6.4 + z) * 0.2;
  }
  return field;
}

function seedNamedWeatherField(grid, name) {
  const field = new Float32Array(grid.cellCount);
  for (let i = 0; i < grid.cellCount; i++) {
    const x = grid.positions[i * 3 + 0];
    const y = grid.positions[i * 3 + 1];
    const z = grid.positions[i * 3 + 2];
    if (name === "pressure") field[i] = Math.sin(x * 3.4 + z * 1.7) * 0.22;
    else if (name === "moisture") field[i] = 0.34 + Math.max(0, 1 - Math.abs(y)) * 0.18;
    else if (name === "temperature") field[i] = 0.52 - Math.abs(y) * 0.45;
    else if (name === "catalyst") field[i] = Math.max(0, Math.sin(x * 8 + z * 5)) * 0.12;
    else if (name === "exhaustion") field[i] = 0.08;
    else if (name === "cloud") field[i] = Math.max(0, Math.sin(x * 6 - z * 2)) * 0.08;
    else if (name === "moistureSource") field[i] = Math.max(0, 1 - Math.abs(y));
    else if (name === "heatSource") field[i] = 0.8 - Math.abs(y) * 0.9;
    else if (name === "catalystSource") field[i] = Math.max(0, Math.sin((x + z) * 10)) * 0.4;
    else if (name === "sinkSource") field[i] = 0.18 + Math.abs(y) * 0.22;
    else if (name === "forcing") field[i] = Math.sin(x * 2 + z * 3) * 0.2;
    else field[i] = 0;
  }
  return field;
}

function compare(cpu, gpu) {
  let maxDiff = 0;
  let meanDiff = 0;
  let maxIndex = 0;
  for (let i = 0; i < cpu.length; i++) {
    const diff = Math.abs(cpu[i] - gpu[i]);
    meanDiff += diff;
    if (diff > maxDiff) {
      maxDiff = diff;
      maxIndex = i;
    }
  }
  return {
    maxDiff,
    meanDiff: meanDiff / cpu.length,
    maxIndex,
    cpu: cpu[maxIndex],
    gpu: gpu[maxIndex],
  };
}

function compareMany(cpuFields, gpuFields) {
  let worst = null;
  for (let i = 0; i < cpuFields.length; i++) {
    const result = compare(cpuFields[i], gpuFields[i]);
    if (!worst || result.maxDiff > worst.maxDiff) worst = { ...result, fieldIndex: i };
  }
  return worst;
}
