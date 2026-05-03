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

// CFL: the cubic excitation term has effective relaxation rate ~k.
// Forward-Euler stability requires dt_eff·k < 2; defaults k=6, rate=10,
// dt=1/60 give dt_eff·k = 10/60·6 = 1.0 — safely below the bound.
// Cranking k past ~10 will start oscillating between u≈0 and u≈1
// each tick; drop rate proportionally (k=8 wants rate≤7).
//
// Wave speed scales as √(D·k). With D=0.04, k=6, that's ~0.49 sim-time
// units per radian — at rate=10 the wavefront crosses ~3 cells per
// real-time tick, slow enough to read but fast enough to traverse the
// sphere in ~10 wall-seconds.
param simRateHz slider 0..360  step 1     default 60    label "SIM RATE"
param rate      slider 1..30   step 1     default 10    label "RATE"
param a         slider 0..0.3  step 0.005 default 0.10  label "a (THRESH)"
param k         slider 0..12   step 0.1   default 6     label "k (KINETIC)"
param eps0      slider 0..0.05 step 0.0005 default 0.002 label "ε₀"
param mu1       slider 0..0.5  step 0.005 default 0.20  label "μ₁"
param mu2       slider 0.05..1 step 0.01  default 0.30  label "μ₂"
param diffusion slider 0..0.2  step 0.002 default 0.040 label "DIFF"

stamp shock "Defibrillator pulse" {
  spot u at brush.pos, radius=brush.r, amount=1
}

stamp pad "Refractory pad" {
  spot v at brush.pos, radius=brush.r, amount=0.6
}

scenario reentry "Spiral rotor seed (broken plane wave)" {
  // Thin north-south wavefront travelling east, with a half-domain
  // refractory block immediately ahead in the northern hemisphere.
  // The southern half of the front propagates into clean tissue;
  // the northern half hits refractory tissue and dies. The torn
  // front bends into the killed region as v decays there, forming
  // a phase singularity at the boundary — that's the spiral tip.
  //
  // Filling a large region with u=1 doesn't work — every cell starts
  // refractory-recovering simultaneously and the whole patch
  // collapses before any wavefront can spread. The trick is to seed
  // a *gradient*: u high on a thin strip, v already high in the
  // tissue you want the wave to die in.
  set u = 0
  set v = 0
  region u at lonMin=-0.4, lonMax=-0.2, latMin=-PI/2, latMax=PI/2, amount=1
  region v at lonMin=-0.2, lonMax=0.6,  latMin=0,     latMax=PI/2, amount=1.0
}

scenario blank "Resting tissue" {
  set u = 0
  set v = 0
}

scenario front "Plane wave (no break)" {
  // Clean north-south wavefront sweeping eastward — no spiral forms;
  // the wave travels around the sphere and self-collides at the
  // antipode. Same wavefront shape as REENTRY but without the
  // refractory shadow that would tear it.
  set u = 0
  set v = 0
  region u at lonMin=-0.4, lonMax=-0.2, latMin=-PI/2, latMax=PI/2, amount=1
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
