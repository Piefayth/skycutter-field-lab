// Bak-Tang-Wiesenfeld (1987) — the original self-organised-criticality
// model. Each cell holds an integer "sand height" h. Every tick:
//
//   - Drive: with probability `dropRate` per cell, add 1 grain.
//   - Topple: any cell with h ≥ threshold redistributes — loses
//     `threshold` grains, sends 1 to each neighbour.
//
// Avalanches form because a single drop can push a cell over threshold,
// which sends grains to neighbours, which in turn may topple. The size
// distribution of avalanches is a power law — that's the SOC signature.
// Bak's whole point was that the system organises itself onto the
// critical surface without external tuning, just by the slow drive
// matching the fast relaxation.
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
// Compared to the forest-fire SOC recipe (drossel-schwabl): same
// universality class (power-law avalanche-size distribution) but
// reached by very different mechanism — deterministic toppling cascades
// triggered by a slow stochastic drive, vs stochastic ignition spreading
// through a percolating tree cluster.

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
recipe "Bak-Tang-Wiesenfeld sandpile"
summary "Classic SOC sandpile. Slowly drop grains onto random cells; whenever a cell's height reaches the toppling threshold (6 for the geodesic's hexagonal cells), it loses 6 grains and sends 1 to each neighbour, possibly triggering further topples in a cascading avalanche. The 12 pentagonal cells (5 neighbours) act as dissipative defects — every pentagon topple leaks one grain — so the pile self-organises around a critical density set by mass-balance with these pinned sinks."
recommendedPreset primed

substrate geodesic frequency 32

field h: u32                  // sand height (integer grains)
field toppled: u32 derived    // 1 if this cell toppled this tick (for visualization + metrics)

// Drop rate: probability per cell per tick of receiving a grain.
// Default 0.001 → ~10 drops/tick on the freq-32 mesh (~10k cells),
// slow enough that avalanches finish between drops at low pile heights.
param DROP_RATE   slider 0..0.05  step 0.0005 default 0.001 label "DROP RATE"
// Topple threshold. Six is the natural value for the hexagonal majority;
// dropping it produces faster cascades, raising it slows everything.
param THRESHOLD   slider 3..12    step 1      default 6     label "THRESHOLD"
param simRateHz   slider 0..120   step 1      default 30    label "SIM RATE"

step {
  // Stage 1 — Drive. Each cell rolls a per-frame random number; if
  // it falls in the bottom DROP_RATE fraction of [0, 1], the cell
  // gets one grain.
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

  // Stage 2 — Topple. Synchronous: every cell that's above threshold
  // loses THRESHOLD grains; every cell receives 1 grain per toppling
  // neighbour. Reads-from-previous-tick guarantees a deterministic
  // synchronous avalanche front.
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
  scenario slow "Slow drive (default)" {
    // Bare lattice; drive nucleates the pile from scratch. The pile
    // climbs to criticality over ~30 wallclock seconds and then
    // produces intermittent avalanches forever.
    set h = 0
  }

  scenario primed "Pre-loaded near-critical" {
    // Every cell starts one grain shy of toppling. Any further drop
    // triggers a cascade — useful for watching a single avalanche
    // propagate cleanly.
    for each cell {
      set h = THRESHOLD - 1
    }
  }

  scenario peak "Single tall pile" {
    // One cell vastly over threshold; the topple front spreads
    // radially and leaves a roughly-conical pile behind.
    set h = 0
    spot h at lon=0, lat=0, radius=0.05, amount=20
  }
}
`;

export const pipeline = compileV2(pipelineDsl);
