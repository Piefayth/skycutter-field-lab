// Lengyel-Epstein CIMA — chlorite-iodide-malonic-acid reaction.
// Castets, Dulos, Boissonade, De Kepper (1990) provided the first
// experimental confirmation of Turing's 1952 theoretical patterns
// using this real-world chemistry.
//
//   du/dt = a − u − 4·u·v / (1 + u²) + D_u·∇²u
//   dv/dt = σ · b · (u − u·v / (1 + u²)) + D_v·∇²v
//
// u is the activator (iodide), v is the inhibitor (chlorite). The
// rational kinetics u·v / (1 + u²) come from a Michaelis-Menten-style
// starch-iodide complex that suppresses iodide at high concentrations.
//
// σ is a stiffness parameter that decouples the inhibitor's kinetic
// timescale from the activator's. Even though the raw diffusion
// coefficients D_u and D_v are similar in real chemistry, the σ
// rescaling makes the *effective* relaxation of v much faster than u,
// so the system satisfies the Turing condition that the inhibitor
// outpaces the activator. Without σ, this reaction would never have
// produced patterns in the lab — that's the experimental discovery
// the model captures.
//
// Steady state: u* = a/5, v* = 1 + (a/5)². At a=12 → u*=2.4, v*=6.76.

import { compileV2 } from "../dsl/compile-v2.mjs";

export const overlays = [];

export const metrics = [
  { id: "meanU", label: "MEAN U", source: "dsl:meanU", spark: true, precision: 3 },
  { id: "meanV", label: "MEAN V", source: "dsl:meanV", spark: true, precision: 3 },
  { id: "active", label: "PEAKS", source: "dsl:active", mini: true, precision: 0 },
  { id: "fps",    label: "FPS",   source: "fps",       mini: true },
];

export const regime = {
  silent:       {},
  intermittent: { active: 5 },
  active:       { active: 80 },
  runaway:      { active: 2000 },
};

export const pipelineDsl = `
recipe "Lengyel-Epstein (CIMA)"
summary "Chlorite-iodide-malonic-acid R-D — the first experimentally confirmed Turing patterns (Castets et al. 1990). Rational u·v/(1+u²) kinetics from a starch-iodide complex; the σ stiffness lets the inhibitor's effective timescale outrun the activator's so the Turing condition holds even when the raw diffusion coefficients are similar. Hexagonal spots that crystallize into stripes when parameters drift across the bifurcation."
recommendedPreset spots

substrate geodesic frequency 64

field u: f32
field v: f32

// CFL note — Lengyel-Epstein is genuinely a stiff model. The σ
// stiffness creates a fast/slow split: the homogeneous fixed point
// is Hopf-unstable when σ is *small* (the Turing condition needs
// σ above a threshold), but Forward Euler with dt·σ above the
// stability bound is also unstable. Those two cliffs come at you
// from opposite directions.
//
// At a=10, b=0.3, σ=30 the fixed point is (u*, v*) = (2, 5) and
// the Jacobian eigenvalues are λ ≈ -1.1 ± 4.1i — Hopf-stable but
// dt·|λ| ≈ 4 at rate=60, requiring much smaller dt than feels
// natural. Defaults rate=3 give dt_eff = 0.05 and a per-tick
// amplification of 0.94 — stable but slow. Patterns take 30-60
// wall-seconds to crystallize at default rate.
//
// Crank σ above ~50 and you'll need rate=2 or below; crank σ below
// ~20 with this a/b and the homogeneous state goes unstable and
// flashes globally regardless of how you tune rate. The model only
// looks "right" in a narrow corridor.
param simRateHz slider 0..360 step 1    default 60   label "SIM RATE"
param rate      slider 1..30  step 1    default 3    label "RATE"
param a         slider 4..20  step 0.5  default 10   label "a"
param b         slider 0..1   step 0.01 default 0.3  label "b"
param sigma     slider 5..80  step 1    default 30   label "σ (STIFF)"
param Du        slider 0..0.3 step 0.005 default 0.05 label "Du"
param Dv        slider 0..4   step 0.05  default 3.0  label "Dv"

step {
  stage diffuse "Diffuse u (slow) + v (fast)" {
    reads u, v
    writes u, v
    cell {
      add u = (mean n in neighbors { u@n } - u) * clamp(Du * 0.16 * dt * rate, 0, 0.24)
      add v = (mean n in neighbors { v@n } - v) * clamp(Dv * 0.16 * dt * rate, 0, 0.24)
    }
  }

  stage react "CIMA kinetics" {
    reads u, v
    writes u, v
    cell {
      // The rational denominator (1 + u²) saturates the iodide
      // self-quenching term — central to the experimental match.
      let denom = 1 + u * u
      let uv_q  = u * v / denom
      add u = (a - u - 4 * uv_q) * dt * rate
      add v = sigma * b * (u - uv_q) * dt * rate
    }
  }

  stage clampPos "Stay non-negative" {
    reads u, v
    writes u, v
    cell {
      set u = clamp(u, 0, 24)
      set v = clamp(v, 0, 32)
    }
  }
}

metric meanU  = mean cells { u }
metric meanV  = mean cells { v }
metric active = count cells where u > 3

views {
  palette U_RAMP {
    stop 0 color [10, 16, 28]
    stop 1 color [255, 220, 100]
  }

  palette V_RAMP {
    stop 0 color [16, 22, 36]
    stop 1 color [180, 100, 200]
  }

  view u "U (iodide)"   { color ramp u range [0, 5]  palette U_RAMP }

  view v "V (chlorite)" { color ramp v range [0, 10] palette V_RAMP }
}

stamps {
  stamp pulse "Pulse U" {
    spot u at brush.pos, radius=brush.r, amount=2
  }
}

scenarios {
  scenario spots "Random near-steady seed" {
    // Steady state at a=10: u* = a/5 = 2, v* = 1 + u*² = 5. Seed
    // small noise around the fixed point; spatial Turing modes grow
    // into hexagonal spots over 30-60 wall-seconds at default rate.
    for each cell {
      set u = 2.0 + cellNoise(11, 1.0) * 0.3
      set v = 5.0 + cellNoise(13, 1.0) * 0.3
    }
  }

  scenario steady "Homogeneous steady state" {
    set u = 2.0
    set v = 5.0
  }

  scenario stripes "Latitudinal pattern seed" {
    // Pre-pattern sin(lat) in U; depending on (a, b) the system either
    // heals into stripes or fragments into a spot lattice.
    for each cell {
      set u = 2.0 + sin(lat * 5) * 0.6
      set v = 5.0
    }
  }

  scenario singleSpot "One nucleation" {
    set u = 2.0
    set v = 5.0
    spot u at lon=0, lat=0, radius=0.12, amount=2
  }
}
`;

export const pipeline = compileV2(pipelineDsl);
