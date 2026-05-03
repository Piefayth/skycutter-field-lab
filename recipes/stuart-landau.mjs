// Stuart-Landau (1944) — the canonical normal-form model of a Hopf
// bifurcation. Each cell carries a complex amplitude A = re + i·im
// and the per-cell dynamics are:
//
//   dA/dt = (μ + i·ω) · A − (1 + i·c) · |A|² · A
//
// Splitting into real and imaginary parts and adding diffusive
// coupling on each:
//
//   d(re)/dt = μ·re − ω·im − r²·(re − c·im) + D·∇²re
//   d(im)/dt = μ·im + ω·re − r²·(im + c·re) + D·∇²im
//
// where r² = re² + im². At μ > 0 each cell relaxes onto a circular
// limit cycle of radius √μ and rotates at angular frequency ω. The
// extra c·im / c·re terms are the "shear" — when c ≠ 0, oscillation
// frequency depends on amplitude (anisochronicity). Strong shear
// gives the famous Benjamin-Feir instability: the synchronous limit
// cycle destabilises and patches of phase chaos nucleate.
//
// What's different from Kuramoto: Kuramoto oscillators have FIXED
// amplitude and only their phases evolve. Stuart-Landau lets
// amplitude breathe. Combined with diffusion this opens up a much
// richer phase diagram — quiescent, synchronous, chimera, defect
// turbulence, all reachable by sliders.
//
// Why on a sphere: closed surface plus finite mesh size produces
// topologically-constrained defect patterns (phase singularities
// that can't disappear except by pair annihilation). The 12
// pentagonal cells pin defect cores naturally.

import { compileV2 } from "../dsl/compile-v2.mjs";

export const overlays = [];

export const metrics = [
  { id: "meanAmp", label: "MEAN |A|",  source: "dsl:meanAmp", spark: true, precision: 3 },
  { id: "ampVar",  label: "VAR |A|",   source: "dsl:ampVar",  spark: true, precision: 3 },
  { id: "fps",     label: "FPS",       source: "fps",         mini: true },
];

export const regime = {
  silent:       { meanAmp: 0 },
  intermittent: { ampVar: 0.005 },
  active:       { ampVar: 0.05 },
  runaway:      { meanAmp: 5 },
};

export const pipelineDsl = `
recipe "Stuart-Landau coupled oscillators"
summary "Sphere-wide grid of complex Hopf-normal-form oscillators with diffusive coupling. Each cell carries (re, im) amplitude; |A| = √(re²+im²) saturates to √μ; the phase wraps via mod(atan2(im, re), TAU). The shear parameter c (anisochronicity — frequency depends on amplitude) drives the Benjamin-Feir instability: at large c the synchronous limit cycle gives way to defect turbulence with phase singularities pinned to pentagonal cells."
recommendedPreset noisy

substrate geodesic frequency 32

field re:    f32                      // real part of complex amplitude A
field im:    f32                      // imaginary part of A
field amp:   f32 derived              // |A| = sqrt(re² + im²) for views/metrics
field phase: f32 derived              // atan2(im, re) wrapped into [0, TAU) for the wheel view

// Linear gain. μ > 0 makes the origin unstable (Hopf side); each cell
// converges onto a limit cycle of radius √μ. μ < 0 quenches everything.
param MU      slider -0.2..1   step 0.005 default 0.30  label "μ (GAIN)"
// Natural frequency. Sets the rotation speed of the limit cycle in
// rad / sim-time-unit.
param OMEGA   slider 0..3      step 0.01  default 1.20  label "ω (FREQUENCY)"
// Shear / anisochronicity. c = 0 gives perfectly isochronous
// oscillators; c near 1 gives Benjamin-Feir-unstable defect
// turbulence; c around 0.5 is on the boundary.
param C       slider -2..2     step 0.01  default 0.80  label "c (SHEAR)"
// Spatial diffusion of the complex amplitude (real and imag parts
// each independently). Couples neighbours into either synchronous
// patches or interleaved phase domains depending on c.
param DA      slider 0..0.3    step 0.005 default 0.04  label "D (DIFFUSE)"

param simRateHz slider 0..360 step 1     default 60    label "SIM RATE"
param rate      slider 1..40  step 1     default 8     label "RATE"

step {
  // Stage 1 — diffuse re and im across neighbours. Diffusing the two
  // components independently is equivalent to diffusing the complex
  // amplitude A as a single quantity (Laplacian commutes with the
  // real/imag projection), so the dynamics aren't biased by the
  // chosen coordinate split.
  stage diffuse "Diffuse complex amplitude" {
    reads re, im
    writes re, im
    cell {
      add re = (mean n in neighbors { re@n } - re) * clamp(DA * 0.16 * dt * rate, 0, 0.24)
      add im = (mean n in neighbors { im@n } - im) * clamp(DA * 0.16 * dt * rate, 0, 0.24)
    }
  }

  // Stage 2 — local Stuart-Landau dynamics. The (μ + iω)·A linear
  // term grows the amplitude and rotates the phase; the −(1 + ic)·|A|²·A
  // saturates amplitude at √μ and bends the phase as |A| changes.
  stage rotate "Hopf normal form" {
    reads re, im
    writes re, im
    cell {
      let r2 = re * re + im * im
      let dRe = MU * re - OMEGA * im - r2 * (re - C * im)
      let dIm = MU * im + OMEGA * re - r2 * (im + C * re)
      add re = dRe * dt * rate
      add im = dIm * dt * rate
    }
  }

  // Stage 3 — derived projections for views + metrics. atan2 returns
  // [-π, π] but the colour-wheel view wants [0, TAU) so phase wraps
  // there are no visible seams — that's the mod() on the wrap point.
  stage diagnostics "Amplitude + wrapped phase" {
    reads re, im
    writes amp, phase
    cell {
      set amp   = sqrt(re * re + im * im)
      set phase = mod(atan2(im, re), TAU)
    }
  }
}

metric meanAmp = mean cells { sqrt(re * re + im * im) }
metric ampVar  = mean cells { re * re + im * im } - (mean cells { sqrt(re * re + im * im) }) * (mean cells { sqrt(re * re + im * im) })

views {
  // Phase wheel — atan2 / TAU mapped onto a 6-stop colour wheel.
  // Synchronous patches show a single colour; turbulent regions
  // show every colour at once.
  palette WHEEL {
    stop 0     color [220, 60,  90]
    stop 0.166 color [220, 200, 60]
    stop 0.333 color [120, 220, 60]
    stop 0.5   color [60,  220, 200]
    stop 0.666 color [60,  120, 220]
    stop 0.833 color [180, 60,  220]
    stop 1     color [220, 60,  90]
  }

  // Amplitude — |A| ranges around √μ at default. Bright = strong
  // oscillator; dim = phase singularity (where amplitude must vanish).
  palette AMP {
    stop 0   color [10, 14, 22]
    stop 0.5 color [120, 80, 60]
    stop 1   color [255, 230, 180]
  }

  view phase "Phase (wheel)" {
    color ramp phase range [0, TAU] palette WHEEL
  }

  view amplitude "Amplitude |A|" {
    color ramp amp range [0, 1.5] palette AMP
  }
}

stamps {
  stamp kick "Kick amplitude (real component)" {
    spot re at brush.pos, radius=brush.r, amount=0.4
  }

  stamp twist "Inject imaginary kick" {
    spot im at brush.pos, radius=brush.r, amount=0.4
  }

  stamp quench "Quench to origin" {
    spot re at brush.pos, radius=brush.r, amount=-2
    spot im at brush.pos, radius=brush.r, amount=-2
  }
}

scenarios {
  scenario noisy "Random tiny perturbations (default)" {
    // Each cell starts close to the origin with a small random
    // (re, im) kick. The Hopf instability amplifies the perturbation
    // onto the limit cycle — within a few sim-seconds the amplitude
    // is around √μ everywhere.
    for each cell {
      set re = cellRand(7) * 0.05
      set im = cellRand(11) * 0.05
    }
  }

  scenario synced "Phase-locked everywhere" {
    // All cells start at A = √μ on the positive real axis. With c=0
    // the synchronous state is stable and stays so; with c large
    // enough the Benjamin-Feir instability makes it spontaneously
    // shatter into phase domains and defects.
    set re = 0.55
    set im = 0
  }

  scenario hemispheres "Two phase-locked domains" {
    // Northern and southern hemispheres start in opposite phases —
    // a domain wall on the equator. Diffusion either heals the wall
    // (low c) or pinches off persistent phase defects (high c).
    for each cell {
      set re = lat > 0 ? 0.55 : -0.55
      set im = 0
    }
  }

  scenario defects "Pre-seeded phase defects" {
    // Six discrete phase singularities — paired (+/−) charges around
    // the equator. Useful for watching defects drift, pair-annihilate,
    // and pin to the icosahedron's pentagonal vertices.
    set re = 0.5
    set im = 0
    spot re at lon=0,    lat=0,   radius=0.15, amount=-1.0
    spot im at lon=0,    lat=0,   radius=0.15, amount=0.8
    spot re at lon=2.0,  lat=0.4, radius=0.15, amount=-1.0
    spot im at lon=2.0,  lat=0.4, radius=0.15, amount=-0.8
    spot re at lon=-2.0, lat=-0.4, radius=0.15, amount=-1.0
    spot im at lon=-2.0, lat=-0.4, radius=0.15, amount=0.8
  }
}
`;

export const pipeline = compileV2(pipelineDsl);
