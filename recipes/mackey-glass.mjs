// Mackey-Glass (1977) — the classical scalar time-delay differential
// equation that produces chaos from a single feedback loop:
//
//   dx/dt = β · x(t − τ) / (1 + x(t − τ)ⁿ) − γ · x
//
// In words: a saturating feedback that depends on x's value τ ticks
// ago (not the current value). The delay is the whole story — without
// it (τ = 0) the equation has a trivial fixed point. With τ large
// enough, the closed loop becomes long enough to support chaotic
// trajectories.
//
// On a per-cell basis each cell runs its own MG. The interesting
// twist on the sphere is adding diffusion — neighbouring cells
// exchange their CURRENT x but not their delayed x@prev(τ), so
// neighbours can synchronise their amplitude envelopes while keeping
// independent phase trajectories. With strong coupling the sphere
// locks; with weak coupling each patch chaoses at its own pace.
//
// τ is BAKED INTO THE RECIPE. The DSL requires the depth in
// `field@prev(N)` to be a parse-time integer (the buffer-rotation
// allocator decides depth at recipe-load), so we can't expose τ as a
// slider — varying it requires editing this file. The default τ = 4
// gives clean periodic oscillation per cell; τ = 8 (try editing the
// `let xDelayed = x@prev(N)` line) tips into chaos. The canonical
// chaotic regime is τ = 17 in continuous time; at our 60 Hz tick rate
// that's roughly 17 sim-time-units, which is a lot of buffer overhead.

import { compileV2 } from "../dsl/compile-v2.mjs";

export const overlays = [];

export const metrics = [
  { id: "meanX",   label: "MEAN x",  source: "dsl:meanX",   spark: true, precision: 3 },
  { id: "varX",    label: "VAR x",   source: "dsl:varX",    spark: true, precision: 3 },
  { id: "fps",     label: "FPS",     source: "fps",         mini: true },
];

export const regime = {
  silent:       { varX: 0 },
  intermittent: { varX: 0.005 },
  active:       { varX: 0.05 },
  runaway:      { varX: 1 },
};

export const pipelineDsl = `
recipe "Mackey-Glass delay-feedback"
summary "Classical scalar delay-differential equation: dx/dt = β·x(t−τ)/(1+x(t−τ)^n) − γ·x. Each sphere cell runs its own Mackey-Glass with delay τ ticks; neighbours diffuse their CURRENT x but not their delayed x@prev(τ), so amplitudes can synchronise while phases stay independent. The delay τ is fixed at recipe-load time (4 ticks at default settings); the canonical chaotic regime needs τ ~17 — try editing the @prev(4) call to a higher depth if you want full chaos."
recommendedPreset noisy

substrate geodesic frequency 32

field x: f32

// Local feedback gain. Higher β strengthens the delayed-feedback drive.
param BETA      slider 0..1     step 0.005 default 0.20  label "β (FEED)"
// Local damping. dx/dt has a -γx term that returns x toward zero in
// absence of feedback. β/γ ratio sets the equilibrium amplitude.
param GAMMA     slider 0..0.5   step 0.005 default 0.10  label "γ (DAMP)"
// Saturation exponent n. n = 10 is the canonical value; larger n
// makes the saturation curve sharper, smaller n smooths it out.
param N         slider 1..20    step 0.5   default 10    label "n (SATURATE)"
// Spatial diffusion of x. With Dx > 0 the per-cell trajectories
// pull on each other through the membrane.
param Dx        slider 0..0.3   step 0.005 default 0.05  label "D_x (DIFFUSE)"

param simRateHz slider 0..120   step 1     default 60    label "SIM RATE"
param rate      slider 1..40    step 1     default 10    label "RATE"

step {
  // History fields can only be written by one stage per tick (the
  // {prev, current, next} rotation stays consistent only if the
  // single writer deposits into "next" once). So both the diffusion
  // term and the delayed-feedback term live in one cell body.
  // The interesting dynamics are the @prev(4) read — the τ-tick lag
  // that produces the delay-differential behaviour. Without it the
  // equation collapses to dx/dt = (β − γ)·x — exponential decay or
  // growth, no oscillation.
  stage advance "Mackey-Glass step (delay feedback + diffusion)" {
    reads x
    writes x
    cell {
      // Diffusive coupling (current x, not delayed).
      let lap = mean n in neighbors { x@n } - x
      // Delay term: x as it was τ ticks ago.
      let xDelayed = x@prev(4)
      let drive = BETA * xDelayed / (1 + pow(xDelayed, N))
      add x = (drive - GAMMA * x + Dx * lap) * dt * rate
    }
  }
}

metric meanX = mean cells { x }
metric varX  = mean cells { x * x } - (mean cells { x }) * (mean cells { x })

views {
  palette MG {
    stop 0    color [12, 18, 32]
    stop 0.3  color [40, 90, 140]
    stop 0.6  color [220, 200, 80]
    stop 1    color [240, 100, 40]
  }

  view value "x" {
    color ramp x range [0, 1.5] palette MG
  }
}

stamps {
  stamp pulse "Inject pulse" {
    spot x at brush.pos, radius=brush.r, amount=0.5
  }

  stamp drain "Drain to zero" {
    spot x at brush.pos, radius=brush.r, amount=-2
  }
}

scenarios {
  scenario noisy "Random small perturbations (default)" {
    // Each cell starts near the canonical fixed point with a small
    // random kick — gives an initial trajectory each cell can
    // amplify through the delay loop.
    for each cell {
      let r = cellRand(11) * 0.5 + 0.5
      set x = 0.6 + r * 0.4
    }
  }

  scenario uniform "All cells at the steady-state fixed point" {
    // x* solves β/(1 + x*^n) = γ. With β=0.2, γ=0.1, n=10:
    // 0.2 = 0.1·(1 + x*^10), so x*^10 = 1, x* = 1. Setting all cells
    // exactly there means the only thing breaking symmetry is the
    // delayed-feedback eigenvalue — useful for clean Hopf demos.
    set x = 1
  }

  scenario hemisphere "Two-domain split" {
    // Northern hemisphere starts at low x, southern at high x. The
    // delay dynamics oscillate each region into its own attractor;
    // diffusion at the equator either smooths the boundary or lets
    // distinct phase patterns persist.
    for each cell {
      set x = lat > 0 ? 0.3 : 1.2
    }
  }
}
`;

export const pipeline = compileV2(pipelineDsl);
