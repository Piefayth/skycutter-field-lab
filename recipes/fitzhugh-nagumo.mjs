// FitzHugh-Nagumo — excitable medium. u is the fast "membrane
// potential", v is the slow recovery variable. The cubic reaction
// u(1-u)(u-a) lets u spike past threshold; v rises in response and
// pulls u back down through the -v term, which then lets v decay
// (γv) and the cell becomes excitable again. Spatial diffusion of u
// turns local spikes into traveling waves; an asymmetric v gradient
// breaks a wave into a rotating spiral.

import { ramp, gray } from "../prims/colorers.mjs";
import { compileDsl } from "../dsl/compiler.mjs";

export const views = [
  { id: "u", label: "U (membrane)", color: gray("u") },
  { id: "v", label: "V (recovery)", color: ramp("v", [16, 22, 32], [220, 110, 110]) },
];

export const overlays = [];

export const metrics = [
  { id: "u", label: "U", source: "u", spark: true, precision: 3 },
  { id: "v", label: "V", source: "v", spark: true, precision: 3 },
  { id: "active", label: "U>0.5", source: "coverage:u:0.5", mini: true, precision: 3 },
  { id: "maxU", label: "MAX U", source: "max:u", mini: true, precision: 3 },
  { id: "fps", label: "FPS", source: "fps", mini: true },
];

export const regime = {
  silent: {},
  intermittent: { u: 0.01 },
  active: { "coverage:u:0.5": 0.05 },
  runaway: { "coverage:u:0.5": 0.6 },
};

export const pipelineDsl = `
recipe "FitzHugh-Nagumo"
summary "Excitable medium. Fast u spikes through a cubic threshold; slow v recovers and suppresses. Diffusion turns spikes into traveling fronts; an asymmetric seed breaks a front into a rotating spiral."
recommendedPreset spiral
grid geodesic tiles 64

const a 0.13
const epsilon 0.005
const gamma 1.0

use clock dt, frame
use geo x, y, i, lon, lat, u, v, px, py, pz, N, PI, TAU
use sim cell, diffuse, clamp
use init fill, spot, region, eachCell
use core clamp, smoothstep, max, min, abs, hypot, cellNoise

field u, v

setting simRateHz slider min 0 max 360 step 1 default 60 label "SIM RATE"
param diffusion slider min 0 max 4 step 0.05 default 1.0 label "DIFF"
param rate slider min 1 max 100 step 1 default 30 label "RATE"

stamp pulse "Pulse" {
  spot u lon lon lat lat radius r amount 1
}

stamp refract "Refractory pad" {
  spot v lon lon lat lat radius r amount 0.5
}

stamp spiralSeed "Spiral seed" {
  spot u lon lon - r * 0.6 lat lat radius r * 1.4 amount 1
  spot v lon lon + r * 0.5 lat lat - r * 0.5 radius r amount 0.45
}

preset blank "Blank canvas" {
  fill u 0
  fill v 0
}

preset spiral "Spiral wave seed" {
  fill u 0
  fill v 0
  region u lon -0.6..0.6 lat 0..PI/2 amount 1
  region v lon -0.2..0.4 lat -0.5..0 amount 0.4
}

preset pulses "Random pulses" {
  fill u 0
  fill v 0
  eachCell {
    when cellNoise(7, 0.6) > 0.45 {
      set u = 1
    }
  }
}

preset front "Plane wave" {
  fill u 0
  fill v 0
  region u lon -0.2..0.2 lat -PI/2..PI/2 amount 1
}

stage diffuseU "Diffuse u (only u diffuses; v is local recovery)" {
  reads u
  writes u
  diffuse u amount diffusion * 0.16 * dt * rate
}

stage react "FitzHugh-Nagumo reaction" {
  reads u, v
  writes u, v
  cell {
    let cubic = u * (1 - u) * (u - a)
    add u = (cubic - v) * dt * rate
    add v = epsilon * (u - gamma * v) * dt * rate
  }
}

stage clampFields "Clamp to safe envelope" {
  reads u, v
  writes u, v
  clamp u -0.4 1.4
  clamp v -0.4 1.0
}
`;

export const pipeline = compileDsl(pipelineDsl);
