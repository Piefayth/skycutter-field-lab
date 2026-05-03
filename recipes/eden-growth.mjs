// Eden growth (Eden 1961) — the simplest stochastic aggregation model.
// Cells are either occupied (1) or empty (0). Each tick, every empty
// cell with at least one occupied neighbour flips to occupied with
// probability `growthRate`. That's the whole rule.
//
// Started from a single seed, the cluster expands radially with a
// rough fractal edge. The bulk fills in dense; only the boundary
// stays interesting. Over time the cluster swallows the whole sphere
// (it's not a fractal in 2D — Eden clusters are space-filling — but
// the boundary itself has nontrivial roughness in the Family-Vicsek
// sense).
//
// Why on the geodesic: planar Eden growth has a slight directional
// bias from the lattice; on the icosphere the 12 pentagonal cells
// pin small distortions in the front but the bulk is approximately
// isotropic. Watch the front sweep across the equator and meet
// itself at the antipode — the meeting line is where roughness is
// most visible.
//
// Compared to the forest-fire CA (drossel-schwabl): same family
// (stochastic state CA) but Eden is monotone — once occupied always
// occupied — so there's no SOC, no power-law avalanches, just a
// growing cluster with a rough advancing front.

import { compileV2 } from "../dsl/compile-v2.mjs";

export const overlays = [];

export const metrics = [
  { id: "occupied",  label: "OCCUPIED", source: "dsl:occupied",  spark: true, precision: 0 },
  { id: "frontSize", label: "FRONT",    source: "dsl:frontSize", spark: true, precision: 0 },
  { id: "fps",       label: "FPS",      source: "fps",           mini: true },
];

// "Front" cells are empty cells with at least one occupied neighbour —
// the boundary that's eligible to grow. Front size peaks at intermediate
// occupation and shrinks back toward zero as the cluster fills the sphere.
export const regime = {
  silent:       { frontSize: 0 },
  intermittent: { frontSize: 5 },
  active:       { frontSize: 100 },
  runaway:      { frontSize: 5000 },
};

export const pipelineDsl = `
recipe "Eden growth"
summary "Simplest stochastic aggregation. Each empty cell with an occupied neighbour flips to occupied with probability g per tick. From a single seed the cluster expands with a rough advancing front; the icosphere's 12 pentagonal cells subtly perturb the boundary but the bulk grows isotropically. The front roughens as ~t^β (Family-Vicsek) before saturating when the cluster wraps the sphere."
recommendedPreset seed

substrate geodesic frequency 48

field state: u32
field frontF: u32 derived  // 1 if empty AND has an occupied neighbour

// Growth probability per eligible empty cell per tick. Default 0.02
// gives a visible front advancing at ~one cell per 50 ticks; cranking
// it any higher swallows the sphere in a few wall-clock seconds and
// you don't get to watch the front roughen.
param GROWTH      slider 0..0.5  step 0.005 default 0.02 label "g (GROWTH)"
param simRateHz   slider 0..120  step 1     default 30   label "SIM RATE"

step {
  // Stage 1 — One eligibility-and-flip pass. Empty cells with at
  // least one occupied neighbour roll the dice; everyone else stays
  // put.
  stage grow "Stochastic edge attachment" {
    reads state
    writes state
    cell {
      let isEmpty = state == 0
      let occNbrs = sum n in neighbors { (state@n == 1) ? 1 : 0 }
      let onFront = isEmpty && (occNbrs > 0)
      // cellRand returns [-1, 1]; remap to [0, 1] before comparing
      // to the growth probability.
      let r       = cellRand(frame) * 0.5 + 0.5
      let attach  = onFront && (r < GROWTH)
      set state = attach ? 1 : state
    }
  }

  // Stage 2 — Front diagnostic. Mirrors the eligibility test from
  // stage 1 but reads the just-updated state, so the metric tracks
  // the post-step front.
  stage diagnostics "Front projection" {
    reads state
    writes frontF
    cell {
      let isEmpty = state == 0
      let occNbrs = sum n in neighbors { (state@n == 1) ? 1 : 0 }
      set frontF  = (isEmpty && (occNbrs > 0)) ? 1 : 0
    }
  }
}

metric occupied  = count cells where state == 1
metric frontSize = sum cells { frontF }

views {
  // Two-tone with a hint of the front: empty=cold, occupied=warm.
  palette CLUSTER {
    stop 0   color [16, 18, 28]
    stop 0.5 color [120, 90, 60]
    stop 1   color [240, 200, 140]
  }

  // Pure front colorer — drops out the bulk, leaves the advancing edge.
  palette EDGE {
    stop 0 color [12, 14, 22]
    stop 1 color [80, 230, 255]
  }

  view cluster "Cluster (occupied / empty)" {
    color ramp state range [0, 1] palette CLUSTER
  }

  view front "Active growth front" {
    color ramp frontF range [0, 1] palette EDGE
  }
}

stamps {
  stamp seedHere "Seed (occupy)" {
    spot state at brush.pos, radius=brush.r, amount=1
  }

  stamp clearArea "Clear patch" {
    spot state at brush.pos, radius=brush.r, amount=-100
  }
}

scenarios {
  scenario seed "Single seed (default)" {
    // One small occupied dot at the equator. Cluster expands radially,
    // engulfs the sphere over a couple hundred wallclock seconds at
    // default growth rate.
    set state = 0
    spot state at lon=0, lat=0, radius=0.04, amount=1
  }

  scenario antipodes "Two seeds, opposite poles" {
    // Two clusters grow toward each other; they meet on the equator
    // and the meeting front is where front-roughness is most visible.
    set state = 0
    spot state at lon=0,  lat=1.5,  radius=0.04, amount=1
    spot state at lon=0,  lat=-1.5, radius=0.04, amount=1
  }

  scenario six "Six-fold seeds" {
    // Six seeds equally spaced around the equator. Expanding fronts
    // collide hexagonally and lock the final boundary to the
    // icosphere's symmetries.
    set state = 0
    spot state at lon=0,    lat=0, radius=0.03, amount=1
    spot state at lon=1.05, lat=0, radius=0.03, amount=1
    spot state at lon=2.10, lat=0, radius=0.03, amount=1
    spot state at lon=-1.05, lat=0, radius=0.03, amount=1
    spot state at lon=-2.10, lat=0, radius=0.03, amount=1
    spot state at lon=3.14,  lat=0, radius=0.03, amount=1
  }

  scenario noiseSeed "Sparse random seeds" {
    // ~1% of cells start occupied. Many small clusters merge over time;
    // the meeting boundaries make a richer texture than a single seed.
    for each cell {
      let r = cellRand(7) * 0.5 + 0.5
      set state = (r < 0.01) ? 1 : 0
    }
  }
}
`;

export const pipeline = compileV2(pipelineDsl);
