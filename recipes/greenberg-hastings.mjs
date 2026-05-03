// Greenberg-Hastings (1978) — the minimal cellular automaton model of
// excitable media. Each cell holds an integer phase ∈ [0, K). The
// transitions are deterministic and trivial:
//
//   - Phase 0 (resting):     stay at 0, unless any neighbour is in
//                            phase 1 (excited) — then move to phase 1.
//   - Phase 1 (excited):     advance to phase 2 unconditionally.
//   - Phases 2..K-1 (refractory): advance toward K, wrapping to 0.
//
// That's the entire rule. With K=4 you get target waves and rotating
// spirals (drop a partial wave, watch it close into a spiral),
// hexagonal-symmetry pinned to the icosphere's geometry. Cranking K
// stretches the refractory tail — longer recovery times mean wider
// spacing between successive wavefronts of the same spiral.
//
// Compared to recipes already in the catalog:
//   - cyclic-CA: same vibe (state machine on u32) but every cell
//     advances when its neighbour is at the *next* state — produces
//     interleaved spirals.
//   - FitzHugh-Nagumo: continuous excitable medium. Same emergent
//     behaviour (spiral waves) but f32 dynamics with a real refractory
//     timescale. Greenberg-Hastings is the discrete cartoon version.
//
// Why the geodesic: open-boundary planar excitable-media spirals can
// drift indefinitely; on a closed sphere they're topologically pinned
// and the 12 pentagonal cells anchor spiral cores naturally.

import { compileV2 } from "../dsl/compile-v2.mjs";

export const overlays = [];

// Greenberg-Hastings advances every cell through K phases each tick by
// design — the front sweeps through ~half the cells per step, so the
// stateNorm projection naturally has |Δ| ≈ 0.5 per tick. That's
// rotating wave propagation, not visual noise.
export const audit = {
  allowStrobe: true,
};

export const metrics = [
  { id: "excited",    label: "EXCITED",    source: "dsl:excited",    spark: true, precision: 0 },
  { id: "refractory", label: "REFRACTORY", source: "dsl:refractory", spark: true, precision: 0 },
  { id: "resting",    label: "RESTING",    source: "dsl:resting",    mini: true,  precision: 0 },
  { id: "fps",        label: "FPS",        source: "fps",            mini: true },
];

export const regime = {
  silent:       { excited: 0 },
  intermittent: { excited: 5 },
  active:       { excited: 100 },
  runaway:      { excited: 5000 },
};

export const pipelineDsl = `
recipe "Greenberg-Hastings excitable medium"
summary "Minimal CA model of excitable media. Each cell sits in one of K phases: 0 = resting, 1 = excited, 2..K-1 = refractory. Resting cells fire when any neighbour is excited; everything else marches forward through the refractory tail and back to rest. Drop a half-wave on the sphere and it closes into a rotating spiral pinned to a pentagonal cell. The discrete-state cousin of FitzHugh-Nagumo."
recommendedPreset wavefront

substrate geodesic frequency 48

field state: u32

field stateNorm:  f32 derived  // state / K, for the ramp colorer
field excitedF:   u32 derived  // 1 if state == 1, for metrics + a "fire only" view
field refractF:   u32 derived  // 1 if state in [2, K-1]

// Number of phases. K=4 is the textbook "excited + 2 refractory + rest"
// canon. Cranking K up stretches the refractory tail, slowing
// successive wavefronts.
param K           slider 3..16  step 1     default 4    label "PHASES K"
param simRateHz   slider 0..120 step 1     default 30   label "SIM RATE"

step {
  // Stage 1 — Apply the Greenberg-Hastings rule. Branches are
  // mutually exclusive on the previous-tick state.
  stage transition "GH transition" {
    reads state
    writes state
    cell {
      let isResting = state == 0
      let isExcited = state == 1
      // Any neighbour in the excited (1) state? Threshold 1 = "at
      // least one fires me up".
      let neighborFires = sum n in neighbors { (state@n == 1) ? 1 : 0 }
      let willFire = isResting && (neighborFires > 0)
      // Resting + neighbour-excited → 1. Excited or refractory →
      // (state + 1) mod K. Otherwise stay put. The ternary cascade
      // expresses the four cases as a single expression.
      let advanced = (state + 1) % K
      let next1 = isResting ? (willFire ? 1 : 0) : advanced
      set state = next1
    }
  }

  // Stage 2 — Diagnostic projections for views + metrics.
  stage diagnostics "Render projections" {
    reads state
    writes stateNorm, excitedF, refractF
    cell {
      set stateNorm = state / K
      set excitedF  = (state == 1) ? 1 : 0
      // Refractory is anything in [2, K-1]. state=0 (rest) and state=1
      // (excited) both miss; everything else hits.
      set refractF  = (state >= 2) ? 1 : 0
    }
  }
}

metric excited    = sum cells { excitedF }
metric refractory = sum cells { refractF }
metric resting    = count cells where state == 0

views {
  // Three-zone palette: resting (cold blue), excited (bright yellow),
  // refractory (graded purple → grey as the cell recovers). The
  // K=4 default puts excited at stateNorm=0.25, refractory at 0.5/0.75.
  palette EXCITE {
    stop 0    color [12, 18, 36]
    stop 0.2  color [60, 80, 140]
    stop 0.3  color [255, 230, 100]
    stop 0.5  color [180, 80, 160]
    stop 0.8  color [80, 50, 90]
    stop 1    color [40, 40, 60]
  }

  palette FIRE {
    stop 0 color [10, 12, 18]
    stop 1 color [255, 200, 60]
  }

  view phase "All phases" {
    color ramp stateNorm range [0, 1] palette EXCITE
  }

  view fronts "Active wavefronts" {
    color ramp excitedF range [0, 1] palette FIRE
  }
}

stamps {
  stamp ignite "Ignite (paint excited)" {
    // amount=1 lights the cell. If a cell is already excited (1)
    // adding 1 produces 2 (refractory), which is fine — the cell
    // continues marching through recovery.
    spot state at brush.pos, radius=brush.r, amount=1
  }

  stamp quench "Reset to rest" {
    // Negative amount drives state below 0; the writeback clamps to 0.
    spot state at brush.pos, radius=brush.r, amount=-100
  }
}

scenarios {
  scenario wavefront "Half-wave seed (default)" {
    // Lay down a single excited band across one hemisphere with a
    // refractory trail behind it. The open end of the band curls up
    // into a spiral whose tip pins to one of the 12 pentagonal cells.
    for each cell {
      let band = (lat > 0) && (lat < 0.4) && (lon > -0.5)
      set state = band ? 1 : 0
    }
    // Refractory wake — dampens propagation back across the seed.
    for each cell where (lat > 0.4) && (lat < 0.8) {
      set state = 2
    }
  }

  scenario triplePulse "Three excitation points" {
    // Three independent target-wave sources collide and interfere;
    // boundaries between the wavefronts produce extra spirals.
    set state = 0
    spot state at lon=0,    lat=0,    radius=0.04, amount=1
    spot state at lon=2.0,  lat=0.5,  radius=0.04, amount=1
    spot state at lon=-2.0, lat=-0.5, radius=0.04, amount=1
  }

  scenario blank "Quiescent" {
    // Pure rest. The medium is excitable but unexcited — paint with
    // the ignite stamp to start.
    set state = 0
  }

  scenario noise "Random refractory jumble" {
    // Each cell at a random phase. Most patterns dissipate but a
    // small fraction nucleate persistent spirals.
    for each cell {
      let r = cellRand(7) * 0.5 + 0.5
      set state = r * K
    }
  }
}
`;

export const pipeline = compileV2(pipelineDsl);
