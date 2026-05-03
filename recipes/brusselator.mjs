// Brusselator — synthetic two-species R-D from Prigogine + Lefever (1968).
// The textbook example for Turing analysis.
//
//   du/dt = A + u²·v − (B+1)·u + D_u·∇²u
//   dv/dt = B·u − u²·v          + D_v·∇²v
//
// Steady state: u* = A, v* = B/A. The well-mixed system goes through
// a Hopf bifurcation when B > 1 + A² (oscillates), and the spatial
// version develops Turing instability when D_v / D_u exceeds a
// threshold that depends on A, B. Default parameters land in the
// Turing-unstable regime: small fluctuations grow into stripes or
// spots whose wavelength is set by the diffusion contrast.
//
// Cleanest classroom-friendly Turing demo — every term has a clear
// chemical interpretation, the steady state is exact, and the linear
// stability analysis is a standard PDE-textbook exercise.

import { compileV2 } from "../dsl/compile-v2.mjs";

export const overlays = [];

export const metrics = [
  { id: "meanU", label: "MEAN U", source: "dsl:meanU", spark: true, precision: 3 },
  { id: "meanV", label: "MEAN V", source: "dsl:meanV", spark: true, precision: 3 },
  { id: "maxU",  label: "MAX U",  source: "dsl:maxU",  mini: true,  precision: 3 },
  { id: "fps",   label: "FPS",    source: "fps",       mini: true },
];

export const regime = {
  silent:       {},
  intermittent: { maxU: 2.5 },
  active:       { maxU: 3.5 },
  runaway:      { maxU: 7 },
};

export const pipelineDsl = `
recipe "Brusselator"
summary "Synthetic two-species reaction-diffusion. Steady state u=A, v=B/A. With D_v ≫ D_u the homogeneous fixed point is Turing-unstable: noise crystallizes into stripes whose wavelength is set by the diffusion contrast. Crank B past 1+A² to see Hopf-flavored oscillations interfere with the Turing pattern. The classroom textbook demo of pattern formation."
recommendedPreset stripes

substrate geodesic frequency 64

field u: f32
field v: f32

// CFL: at the (u*, v*) = (A, B/A) fixed point, the Jacobian's
// eigenvalues are complex λ = -(1+A²-B)/2 ± i·√(A² - ((1+A²-B)/2)²).
// Forward-Euler stability for complex λ is much tighter than the
// "dt·|λ|<2" rule of thumb suggests — what really matters is
// dt·|Im(λ)|² < 2·|Re(λ)|, i.e. the imaginary (oscillatory) part
// can dominate. Defaults A=2, B=3 give λ ≈ -1 ± 1.73i, so the
// per-tick amplification at dt=0.25 (rate=15) is |1+λ·dt|² = 0.75
// — comfortably stable.
//
// Push B closer to 1+A² = 5 and the real part shrinks (weaker
// damping); past A²+1 the homogeneous state goes Hopf-unstable and
// you'll see global oscillations dominate over Turing patterns. The
// previous default B=4.5 was Hopf-stable on paper but FE-unstable
// numerically (|1+λ·dt|² ≈ 1.13 grew exponentially).
//
// Turing-unstable defaults: D_v / D_u = 15. Bumping Dv past ~1.5 or
// lowering Du below ~0.02 picks shorter wavelengths (denser spots).
param simRateHz slider 0..360 step 1     default 60   label "SIM RATE"
param rate      slider 1..60  step 1     default 10   label "RATE"
param A         slider 0.5..4 step 0.05  default 2.0  label "A (FEED)"
param B         slider 0..8   step 0.05  default 3.0  label "B (RATIO)"
param Du        slider 0..0.2 step 0.005 default 0.04 label "Du"
param Dv        slider 0..3   step 0.01  default 1.00 label "Dv"

step {
  stage diffuse "Diffuse u + v (D_v ≫ D_u drives Turing)" {
    reads u, v
    writes u, v
    cell {
      add u = (mean n in neighbors { u@n } - u) * clamp(Du * 0.16 * dt * rate, 0, 0.24)
      add v = (mean n in neighbors { v@n } - v) * clamp(Dv * 0.16 * dt * rate, 0, 0.24)
    }
  }

  stage react "Brusselator kinetics" {
    reads u, v
    writes u, v
    cell {
      let u2v = u * u * v
      add u = (A + u2v - (B + 1) * u) * dt * rate
      add v = (B * u - u2v) * dt * rate
    }
  }

  stage clampPos "Stay non-negative" {
    reads u, v
    writes u, v
    cell {
      set u = clamp(u, 0, 8)
      set v = clamp(v, 0, 12)
    }
  }
}

metric meanU = mean cells { u }
metric meanV = mean cells { v }
metric maxU  = max cells { u }

views {
  palette U_RAMP {
    stop 0 color [12, 14, 24]
    stop 1 color [240, 130, 60]
  }

  palette V_RAMP {
    stop 0 color [16, 18, 30]
    stop 1 color [110, 200, 230]
  }

  view u "U" { color ramp u range [0, 5] palette U_RAMP }

  view v "V" { color ramp v range [0, 6] palette V_RAMP }
}

stamps {
  stamp pulseU "Pulse U" {
    spot u at brush.pos, radius=brush.r, amount=0.5
  }

  stamp pulseV "Pulse V" {
    spot v at brush.pos, radius=brush.r, amount=0.8
  }
}

scenarios {
  scenario stripes "Random near-steady seed" {
    // Tiny noise seed only — the Brusselator's u²·v kinetics are
    // violently nonlinear, so any per-cell perturbation larger than
    // ~0.1 puts the Forward-Euler step outside its linear regime.
    // With overlarge seeds the local trajectory shoots far from
    // (u*, v*), diffusion homogenizes the overshoots, and the field
    // collapses to a uniform sphere before the Turing instability
    // can re-grow the pattern. Tiny noise + slow rate is the safe
    // path: patterns take a few seconds to crystallize but they do.
    for each cell {
      set u = 2.0 + cellNoise(11, 1.2) * 0.05
      set v = 1.5 + cellNoise(13, 1.2) * 0.03
    }
  }

  scenario steady "Homogeneous steady state" {
    // Pure homogeneous fixed point — only numerical roundoff seeds
    // perturbations, so patterns form glacially (or not at all).
    // Useful for testing whether your changes broke the FE-stable
    // damping.
    set u = 2.0
    set v = 1.5
  }

  scenario singleSpot "Single perturbation" {
    set u = 2.0
    set v = 1.5
    spot u at lon=0, lat=0, radius=0.12, amount=0.6
  }

  scenario hopf "Hopf regime — global oscillation" {
    // B past the Hopf threshold (1 + A² = 5 at A=2): the homogeneous
    // fixed point loses stability and the well-mixed kinetics
    // oscillate. With diffusion, the entire sphere pulses in phase.
    // Shipping with B = 5.5 ensures the regime change is the
    // scenario, not "switch scenario then go tune the slider".
    param B = 5.5
    for each cell {
      set u = 2.0 + cellNoise(11, 1.2) * 0.05
      set v = 2.75 + cellNoise(13, 1.2) * 0.03
    }
  }
}
`;

export const pipeline = compileV2(pipelineDsl);
