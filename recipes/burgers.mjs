// Burgers' equation — the simplest PDE that does shock formation.
//
//   ∂u/∂t + u · ∂u/∂x = ν · ∇²u
//
// In 1D this is the scalar conservation law where the field IS its
// own velocity: bigger u travels faster, so a profile with a positive
// gradient steepens at its leading edge. Without viscosity the
// gradient blows up to a discontinuity in finite time (the "shock");
// with ν > 0 the shock survives but stops being singular, and the
// shock thickness scales like ν / |Δu|.
//
// On the sphere we compute du/dx_east via gradient(u).x, treating the
// scalar field as if it advects itself eastward. The visual is one of
// the cleanest PDE demos around: smooth bumps roll east, steepen,
// merge with neighbors, and eventually anneal to a single dominant
// shock or decay viscously into the homogeneous state.
//
// Burgers turbulence (the noise scenario) — a tangled landscape of
// merging shocks where every two-shock collision spawns a single
// faster shock — is the prototype for understanding nonlinear PDE
// chaos and provides the exact analytical solution underneath KPZ
// surface growth.

import { compileV2 } from "../dsl/compile-v2.mjs";

export const overlays = [];

export const metrics = [
  { id: "peakU",    label: "PEAK U",   source: "dsl:peakU",    spark: true, precision: 3 },
  { id: "troughU",  label: "TROUGH U", source: "dsl:troughU",  spark: true, precision: 3 },
  { id: "active",   label: "ACTIVE",   source: "dsl:active",   mini: true,  precision: 0 },
  { id: "fps",      label: "FPS",      source: "fps",          mini: true },
];

export const regime = {
  silent:       {},
  intermittent: { active: 50 },
  active:       { active: 800 },
  runaway:      { active: 8000 },
};

export const pipelineDsl = `
recipe "Burgers' equation"
summary "Scalar self-advection — du/dt + u·du/dx = ν·∇²u — the simplest PDE that does shock formation. The field is its own velocity, so a smooth profile steepens at its leading edge as fast cells overrun slow ones. Without viscosity the gradient blows up to a discontinuity in finite time; with ν > 0 the shock survives as a smoothed front. The NOISE scenario produces 'Burgers turbulence' — a tangled landscape of merging shocks. Every two-shock collision spawns a single faster shock, so the field eventually anneals to a few dominant fronts (or decays viscously, depending on ν)."
recommendedPreset bump

substrate geodesic frequency 64

field u: f32

palette WAVE {
  stop 0    color [40, 90, 200]
  stop 0.45 color [200, 220, 240]
  stop 0.55 color [240, 220, 180]
  stop 1    color [200, 50, 30]
}

view u "Amplitude (u)" {
  color ramp u range [-1, 1] palette WAVE
}

param simRateHz slider 0..360 step 1     default 60   label "SIM RATE"
param rate      slider 1..200 step 1     default 30   label "RATE"
// Self-advection coupling. Physical Burgers has speed=1 (the field
// IS the velocity); we expose it as a knob so you can also dial in
// pure diffusion (speed=0) or aggressive shock formation. The 0.005
// scale factor inside the stage converts gradient-per-radian into a
// per-tick walk distance comparable to the cell size.
param speed     slider 0..2   step 0.05  default 1.0  label "SELF-ADVECT"
param viscosity slider 0..0.4 step 0.005 default 0.04 label "VISCOSITY ν"

stamp bump "Drop a bump" {
  spot u at brush.pos, radius=brush.r, amount=0.8
}

stamp dimple "Drop a dimple" {
  spot u at brush.pos, radius=brush.r, amount=-0.8
}

scenario bump "Single eastward bump" {
  // One Gaussian-flavoured ridge west of the prime meridian. Its
  // leading (east) edge has positive du/dx, so the ridge steepens
  // there and softens on the trailing edge — within ~5 wall-seconds
  // a clean shock front emerges.
  set u = 0
  spot u at lon=-1.2, lat=0, radius=0.22, amount=1
}

scenario sine "Sinusoidal initial profile" {
  // A 2-wavelength sinusoid in longitude — every quarter-period
  // becomes a shock candidate, so you get four quasi-stable fronts
  // that drift and slowly merge.
  set u = 0
  for each cell {
    set u = sin(lon * 2) * 0.6
  }
}

scenario noise "Burgers turbulence" {
  // Random initial profile — the canonical setup for studying
  // shock-merging dynamics. Many small fronts collide and coalesce
  // until just a handful of dominant shocks remain.
  set u = 0
  for each cell {
    set u = cellNoise(11, 0.8) * 1.2
  }
}

scenario blank "Flat" {
  set u = 0
}

step {
  stage advect "Self-advection: shocks form here" {
    reads u
    writes u
    cell {
      // gradient(u).x is du/dx_east (per radian). The 0.005 factor
      // converts to a per-tick advection comparable to a cell width
      // at frequency 64; cranking SELF-ADVECT past ~1.5 with low
      // viscosity will violate CFL and start producing spurious
      // oscillations near the steepest fronts.
      let g = gradient(u)
      add u = -u * g.x * speed * 0.005 * dt * rate
    }
  }

  stage diffuse "Viscous smoothing (sets shock thickness)" {
    reads u
    writes u
    cell {
      add u = (mean n in neighbors { u@n } - u) * clamp(viscosity * 0.16 * dt * rate, 0, 0.24)
    }
  }

  stage clampSafe "Cap amplitude (catches CFL violations)" {
    reads u
    writes u
    cell {
      set u = clamp(u, -2, 2)
    }
  }
}

metric peakU   = max cells { u }
metric troughU = min cells { u }
// "ACTIVE" — cells where the field is appreciably non-flat. Counts
// down as shocks dissipate; stays high in the noise scenario as long
// as multiple fronts coexist.
metric active  = count cells where abs(u) > 0.1
`;

export const pipeline = compileV2(pipelineDsl);
