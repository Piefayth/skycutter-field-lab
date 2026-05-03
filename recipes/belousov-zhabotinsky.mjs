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

palette U_RAMP {
  stop 0 color [14, 18, 26]
  stop 1 color [255, 200, 70]
}

palette V_RAMP {
  stop 0 color [14, 18, 26]
  stop 1 color [80, 220, 100]
}

palette W_RAMP {
  stop 0 color [14, 18, 26]
  stop 1 color [120, 100, 240]
}

view composite "Composite (u/v/w)" {
  color expr {
    let uc = clamp(u, 0, 1.4)
    let vc = clamp(v, 0, 1.4)
    let wc = clamp(w, 0, 1.4)
    set red   = 28 + uc * 220 - vc * 50 - wc * 10
    set green = 22 + vc * 200 - uc * 20
    set blue  = 50 + wc * 180 - uc * 30
  }
}

view u "U (autocatalyst)" {
  color ramp u range [0, 1] palette U_RAMP
}

view v "V (inhibitor)" {
  color ramp v range [0, 1] palette V_RAMP
}

view w "W (slow recovery)" {
  color ramp w range [0, 1] palette W_RAMP
}

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
