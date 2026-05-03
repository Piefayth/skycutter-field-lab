// Coupled-map lattice — Kaneko (1989). Each cell runs an independent
// logistic map x_{n+1} = r·x_n·(1 − x_n), then mixes with the mean
// of its neighbours by a coupling parameter ε:
//
//   x'  = (1 − ε) · f(x)  +  ε · mean(neighbours)
//
// The logistic map is chaotic for r ∈ [3.57, 4]. With ε = 0 every
// cell is its own private chaotic process — the sphere fills with
// uncorrelated time-series and the visual is just per-cell flicker.
// At small ε the sites partially synchronise into "frozen random
// patterns" (clumps of cells with similar x), and at higher ε the
// whole sphere can lock into a single coherent oscillator. In the
// intermediate regime you get the famous Kaneko spatiotemporal
// intermittency: long-lived synchronised patches that occasionally
// fragment when local chaos beats coupling.
//
// This is the only recipe in the catalog that's actually deterministic
// chaos — every other "noisy" recipe uses an explicit cellRand() kick.
// Here the noise IS the chaos: the logistic map at r=3.8 is fully
// deterministic but its trajectory is non-periodic and exquisitely
// sensitive to initial conditions, so the per-cell trajectories
// effectively look random while obeying the same global update rule.
//
// Why on the geodesic: nothing special — coupled-map lattices were
// originally studied on planar grids. The icosphere just gives a
// finite, closed, smooth substrate. Pentagonal cells couple to 5
// neighbours instead of 6, which subtly biases the local mean toward
// fewer samples — invisible in the chaotic regime, sometimes
// detectable as slight defects in the synchronised regime.

import { compileV2 } from "../dsl/compile-v2.mjs";

export const overlays = [];

export const metrics = [
  { id: "meanX",  label: "MEAN x",  source: "dsl:meanX",  spark: true, precision: 3 },
  { id: "varX",   label: "VAR x",   source: "dsl:varX",   spark: true, precision: 3 },
  { id: "fps",    label: "FPS",     source: "fps",        mini: true },
];

// "Active" = sphere-wide variance is significant (chaos). "Silent" =
// everyone synchronised to the same orbit (var → 0). Runaway can't
// happen — the logistic map is bounded in [0, 1] for r ∈ [0, 4].
export const regime = {
  silent:       { varX: 0 },
  intermittent: { varX: 0.005 },
  active:       { varX: 0.04 },
  runaway:      { varX: 1 },
};

export const pipelineDsl = `
recipe "Coupled-map lattice (logistic)"
summary "Per-cell logistic map x' = r·x·(1−x) with diffusive coupling ε to the local mean. At ε=0 every cell is its own chaotic process; at small ε you get Kaneko's spatiotemporal intermittency — frozen random patches that occasionally rupture; at large ε the sphere locks into a single coherent oscillator. The only recipe in the catalog using deterministic chaos rather than explicit randomness."
recommendedPreset turbulent

substrate geodesic frequency 32

field x: f32
field xVar: f32 derived  // local variance for visualization

// r is the logistic-map parameter. r ∈ [3.57, 4] is the chaotic regime;
// 3.8 is a reasonable default well inside chaos. r=3 marks the onset
// of the period-doubling cascade (everyone settles into a fixed point);
// r=3.45 is period-2; etc.
param R           slider 2..4    step 0.005 default 3.8  label "r (LOGISTIC)"
// ε is the coupling strength. 0 = isolated maps; 0.5 = strong
// homogenisation. The interesting regime is ε ∈ [0.05, 0.3].
param EPS         slider 0..0.5  step 0.005 default 0.10 label "ε (COUPLING)"
param simRateHz   slider 0..240  step 1     default 60   label "SIM RATE"

step {
  // Stage 1 — One logistic-map iteration plus diffusive mix. The map
  // is exactly bounded in [0, 1] when r ∈ [0, 4] and x ∈ [0, 1]; the
  // clamp at the end is a numerical-noise safety net, not a dynamic
  // constraint.
  stage update "Iterate + couple" {
    reads x
    writes x
    cell {
      let fx     = R * x * (1 - x)
      let nbrAvg = mean n in neighbors { x@n }
      let blend  = (1 - EPS) * fx + EPS * nbrAvg
      // Clamp keeps the map inside the bounded basin even after
      // repeated round-off; outside [0, 1] the next iteration would
      // explode (r·x·(1−x) goes negative for x > 1).
      set x = clamp(blend, 0, 1)
    }
  }

  // Stage 2 — Local variance for visualisation. (mean of x²) − (mean
  // of x)². On a uniformly synchronised cell the local variance is
  // zero; in chaotic patches it's near 0.05 (the average squared
  // deviation of independent logistic-map samples).
  stage diagnostics "Local variance" {
    reads x
    writes xVar
    cell {
      let mu  = mean n in neighbors { x@n }
      let mu2 = mean n in neighbors { x@n * x@n }
      set xVar = mu2 - mu * mu
    }
  }
}

metric meanX = mean cells { x }
metric varX  = mean cells { xVar }

views {
  // Phase-style ramp: chaos shows as a colorful jumble, sync as a
  // single solid colour shifting over time.
  palette CHAOS {
    stop 0    color [12, 18, 36]
    stop 0.25 color [60, 80, 200]
    stop 0.5  color [240, 220, 60]
    stop 0.75 color [240, 90, 60]
    stop 1    color [255, 240, 220]
  }

  // Variance colorer — high-coupling synced regions go dark; chaotic
  // patches glow.
  palette VAR {
    stop 0 color [10, 12, 18]
    stop 1 color [80, 230, 180]
  }

  view value "x value" {
    color ramp x range [0, 1] palette CHAOS
  }

  view variance "Local variance" {
    color ramp xVar range [0, 0.1] palette VAR
  }
}

stamps {
  stamp kick "Random kick" {
    // Adds a value in roughly [0.2, 0.5] — knocks the painted patch
    // out of whatever attractor it had locked onto.
    spot x at brush.pos, radius=brush.r, amount=0.3
  }

  stamp settle "Settle to 0.5" {
    // Big negative drives x toward 0; the next stage's clamp catches
    // it. Painting then waiting lets you watch the patch re-enter
    // the chaotic regime from a near-zero kick.
    spot x at brush.pos, radius=brush.r, amount=-2
  }
}

scenarios {
  scenario turbulent "Random initial chaos (default)" {
    // Every cell starts at a random x ∈ [0.1, 0.9]. With default
    // (ε, r) the system stays chaotic — the spatial pattern shifts
    // every tick but never settles.
    for each cell {
      let r = cellRand(11) * 0.5 + 0.5
      set x = 0.1 + r * 0.8
    }
  }

  scenario uniform "All synchronised" {
    // Every cell at exactly 0.4. With ε=0 they'd all run identical
    // chaotic trajectories and never desync (they're given the same
    // initial condition under a deterministic map). The coupling
    // provides no symmetry-breaking either, so the sphere stays
    // perfectly homogeneous — useful for verifying the sync ground
    // state. Nudge ε down to 0 and one cell with the kick stamp to
    // watch the perturbation propagate.
    set x = 0.4
  }

  scenario hemisphere "Two-domain initial split" {
    // Northern hemisphere starts low, southern starts high. The
    // boundary is a sharp domain wall; whether it relaxes (high
    // coupling) or freezes into permanent stripes (low coupling) is
    // a function of ε.
    for each cell {
      set x = lat > 0 ? 0.2 : 0.7
    }
  }
}
`;

export const pipeline = compileV2(pipelineDsl);
