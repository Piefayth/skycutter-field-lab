// Klausmeier semi-arid vegetation — biomass-water dynamics.
//
// The "tiger bush" pattern visible from satellites in the Sahel: in dry
// climates with sloping terrain, vegetation self-organizes into stripes
// perpendicular to the slope, separated by bare ground. The stripes
// migrate slowly uphill over decades. The same pattern appears in
// hillside grasslands and is a classic example of a self-organized
// biological landscape.
//
// Equations (per cell):
//   dw/dt = a − w − w·n² + v·∂w/∂x_downhill        (water)
//   dn/dt = w·n² − m·n + D·∇²n                      (biomass)
//
// Three terms compete for water:
//   - rainfall a (constant input)
//   - evaporation -w
//   - uptake by biomass -w·n²        ← nonlinear feedback
//
// Biomass grows where water is available, dies at rate m, diffuses
// slowly. The downhill water advection breaks symmetry: water arrives
// from upslope, biomass that establishes itself uphill consumes water
// before it reaches downhill cells, so a nascent stripe casts a
// "shadow" downhill where no biomass can grow → bands.
//
// At v=0 (flat ground), the system reduces to a Turing reaction-
// diffusion that produces spots instead of stripes — try the "spots"
// preset.

import { ramp, gray } from "../prims/colorers.mjs";
import { compileDsl } from "../dsl/compiler.mjs";

export const views = [
  // Biomass: bare ground (dim) → green
  { id: "n", label: "Biomass (n)", color: ramp("n", [22, 32, 22], [120, 200, 80], 0.6) },
  // Water: dry (warm sand) → blue
  { id: "w", label: "Water (w)",   color: ramp("w", [80, 60, 40], [60, 140, 220], 0.5) },
];

export const overlays = [];

export const metrics = [
  { id: "biomass",  label: "MEAN n", source: "n",                     spark: true, precision: 3 },
  { id: "water",    label: "MEAN w", source: "w",                     spark: true, precision: 3 },
  { id: "vegArea",  label: "VEG",    source: "coverage:n:0.4",        mini: true,  precision: 3 },
  { id: "fps",      label: "FPS",    source: "fps",                   mini: true },
];

export const regime = {
  silent:        {},
  intermittent:  { vegArea: 0.05 },
  active:        { vegArea: 0.2 },
  runaway:       { vegArea: 0.7 },
};

export const pipelineDsl = `
recipe "Klausmeier vegetation"
summary "Semi-arid biomass-water dynamics. Vegetation grows where water pools; water flows downhill, casting a 'shadow' that breaks the substrate into stripes oriented perpendicular to the slope. The tiger-bush pattern visible from satellites in the Sahel. With FLOW SPEED at zero (no slope) the same model produces Turing spots — try the 'spots' preset."
recommendedPreset bands
grid geodesic tiles 64

use clock dt, frame
use geo lon, lat, x, y, i, N, PI, TAU
use sim cell, advect, diffuse, clamp
use init fill, spot, eachCell
use core clamp, smoothstep, max, min, abs, hypot, cellNoise, cellRand

field n, w
// Slope direction is fixed at preset-time. Stored as a vector field
// (slopeU, slopeV) on the sphere — east is the natural "downhill"
// because all geodesic positions agree on east as a direction.
source slopeU, slopeV

setting simRateHz slider min 0 max 360 step 1 default 60 label "SIM RATE"
// Rainfall constant. Above ~2.0 the substrate is fertile enough that
// vegetation covers the planet uniformly. Below ~0.5 it can't sustain
// any biomass. The interesting band/spot regime sits in between.
param rainfall  slider min 0 max 4    step 0.01  default 1.80  label "RAINFALL a"
// Biomass mortality. Higher = more die-off, eventually wipes vegetation.
param mortality slider min 0 max 1    step 0.005 default 0.45  label "MORTALITY m"
// Water advection along the slope. v=0 → no slope, Turing spots only.
// Higher values give faster downhill flow → tighter band spacing,
// faster uphill migration of stripes.
param flowSpeed slider min 0 max 200  step 1     default 80    label "FLOW SPEED v"
// Biomass spatial spread (root competition / seed dispersal proxy).
param diffusion slider min 0 max 4    step 0.01  default 0.50  label "DIFFUSION D"
// Time scaling.
param rate      slider min 1 max 100  step 1     default 30    label "RATE"

stamp seed "Plant patch" {
  // Drop a seedling colony — useful in low-vegetation regions where
  // bare ground is at the n=0 fixed point and can't bootstrap.
  spot n lon lon lat lat radius r amount 0.4
}

stamp clearcut "Clear-cut" {
  // Removes vegetation locally — watch how the system fills the gap
  // (or doesn't, if the patch is downhill of an established band).
  spot n lon lon lat lat radius r amount -1
}

stamp irrigate "Add water" {
  // Bonus water — temporary boost to local biomass.
  spot w lon lon lat lat radius r amount 1
}

preset bands "Tiger-bush bands" {
  // Eastward slope (slopeU = 1, slopeV = 0). Random-noisy initial
  // biomass; full water reservoir. Bands form perpendicular to the
  // slope direction → roughly along latitude lines. Migrate westward
  // (uphill — slope points east, vegetation moves the other way).
  fill slopeU 1
  fill slopeV 0
  fill w 1
  fill n 0
  eachCell {
    when cellRand(7) > 0.65 {
      set n = 0.4
    }
  }
}

preset spots "Turing spots (no slope)" {
  // No advection. The Klausmeier kinetics + biomass diffusion alone
  // produce a Turing instability — lattice of spots like a leopard's.
  fill slopeU 0
  fill slopeV 0
  fill w 1
  eachCell {
    set n = cellRand(11) * 0.15 + 0.05
  }
}

preset desertEdge "Edge of vegetation" {
  // Sparse biomass with eastward slope. Watch the system pick which
  // patches to grow into bands and which to abandon to bare ground.
  fill slopeU 1
  fill slopeV 0
  fill w 1
  fill n 0
  eachCell {
    when cellRand(13) > 0.92 {
      set n = 0.3
    }
  }
}

stage waterFlow "Water advects downhill" {
  reads w, slopeU, slopeV
  writes w
  advect w by slopeU, slopeV dt flowSpeed * dt * rate * 0.001
}

stage biomassDiffuse "Biomass spatial spread" {
  reads n
  writes n
  diffuse n amount diffusion * 0.18 * dt * rate
}

stage react "Klausmeier kinetics" {
  reads n, w
  writes n, w
  cell {
    // n² is the autocatalytic uptake — water consumed in proportion to
    // how much biomass is already there.
    let uptake = w * n * n
    add w = (rainfall - w - uptake)   * dt * rate
    add n = (uptake - mortality * n)  * dt * rate
  }
}

stage clampPositive "Keep populations non-negative" {
  reads n, w
  writes n, w
  clamp n 0 4
  clamp w 0 6
}
`;

export const pipeline = compileDsl(pipelineDsl);
