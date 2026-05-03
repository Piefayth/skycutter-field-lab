// Gierer-Meinhardt — activator-inhibitor R-D with multiplicative kinetics.
//
// Two scalar fields per cell: activator a, inhibitor h.
//   da/dt = ρ · a²/h − μ_a · a + ρ_0 + D_a · ∇²a
//   dh/dt = ρ · a²    − μ_h · h          + D_h · ∇²h
//
// Activator a self-amplifies (a²) but is suppressed by h. Inhibitor
// h is produced by a but diffuses ~40× faster (D_h ≫ D_a). The
// short-range activation + long-range inhibition is the canonical
// Turing recipe: small fluctuations near the homogeneous fixed point
// (a = h = μ_h / ρ) get amplified into spots, stripes, or leopard
// patterns depending on parameters.
//
// Compared to Gray-Scott — which is the *competitive* version of the
// same archetype — Gierer-Meinhardt's multiplicative a²/h kinetics
// produce sharper spot boundaries and more stable stripes. Same idea
// shows up in Meinhardt's seashell-pigment models (Algorithmic Beauty
// of Sea Shells, 1995).

import { compileV2 } from "../dsl/compile-v2.mjs";

export const overlays = [];

export const metrics = [
  { id: "meanA", label: "MEAN A", source: "dsl:meanA", spark: true, precision: 3 },
  { id: "maxA",  label: "MAX A",  source: "dsl:maxA",  spark: true, precision: 3 },
  { id: "peakArea", label: "SPOTS", source: "dsl:peakArea", mini: true, precision: 0 },
  { id: "fps",   label: "FPS",    source: "fps",       mini: true },
];

export const regime = {
  silent:       {},
  intermittent: { peakArea: 5 },
  active:       { peakArea: 50 },
  runaway:      { peakArea: 1000 },
};

export const pipelineDsl = `
recipe "Gierer-Meinhardt"
summary "Activator-inhibitor R-D — short-range self-amplification, long-range suppression. The activator a feeds itself through a²/h kinetics; the inhibitor h diffuses 40× faster than a. The diffusion contrast picks a wavelength and crystallizes random noise into Turing spots, stripes, or leopard patterns. Sharper than Gray-Scott because a²/h is multiplicative rather than competitive."
recommendedPreset spots

substrate geodesic frequency 64

const rho0 = 0.0

field a: f32
field h: f32

param simRateHz slider 0..360  step 1     default 60    label "SIM RATE"
param rate      slider 1..200  step 1     default 60    label "RATE"
// rho was 0..0.1 but past ~0.025 both species saturate to the field
// clamp at 8 within seconds (verified via wgsl-harness audit).
param rho       slider 0..0.05 step 0.001 default 0.01  label "ρ (PROD)"
param muA       slider 0..0.05 step 0.0005 default 0.01 label "μa (DECAY a)"
param muH       slider 0..0.05 step 0.0005 default 0.02 label "μh (DECAY h)"
param Da        slider 0..0.05 step 0.0005 default 0.005 label "Da (DIFF a)"
param Dh        slider 0..0.5  step 0.005  default 0.20  label "Dh (DIFF h)"

step {
  stage diffuse "Diffuse a (slow) + h (fast)" {
    reads a, h
    writes a, h
    cell {
      add a = (mean n in neighbors { a@n } - a) * clamp(Da * 0.16 * dt * rate, 0, 0.24)
      add h = (mean n in neighbors { h@n } - h) * clamp(Dh * 0.16 * dt * rate, 0, 0.24)
    }
  }

  stage react "Gierer-Meinhardt kinetics" {
    reads a, h
    writes a, h
    cell {
      // safeH guards the a²/h division near zero (initial transients
      // can briefly drive h ≈ 0 if the user paints aggressively).
      let safeH = max(h, 0.001)
      add a = (rho * a * a / safeH - muA * a + rho0) * dt * rate
      add h = (rho * a * a - muH * h) * dt * rate
    }
  }

  stage clampPos "Stay non-negative" {
    reads a, h
    writes a, h
    cell {
      set a = clamp(a, 0, 8)
      set h = clamp(h, 0, 8)
    }
  }
}

metric meanA = mean cells { a }
metric maxA  = max cells { a }
// Cells where the activator has crossed roughly half-saturation —
// at equilibrium under default params this is the visible spot count.
metric peakArea = count cells where a > 3

views {
  palette ACT {
    stop 0 color [12, 22, 30]
    stop 1 color [255, 230, 80]
  }

  palette INH {
    stop 0 color [10, 14, 24]
    stop 1 color [120, 200, 240]
  }

  view a "Activator (a)" {
    color ramp a range [0, 4] palette ACT
  }

  view h "Inhibitor (h)" {
    color ramp h range [0, 4] palette INH
  }
}

stamps {
  stamp pulseA "Pulse activator" {
    spot a at brush.pos, radius=brush.r, amount=0.6
  }

  stamp dampH "Damp inhibitor" {
    spot h at brush.pos, radius=brush.r, amount=-0.6
  }
}

scenarios {
  scenario spots "Random Turing seed" {
    // Steady state at default params is a = h = μ_h/ρ = 2. Seed a tight
    // Gaussian-flavored noise around it; the activator's lower diffusion
    // amplifies whichever bumps survive the first few hundred ticks.
    for each cell {
      set a = 2 + cellNoise(11, 1.4) * 0.4
      set h = 2 + cellNoise(13, 1.4) * 0.2
    }
  }

  scenario stripes "Latitudinal stripe seed" {
    // Pre-pattern a few latitude bands of high a; the activator-inhibitor
    // dynamics either heal them into stripes (parameters near the stripe
    // regime) or fragment them into spots (closer to the spot regime).
    for each cell {
      set a = 2 + sin(lat * 6) * 0.6
      set h = 2 + sin(lat * 6) * 0.3
    }
  }

  scenario singleSpot "One nucleation site" {
    set a = 0.5
    set h = 1.5
    spot a at lon=0, lat=0, radius=0.12, amount=2
  }

  scenario blank "Empty" {
    set a = 0
    set h = 0
  }
}
`;

export const pipeline = compileV2(pipelineDsl);
