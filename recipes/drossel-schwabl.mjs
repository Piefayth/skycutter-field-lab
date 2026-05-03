// Drossel-Schwabl (1992) — the canonical forest-fire cellular automaton
// and the textbook example of self-organised criticality. Each cell
// holds one of three states:
//
//   0 = empty   (bare ground)
//   1 = tree    (combustible)
//   2 = burning (will be empty next tick)
//
// Every tick:
//   - burning → empty (always)
//   - tree    → burning if any neighbor is burning
//   - tree    → burning with probability `f` (lightning)
//   - empty   → tree   with probability `p` (regrowth)
//
// The interesting parameter is the ratio p/f: when `p ≫ f` the lattice
// fills with trees between rare lightning strikes, so each strike clears
// a giant connected cluster — and the fire-size distribution is a power
// law. That self-organised criticality is what made the model a
// touchstone for SOC research in the 90s. Crank f up (or p down) and
// fires stay tiny; crank f to the floor and you get rare, sphere-spanning
// burn fronts.
//
// Why this is a v2 recipe: it's discrete state evolution that was
// awkward to express in the old f32-only DSL (you'd fake it with
// thresholds on a continuous activator field, and the rounding bias
// changed the dynamics). With a `u32` field and ternary expressions the
// rule reads almost like the literature definition.
//
// Why on a sphere: cluster percolation on the icosphere is genuinely
// different from a flat hex grid because of the 12 pentagonal
// 5-coordinated cells; you'll see fire fronts slow / split as they
// transit pentagons. The percolation threshold on the icosphere is
// close to but not identical to the planar value — easier to feel
// than to derive.

import { compileV2 } from "../dsl/compile-v2.mjs";

export const overlays = [];

export const metrics = [
  { id: "burning",  label: "BURNING", source: "dsl:burning",  spark: true, precision: 0 },
  { id: "trees",    label: "TREES",   source: "dsl:trees",    spark: true, precision: 0 },
  { id: "empty",    label: "EMPTY",   source: "dsl:empty",    mini: true,  precision: 0 },
  { id: "fps",      label: "FPS",     source: "fps",          mini: true },
];

// Active = currently burning. Silent = no fire at all (rare while p>0,
// but possible briefly between strikes). Runaway catches the
// sphere-spanning conflagration regime.
export const regime = {
  silent:       { burning: 0 },
  intermittent: { burning: 5 },
  active:       { burning: 80 },
  runaway:      { burning: 2000 },
};

export const pipelineDsl = `
recipe "Drossel-Schwabl forest fire"
summary "Canonical self-organised-criticality CA. Three states per cell — empty / tree / burning. Trees grow from empty cells with probability p; lightning ignites trees with probability f; burning cells spread to tree neighbours and become empty next tick. At small f and p≫f the fire-size distribution is a power law; this is the textbook example of SOC. Watch lightning strikes nucleate fire fronts that race across the sphere, slowing as they cross pentagonal cells."
recommendedPreset seeded

substrate geodesic frequency 64

field state: u32

field stateNorm:    f32 derived  // state / 2 for the ramp colorer
field isBurning:    u32 derived  // 1 if currently burning, 0 otherwise
field isTree:       u32 derived  // 1 if currently a tree, 0 otherwise
field isEmpty:      u32 derived  // 1 if currently empty, 0 otherwise

// Growth rate p: probability per tick that an empty cell sprouts a tree.
// Default 0.01 → mean tree-regrowth time ~100 ticks.
param P_GROWTH    slider 0..0.05    step 0.0005  default 0.010 label "p (REGROWTH)"
// Lightning rate f: probability per tick that a tree spontaneously
// ignites. Default 5e-5 → on a 64-frequency icosphere (~25k cells)
// that's ~1 strike per tick. Cranking this up flattens the cluster-
// size distribution; cranking it down sends fires further apart in
// time but bigger when they happen.
param F_LIGHTNING slider 0..0.005   step 0.00005 default 0.00005 label "f (LIGHTNING)"

param simRateHz   slider 0..120 step 1     default 30   label "SIM RATE"
param rate        slider 1..10  step 1     default 1    label "RATE"

step {
  // Stage 1 — Apply the three update rules. Order matters:
  //   1. burning  → empty
  //   2. tree     → burning if any neighbor is burning OR lightning hits
  //   3. empty    → tree with probability p
  // Everything else stays put.
  stage transition "Forest-fire transition" {
    reads state
    writes state
    cell {
      // Has any neighbor caught fire? state@n == 2 → 1, else 0; sum
      // counts burning neighbours. Threshold 1 means "at least one".
      let burnNbrs = sum n in neighbors { (state@n == 2) ? 1 : 0 }
      // cellRand returns [-1, 1]; remap to [0, 1] before comparing
      // against probabilities (otherwise half of cells fire every tick
      // regardless of f and p).
      let strikeR = cellRand(frame) * 0.5 + 0.5
      let sproutR = cellRand(frame * 31 + 7) * 0.5 + 0.5
      let strike  = strikeR < F_LIGHTNING
      let sprout  = sproutR < P_GROWTH

      let isBurningCell = (state == 2) ? 1 : 0
      let isTreeCell    = (state == 1) ? 1 : 0
      let isEmptyCell   = (state == 0) ? 1 : 0

      let treeIgnites   = isTreeCell == 1 && (burnNbrs > 0 || strike)
      let emptySprouts  = isEmptyCell == 1 && sprout

      // Cascade: burning resolves first, then tree-spreads, then
      // empty-sprouts. Each branch is mutually exclusive on this tick.
      let next1 = (isBurningCell == 1) ? 0 : state
      let next2 = treeIgnites ? 2 : next1
      let next3 = emptySprouts ? 1 : next2
      set state = next3
    }
  }

  // Stage 2 — Diagnostic projections for visualization + metrics.
  // Cheap; runs once per tick. The boolean indicators feed the
  // count-style metrics without each metric having to re-evaluate
  // \`state == k\` over the whole grid.
  stage diagnostics "Indicator projections" {
    reads state
    writes stateNorm, isBurning, isTree, isEmpty
    cell {
      set stateNorm = state * 0.5
      set isBurning = (state == 2) ? 1 : 0
      set isTree    = (state == 1) ? 1 : 0
      set isEmpty   = (state == 0) ? 1 : 0
    }
  }
}

metric burning = sum cells { isBurning }
metric trees   = sum cells { isTree }
metric empty   = sum cells { isEmpty }

views {
  // Three-stop ramp pinned to the discrete states:
  //   stateNorm = 0   → empty (dark earth)
  //   stateNorm = 0.5 → tree  (green)
  //   stateNorm = 1   → burn  (orange/red)
  // The colorer interpolates linearly, but the field only ever sits at
  // exactly one of three values, so the displayed colour is always crisp.
  palette FOREST {
    stop 0   color [42, 30, 22]
    stop 0.5 color [60, 130, 60]
    stop 1   color [255, 90, 30]
  }

  // Pure burning highlight — useful for spotting tiny fires the
  // tri-colour view washes out at low frequencies.
  palette FIRE {
    stop 0 color [10, 12, 18]
    stop 1 color [255, 200, 60]
  }

  view forest "Forest (empty / tree / burn)" {
    color ramp stateNorm range [0, 1] palette FOREST
  }

  view burning "Burning only" {
    color ramp isBurning range [0, 1] palette FIRE
  }
}

stamps {
  stamp ignite "Strike a match" {
    // Force the painted area to burning; trees there light immediately,
    // empty ground there will go out next tick (you're burning the air).
    spot state at brush.pos, radius=brush.r, amount=2
  }

  stamp clearcut "Clear the patch" {
    // Big negative push drives state below 0; the writeback clamps
    // u32 to 0, so the painted area becomes empty ground.
    spot state at brush.pos, radius=brush.r, amount=-100
  }

  stamp plant "Plant trees" {
    // Push every cell exactly to state 1. Negative amount first knocks
    // it down past zero, so this stamp is destructive of any fires —
    // good for resetting a region to a clean tree-bed.
    spot state at brush.pos, radius=brush.r, amount=1
  }
}

scenarios {
  scenario seeded "Mature forest, one ignition (default)" {
    // Start with a forest that's mostly trees and a single burning
    // pixel near (0, 0). Watch the front spread radially, slowing as
    // it crosses the pentagon at the icosahedron pole.
    for each cell {
      let r = cellRand(11)
      set state = (r < 0.6) ? 1 : 0
    }
    spot state at lon=0, lat=0, radius=0.04, amount=2
  }

  scenario virgin "Empty world (regrowth only)" {
    // Bare lattice. Trees nucleate at rate p, lightning ignites them
    // once density crosses percolation. Useful for watching the
    // spontaneous build-up to the first big fire.
    set state = 0
  }

  scenario densePack "Saturated forest" {
    // Every cell starts as a tree. The very first lightning strike
    // burns essentially the whole sphere — sphere-spanning conflagration
    // demo. After the burn-out the system relaxes into the
    // power-law regime.
    set state = 1
  }

  scenario halfBurn "Burning hemisphere vs trees" {
    // Northern hemisphere starts burning, southern hemisphere starts
    // as trees, equator empty. The fire eats southwards across the
    // boundary and the SOC dynamics take over from there.
    set state = 0
    for each cell where lat > 0.1  { set state = 2 }
    for each cell where lat < -0.1 { set state = 1 }
  }
}
`;

export const pipeline = compileV2(pipelineDsl);
