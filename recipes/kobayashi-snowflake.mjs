// Kobayashi (1993) — anisotropic phase-field for dendritic crystal growth.
//
// Two coupled fields evolve together: a phase order parameter `p` ∈ [0, 1]
// (0 = liquid, 1 = solid) and a dimensionless undercooling `T`. The
// solid invades the liquid where `p` crosses 0.5, releasing latent
// heat that warms the surrounding liquid (`K * dp/dt` term in dT/dt).
// That warmer liquid resists further freezing, slowing growth — except
// at protrusions, where curvature reduces the local heat sink and the
// front bulges further. That feedback creates the dendritic instability.
//
// The anisotropy that turns generic dendrites into proper snowflake
// branches comes from `ε(θ) = ε₀ · (1 + δ · cos(j·θ))`, where θ is the
// angle of the phase gradient — i.e. the local "interface normal."
// At j=6 the surface tension is six-fold symmetric, so growth fronts
// preferentially align with one of six directions. Drop a seed and a
// hexagonal snowflake emerges.
//
// Equations (per cell):
//   τ · ∂p/∂t = ∇·(ε(θ)² ∇p) + p(1 − p)(p − ½ + m(T))
//   ∂T/∂t    = ∇²T + K · ∂p/∂t
//   m(T)     = (α/π) · atan(γ(T_eq − T))
//
// On a sphere: same dynamics, six-fold-symmetric snowflakes pinned to
// the icosphere's orientation. The anisotropic flux `ε² ∇p` is computed
// into a derived vec2 field so the second stage can take its
// divergence — the validator forbids stencil-builtin args from
// referencing let-locals.

import { compileV2 } from "../dsl/compile-v2.mjs";

export const overlays = [];

export const metrics = [
  { id: "solidArea", label: "SOLID",   source: "dsl:solidArea", spark: true, precision: 0 },
  { id: "meanT",     label: "MEAN T",  source: "dsl:meanT",     spark: true, precision: 3 },
  { id: "fps",       label: "FPS",     source: "fps",           mini: true },
];

export const regime = {
  silent:       {},
  intermittent: { solidArea: 5 },
  active:       { solidArea: 200 },
  runaway:      { solidArea: 30000 },
};

export const pipelineDsl = `
recipe "Kobayashi snowflake"
summary "Anisotropic phase-field crystal growth — Kobayashi (1993). A solid seed releases latent heat that warms the surrounding liquid; protrusions cool faster than concavities so the front becomes unstable, and the six-fold ε(θ) anisotropy locks the resulting dendrites into snowflake branches. Drop a single seed and watch a hexagonal snowflake grow on the sphere over ~30 wall-seconds."
recommendedPreset nucleus

substrate geodesic frequency 64

const epsBar = 0.012
const Teq    = 0.0

field p: f32                     // phase: 0 = liquid, 1 = solid
field T: f32                     // dimensionless undercooling
field flux: vec2 derived         // ε(θ)²·∇p — written by stage, read by divergence

param simRateHz   slider 0..360 step 1     default 60   label "SIM RATE"
// rate slider tops out at 10 because the phase-field equation is stiff
// (τ ≪ 1, latent heat couples back into T, anisotropic flux is
// nonlinear in ∇p). At rate ≳ 12 the explicit integrator blows T to
// ±1e27 within a few hundred ticks. Default 4 has dt_eff/τ ≈ 0.67,
// already aggressive but stable.
param rate        slider 1..10  step 1     default 4    label "RATE"
param tau         slider 0.01..0.2 step 0.005 default 0.05 label "τ (PHASE)"
param ANIS_DELTA  slider 0..0.10 step 0.002 default 0.04 label "ANISOTROPY δ"
param ANIS_J      slider 2..8   step 1     default 6    label "SYMMETRY j"
param COUPLING    slider 0..3   step 0.05  default 1.6  label "K (LATENT)"
param ALPHA       slider 0.1..2 step 0.05  default 0.9  label "α (DRIVE)"
param GAMMA       slider 1..30  step 0.5   default 10   label "γ (SHARPNESS)"
param diffusionT  slider 0..1   step 0.01  default 0.5  label "DIFF T"

step {
  // Stage 1 — Compute the anisotropic flux ε(θ)² ∇p as a derived
  // vec2 field. The validator forbids let-locals inside divergence(...)
  // arguments, so we have to land the flux in a real field before the
  // next stage takes its divergence.
  stage flux "Anisotropic flux ε(θ)²·∇p" {
    reads p
    writes flux
    cell {
      let gp    = gradient(p)
      let theta = atan2(gp.y, gp.x)
      let eps   = epsBar * (1 + ANIS_DELTA * cos(ANIS_J * theta))
      let eps2  = eps * eps
      set flux = vec2(eps2 * gp.x, eps2 * gp.y)
    }
  }

  // Stage 2 — Phase + temperature update. The phase term is stiff
  // (τ ≪ 1), which is why rate sits in the single digits — dt_eff/τ
  // approaches 1 quickly if you crank rate up.
  stage update "Phase-field + temperature update" {
    reads p, T, flux
    writes p, T
    cell {
      let lapT     = (mean n in neighbors { T@n } - T) * 6
      let divFlux  = divergence(flux)
      // m(T): saturating drive toward solid when T < Teq, toward
      // liquid when T > Teq. atan2(x, 1) = atan(x) — the math-fn
      // catalog has atan2 but not bare atan.
      let mt       = (ALPHA / PI) * atan2(GAMMA * (Teq - T), 1.0)
      let phaseRhs = divFlux + p * (1 - p) * (p - 0.5 + mt)
      let dpdt     = phaseRhs / tau
      add p = dpdt * dt * rate
      add T = (diffusionT * lapT + COUPLING * dpdt) * dt * rate
    }
  }

  stage clampPhase "Clamp p to [0, 1]" {
    reads p
    writes p
    cell { set p = clamp(p, 0, 1) }
  }
}

metric solidArea = count cells where p > 0.5
metric meanT     = mean cells { T }

views {
  // Phase: liquid → mid-blue → solid white. Reads the solid front
  // sharply because the field is bistable around p = 0.5.
  palette ICE {
    stop 0    color [12, 18, 32]
    stop 0.45 color [60, 110, 180]
    stop 0.55 color [180, 210, 240]
    stop 1    color [240, 250, 255]
  }

  // Temperature: cold blue ← Teq=0 → warm red. The exotherm
  // released by the growing crystal shows up as a halo of warm
  // liquid around the solid front.
  palette HEAT {
    stop 0    color [40, 80, 220]
    stop 0.5  color [200, 200, 200]
    stop 1    color [240, 80, 40]
  }

  view phase "Phase (solid / liquid)" {
    color ramp p range [0, 1] palette ICE
  }

  view temp "Temperature" {
    color ramp T range [-0.5, 0.5] palette HEAT
  }
}

stamps {
  stamp seedSolid "Seed crystal" {
    spot p at brush.pos, radius=brush.r, amount=1
  }

  stamp coolPatch "Cool a patch" {
    spot T at brush.pos, radius=brush.r, amount=-0.4
  }
}

scenarios {
  scenario nucleus "Single seed crystal" {
    // One small solid seed in supercooled liquid (T = -0.3 means
    // 0.3 below freezing). Six-fold dendrite emerges around it.
    set p = 0
    set T = -0.3
    spot p at lon=0, lat=0, radius=0.05, amount=1
  }

  scenario triplet "Three seeds" {
    // Three seeds compete for thermal field — branches that meet
    // each other slow and the late-stage shape shows the boundary.
    set p = 0
    set T = -0.3
    spot p at lon=-1.5, lat=0.4,  radius=0.04, amount=1
    spot p at lon=1.5,  lat=-0.4, radius=0.04, amount=1
    spot p at lon=0,    lat=1.0,  radius=0.04, amount=1
  }

  scenario coldField "Deeply supercooled liquid" {
    // T uniformly very cold. Growth from a seed is fast because the
    // latent-heat barrier is small. Use to get a snowflake quickly,
    // at the cost of less branched detail.
    set p = 0
    set T = -0.6
    spot p at lon=0, lat=0, radius=0.04, amount=1
  }

  scenario warmField "Mildly supercooled — slow growth" {
    // T just below freezing. Growth is slow but produces fine branches.
    set p = 0
    set T = -0.15
    spot p at lon=0, lat=0, radius=0.05, amount=1
  }
}
`;

export const pipeline = compileV2(pipelineDsl);
