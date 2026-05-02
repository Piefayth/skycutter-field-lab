// Kuramoto coupled-oscillator network. Each cell carries a phase θ and
// an intrinsic frequency ω; nearest-neighbor coupling pulls phases
// toward each other. With Sakaguchi phase lag α near π/2, sync and
// chaos can coexist on the same sphere — the "chimera" regime.
//
// Math:
//   dθ/dt = ω + K * Σ_j sin(θ_j - θ - α)   over neighbors j
//
// Knobs: K (coupling strength), α (phase lag), ωspread (heterogeneity
// of intrinsic frequencies). Pure 2D-lattice Sakaguchi typically gives
// spiral-chimera patterns rather than the canonical Abrams-Strogatz
// classical chimera (which needs nonlocal coupling). On the geodesic
// sphere both regimes are visually rich.

import { phase, gray } from "../prims/colorers.mjs";
import { compileDsl } from "../dsl/compiler.mjs";

export const views = [
  { id: "phase", label: "Phase (θ)", color: phase("theta") },
  { id: "omega", label: "Intrinsic ω", color: gray("omega") },
];

export const overlays = [];

export const metrics = [
  // |R| ≈ ⟨cos θ⟩ as a cheap proxy for the Kuramoto order parameter.
  // Goes to 1 at full sync, ~0 in chaotic regime, intermediate when
  // partial synchronization (chimera-like) sets in.
  { id: "order", label: "ORDER", source: "cosTheta", spark: true, precision: 3 },
  { id: "fps", label: "FPS", source: "fps", mini: true },
];

export const regime = {
  silent: {},
  intermittent: { cosTheta: 0.15 },
  active: { cosTheta: 0.5 },
  runaway: { cosTheta: 0.95 },
};

export const pipelineDsl = `
recipe "Kuramoto chimera"
summary "Coupled phase oscillators on a sphere. Each cell evolves dθ/dt = ω + K · Σ sin(θ_neighbor - θ - α). With Sakaguchi lag α near π/2, partial synchronization regimes emerge — rotating spirals, drifting bands, or coexisting sync / chaos."
recommendedPreset spiral
grid geodesic tiles 64

use clock dt, frame
use geo lon, lat, x, y, i, N, PI, TAU
use sim cell, each
use init fill, spot, eachCell
use core sin, cos, exp, smoothstep, max, min, abs, hypot, cellRand, neighbor, wrapAngle

// θ is each cell's phase angle (radians); cosTheta is just cos(θ),
// updated each tick so the metrics layer can take its mean as the
// order parameter without reaching into theta directly.
field theta, cosTheta

// ω is the intrinsic frequency, drawn once per cell at preset time.
// Stage-readable but not stage-writable.
source omega

setting simRateHz slider min 0 max 360 step 1 default 60 label "SIM RATE"
// K is per-neighbor coupling. Each cell sums over 5–6 neighbors,
// so the effective coupling pressure is ~5–6 × K.
param K     slider min 0 max 2    step 0.01 default 1.58 label "COUPLING K"
// α near π/2 (≈ 1.5708) is the Sakaguchi-Kuramoto sync edge; low
// values give standard Kuramoto where sync wins when K dominates ω
// spread. The recommended preset's K vs ωspread ratio sits in the
// partial-sync regime.
param alpha slider min 0 max 1.6  step 0.01 default 0.15 label "PHASE LAG α"
// Heterogeneity of intrinsic frequencies. Higher = harder to fully
// synchronize, more likely to see partial-sync regimes.
param omegaSpread slider min 0 max 2 step 0.01 default 1.45 label "ω SPREAD"
// Time scaling. dt = 1/60 already; rate amplifies the per-tick step
// so phase evolution is visible. Keep modest — too high and a single
// tick can flip phases through more than a half-cycle.
param rate  slider min 0 max 8    step 0.05 default 2.05 label "RATE"

stamp pulse "Phase pulse" {
  // Lift theta by π in a brush-radius patch — useful for kicking the
  // system out of full sync to see how it recovers.
  spot theta lon lon lat lat radius r amount PI
}

stamp randomize "Randomize phase" {
  // Re-roll phases inside the brush — local "thermal" disturbance.
  spot theta lon lon lat lat radius r amount cellRand(frame) * PI
}

preset spiral "Spiral seed" {
  // Phase varies smoothly with longitude — gradient seeds spirals
  // when coupling kicks in.
  fill theta 0
  fill cosTheta 1
  eachCell {
    set theta = lon * 2
    set omega = cellRand(7) * omegaSpread
  }
}

preset uniform "Uniform ω, random θ" {
  fill cosTheta 1
  eachCell {
    set theta = cellRand(11) * PI
    set omega = 0
  }
}

preset bands "Latitudinal bands" {
  fill cosTheta 1
  eachCell {
    set theta = lat * 4
    set omega = cellRand(13) * omegaSpread
  }
}

stage couple "Sakaguchi-Kuramoto coupling" {
  reads theta, omega
  writes theta
  each {
    let coupling = neighbor sum n in theta { sin(n - theta - alpha) }
    add theta = (omega + K * coupling) * dt * rate
  }
}

stage observe "Wrap and project" {
  reads theta
  writes theta, cosTheta
  cell {
    let wrapped = wrapAngle(theta)
    set theta = wrapped
    set cosTheta = cos(wrapped)
  }
}
`;

export const pipeline = compileDsl(pipelineDsl);
