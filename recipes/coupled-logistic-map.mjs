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

// The logistic map at r=3.8 has |Δx| ≈ 0.4 every iteration BY
// CONSTRUCTION — that's deterministic chaos with no slow timescale.
// We work around it with a low default simRateHz and the xAvg envelope
// view; the raw x view is still expected to strobe and that's
// declared up front rather than masked.
export const audit = {
  allowStrobe: true,
};

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
field xAvg: f32           // exponential moving average of x — slow envelope
                          // for the "structure" view (NOT derived: it has to
                          // persist across ticks since stage avg reads its
                          // own previous value).
field xVar: f32 derived   // local variance — high in chaotic patches, low
                          // in synchronised ones.

// r is the logistic-map parameter. r ∈ [3.57, 4] is the chaotic regime;
// 3.8 is a reasonable default well inside chaos. r=3 marks the onset
// of the period-doubling cascade (everyone settles into a fixed point);
// r=3.45 is period-2; etc.
param R           slider 2..4    step 0.005 default 3.8  label "r (LOGISTIC)"
// ε is the coupling strength. 0 = isolated maps; 0.5 = strong
// homogenisation. The interesting regime is ε ∈ [0.05, 0.3].
param EPS         slider 0..0.5  step 0.005 default 0.20 label "ε (COUPLING)"
// Default simRateHz is intentionally LOW (8 Hz). The logistic map at
// r=3.8 has no slow timescale — every iteration is a complete state
// change with |Δx| ~ 0.4 — so running at 60 Hz produces TV static
// regardless of coupling. At 8 Hz the spatial pattern at each
// iteration is on screen long enough to read; the eye also picks up
// the temporal evolution of patches across iterations. Crank
// simRateHz back up if you want raw chaos.
param simRateHz   slider 0..240  step 1     default 8    label "SIM RATE"

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

  // Stage 2 — Slow envelope. Exponential moving average of x with
  // half-life ~10 ticks. Hides per-iteration chaos and surfaces the
  // slowly-evolving patch structure that's the actual point of CML.
  stage avg "Slow envelope (EMA)" {
    reads x, xAvg
    writes xAvg
    cell {
      set xAvg = xAvg * 0.93 + x * 0.07
    }
  }

  // Stage 3 — Local variance. (mean of x²) − (mean of x)². On a
  // uniformly synchronised cell the local variance is zero; in
  // chaotic patches it's near 0.05 (the average squared deviation of
  // independent logistic-map samples).
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
  // Single-hue brightness ramp. Logistic-map jumps from x=0.3 to x=0.9
  // produce dim-to-bright transitions instead of cycling through
  // multiple colours — far less strobe-y at any frame rate. Tuned for
  // dark substrate so the chaotic peaks pop without burning the eyes.
  palette EMBER {
    stop 0   color [10, 8, 14]
    stop 0.4 color [80, 30, 40]
    stop 0.7 color [200, 90, 60]
    stop 1   color [255, 220, 160]
  }

  // Cool ramp for the slow envelope. xAvg stays in [0.3, 0.7]-ish so
  // the palette range is set tighter; patches that drift slowly read
  // as different shades of teal/cyan.
  palette FROST {
    stop 0   color [12, 16, 28]
    stop 0.3 color [40, 80, 110]
    stop 0.7 color [80, 180, 200]
    stop 1   color [200, 240, 240]
  }

  // Variance colorer — synced regions go dark; chaotic patches glow.
  palette VAR {
    stop 0 color [10, 12, 18]
    stop 1 color [80, 230, 180]
  }

  // Default view: slow envelope. This is the one view that's stable
  // enough to actually read patterns at standard frame rates. The raw
  // x view is included for users who want to watch the chaos directly.
  // Range is tight ([0.6, 0.72]) because xAvg's per-cell spread is
  // narrow — every cell's long-run logistic-map mean is the same
  // (~0.65), so cell-to-cell xAvg differences come from recent
  // history. The narrow range maximises contrast over those subtle
  // recent-history differences.
  view envelope "Slow envelope (xAvg)" {
    color ramp xAvg range [0.6, 0.72] palette FROST
  }

  view value "x value (raw chaos — best at low SIM RATE)" {
    color ramp x range [0, 1] palette EMBER
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
  // xAvg is seeded with the long-run logistic-map mean (~0.65 at r=3.8)
  // in every scenario so the envelope view doesn't darkly fade in over
  // the first 30 ticks while the EMA converges from 0.
  scenario turbulent "Random initial chaos (default)" {
    // Every cell starts at a random x ∈ [0.1, 0.9]. With default
    // (ε, r) the system stays chaotic — the spatial pattern shifts
    // every tick but never settles.
    set xAvg = 0.65
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
    set xAvg = 0.4
  }

  scenario hemisphere "Two-domain initial split" {
    // Northern hemisphere starts low, southern starts high. The
    // boundary is a sharp domain wall; whether it relaxes (high
    // coupling) or freezes into permanent stripes (low coupling) is
    // a function of ε.
    for each cell {
      set x    = lat > 0 ? 0.2 : 0.7
      set xAvg = lat > 0 ? 0.2 : 0.7
    }
  }
}
`;

export const pipeline = compileV2(pipelineDsl);
