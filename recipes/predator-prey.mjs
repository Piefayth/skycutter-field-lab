// Predator-prey on a sphere — Rosenzweig-MacArthur model with diffusion.
//
// Two density fields per cell: prey N (vegetation, herbivores, the
// substrate), predator P (active consumers). The classic Lotka-Volterra
// closed-orbit model is mathematically elegant but numerically fragile
// — orbits are neutrally stable, drift turns into spirals or blow-ups.
// Rosenzweig-MacArthur replaces the LV linear terms with logistic prey
// growth and a Holling type-II saturating functional response, which
// produces an interior equilibrium with a genuine limit cycle when the
// equilibrium sits to the left of the prey-isocline maximum.
//
// Equations:
//   dN/dt = r·N·(1 − N/K) − a·N·P/(N + h) + Dn·∇²N
//   dP/dt = e·a·N·P/(N + h) − m·P             + Dp·∇²P
//
// Spatial dynamics: prey colonizes empty cells; predator population
// follows behind, eating; a void trails the predators which is then
// re-colonized by prey. The "chase wave" pattern. With higher
// carrying capacity K, the equilibrium destabilizes more aggressively
// (paradox of enrichment) — boost K and the cycle's amplitude blows
// up; eventually predators can crash whole regions to extinction
// before prey re-establishes.

import { compileDsl } from "../dsl/compiler.mjs";

// Composite view: prey N → green tint, predator P → red tint.
// Where both are low: dark / "extinction void." Where both are
// moderate: brown-orange / "transition zone." Saturating mapping
// keeps the field readable across orders of magnitude.
function predatorPreyComposite() {
  const color = (i, fields) => {
    const n = Math.max(0, Math.min(2.5, fields.N[i]));
    const p = Math.max(0, Math.min(2.5, fields.P[i]));
    // Green channel from prey, red from predator. Both go through
    // smoothstep-y saturation so densities above ~1 don't keep
    // brightening the cell to white.
    const ng = Math.min(1, n * 0.8);
    const pg = Math.min(1, p * 1.2);
    const r = Math.round(40 + pg * 215);
    const g = Math.round(28 + ng * 200 - pg * 30);
    const b = Math.round(34 + ng * 60);
    return [
      Math.max(0, Math.min(255, r)),
      Math.max(0, Math.min(255, g)),
      Math.max(0, Math.min(255, b)),
    ];
  };
  color.write = (i, fields, data, k) => {
    const [r, g, b] = color(i, fields);
    data[k + 0] = r;
    data[k + 1] = g;
    data[k + 2] = b;
  };
  color.fields = ["N", "P"];
  return color;
}

function rampColor(field, lo, hi, scale = 1) {
  const color = (i, fields) => {
    const v = Math.max(0, Math.min(1, (fields[field][i] || 0) * scale));
    return [
      Math.round(lo[0] + (hi[0] - lo[0]) * v),
      Math.round(lo[1] + (hi[1] - lo[1]) * v),
      Math.round(lo[2] + (hi[2] - lo[2]) * v),
    ];
  };
  color.write = (i, fields, data, k) => {
    const [r, g, b] = color(i, fields);
    data[k + 0] = r;
    data[k + 1] = g;
    data[k + 2] = b;
  };
  color.fields = [field];
  return color;
}

export const views = [
  { id: "composite", label: "N + P composite", color: predatorPreyComposite() },
  { id: "N",         label: "Prey (N)",        color: rampColor("N", [22, 28, 22], [120, 230, 110], 1.0) },
  { id: "P",         label: "Predator (P)",    color: rampColor("P", [28, 22, 22], [240, 110, 80], 1.5) },
];

export const overlays = [];

export const metrics = [
  { id: "preyMean",     label: "MEAN N",  source: "N",                spark: true, precision: 3 },
  { id: "predatorMean", label: "MEAN P",  source: "P",                spark: true, precision: 3 },
  { id: "preyArea",     label: "PREY",    source: "coverage:N:0.3",   mini: true,  precision: 3 },
  { id: "predatorArea", label: "HUNTERS", source: "coverage:P:0.2",   mini: true,  precision: 3 },
  { id: "fps",          label: "FPS",     source: "fps",              mini: true },
];

export const regime = {
  silent:        {},
  intermittent:  { predatorArea: 0.05 },
  active:        { predatorArea: 0.2 },
  runaway:       { predatorArea: 0.7 },
};

export const pipelineDsl = `
recipe "Predator-prey"
summary "Spatial Rosenzweig-MacArthur — logistic prey + Holling-II predators with diffusion. Produces 'chase waves' on the sphere: prey colonizes empty cells, predators follow eating, a void trails them, prey re-colonizes the void. The system runs forever in a limit cycle when default K and m sit on the unstable side of the prey-isocline peak."
recommendedPreset patches
grid geodesic tiles 64

use clock dt, frame
use geo lon, lat, x, y, i, N, PI, TAU
use sim cell, diffuse, clamp
use init fill, spot, eachCell
use core clamp, smoothstep, max, min, abs, hypot, cellNoise, cellRand

field N, P

setting simRateHz slider min 0 max 360 step 1 default 60 label "SIM RATE"
// Prey intrinsic growth rate.
param r        slider min 0    max 2 step 0.01  default 0.55  label "r (PREY GROWTH)"
// Carrying capacity. Below ~0.5 the equilibrium is stable; above ~1.5
// limit cycles get violent enough to crash whole regions to local
// extinction before prey re-establishes (paradox of enrichment).
param Kcap     slider min 0.2  max 3 step 0.01  default 1.10  label "K (CAP)"
// Attack rate.
param a        slider min 0    max 4 step 0.01  default 1.40  label "a (ATTACK)"
// Half-saturation density. Lower = predators saturate quickly; higher =
// predators only effective at high prey density. This + r·K·a sets the
// position of the equilibrium relative to the prey-isocline peak.
param hSat     slider min 0.05 max 1 step 0.01  default 0.30  label "h (SATURATE)"
// Conversion efficiency: each prey eaten produces e·a predators.
param eEff     slider min 0    max 1 step 0.01  default 0.55  label "e (EFFICIENCY)"
// Predator mortality. Higher → predators die faster, equilibrium prey
// density rises.
param m        slider min 0    max 1 step 0.01  default 0.28  label "m (MORTALITY)"
// Spatial diffusion rates. Predator mobility usually exceeds prey
// mobility — gives the "predator wave catching up" structure.
param Dn       slider min 0    max 4 step 0.05  default 0.45  label "Dn (PREY DIFF)"
param Dp       slider min 0    max 4 step 0.05  default 0.85  label "Dp (PRED DIFF)"
// Time scaling.
param rate     slider min 1    max 100 step 1   default 14    label "RATE"

stamp seedPrey "Seed prey patch" {
  spot N lon lon lat lat radius r amount 0.5
}

stamp seedPredator "Seed predator patch" {
  spot P lon lon lat lat radius r amount 0.4
}

stamp cull "Cull both" {
  spot N lon lon lat lat radius r amount -1.5
  spot P lon lon lat lat radius r amount -1.5
}

preset patches "Random patches" {
  // Prey scattered across the sphere with a few predator hotspots.
  // Initial chaos seeds the chase-wave pattern.
  fill N 0
  fill P 0
  eachCell {
    let seedN = cellRand(11)
    when seedN > 0.4 {
      set N = 0.5 + cellRand(13) * 0.3
    }
    let seedP = cellRand(17)
    when seedP > 0.85 {
      set P = 0.4
    }
  }
}

preset preyOnly "Prey-only world" {
  // No initial predators. Prey grows to carrying capacity uniformly,
  // then a small predator stamp can demonstrate invasion dynamics.
  fill N 0.6
  fill P 0
}

preset front "Predator invasion front" {
  // Prey at carrying capacity in one hemisphere; predator concentrated
  // at a single seed point. Watch the predator wave radiate outward,
  // leaving a void that prey slowly re-colonizes.
  fill N 0.7
  fill P 0
  spot P lon -2.5 lat 0 radius 0.18 amount 0.6
}

preset equilibrium "Near interior equilibrium" {
  // Both populations seeded near the interior fixed point. Spatially
  // uniform start; the limit-cycle instability is what breaks symmetry
  // — small perturbations grow into the chase-wave pattern.
  fill N 0.25
  fill P 0.18
  eachCell {
    set N = 0.25 + cellNoise(7, 1.4) * 0.05
    set P = 0.18 + cellNoise(13, 1.4) * 0.04
  }
}

stage diffuseFields "Spatial spread (Dp > Dn — predators move further)" {
  reads N, P
  writes N, P
  diffuse N amount Dn * 0.18 * dt * rate
  diffuse P amount Dp * 0.18 * dt * rate
}

stage react "Rosenzweig-MacArthur kinetics" {
  reads N, P
  writes N, P
  cell {
    // Holling type-II functional response — predation saturates as
    // prey gets dense. The +1e-6 in the denominator keeps the term
    // finite at N=0; without it WGSL float division throws Inf.
    let response = a * N * P / (N + hSat + 0.000001)
    let preyDot  = r * N * (1 - N / Kcap) - response
    let predDot  = eEff * response - m * P
    add N = preyDot * dt * rate
    add P = predDot * dt * rate
  }
}

stage clampPositive "Densities can't go negative" {
  reads N, P
  writes N, P
  clamp N 0 3
  clamp P 0 3
}
`;

export const pipeline = compileDsl(pipelineDsl);
