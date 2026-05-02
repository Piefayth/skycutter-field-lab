// Gray-Scott reaction-diffusion. Two-field nonlinear reaction with
// asymmetric diffusion. u (substrate) + v (autocatalyst).

// Sim operators are injected into node bodies by the runtime; no import.
import { ramp, gray } from "../prims/colorers.mjs";
import { compileDsl } from "../dsl/compiler.mjs";

export const views = [
  { id: "u", label: "U (substrate)", color: ramp("u", [8, 32, 60], [60, 150, 240]) },
  { id: "v", label: "V (autocatalyst)", color: gray("v") },
];

export const overlays = [];

export const metrics = [
  { id: "u", label: "U", source: "u", spark: true, precision: 3 },
  { id: "v", label: "V", source: "v", spark: true, precision: 3 },
  { id: "var", label: "VAR", source: "field:v", spark: true, precision: 4 },
  { id: "maxV", label: "MAX V", source: "max:v", mini: true, precision: 3 },
  { id: "active", label: "ACTIVE", source: "coverage:v:0.5", mini: true, precision: 3 },
  { id: "fps", label: "FPS", source: "fps", mini: true },
];

export const regime = {
  silent: {},
  intermittent: { v: 0.01 },
  active: { "coverage:v:0.5": 0.02 },
  runaway: { v: 0.8, "coverage:v:0.5": 0.75 },
};

export const pipelineDsl = `
recipe "Gray-Scott reaction-diffusion"
summary "Two-field nonlinear reaction with asymmetric diffusion. u (substrate), v (autocatalyst). Knobs gsFeed/gsKill walk Pearson's f/k phase diagram."
recommendedPreset blank
grid geodesic tiles 64

use clock dt, frame
use geo x, y, i, lon, lat, u, v, px, py, pz, N, PI, TAU
use sim wind, advect, diffuse, clamp, normalize, cell, event, each
use init fill, eachCell
use core clamp, smoothstep, max, min, abs, hypot, cellNoise

field u, v

setting simRateHz slider min 0 max 360 step 1 default 60 label "SIM RATE"
param gsFeed slider min 0 max 0.1 step 0.001 default 0.046 label "FEED"
param gsKill slider min 0 max 0.1 step 0.001 default 0.063 label "KILL"
param rate slider min 1 max 100 step 1 default 30 label "RATE"

preset blank "Blank canvas" {
  fill u 1
  fill v 0
  eachCell {
    let d2 = lon * lon + lat * lat
    when d2 < 0.16 * 0.16 {
      set v = 0.5 + cellNoise(7) * 0.05
      set u = 0.5
    }
  }
}

stage diffuseU "Diffuse u (substrate)" {
  reads u
  writes u
  diffuse u amount 0.16 * dt * rate
}

stage diffuseV "Diffuse v (autocatalyst, half rate of u)" {
  reads v
  writes v
  diffuse v amount 0.08 * dt * rate
}

stage gsReaction "Gray-Scott reaction" {
  reads u, v
  writes u, v
  cell {
    let r = u * v * v
    add u = (-r + gsFeed * (1 - u)) * dt * rate
    add v = (r - (gsFeed + gsKill) * v) * dt * rate
  }
}

stage clamp "Clamp" {
  reads u, v
  writes u, v
  clamp u 0 1.4
  clamp v 0 1
}
`;

export const pipeline = compileDsl(pipelineDsl);
