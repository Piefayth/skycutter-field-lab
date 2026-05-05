// Parallel sandpile relaxation on a geodesic sphere. Each cell holds an
// integer sand height h. Every tick:
//
//   - Drive: with a small probability per cell, add 1 grain.
//   - Topple: any cell with h ≥ threshold redistributes — loses
//     `threshold` grains, sends 1 to each neighbour.
//
// This is deliberately the synchronous, one-relaxation-sweep-per-tick
// version that the current DSL can express cleanly. It is related to
// Bak-Tang-Wiesenfeld, but it is not the full Abelian sandpile protocol
// where one grain is dropped and the avalanche relaxes to quiescence
// before the next grain arrives. That fully-relaxed model wants a bounded
// cascade/relax primitive.
//
// Why the geodesic: BTW is canonically a square-lattice rule (h ≥ 4 →
// topple, distribute 1 to each of 4 neighbours; mass exactly conserved).
// On a hex grid the natural threshold is 6, also conservative. On an
// icosphere most cells have 6 neighbours but the 12 pentagonal cells
// (icosahedron vertices) have only 5. We pick threshold=6 uniformly:
// hexagonal cells topple conservatively, pentagons lose one grain each
// time they topple. Pentagons act as dissipative defects pinned to
// specific points — geometrically, the curvature has to leak somewhere.
//
// Compared to the forest-fire recipe: this is a conservative local
// redistribution toy. Watch toppling fronts, pinned pentagon sinks, and
// metastable near-critical patches rather than a rigorously measured SOC
// avalanche distribution.

import { compileV2 } from "../dsl/compile-v2.mjs";

export const overlays = [];

export const metrics = [
  { id: "topples",  label: "TOPPLES",  source: "dsl:topples",  spark: true, precision: 0 },
  { id: "critical", label: "CRITICAL", source: "dsl:critical", spark: true, precision: 0 },
  { id: "meanH",    label: "MEAN h",   source: "dsl:meanH",    mini: true,  precision: 2 },
  { id: "fps",      label: "FPS",      source: "fps",          mini: true },
];

// "Critical" = cells one drop from toppling (h == threshold − 1). Their
// fraction climbs as the system fills toward criticality, then plateaus
// when avalanches start dissipating mass through the pentagons.
export const regime = {
  silent:       { topples: 0 },
  intermittent: { topples: 5 },
  active:       { topples: 100 },
  runaway:      { topples: 5000 },
};

export const pipelineDsl = `
recipe "Sandpile relaxation"
summary "Parallel sandpile relaxation on a sphere. Sparse random grains slowly load an integer height field; cells at threshold lose grains to their neighbours, producing toppling fronts and pinned sinks at the 12 pentagonal cells. This is the synchronous one-sweep-per-tick model the current DSL can express, not the fully-relaxed Abelian sandpile."
recommendedPreset patchy

substrate geodesic frequency 32

field h: u32                  // sand height (integer grains)
field toppled: u32 derived    // 1 if this cell toppled this tick (for visualization + metrics)

// Drop rate: probability per cell per tick of receiving a grain. Keep it
// low: at frequency 32, 0.00008 is roughly one random drop per tick.
param DROP_RATE   slider 0..0.005 step 0.00002 default 0.00008 label "DROP RATE"
// Topple threshold. Six is the natural value for the hexagonal majority;
// dropping it produces faster cascades, raising it slows everything.
param THRESHOLD   slider 3..12    step 1      default 6     label "THRESHOLD"
param simRateHz   slider 0..120   step 1      default 24    label "SIM RATE"

step {
  // Stage 1 — Drive. Each cell rolls a per-frame random number; if it
  // falls in the bottom DROP_RATE fraction of [0, 1], the cell gets
  // one grain. This is intentionally sparse so relaxation fronts remain
  // readable between random kicks.
  stage drive "Random grain drop" {
    reads h
    writes h
    cell {
      // cellRand returns [-1, 1]; remap to [0, 1] before comparing
      // to the drop probability.
      let r = cellRand(frame) * 0.5 + 0.5
      let dropHere = r < DROP_RATE
      set h = h + (dropHere ? 1 : 0)
    }
  }

  // Stage 2 — Topple. Synchronous: every cell at/above threshold loses
  // THRESHOLD grains; every cell receives 1 grain per toppling neighbour.
  // One tick performs one relaxation sweep, so large avalanches visibly
  // travel as fronts instead of collapsing into a single hidden event.
  stage topple "Toppling cascade" {
    reads h
    writes h, toppled
    cell {
      let willTopple = h >= THRESHOLD
      let incoming   = sum n in neighbors { (h@n >= THRESHOLD) ? 1 : 0 }
      let outflow    = willTopple ? THRESHOLD : 0
      // max(0, ...) is a safety net for u32 underflow; with willTopple
      // gating outflow it's mathematically unreachable but makes the
      // intent explicit.
      set h       = max(0, h + incoming - outflow)
      set toppled = willTopple ? 1 : 0
    }
  }
}

metric topples  = sum cells { toppled }
metric critical = count cells where h >= (THRESHOLD - 1)
metric meanH    = mean cells { h }

views {
  // Sand-yellow ramp through the typical operating range. Cells right
  // at threshold appear bright; deep stable regions are warm-dim.
  palette SAND {
    stop 0   color [10, 12, 18]
    stop 0.3 color [80, 60, 30]
    stop 0.6 color [200, 140, 50]
    stop 1   color [255, 240, 180]
  }

  // Avalanche colorer — pure heat from non-toppling to actively toppling.
  palette FIRE {
    stop 0 color [10, 12, 18]
    stop 1 color [255, 100, 30]
  }

  view height "Sand height" {
    color ramp h range [0, 8] palette SAND
  }

  view avalanche "Toppling activity" {
    color ramp toppled range [0, 1] palette FIRE
  }
}

stamps {
  stamp dump "Dump grains" {
    spot h at brush.pos, radius=brush.r, amount=4
  }

  stamp clearArea "Clear patch" {
    // Big negative knocks h to 0 (clamped at zero in writeback).
    spot h at brush.pos, radius=brush.r, amount=-100
  }
}

scenarios {
  scenario slow "Empty slow drive" {
    // Bare lattice; sparse drive slowly nucleates the pile from scratch.
    // This is the cleanest long-run view, but it takes time to build.
    set h = 0
  }

  scenario patchy "Patchy near-critical" {
    // A calmer default than filling the whole sphere to threshold - 1.
    // Most cells are subcritical; scattered near-critical patches produce
    // local relaxation fronts without instantly wiping the whole planet.
    for each cell {
      let r = cellRand(17) * 0.5 + 0.5
      let band = sin(lon * 2.0 + lat * 1.5) * 0.5 + 0.5
      let base = r > 0.72 ? THRESHOLD - 1 : (r > 0.38 ? THRESHOLD - 2 : THRESHOLD - 3)
      set h = max(0, base + (band > 0.68 && r > 0.55 ? 1 : 0))
    }
  }

  scenario peak "Single tall pile" {
    // One cell vastly over threshold; the relaxation front spreads
    // radially over many ticks.
    set h = 0
    spot h at lon=0, lat=0, radius=0.05, amount=20
  }

  scenario primed "Whole sphere primed (explosive)" {
    // Deliberately extreme: every cell starts one grain shy of toppling.
    // A single drop creates a planet-scale wave and then a drained sphere.
    // Useful as a stress test, not as the default behaviour.
    for each cell {
      set h = THRESHOLD - 1
    }
  }
}
`;

export const pipeline = compileV2(pipelineDsl);
