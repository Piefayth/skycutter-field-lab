// Toner-Tu (1995) — continuous-density flocking. Long-range orientational
// order in a 2D dynamical XY model — i.e. the hydrodynamic equations
// that birds (or fish, or self-propelled particles) flow under.
//
// Two fields: density ρ and velocity v (a vec2). The dynamics:
//
//   ∂ρ/∂t + ∇·(ρv) = 0                          (mass conservation)
//   ∂v/∂t = (α − β|v|²)v − c²·∇ρ + D·∇²v − ζv  (momentum)
//
// Self-propulsion + saturation: `(α − β|v|²)v` drives velocity toward
// magnitude √(α/β). When |v| < √(α/β) the term is positive (pumps
// energy in); when |v| > √(α/β) the term is negative (saturates).
// The result: every cell is "trying" to move at a preferred speed
// without external forcing.
//
// Pressure gradient `−c²·∇ρ` smooths density fluctuations. Viscosity
// `D·∇²v` aligns neighbours. Friction `−ζv` bleeds excess energy to
// keep the integrator stable.
//
// Compared to Vicsek: Toner-Tu is the *continuum limit* of Vicsek-
// style alignment. Vicsek has discrete particles aligning to neighbour
// orientations; Toner-Tu has a continuous velocity field whose
// magnitude AND direction self-organise. Density can vary, so the
// recipe famously produces "giant number fluctuations" — long-lived
// dense bands that shouldn't exist in equilibrium statistical
// mechanics but do in active matter.
//
// We omit the convective derivative (v·∇)v from the momentum
// equation — it's the term that gives Toner-Tu its true vector
// conservation law character but it requires a tensor-gradient
// primitive we don't expose. The simplification keeps the polarised-
// flocking and density-banding behaviour while reducing to a model
// expressible in current v2.

import { compileV2 } from "../dsl/compile-v2.mjs";

export const overlays = [];

export const metrics = [
  { id: "polarOrder", label: "POLAR",   source: "dsl:polarOrder", spark: true, precision: 3 },
  { id: "speedMax",   label: "MAX |v|", source: "dsl:speedMax",   spark: true, precision: 3 },
  { id: "rhoMax",     label: "MAX ρ",   source: "dsl:rhoMax",     mini: true,  precision: 3 },
  { id: "rhoMin",     label: "MIN ρ",   source: "dsl:rhoMin",     mini: true,  precision: 3 },
  { id: "fps",        label: "FPS",     source: "fps",            mini: true },
];

export const regime = {
  silent:       { polarOrder: 0 },
  intermittent: { polarOrder: 0.2 },
  active:       { polarOrder: 0.6 },
  runaway:      { polarOrder: 0.95 },
};

export const pipelineDsl = `
recipe "Toner-Tu flocking"
summary "Continuum limit of Vicsek-style flocking. Velocity v is self-propelled toward magnitude √(α/β); density ρ is conserved by ∇·(ρv); pressure smooths density bunching, viscosity aligns neighbours. Below the critical noise the whole sphere polarises into a single global flow direction with persistent dense bands (Toner-Tu's giant number fluctuations); above it, flow is turbulent. The continuous-density alternative to the Vicsek-flock recipe."
recommendedPreset eastward

substrate geodesic frequency 48

field rho:  f32                    // density
field v:    vec2                    // velocity
field flux: vec2 derived            // ρ·v for the continuity divergence
field speed: f32 derived            // |v| for visualization + metrics

param simRateHz slider 0..360 step 1     default 60   label "SIM RATE"
// rate is a scalar multiplier on dt — NOT real substepping — so big
// rate values blow the explicit integrator's CFL bound. Stable
// envelope at default CS2/DIFF is rate ≤ 1; if you crank CS2 down
// near zero you can push rate to ~4. The slider goes higher for
// experimentation but density runaway (visible as both clamp bounds
// pinned) starts immediately past rate ~2.
param rate      slider 1..40  step 1     default 1    label "RATE"
param ALPHA     slider 0..3   step 0.05  default 1.2  label "α (DRIVE)"
param BETA      slider 0..3   step 0.05  default 1.0  label "β (SATURATE)"
// Sound speed²: density variations propagate at speed √(c² · ρ).
// Higher c² means stronger / faster pressure response — but explicit
// pressure with no projection step is the integrator's tightest CFL
// bound. 0.10 at rate=1 is the working sweet spot: visible density
// bands, mass conserved. Crank past ~0.2 and density runs into the
// rho_max=8 clamp within seconds.
param CS2       slider 0..2   step 0.02  default 0.10 label "c² (PRESSURE)"
param DIFF      slider 0..0.5 step 0.01  default 0.10 label "D (VISCOSITY)"
param FRICTION  slider 0..1   step 0.01  default 0.20 label "ζ (FRICTION)"
param NOISE     slider 0..0.5 step 0.005 default 0.05 label "η (NOISE)"

step {
  // Stage 1 — Density flux for the continuity equation. ρ·v lands
  // in a derived vec2 field so the next stage can take its
  // divergence (validator forbids let-locals inside divergence args).
  stage flux "Compute mass flux ρ·v" {
    reads rho, v
    writes flux
    cell {
      set flux = vec2(rho * v.x, rho * v.y)
    }
  }

  // Stage 2 — Continuity: ∂ρ/∂t = -∇·(ρv). Mass is exactly
  // conserved at the operator level on a closed sphere; the rhoMin
  // floor catches numerical drift if the explicit integrator
  // overshoots near a near-zero-density region.
  stage continuity "Density continuity" {
    reads rho, flux
    writes rho
    cell {
      add rho = -divergence(flux) * dt * rate
    }
  }

  // Stage 3 — Momentum. (α − β|v|²)v drives self-propulsion;
  // pressure ∝ −∇ρ; viscosity smooths velocity (graph-Laplacian
  // form on the vec2 field directly); friction bleeds energy;
  // η·random kick provides the noise floor that's the order
  // parameter of the Vicsek-flock transition.
  stage momentum "Velocity update" {
    reads rho, v
    writes v
    cell {
      let speed2 = v.x * v.x + v.y * v.y
      let drive  = ALPHA - BETA * speed2
      let visc   = (mean n in neighbors { v@n } - v) * DIFF
      let press  = gradient(rho)
      // Independent random kicks per component. cellRand returns
      // [-1, 1], so multiplying by NOISE directly gives the symmetric
      // ±NOISE range we want — no biased shift.
      let nx = cellRand(frame) * NOISE
      let ny = cellRand(frame * 17 + 3) * NOISE
      let dvx = (drive * v.x - CS2 * press.x - FRICTION * v.x + visc.x + nx) * dt * rate
      let dvy = (drive * v.y - CS2 * press.y - FRICTION * v.y + visc.y + ny) * dt * rate
      add v = vec2(dvx, dvy)
    }
  }

  stage diagnostics "Compute |v| for visualization + metrics" {
    reads v
    writes speed
    cell {
      set speed = length(v)
    }
  }

  stage clampPos "Density floor + speed cap (numerical safety)" {
    reads rho, v
    writes rho, v
    cell {
      set rho = clamp(rho, 0.05, 8)
      set v   = vec2(clamp(v.x, -3, 3), clamp(v.y, -3, 3))
    }
  }
}

// Polar order parameter: the sphere-averaged velocity magnitude. 1.0
// when every cell points the same direction, 0 when fully turbulent.
metric polarOrder = mean cells { speed }
metric speedMax   = max  cells { speed }
metric rhoMax     = max  cells { rho }
metric rhoMin     = min  cells { rho }

views {
  palette DENSITY {
    stop 0   color [16, 18, 32]
    stop 0.5 color [120, 140, 200]
    stop 1   color [255, 240, 200]
  }

  palette SPEED {
    stop 0 color [8, 12, 22]
    stop 1 color [255, 180, 70]
  }

  // Primary view: speed magnitude with arrow glyphs for direction.
  // Coherent flocks: bright arrows pointing the same way; turbulent
  // regions: random colors, scattered orientations.
  view flow "Flow (speed + direction)" {
    color ramp speed range [0, 1.5] palette SPEED
    glyph "→" rotate=v length=0.6 stride=2
  }

  view density "Density" {
    color ramp rho range [0, 3] palette DENSITY
  }

  view directions "Direction wheel" {
    color wheel speed range [0, 1.5]
    glyph "→" rotate=v length=0.5 stride=3
  }
}

stamps {
  stamp pulse "Density pulse" {
    spot rho at brush.pos, radius=brush.r, amount=0.5
  }

  stamp shove "Push velocity east" {
    spot v at brush.pos, radius=brush.r, amount=vec2(0.5, 0)
  }

  stamp swirl "Swirl velocity" {
    spot v at brush.pos, radius=brush.r, amount=vec2(0, 0.5)
  }
}

scenarios {
  scenario noisy "Random initial velocities (default)" {
    // Each cell gets a random direction at ~unit speed. The
    // alignment dynamics will polarise the whole sphere over
    // 10-30 wall-seconds at default noise; cranking NOISE past
    // ~0.25 keeps it permanently turbulent. Lower CS2 from the
    // recipe default 0.10 to 0.05 — random initial velocities
    // produce large divergence and the explicit-Euler pressure
    // term stresses the integrator at the default pressure.
    param CS2 = 0.05
    set rho = 1
    for each cell {
      let theta = cellRand(7) * 2 * PI
      set v = vec2(cos(theta) * 0.5, sin(theta) * 0.5)
    }
  }

  scenario quiet "Quiescent" {
    // No motion, uniform density. Noise alone slowly nucleates
    // flow regions.
    set rho = 1
    set v = vec2(0, 0)
  }

  scenario eastward "Pre-aligned eastward flow" {
    // Already-polarised state. Density bands form spontaneously
    // under the giant-number-fluctuations dynamics.
    set rho = 1
    set v = vec2(0.8, 0)
  }

  scenario denseCore "Dense pile + ambient flow" {
    // A high-density patch radiates outward as the pressure gradient
    // pushes it. Combined with the self-propulsion drive, the patch
    // fragments into traveling bands. The dense patch produces
    // strong gradients; lower CS2 keeps the pressure response in
    // the integrator-stable range while still letting the patch
    // drive flow.
    param CS2 = 0.05
    set rho = 0.8
    set v = vec2(0, 0)
    spot rho at lon=0, lat=0, radius=0.4, amount=1.5
  }
}
`;

export const pipeline = compileV2(pipelineDsl);
