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
  intermittent: { maxU: 1.5 },
  active:       { maxU: 2.5 },
  runaway:      { maxU: 6 },
};

export const pipelineDsl = `
recipe "Brusselator"
summary "Synthetic two-species reaction-diffusion. Steady state u=A, v=B/A. With D_v ≫ D_u the homogeneous fixed point is Turing-unstable: noise crystallizes into stripes whose wavelength is set by the diffusion contrast. Crank B past 1+A² to see Hopf-flavored oscillations interfere with the Turing pattern. The classroom textbook demo of pattern formation."
recommendedPreset stripes

substrate geodesic frequency 64

field u: f32
field v: f32

palette U_RAMP {
  stop 0 color [12, 14, 24]
  stop 1 color [240, 130, 60]
}

palette V_RAMP {
  stop 0 color [16, 18, 30]
  stop 1 color [110, 200, 230]
}

view u "U" { color ramp u range [0, 4] palette U_RAMP }
view v "V" { color ramp v range [0, 6] palette V_RAMP }

param simRateHz slider 0..360 step 1    default 60   label "SIM RATE"
param rate      slider 1..200 step 1    default 60   label "RATE"
param A         slider 0.1..3 step 0.05 default 1.0  label "A (FEED)"
param B         slider 0..6   step 0.05 default 3.0  label "B (RATIO)"
param Du        slider 0..0.3 step 0.005 default 0.04 label "Du"
param Dv        slider 0..2   step 0.01  default 0.40 label "Dv"

stamp pulseU "Pulse U" {
  spot u at brush.pos, radius=brush.r, amount=0.5
}

stamp pulseV "Pulse V" {
  spot v at brush.pos, radius=brush.r, amount=0.8
}

scenario stripes "Random near-steady seed" {
  // Defaults sit in the Turing-unstable regime; tiny perturbations
  // around the (1, 3) fixed point grow into stripes after a few
  // hundred ticks.
  for each cell {
    set u = 1.0 + cellNoise(11, 1.0) * 0.1
    set v = 3.0 + cellNoise(13, 1.0) * 0.1
  }
}

scenario steady "Homogeneous steady state" {
  set u = 1.0
  set v = 3.0
}

scenario singleSpot "Single perturbation" {
  set u = 1.0
  set v = 3.0
  spot u at lon=0, lat=0, radius=0.12, amount=0.6
}

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
`;

export const pipeline = compileV2(pipelineDsl);
