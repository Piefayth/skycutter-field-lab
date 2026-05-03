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

import { compileV2 } from "../dsl/compile-v2.mjs";

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

substrate geodesic frequency 64

const a    = 0.1
const eps1 = 0.08
const eps2 = 0.012

field u: f32
field v: f32
field w: f32

param simRateHz  slider 0..360   step 1     default 60    label "SIM RATE"
param rate       slider 1..100   step 1     default 30    label "RATE"
param diffU      slider 0..4     step 0.05  default 0.55  label "DIFF U"
param diffV      slider 0..4     step 0.05  default 0.30  label "DIFF V"
param diffW      slider 0..4     step 0.05  default 0.10  label "DIFF W"
param threshold  slider -0.3..0.5 step 0.01 default -0.05 label "THRESH"
param drive      slider 0..0.2   step 0.001 default 0.025 label "DRIVE"
param eps1Mul    slider 0.1..5   step 0.05  default 1.0   label "EPS1·"
param eps2Mul    slider 0.1..5   step 0.05  default 1.0   label "EPS2·"
param wCoupling  slider 0..2     step 0.05  default 0.55  label "W→U"
param vDamping   slider 0..2     step 0.05  default 1.0   label "V→U"

stamp pulse "Pulse u" {
  spot u at brush.pos, radius=brush.r, amount=1
}

stamp inhibitor "Inhibitor pad" {
  spot v at brush.pos, radius=brush.r, amount=0.6
}

scenario blank "Empty" {
  set u = 0
  set v = 0
  set w = 0
}

scenario spiral "Spiral seed" {
  set u = 0
  set v = 0
  set w = 0
  region u at lonMin=-0.6, lonMax=0.6, latMin=0,    latMax=PI/2, amount=1
  region v at lonMin=-0.2, lonMax=0.4, latMin=-0.5, latMax=0,    amount=0.5
}

scenario rings "Concentric target waves" {
  set u = 0
  set v = 0
  set w = 0
  spot u at lon=0, lat=0, radius=0.18, amount=1
}

scenario random "Random pulses" {
  set u = 0
  set v = 0
  set w = 0
  for each cell {
    when cellNoise(11, 0.45) > 0.55 {
      set u = 1
    }
  }
}

scenario bands "Latitude bands" {
  set u = 0
  set v = 0
  set w = 0
  region u at lonMin=-PI, lonMax=PI, latMin=0.4,  latMax=0.8,  amount=1
  region u at lonMin=-PI, lonMax=PI, latMin=-0.8, latMax=-0.4, amount=1
  region v at lonMin=-PI, lonMax=PI, latMin=-0.2, latMax=0.2,  amount=0.5
}

step {
  stage diffuseFields "Diffuse u, v, w (different rates)" {
    reads u, v, w
    writes u, v, w
    cell {
      add u = (mean n in neighbors { u@n } - u) * clamp(diffU * 0.16 * dt * rate, 0, 0.24)
      add v = (mean n in neighbors { v@n } - v) * clamp(diffV * 0.16 * dt * rate, 0, 0.24)
      add w = (mean n in neighbors { w@n } - w) * clamp(diffW * 0.16 * dt * rate, 0, 0.24)
    }
  }

  stage react "BZ reaction (u fast, v medium, w slow)" {
    reads u, v, w
    writes u, v, w
    cell {
      let cubic = u * (1 - u) * (u - threshold)
      let inhibit = v * vDamping
      let slowSuppress = w * wCoupling
      add u = (cubic - inhibit - slowSuppress + drive) * dt * rate
      add v = eps1 * eps1Mul * (u - v) * dt * rate
      add w = eps2 * eps2Mul * (v - w) * dt * rate
    }
  }

  stage clampFields "Clamp to safe envelope" {
    reads u, v, w
    writes u, v, w
    cell {
      set u = clamp(u, -0.4, 1.4)
      set v = clamp(v, -0.4, 1.2)
      set w = clamp(w, -0.4, 1.2)
    }
  }
}
`;

export const pipeline = compileV2(pipelineDsl);
