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

import { compileV2 } from "../dsl/compile-v2.mjs";

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

substrate geodesic frequency 64

// θ is each cell's phase angle (radians).
// ω is the intrinsic frequency — written once per cell at scenario
// init, never touched by stages.
// cosTheta is a derived projection of θ for the metrics layer.
field theta: f32
field omega: f32
field cosTheta: f32 derived

param simRateHz   slider 0..360 step 1    default 60   label "SIM RATE"
param K           slider 0..2   step 0.01 default 1.58 label "COUPLING K"
param alpha       slider 0..1.6 step 0.01 default 0.15 label "PHASE LAG α"
param omegaSpread slider 0..2   step 0.01 default 1.45 label "ω SPREAD"
param rate        slider 0..8   step 0.05 default 2.05 label "RATE"

step {
  stage couple "Sakaguchi-Kuramoto coupling" {
    reads theta, omega
    writes theta
    cell {
      // Cell-centered reduction: bind n as a neighbor coordinate, then
      // read theta@n. v2's cell-centered form lets us compute the
      // Sakaguchi term in one expression without precomputed cosTheta.
      let coupling = sum n in neighbors { sin(theta@n - theta - alpha) }
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
}

views {
  palette OMEGA {
    stop 0 color [10, 14, 22]
    stop 1 color [240, 240, 240]
  }

  view phase "Phase (θ)" {
    color wheel theta
  }

  view omega "Intrinsic ω" {
    color ramp omega range [0, 2] palette OMEGA
  }
}

stamps {
  stamp pulse "Phase pulse" {
    spot theta at brush.pos, radius=brush.r, amount=PI
  }

  stamp randomize "Randomize phase" {
    spot theta at brush.pos, radius=brush.r, amount=cellRand(frame) * PI
  }
}

scenarios {
  scenario spiral "Spiral seed" {
    for each cell {
      set theta = lon * 2
      set omega = cellRand(7) * omegaSpread
    }
  }

  scenario uniform "Uniform ω, random θ" {
    for each cell {
      set theta = cellRand(11) * PI
      set omega = 0
    }
  }

  scenario bands "Latitudinal bands" {
    for each cell {
      set theta = lat * 4
      set omega = cellRand(13) * omegaSpread
    }
  }
}
`;

export const pipeline = compileV2(pipelineDsl);
