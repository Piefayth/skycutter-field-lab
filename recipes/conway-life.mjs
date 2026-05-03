// Hex Life on a sphere — generalized Game-of-Life with parameterized
// birth/survival rules.
//
// Conway's classic B3/S23 was tuned for an 8-neighbor square (Moore)
// grid. The geodesic mesh has 6 neighbors per cell (5 at the 12
// pentagonal cells), so the canonical rule kills almost everything
// in a few ticks — "exactly 3 alive neighbors" out of 6 is rare at
// random density. The hex-Life community has tuned rules that DO
// sustain activity on 6-neighbor tilings; B2/S34 ("Brian Prentice"-
// style) is one of the better-known ones. The recipe defaults to
// B2/S34 and exposes the birth and survival counts as sliders so
// you can sweep the rule space:
//
//   - birthMin / birthMax: dead cell becomes alive if alive neighbor
//     count is in [birthMin, birthMax].
//   - surviveMin / surviveMax: alive cell stays alive if alive
//     neighbor count is in [surviveMin, surviveMax].
//
// Sweep birthMin from 2 → 3 with surviveMin/Max at 2/3 to recover
// vanilla Conway B3/S23 (will mostly die). Sweep birthMin to 1 for
// flood-fill explosions. Try B2/S2345 for slowly-shifting blobs.
//
// Why this is a v2 recipe at all: Life needs an integer-valued
// state per cell. v2's `u32` field type stores it as native
// integers; inside expressions it surfaces as f32 (so arithmetic
// and comparisons compile), but the wire / readback / colorer all
// see u32. The WGSL emit is:
//   let v_state: f32 = f32(f_state[cell]);
//   ...
//   outputField[cell] = u32(round(outValue));
// — the cast happens at the storage boundary, not inside the cell.
//
// Stamps: paint random alive cells with NOISE; flick single cells
// with SEED; ERASE clears regions.

import { ramp } from "../prims/colorers.mjs";
import { compileV2 } from "../dsl/compile-v2.mjs";

export const views = [
  { id: "state", label: "Alive (state)", color: ramp("state", [10, 14, 28], [240, 250, 255], 1.0) },
];

export const overlays = [];

export const metrics = [
  { id: "alive", label: "ALIVE", source: "dsl:alive", spark: true, precision: 0 },
  { id: "ratio", label: "RATIO", source: "dsl:ratio", spark: true, precision: 3 },
  { id: "fps",   label: "FPS",   source: "fps",       mini: true },
];

// "Alive" cell count drives the regime indicator. The geodesic mesh
// at frequency 32 has ~6k cells, so "active" lights up around 5-15%
// alive (sparse but persistent). "Runaway" catches the flood-fill
// degenerate state where everything is alive.
export const regime = {
  silent:       { alive: 0 },
  intermittent: { alive: 50 },
  active:       { alive: 200 },
  runaway:      { alive: 4000 },
};

export const pipelineDsl = `
recipe "Hex Life (sphere)"
summary "Cellular automaton on a sphere. State is u32 (alive=1, dead=0); each tick counts alive neighbors and applies a configurable B/S rule. Default B2/S34 sustains activity on 6-neighbor hex tilings; sweep the rule sliders to find your own. The 12 pentagonal cells (at icosahedron vertices) put a permanent topological wrinkle in the dynamics. Demonstrates v2's u32 field type."
recommendedPreset noise

substrate geodesic frequency 32

field state: u32

param simRateHz   slider 0..120  step 1   default 30  label "SIM RATE"
param rate        slider 1..10   step 1   default 1   label "RATE"
param density     slider 0..1    step 0.01 default 0.45 label "INIT DENSITY"
// Rule parameters — birth window and survival window. Defaults:
// B2/S34. Vanilla Conway B3/S23 = (birth 3..3, survive 2..3) and
// dies fast on a hex mesh. B2/S35 makes shifting blobs; B1/S* is a
// flood explosion. Live-fiddle while running for the full feel.
param birthMin    slider 0..6   step 1   default 2   label "BIRTH MIN"
param birthMax    slider 0..6   step 1   default 2   label "BIRTH MAX"
param surviveMin  slider 0..6   step 1   default 3   label "SURVIVE MIN"
param surviveMax  slider 0..6   step 1   default 4   label "SURVIVE MAX"

stamp seed "Drop one alive cell" {
  spot state at brush.pos, radius=brush.r, amount=1
}

stamp noise "Random alive cells" {
  spot state at brush.pos, radius=brush.r, amount=1
}

stamp erase "Clear region" {
  spot state at brush.pos, radius=brush.r, amount=-100
}

scenario noise "Random alive cells (default)" {
  set state = 0
  for each cell where cellRand(11) > (1 - density * 2) {
    set state = 1
  }
}

scenario sparse "Sparse seed pattern" {
  set state = 0
  for each cell where cellRand(7) > 0.92 {
    set state = 1
  }
}

scenario empty "Empty board (paint your own)" {
  set state = 0
}

scenario stripes "Diagonal stripes" {
  // A patterned init that immediately starts decaying into Life
  // dynamics. Useful as a deterministic "did anything change?"
  // sanity check.
  set state = 0
  for each cell where sin(lon * 6 + lat * 6) > 0.7 {
    set state = 1
  }
}

step {
  stage life "Hex Life — parameterized B/S rule" {
    reads state
    writes state
    cell {
      // Count alive neighbors. state@n is u32 in storage, surfaces
      // as f32 in the cell body via the WGSL cast. The sum is an
      // f32 count we compare against the rule windows.
      let count = sum n in neighbors { state@n }
      // Bool checks split out so the conditional is readable. Each
      // window is a closed interval — birthMin..birthMax and
      // surviveMin..surviveMax. A cell becomes alive next tick if
      // either window matches its (alive, count) pair.
      let alive = state == 1
      let inBirthWindow = (count >= birthMin) and (count <= birthMax)
      let inSurviveWindow = (count >= surviveMin) and (count <= surviveMax)
      let nextAlive = (alive and inSurviveWindow) or ((not alive) and inBirthWindow)
      set state = nextAlive ? 1 : 0
    }
  }
}

// Live observables. count returns an integer; the metric reduction
// floors to f32 internally but the precision=0 metric format keeps
// it visually integer.
metric alive = count cells where state == 1
metric ratio = mean cells { state }
`;

export const pipeline = compileV2(pipelineDsl);
