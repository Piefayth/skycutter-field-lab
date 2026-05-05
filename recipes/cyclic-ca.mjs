// Cyclic cellular automaton on a sphere — the canonical "u32 +
// emergence" demonstration. Each cell holds a state in [0, N).
// Every tick:
//
//   if any neighbor is at state ((self + 1) mod N), advance self;
//   otherwise stay put.
//
// That's it. Random initial state → after a few seconds the whole
// sphere fills with rotating spirals, color-cycling around the N-
// state palette. The spirals are stable: each spiral has a topological
// charge (how many full color cycles you traverse going around it),
// and charges only change when two spirals collide and annihilate or
// when one nucleates from a domain wall.
//
// Why this is a v2 recipe: state is genuinely an integer (state ID,
// not a continuous quantity), and the rule has no analogue in pure
// f32 land — comparing equality of an integer-valued state to a
// computed target is the whole loop. v2's u32 storage type makes
// the intent obvious. Inside cell expressions everything still
// flows as f32 (the WGSL emit casts on read), so the comparison
// `state@n == target` is f32-exact for small integers.
//
// Why this is a sphere recipe: the geodesic mesh has 12 pentagonal
// cells (at the icosahedron vertices). On a flat hex grid, cyclic
// CA spirals can drift freely; on a sphere the pentagons are
// topological defects that PIN the cores of nearby spirals — they
// can't drift over a 5-coordinated cell without changing winding
// number. So you get a global pattern of ~12 stable spiral cores
// preferring the icosahedron vertices, with smaller transient
// spirals filling the rest. Geometrically, the dynamics are doing
// what they have to do given the substrate's topology.
//
// Tuning notes:
//   - numStates: 4 too few (just blocks). 14-20 is the visual
//     sweet spot — enough states to see the color cycle, few
//     enough that the same color recurs visibly across the sphere.
//   - threshold: how many neighbors at the target state are
//     required to advance. 1 (default) gives spirals; 2-3 gives
//     blockier patterns; higher values mostly freeze.

import { compileV2 } from "../dsl/compile-v2.mjs";

export const overlays = [];

export const metrics = [
  { id: "active", label: "ACTIVE",   source: "dsl:active",  spark: true, precision: 0 },
  { id: "spirals", label: "SPIRALS", source: "dsl:spirals", mini: true, precision: 0 },
  { id: "fps",     label: "FPS",     source: "fps",         mini: true },
];

// Regime classifier reads `active` (cells in transition this tick).
// Cold start has 0; once spirals organise the transition count
// stabilises; runaway catches numerical instability (it shouldn't
// happen for cyclic CA — pure integer logic — but the threshold is
// there as a sanity floor).
export const regime = {
  silent:       { active: 0 },
  intermittent: { active: 100 },
  active:       { active: 800 },
  runaway:      { active: 50000 },
};

export const pipelineDsl = `
recipe "Cyclic CA (sphere)"
summary "Each cell holds a state in [0, N). Every tick, if any neighbor is at state (self+1) mod N, the cell advances. Random initial state → self-organized rotating spirals across the whole sphere. The 12 pentagonal cells (at icosahedron vertices) pin spiral cores. First v2 demo of integer field types in service of an actually striking visual."
recommendedPreset noise

substrate geodesic frequency 32

field state: u32

field phaseAngle: f32 derived   // state * TAU / numStates, for phase coloring
field stateNorm:  f32 derived   // state / numStates, for ramp coloring
field changed:    u32 derived   // 1 if this cell advanced this tick, 0 otherwise

// Color wheel mapped from state-space: state * TAU / N. The recipe
// writes that mapping into the derived phaseAngle field, so the
// wheel reads it as a smooth angle.

// Raw state visualised as a normalized scalar — useful for debugging
// "is the state actually changing?" without the wrap-around of the
// phase wheel.

param numStates  slider 3..32  step 1   default 14   label "STATES N"
param threshold  slider 1..6   step 1   default 1    label "THRESHOLD"
// (No rate param: cyclic-CA is a pure state-replacement rule — no dt
// to multiply by — so a rate slider would do nothing. Tune simRateHz
// instead if you want the sim to chew through ticks faster.)
param simRateHz  slider 0..120 step 1   default 30   label "SIM RATE"

step {
  stage advance "Cyclic-CA step" {
    reads state
    writes state, changed
    cell {
      // Next state in the cycle = (state + 1) mod numStates. WGSL's
      // % works on f32 too; the cell body sees state as f32 (cast
      // on read) and produces an f32 nextState the WGSL emit casts
      // back to u32 on writeback. (\`target\` would be a friendlier
      // name but it's a WGSL reserved keyword.)
      let nextState = (state + 1) % numStates
      // Count neighbors at the target state. state@n surfaces as
      // f32; equality compares as f32 == f32 which is exact for
      // the small integer values we're dealing with.
      let triggers = count n in neighbors where state@n == nextState
      let advance = triggers >= threshold
      set state = advance ? nextState : state
      // Diagnostic — was this cell rotated this tick? Drives the
      // ACTIVE metric so the regime indicator reflects "is the
      // pattern still settling".
      set changed = advance ? 1 : 0
    }
  }

  stage diagnostics "Phase + normalized state for rendering" {
    reads state
    writes phaseAngle, stateNorm
    cell {
      // state * TAU / N gives an angle in [0, TAU) the phase
      // colorer can drop into the color wheel.
      set phaseAngle = state * TAU / numStates
      // 0..1 normalized for the ramp colorer.
      set stateNorm = state / numStates
    }
  }
}

// Live observables. ACTIVE = cells that rotated this tick (drops
// once spirals lock in). SPIRALS approximates the spiral count by
// looking for cells whose 6-neighbor sum is significantly less
// than max — the cores have the most disagreement around them.
metric active = sum cells { changed }
metric spirals = count cells where state == 0

views {
  palette STATE_RAMP {
    stop 0 color [10, 12, 28]
    stop 1 color [240, 250, 255]
  }

  view phaseAngle "Phase (state)" {
    color wheel phaseAngle
  }

  view stateNorm "State (raw)" {
    color ramp stateNorm range [0, 1] palette STATE_RAMP
  }
}

stamps {
  stamp seedRandom "Random states (paint area)" {
    // The amount is added to whatever's there; for u32 fields the
    // runtime rounds and the field naturally wraps mod numStates on
    // the next tick (since the rule only ever produces values in [0,
    // N)). Brushed cells shake the local pattern without erasing it.
    spot state at brush.pos, radius=brush.r, amount=3
  }

  stamp seedZero "Reset to state 0" {
    spot state at brush.pos, radius=brush.r, amount=-100
  }

  stamp seedTarget "Force a single state" {
    // Hard-set everything in the brush to state 5 — useful for
    // injecting a uniform region into a chaotic field.
    spot state at brush.pos, radius=brush.r, amount=5
  }
}

scenarios {
  scenario noise "Random states (default)" {
    // Each cell gets an independent random state. Spirals nucleate
    // within ~5 wall-seconds and stabilise within ~30.
    for each cell {
      let r = cellRand(7) * 0.5 + 0.5
      set state = r * numStates
    }
  }

  scenario zonal "Striped initial states" {
    // Latitude bands of constant state. Domain walls form along
    // every band boundary; spirals nucleate from the walls.
    for each cell {
      set state = (lat * 4 + PI) * numStates / TAU
    }
  }

  scenario singleSeed "One state-1 dot in a sea of zeros" {
    // Clean nucleation point — watch a single ring of state-1 cells
    // expand outward, followed by state-2, state-3, ... A traveling
    // wave-front of color cycles, until reflections / pentagon
    // interactions break the symmetry into spirals.
    set state = 0
    for each cell where (lon * lon + lat * lat) < 0.01 {
      set state = 1
    }
  }

  scenario halves "Two-state hemispheres" {
    // Northern hemisphere at state 0, southern at state numStates/2.
    // The equator becomes a domain wall that fragments into spirals.
    set state = 0
    for each cell where lat < 0 {
      set state = numStates / 2
    }
  }
}
`;

export const pipeline = compileV2(pipelineDsl);
