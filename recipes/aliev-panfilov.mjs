// Aliev-Panfilov (1996) — modified FitzHugh-Nagumo tuned to cardiac
// action potentials. Same archetype as FN — fast excitable u, slow
// recovery v — but the recovery rate ε(u, v) is itself state-dependent:
//
//   du/dt = −k · u · (u − a) · (u − 1) − u · v + D · ∇²u
//   dv/dt = ε(u, v) · (−v − k · u · (u − a − 1))
//   ε(u, v) = ε₀ + μ₁ · v / (u + μ₂)
//
// State-dependent ε reproduces two observations from cardiac tissue
// that plain FN misses: the *restitution curve* (action-potential
// duration depends on the preceding rest interval) and *curvature
// dispersion* (sharply curved wavefronts propagate slower). Together
// these effects are what makes a single break in a plane wave evolve
// into the self-sustaining spiral rotor that's the canonical model
// of cardiac fibrillation.
//
// Ship the reentry scenario by default — it produces a clean spiral
// rotor over the full sphere within ~5 wall-seconds.

import { compileV2 } from "../dsl/compile-v2.mjs";

export const overlays = [];

export const metrics = [
  { id: "meanU",   label: "MEAN U",  source: "dsl:meanU",   spark: true, precision: 3 },
  { id: "active",  label: "DEPOL",   source: "dsl:active",  spark: true, precision: 0 },
  { id: "rotors",  label: "ROTORS",  source: "dsl:rotors",  mini: true,  precision: 0 },
  { id: "fps",     label: "FPS",     source: "fps",          mini: true },
];

export const regime = {
  silent:       {},
  intermittent: { active: 50 },
  active:       { active: 500 },
  runaway:      { active: 5000 },
};

export const pipelineDsl = `
recipe "Aliev-Panfilov (cardiac)"
summary "Cardiac action-potential model — modified FitzHugh-Nagumo where the recovery rate ε(u,v) depends on local state. The state-dependence reproduces restitution and curvature dispersion, which together turn a single plane-wave break into a self-sustaining spiral rotor — the canonical mathematical model of cardiac fibrillation. Try the REENTRY preset: a half-plane wave with a refractory shadow, watch a single rotor pin, multiply, and tile the sphere."
recommendedPreset reentry

substrate geodesic frequency 64

field u: f32
field v: f32

palette U_RAMP {
  stop 0 color [16, 14, 18]
  stop 1 color [255, 220, 80]
}

palette V_RAMP {
  stop 0 color [12, 18, 32]
  stop 1 color [200, 90, 110]
}

view u "Membrane (u)"  { color ramp u range [0, 1]   palette U_RAMP }
view v "Recovery (v)"  { color ramp v range [0, 2.5] palette V_RAMP }

param simRateHz slider 0..360  step 1     default 60    label "SIM RATE"
param rate      slider 1..120  step 1     default 30    label "RATE"
param a         slider 0..0.3  step 0.005 default 0.05  label "a (THRESH)"
param k         slider 0..16   step 0.1   default 8     label "k (KINETIC)"
param eps0      slider 0..0.05 step 0.0005 default 0.002 label "ε₀"
param mu1       slider 0..0.5  step 0.005 default 0.20  label "μ₁"
param mu2       slider 0.05..1 step 0.01  default 0.30  label "μ₂"
param diffusion slider 0..0.1  step 0.001 default 0.020 label "DIFF"

stamp shock "Defibrillator pulse" {
  spot u at brush.pos, radius=brush.r, amount=1
}

stamp pad "Refractory pad" {
  spot v at brush.pos, radius=brush.r, amount=0.6
}

scenario reentry "Spiral rotor seed (broken plane wave)" {
  // Eastern half of sphere is depolarized; an equatorial band of
  // refractory tissue on the same half blocks part of the wavefront.
  // The break in the front evolves into a rotating spiral whose
  // tip sits where the refractory shadow ends.
  set u = 0
  set v = 0
  region u at lonMin=-PI, lonMax=0, latMin=-PI/2, latMax=PI/2, amount=1
  region v at lonMin=-PI, lonMax=0, latMin=-0.4, latMax=0.4,  amount=0.6
}

scenario blank "Resting tissue" {
  set u = 0
  set v = 0
}

scenario front "Plane wave (no break)" {
  // A clean north-south plane wave sweeping eastward — no spiral
  // forms; the wave just travels around the sphere and self-collides
  // at the antipode.
  set u = 0
  set v = 0
  region u at lonMin=-0.2, lonMax=0.2, latMin=-PI/2, latMax=PI/2, amount=1
}

scenario chaos "Random initial depolarization" {
  // High-noise start — multiple rotors nucleate, drift, annihilate,
  // and tile the sphere with a tangle of spirals. "Fibrillation"
  // looks like this.
  set v = 0
  for each cell {
    let r = cellRand(7)
    set u = r * r
  }
}

step {
  stage diffuseU "Diffuse u (the fast cardiac wave; v stays local)" {
    reads u
    writes u
    cell {
      add u = (mean n in neighbors { u@n } - u) * clamp(diffusion * 0.16 * dt * rate, 0, 0.24)
    }
  }

  stage react "Aliev-Panfilov reaction" {
    reads u, v
    writes u, v
    cell {
      // Cubic excitation gate — fires when u clears the threshold a,
      // self-suppresses near u = 1.
      let cubic = k * u * (u - a) * (u - 1)
      // State-dependent recovery rate. μ₂ never reaches 0 (slider
      // floor is 0.05) so the denominator stays well-defined.
      let eps = eps0 + mu1 * v / (u + mu2)
      add u = (-cubic - u * v) * dt * rate
      add v = eps * (-v - k * u * (u - a - 1)) * dt * rate
    }
  }

  stage clampSafe "Stay in physiological envelope" {
    reads u, v
    writes u, v
    cell {
      set u = clamp(u, -0.1, 1.4)
      set v = clamp(v, -0.1, 2.5)
    }
  }
}

metric meanU  = mean cells { u }
// "DEPOL" — cells in the depolarized phase. The total roughly tracks
// the wave area; sustained nonzero values mean rotors persist.
metric active = count cells where u > 0.3
// "ROTORS" — cells inside the wave's leading edge (intermediate u),
// a rough proxy for rotor count.
metric rotors = count cells where u > 0.15 and u < 0.4
`;

export const pipeline = compileV2(pipelineDsl);
