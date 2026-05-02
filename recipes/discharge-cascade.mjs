// Discharge cascade — three-substance excitable medium driven by discrete
// events. A accumulates; where A > threshold AND R is low, fires a
// discharge event into B and resets local A, locks R. First demo of the
// events layer (where prim).

// Sim operators are injected into node bodies by the runtime; no import.
import { ramp, gray, diverge } from "../prims/colorers.mjs";
import { compileDsl } from "../dsl/compiler.mjs";

export const views = [
  { id: "a", label: "A (accumulator)", color: diverge("A") },
  { id: "b", label: "B (discharge)", color: gray("B") },
  { id: "r", label: "R (refractory)", color: ramp("R", [34, 28, 46], [255, 194, 84]) },
];

export const overlays = [];

export const metrics = [
  { id: "a", label: "A", source: "A", spark: true, precision: 3 },
  { id: "b", label: "B", source: "B", spark: true, precision: 3 },
  { id: "r", label: "R", source: "R", spark: true, precision: 3 },
  { id: "events", label: "EVENTS", source: "events", spark: true },
  { id: "activeB", label: "B>0.5", source: "coverage:B:0.5", mini: true, precision: 3 },
  { id: "fps", label: "FPS", source: "fps", mini: true },
];

export const regime = {
  intermittent: { events: 0, B: 0.01 },
  active: { events: 60, "coverage:B:0.5": 0.05 },
  runaway: { events: 2500, "coverage:B:0.5": 0.5 },
};

export const pipelineDsl = `
recipe "Discharge cascade (events layer)"
summary "Three-substance excitable medium driven by discrete events. Substance A accumulates from a constant source; where A > dischargeThreshold AND R is low, fires a discrete event: dumps dischargeAmount into B, resets local A, locks R=1. R decays continuously; B diffuses and decays."
recommendedPreset blank
grid geodesic tiles 64

use clock dt, frame
use geo x, y, i, lon, lat, u, v, px, py, pz, N, PI, TAU
use sim wind, advect, diffuse, clamp, normalize, cell, event, each
use init fill, eachCell
use core clamp, smoothstep, max, min, abs, hypot, noise, sample

field A, B, R

setting simRateHz slider min 0 max 360 step 1 default 60 label "SIM RATE"
param dischargeThreshold slider min 0 max 2 step 0.05 default 1 label "THR"
param dischargeAmount slider min 0 max 2 step 0.05 default 0.6 label "AMT"
param refractoryDecay slider min 0 max 2 step 0.05 default 0.5 label "R DECAY"
param accumRate slider min 0 max 0.05 step 0.001 default 0.01 label "ACCUM"
param bDiffuse slider min 0 max 0.5 step 0.005 default 0.05 label "B DIFF"
param bDecay slider min 0 max 2 step 0.05 default 0.3 label "B DECAY"
param bToA slider min 0 max 2 step 0.05 default 0.4 label "B->A"

preset blank "Blank canvas" {
  fill A 0.2
  fill B 0
  fill R 0
  eachCell {
    let d2 = lon * lon + lat * lat
    when d2 < 0.08 * 0.08 {
      set A = 0.9 + noise(3) * 0.05
    }
  }
}

stage accumulate "Accumulate A, decay R, B->A coupling" {
  reads A, B, R
  writes A, R
  cell {
    let accum = accumRate ?? 0.01
    let rDecay = refractoryDecay ?? 0.5
    let bToA = bToA ?? 0.4
    add A = (accum + bToA * B) * dt
    add R = -rDecay * R * dt
  }
}

stage diffuseB "Diffuse B so cascades can propagate" {
  reads B
  writes B
  diffuse B amount (bDiffuse ?? 0.05) * dt
}

stage decayB "Decay B" {
  reads B
  writes B
  cell {
    let bDecay = bDecay ?? 0.3
    add B = -bDecay * B * dt
  }
}

stage discharge "Discharge event" {
  reads A, B, R
  writes A, B, R
  event when A > dischargeThreshold and R < 0.05 {
    add B = dischargeAmount
    set A = 0
    set R = 1
  }
}

stage clamp "Clamp" {
  reads A, B, R
  writes A, B, R
  clamp A 0 4
  clamp B 0 1
  clamp R 0 1.5
}
`;

export const pipeline = compileDsl(pipelineDsl);
