// Conway's Game of Life on a sphere — the canonical cellular
// automaton. Each cell holds a single bit (alive=1, dead=0), and
// each tick:
//   - count alive neighbors
//   - alive cell with 2 or 3 neighbors stays alive
//   - dead cell with exactly 3 neighbors becomes alive
//   - all other cells die or stay dead
//
// Why this is a v2 recipe at all: Life needs an integer-valued state
// per cell. f32 storage technically works (0.0 / 1.0 are perfectly
// representable), but the *type* of the state is conceptually
// integer — neighbor counts, alive/dead transitions, no continuous
// range. v2's `u32` field type stores it as native integers and
// makes the cell-body intent obvious. Inside expressions the value
// surfaces as f32 (so arithmetic and comparisons compile), but the
// wire / readback / colorer all see u32. The WGSL emit is
//   let v_state: f32 = f32(f_state[cell]);
//   ...
//   outputField[cell] = u32(round(outValue));
// — the cast happens at the storage boundary, not inside the cell.
//
// Sphere caveat: the geodesic mesh has 12 pentagonal cells (at the
// 12 icosahedron vertices); every other cell has 6 neighbors. So
// "exactly 3 alive neighbors" is a slightly different rule near the
// pentagons than the canonical 2D-Life rule on a square grid. The
// recipe still produces classic Life-like dynamics (gliders that
// crawl, blinkers that flicker, big blobs that decay), but exact
// 2D-Life patterns won't survive transitioning across a pentagonal
// cell. That's what makes it interesting on a sphere — the topology
// is part of the dynamics.
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
recipe "Conway's Life (sphere)"
summary "Cellular automaton on a sphere. State is u32 (alive=1, dead=0); each tick counts alive neighbors and applies the standard B3/S23 rule. The 12 pentagonal cells (at icosahedron vertices) make the dynamics slightly different from flat 2D Life — gliders deform when they cross a pentagon. Demonstrates v2's u32 field type: integer storage, f32-on-read inside cell expressions, u32-on-write back to storage."
recommendedPreset noise

substrate geodesic frequency 32

field state: u32

param simRateHz slider 0..120  step 1   default 30  label "SIM RATE"
param rate      slider 1..10   step 1   default 1   label "RATE"
param density   slider 0..1    step 0.01 default 0.35 label "INIT DENSITY"

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
  stage life "Conway B3/S23" {
    reads state
    writes state
    cell {
      // Count alive neighbors. state@n is u32 in storage, surfaces as
      // f32 in the cell body via the WGSL cast — the sum produces a
      // float-valued count that compares cleanly against 2/3.
      let count = sum n in neighbors { state@n }
      // Standard Life rule, expressed as a single conditional on
      // (state, count). Result is 0 or 1; the WGSL emit casts the
      // f32 outValue to u32 on writeback.
      //   - dead cell, 3 alive neighbors → alive
      //   - alive cell, 2 or 3 alive neighbors → stays alive
      //   - everything else → dead
      let alive = state == 1
      let staysAlive = alive and (count == 2 or count == 3)
      let isBorn = (not alive) and count == 3
      set state = (staysAlive or isBorn) ? 1 : 0
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
