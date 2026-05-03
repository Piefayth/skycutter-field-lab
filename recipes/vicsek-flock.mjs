// Vicsek alignment on a sphere — emergent flocking from local rules.
//
// Each cell carries a heading direction (vec2 of unit length). Every
// tick:
//   1. compute the mean heading of immediate neighbors,
//   2. normalize it (commits to a direction even when neighbors
//      disagree — the symmetry-breaking move that makes Vicsek
//      Vicsek),
//   3. rotate by a small random angle scaled by the noise param.
//
// That's it. No global coordination, no leader, no objective.
//
// What you'll see:
//   - At low noise (η ≲ 0.1) the whole sphere polarizes into a
//     single direction within a few seconds. The phase-color view
//     fills with a single color modulo the few topological defects
//     that survived the alignment cascade.
//   - At intermediate noise (η ≈ 0.2) defects nucleate, drift, and
//     annihilate in pairs (vortex/antivortex). The mean polarization
//     metric oscillates as defects collide and reform.
//   - At high noise (η ≳ 0.4) alignment is frustrated — the sphere
//     never picks a global direction, the phase-color view stays
//     speckled, mean polarization stays near zero.
//
// The order/disorder transition is a real second-order phase
// transition in the Vicsek model. Sweep η across 0.1 → 0.5 with the
// MEAN POLAR metric visible and you can watch it drop from ~1 to ~0.
//
// Why this is a v2-only recipe: the heading is naturally a vec2
// (orientation on a 2D tangent plane), and the alignment update
// needs the neighborhood mean of those vec2s. v1 would have had
// to fake it with two scalar fields and lose the algebraic
// elegance — v2 stores it as one vec2 field, reads neighbors via
// `mean n in neighbors { heading@n.x }` / `.y` (the type checker
// requires component-wise scalar reductions today), and renders
// the result via atan2 + the existing phase colorer.

import { compileV2 } from "../dsl/compile-v2.mjs";

export const overlays = [];

export const metrics = [
  { id: "polarX",   label: "POLAR X", source: "dsl:polarX",   spark: true, precision: 3 },
  { id: "polarY",   label: "POLAR Y", source: "dsl:polarY",   spark: true, precision: 3 },
  { id: "meanAlign", label: "MEAN ALIGN", source: "dsl:meanAlign", spark: true, precision: 3 },
  { id: "defects", label: "DEFECTS", source: "dsl:defects", mini: true, precision: 0 },
  { id: "fps",     label: "FPS",     source: "fps",          mini: true },
];

// Regime classifier on global polarization magnitude. Low alignment =
// disordered (random heading at every cell), high alignment = single
// global flow. The 0.6/0.85 thresholds bracket the typical noise-
// driven transition window at this mesh size.
export const regime = {
  silent:       { meanAlign: 0 },
  intermittent: { meanAlign: 0.4 },
  active:       { meanAlign: 0.7 },
  runaway:      { meanAlign: 0.95 },
};

export const pipelineDsl = `
recipe "Vicsek flock (sphere)"
summary "Emergent flocking on a sphere. Each cell has a heading vec2; each tick it adopts the neighborhood-mean direction plus a random rotation. Below the critical noise the whole sphere polarizes; above it, alignment is frustrated. The order/disorder transition is a real second-order phase transition. Sweep NOISE 0.1 → 0.5 and watch MEAN ALIGN drop from ~1 to ~0."
recommendedPreset random

substrate geodesic frequency 48

field heading: vec2

// Diagnostics — both surfaces update every tick from the heading.
field dir: f32 derived       // atan2(heading.y, heading.x), for phase coloring
field align: f32 derived     // |neighborhood-mean heading|, defect indicator

// Heading direction → color wheel. Defects appear where the wheel
// wraps around a singularity (a topological vortex of order ±1). Two
// adjacent cells with opposite phase colors = a defect line.

// Local alignment magnitude. 1 = neighbors all agree (interior of a
// domain); 0 = neighbors cancel (a defect core). Defects show as dark
// spots in an otherwise bright field.

// Single noise knob — Vicsek's order parameter is a function of η alone
// at fixed density. The geodesic mesh fixes density, so noise is the
// whole transition. (No rate param: the Vicsek update rule is a pure
// state-replacement per tick — there's no dt to multiply by, so a rate
// slider would do nothing.)
param noise     slider 0..1     step 0.005  default 0.15  label "NOISE η"
param simRateHz slider 0..120   step 1      default 60    label "SIM RATE"

step {
  stage align "Align with neighbors + random kick" {
    reads heading
    writes heading
    cell {
      // Vec2 neighbor-mean — single reduction, vec2 result. (Earlier
      // versions of v2 required pulling .x and .y as separate scalar
      // reductions; sum/mean now accept vec2 bodies directly and
      // emit a vec2<f32> accumulator.)
      let avg = mean n in neighbors { heading@n }
      // Normalize the neighborhood mean. When neighbors agree, the
      // mean is unit length already; when they disagree, the mean
      // shrinks toward zero and normalization commits to whichever
      // direction the residual points. This commitment is what
      // breaks the symmetry — without it, Vicsek collapses to
      // diffusion and never polarizes.
      let len = length(avg)
      let aligned = avg / max(len, 0.001)
      // Per-cell, per-tick random rotation. cellRand seeded by frame
      // gives independent samples each tick; cellRand seeded by cell
      // index alone would freeze the noise (defects would never
      // anneal). Scale by π·η so η=1 means full uniform random
      // rotation.
      let r = cellRand(frame) * PI * noise
      let cr = cos(r)
      let sr = sin(r)
      set heading = vec2(aligned.x * cr - aligned.y * sr, aligned.x * sr + aligned.y * cr)
    }
  }

  stage diagnostics "Compute color/metric helpers" {
    reads heading
    writes dir, align
    cell {
      // Phase angle for the colorer. atan2 returns [-π, π]; phase()
      // wraps that into the color wheel.
      set dir = atan2(heading.y, heading.x)
      // Local alignment = |neighborhood-mean heading|. 1.0 means
      // every neighbor (and self) point the same way; 0.0 means the
      // mean cancels (a defect core).
      set align = length(mean n in neighbors { heading@n })
    }
  }
}

// Global polarization order parameter, decomposed into east/north
// components. The vector (polarX, polarY) is the average heading
// over the whole sphere; its length is the standard Vicsek order
// parameter. We surface the components so the metric panel can show
// both the magnitude trend and any directional drift.
metric polarX = mean cells { heading.x }
metric polarY = mean cells { heading.y }
// Mean local alignment — a more local quantity than the global
// polarization. Stays high even when the field has many small
// domains pointing in different directions, as long as each domain
// is internally consistent.
metric meanAlign = mean cells { align }
// Defect count proxy — cells where local alignment dropped below
// 0.5 are inside or near a defect core. At equilibrium under
// moderate noise the count fluctuates around a slowly-decaying
// baseline as defects annihilate in pairs.
metric defects = count cells where align < 0.5

views {
  palette ALIGN {
    stop 0 color [12, 14, 28]
    stop 1 color [220, 240, 255]
  }

  view dir "Heading direction" {
    color wheel dir
    glyph "→" rotate=heading length=0.7 stride=2
  }

  view align "Local alignment" {
    color ramp align range [0, 0.833] palette ALIGN
    glyph "→" rotate=heading length=0.5 stride=3
  }
}

stamps {
  stamp swirl "Inject swirl" {
    // Adds a ±1 vortex worth of heading at the brush position by
    // rotating the existing heading 90° within a Gaussian footprint.
    // The runtime adds the stamped vec2 to the existing field; the
    // alignment stage will then renormalize to unit-length next tick.
    spot heading at brush.pos, radius=brush.r, amount=vec2(0, 1)
  }

  stamp counterswirl "Inject counter-swirl" {
    spot heading at brush.pos, radius=brush.r, amount=vec2(0, -1)
  }
}

scenarios {
  scenario random "Random heading per cell (default)" {
    // Default noise level — inside the polarisation regime, so the
    // sphere walks toward global alignment over ~30 wallclock seconds.
    param noise = 0.15
    for each cell {
      // cellRand returns [-1, 1]; scale to [-π, π] for full angle range.
      let theta = cellRand(7) * PI
      set heading = vec2(cos(theta), sin(theta))
    }
  }

  scenario zonal "Eastward initial flow" {
    // Starts already polarised — drop noise so it stays that way long
    // enough to read; cranking the slider afterward shows the noise →
    // disorder transition without the long warm-up.
    param noise = 0.05
    set heading = vec2(1, 0)
  }

  scenario stripes "Striped initial alignment" {
    // Striped pre-pattern wants a touch more noise than the default
    // so the domain walls visibly anneal rather than locking forever.
    param noise = 0.20
    for each cell {
      let theta = sin(lat * 4) * PI * 0.5
      set heading = vec2(cos(theta), sin(theta))
    }
  }

  scenario antipodes "Two source points" {
    // Two regions of strong eastward flow at antipodes. The
    // intervening regions start random; watch the eastward domains
    // grow and meet.
    for each cell {
      let theta = cellRand(13) * PI
      set heading = vec2(cos(theta), sin(theta))
    }
    spot heading at lon=-PI/2, lat=0.3, radius=0.4, amount=vec2(2, 0)
    spot heading at lon=PI/2,  lat=-0.3, radius=0.4, amount=vec2(2, 0)
  }
}
`;

export const pipeline = compileV2(pipelineDsl);
