// Inverter front — wave of activity propagates by threshold-spread;
// cells the wave passes through swap substances A and B locally. Closes
// the events trilogy alongside discharge-cascade and residue-tracks.

// Sim operators are injected into node bodies by the runtime; no import.
import { ramp, gray, diverge } from "../prims/colorers.mjs";
import { compileDsl } from "../dsl/compiler.mjs";

export const views = [
  { id: "a", label: "A (substance)", color: ramp("A", [8, 32, 60], [60, 150, 240]) },
  { id: "b", label: "B (substance)", color: gray("B") },
  { id: "w", label: "W (wave)", color: diverge("W") },
];

export const overlays = [];

export const metrics = [
  { id: "a", label: "A", source: "A", spark: true, precision: 3 },
  { id: "b", label: "B", source: "B", spark: true, precision: 3 },
  { id: "w", label: "W", source: "W", spark: true, precision: 3 },
  { id: "events", label: "EVENTS", source: "events", spark: true },
  { id: "waveArea", label: "W>0.5", source: "coverage:W:0.5", mini: true, precision: 3 },
  { id: "fps", label: "FPS", source: "fps", mini: true },
];

export const regime = {
  intermittent: { events: 0 },
  active: { events: 100, W: 0.01 },
  runaway: { events: 8000, W: 0.5 },
};

export const pipelineDsl = `
recipe "Inverter front (events layer)"
summary "A wave of activity propagates by threshold-spread; cells the wave passes through have substances A and B swapped. Wave-spread uses a two-pass mark-then-apply pattern."
recommendedPreset blank
grid geodesic tiles 64

use clock dt, frame
use geo x, y, i, lon, lat, u, v, px, py, pz, N, PI, TAU
use sim wind, advect, diffuse, clamp, normalize, cell, event, each
use core clamp, smoothstep, max, min, abs, hypot, cellNoise, neighbor
use init fill, eachCell

field A, B, W, R, spreadMask

setting simRateHz slider min 0 max 360 step 1 default 60 label "SIM RATE"
param waveThreshold slider min 0 max 1 step 0.05 default 0.5 label "WAVE THR"
param waveDecay slider min 0 max 1 step 0.005 default 0.05 label "W DECAY"
param refractoryDecay slider min 0 max 1 step 0.005 default 0.1 label "R DECAY"
param inversionGuardLow slider min 0 max 2 step 0.05 default 0.5 label "INV LO"
param inversionGuardHigh slider min 0 max 2 step 0.05 default 1.05 label "INV HI"

preset blank "Blank canvas" {
  fill A 0
  fill B 0
  fill W 0
  fill R 0
  fill spreadMask 0
  eachCell {
    when lon < 0 {
      set A = 0.7
    }
    when lon >= 0 {
      set B = 0.7
    }
    when abs(lon) < 0.04 and abs(lat) < 0.04 {
      set W = 1
      set R = 1
    }
  }
}

stage markSpread "Mark wave-spread targets (read-only into spreadMask)" {
  reads W, R
  writes spreadMask
  each {
    when W < waveThreshold and R <= 0.1 and neighbor max n in W { n } > 0.5 {
      set spreadMask = 1
    }
  }
}

stage ignite "Apply wave ignition (where spreadMask is set)" {
  reads spreadMask
  writes W, R, spreadMask
  event when spreadMask > 0.5 {
    set W = 1
    set R = 1
    set spreadMask = 0
  }
}

stage invert "Inversion event (swap A and B where wave is currently passing)" {
  reads W, R, A, B
  writes A, B, R
  event when W > 0.99 and R > inversionGuardLow and R < inversionGuardHigh {
    let a = A
    set A = B
    set B = a
    set R = 1.5
  }
}

stage decay "Wave + refractory decay (continuous)" {
  reads W, R
  writes W, R
  cell {
    add W = -waveDecay * W * dt
    add R = -refractoryDecay * R * dt
  }
}

stage clamp "Clamp" {
  reads W, R, A, B, spreadMask
  writes W, R, A, B, spreadMask
  clamp W 0 1
  clamp R 0 1.5
  clamp A 0 1.4
  clamp B 0 1
  clamp spreadMask 0 1
}
`;

export const pipeline = compileDsl(pipelineDsl);
