// Belousov-Zhabotinsky — 3-field oscillating chemistry. u is the fast
// autocatalyst (HBrO₂-flavoured); v is the medium-timescale inhibitor
// (Br⁻); w is the slow tertiary recovery (Ce⁴⁺/Ce³⁺ in the canonical
// reaction). The chain u → v → w with three different timescales gives
// the nested target waves and rotating spirals BZ is famous for. An
// asymmetric seed breaks symmetry to start a spiral; a uniform seed
// produces concentric target rings.
//
// Loosely based on the Oregonator with a third slow variable. Not a
// faithful reproduction of any specific BZ paper — tuned for visual
// interest and parameter-space exploration.

import { compileDsl } from "../dsl/compiler.mjs";

// 3-channel composite that maps u → red+orange, v → green, w → blue
// shadow. Rotating chemistry shifts each cell's hue as the species
// chase each other through the cycle.
function bzComposite() {
  const color = (i, fields) => {
    const u = Math.max(0, Math.min(1.4, fields.u?.[i] ?? 0));
    const v = Math.max(0, Math.min(1.4, fields.v?.[i] ?? 0));
    const w = Math.max(0, Math.min(1.4, fields.w?.[i] ?? 0));
    const r = 28 + u * 220 - v * 50 - w * 10;
    const g = 22 + v * 200 - u * 20;
    const bl = 50 + w * 180 - u * 30;
    return [
      Math.max(0, Math.min(255, Math.round(r))),
      Math.max(0, Math.min(255, Math.round(g))),
      Math.max(0, Math.min(255, Math.round(bl))),
    ];
  };
  color.fields = ["u", "v", "w"];
  return color;
}

function rampColor(field, lo, hi) {
  const color = (i, fields) => {
    const v = Math.max(0, Math.min(1, fields[field]?.[i] ?? 0));
    return [
      Math.round(lo[0] + (hi[0] - lo[0]) * v),
      Math.round(lo[1] + (hi[1] - lo[1]) * v),
      Math.round(lo[2] + (hi[2] - lo[2]) * v),
    ];
  };
  color.fields = [field];
  return color;
}

export const views = [
  { id: "composite", label: "Composite (u/v/w)", color: bzComposite() },
  { id: "u", label: "U (autocatalyst)", color: rampColor("u", [14, 18, 26], [255, 200, 70]) },
  { id: "v", label: "V (inhibitor)", color: rampColor("v", [14, 18, 26], [80, 220, 100]) },
  { id: "w", label: "W (slow recovery)", color: rampColor("w", [14, 18, 26], [120, 100, 240]) },
];

export const overlays = [];

export const metrics = [
  { id: "u", label: "U", source: "u", spark: true, precision: 3 },
  { id: "v", label: "V", source: "v", spark: true, precision: 3 },
  { id: "w", label: "W", source: "w", spark: true, precision: 3 },
  { id: "active", label: "U>0.5", source: "coverage:u:0.5", mini: true, precision: 3 },
  { id: "fps", label: "FPS", source: "fps", mini: true },
];

export const regime = {
  silent: {},
  intermittent: { "coverage:u:0.5": 0.001 },
  active: { "coverage:u:0.5": 0.05 },
  runaway: { "coverage:u:0.5": 0.7 },
};

export const pipelineDsl = `
recipe "Belousov-Zhabotinsky"
summary "3-field oscillating chemistry. u is the fast autocatalyst, v is the medium-timescale inhibitor, w is the slow tertiary recovery. The three timescales produce nested target waves and rotating spirals; tune EPS1·/EPS2· to walk silent → target rings → spirals → period-doubled."
recommendedPreset spiral
grid geodesic tiles 64

const a 0.1
const eps1 0.08
const eps2 0.012

use clock dt, frame
use geo x, y, i, lon, lat, px, py, pz, N, PI, TAU
use sim cell, diffuse, clamp
use init fill, spot, region, eachCell
use core clamp, smoothstep, max, min, abs, hypot, cellNoise

field u, v, w

setting simRateHz slider min 0 max 360 step 1 default 60 label "SIM RATE"
param rate slider min 1 max 100 step 1 default 30 label "RATE"
param diffU slider min 0 max 4 step 0.05 default 1.0 label "DIFF U"
param diffV slider min 0 max 4 step 0.05 default 0.5 label "DIFF V"
param diffW slider min 0 max 4 step 0.05 default 0.15 label "DIFF W"
param threshold slider min 0 max 0.5 step 0.01 default 0.10 label "THRESH"
param eps1Mul slider min 0.1 max 5 step 0.05 default 1.0 label "EPS1·"
param eps2Mul slider min 0.1 max 5 step 0.05 default 1.0 label "EPS2·"
param wCoupling slider min 0 max 2 step 0.05 default 0.55 label "W→U"
param vDamping slider min 0 max 2 step 0.05 default 1.0 label "V→U"

stamp pulse "Pulse u" {
  spot u lon lon lat lat radius r amount 1
}

stamp inhibitor "Inhibitor pad" {
  spot v lon lon lat lat radius r amount 0.6
}

stamp seed "Spiral seed" {
  spot u lon lon - r * 0.6 lat lat radius r * 1.3 amount 1
  spot v lon lon + r * 0.4 lat lat - r * 0.4 radius r amount 0.5
}

preset blank "Empty" {
  fill u 0
  fill v 0
  fill w 0
}

preset spiral "Spiral seed" {
  fill u 0
  fill v 0
  fill w 0
  region u lon -0.6..0.6 lat 0..PI/2 amount 1
  region v lon -0.2..0.4 lat -0.5..0 amount 0.5
}

preset rings "Concentric target waves" {
  fill u 0
  fill v 0
  fill w 0
  spot u lon 0 lat 0 radius 0.18 amount 1
}

preset random "Random pulses" {
  fill u 0
  fill v 0
  fill w 0
  eachCell {
    when cellNoise(11, 0.45) > 0.55 {
      set u = 1
    }
  }
}

preset bands "Latitude bands" {
  fill u 0
  fill v 0
  fill w 0
  region u lon -PI..PI lat 0.4..0.8 amount 1
  region u lon -PI..PI lat -0.8..-0.4 amount 1
  region v lon -PI..PI lat -0.2..0.2 amount 0.5
}

stage diffuseFields "Diffuse u, v, w (different rates)" {
  reads u, v, w
  writes u, v, w
  diffuse u amount diffU * 0.16 * dt * rate
  diffuse v amount diffV * 0.16 * dt * rate
  diffuse w amount diffW * 0.16 * dt * rate
}

stage react "BZ reaction (u fast, v medium, w slow)" {
  reads u, v, w
  writes u, v, w
  cell {
    let cubic = u * (1 - u) * (u - threshold)
    let inhibit = v * vDamping
    let slowSuppress = w * wCoupling
    add u = (cubic - inhibit - slowSuppress) * dt * rate
    add v = eps1 * eps1Mul * (u - v) * dt * rate
    add w = eps2 * eps2Mul * (v - w) * dt * rate
  }
}

stage clampFields "Clamp to safe envelope" {
  reads u, v, w
  writes u, v, w
  clamp u -0.4 1.4
  clamp v -0.4 1.2
  clamp w -0.4 1.2
}
`;

export const pipeline = compileDsl(pipelineDsl);
