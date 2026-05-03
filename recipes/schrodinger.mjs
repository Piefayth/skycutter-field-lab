// Schrödinger wave equation on a sphere — quantum particle in real
// and imaginary parts, symplectic leapfrog time stepping.
//
// The wavefunction ψ = re + i·im evolves under
//
//   i·∂ψ/∂t = Ĥψ,    Ĥ = -(ℏ²/2m)·∇² + V(x)
//
// Splitting into real and imaginary parts:
//
//   ∂re/∂t = -K·∇²im + V·im
//   ∂im/∂t = +K·∇²re - V·re
//
// where K = ℏ²/(2m) is the "kinetic" parameter and V(x) is a
// position-dependent potential (paintable with the WELL / BARRIER
// stamps). This is the time-dependent Schrödinger equation, the
// fundamental equation of quantum mechanics for a non-relativistic
// particle.
//
// Time integration is symplectic Störmer-Verlet leapfrog:
//
//   re_{n+1} = re_n + Δt·(-K·∇²im_n + V·im_n)
//   im_{n+1} = im_n + Δt·(+K·∇²re_{n+1} - V·re_{n+1})
//
// The im update uses the just-written re (sequential stages do this
// for free — stage 2 reads the field's post-stage-1 buffer). The
// resulting integrator preserves ψ-norm to second order in Δt and
// lets the wavefunction evolve indefinitely without numerical
// drift wiping out interference patterns.
//
// We use the graph Laplacian (`sum n in neighbors { f@n - f }`) for
// ∇², not the geometric one. Eigenvalues are bounded by the cell
// connectivity (~12 on a hex-mostly mesh) regardless of cell size,
// keeping the CFL stable across a broad parameter range. This makes
// the kinetic constant unitless rather than physical, but the
// qualitative dynamics — dispersion, interference, refocusing on a
// closed surface — are correct.
//
// What you'll see:
//   - Default scenario `packet`: a Gaussian wavepacket with eastward
//     momentum, released at the equator. Watch it disperse (its
//     width grows over time, the classic √t spreading), wrap around
//     the sphere, hit its own backside, and self-interfere into
//     caustic ripple patterns. After many traversals it fills the
//     whole sphere with delicate interference fringes.
//   - `doubleSlit`: two packets released simultaneously at
//     antipodal points. Their wavefronts collide on the equator,
//     making a clean two-source interference pattern frozen in time.
//   - `eigenmode`: cos(2·lat) initial real part. A spherical-
//     harmonic-ish standing wave that just oscillates in place
//     without dispersing.
//
// Painting potentials:
//   - WELL stamp drops V<0 (negative potential = attractive bowl).
//     Wavefunction concentrates inside, slowing oscillations in
//     proportion to depth.
//   - BARRIER stamp drops V>0 (positive potential = repulsive
//     barrier). Watch the wavefunction tunnel partway through and
//     reflect with characteristic phase shift.

import { compileV2 } from "../dsl/compile-v2.mjs";

export const overlays = [];

export const metrics = [
  { id: "norm",   label: "‖ψ‖²",   source: "dsl:norm",   spark: true, precision: 4 },
  { id: "peak",   label: "MAX |ψ|²", source: "dsl:peak", spark: true, precision: 3 },
  { id: "vPot",   label: "⟨V⟩",   source: "dsl:vPot",   spark: true, precision: 4 },
  { id: "spread", label: "MEAN", source: "dsl:spread", mini: true, precision: 3 },
  { id: "fps",    label: "FPS",    source: "fps",        mini: true },
];

// Regime classifier reads `peak` (the maximum probability density).
// Just-released wavepackets have high peak (concentrated); after long
// dispersion the wavefunction spreads thin, peak drops. The runaway
// threshold catches integrator instability — if peak shoots above 100
// the symplectic step has lost stability and we're in trouble.
export const regime = {
  silent:       { peak: 0 },
  intermittent: { peak: 0.1 },
  active:       { peak: 0.5 },
  runaway:      { peak: 50 },
};

export const pipelineDsl = `
recipe "Schrödinger packet (sphere)"
summary "Quantum particle on a sphere. ψ = re + i·im evolves by Schrödinger's equation in symplectic leapfrog form. Default scenario releases an eastward Gaussian wavepacket at the equator — watch it disperse, traverse the sphere, hit its own backside, and fill the surface with self-interference caustics. Paint potentials with the WELL or BARRIER stamps to bend the wave."
recommendedPreset packet

substrate geodesic frequency 32

field re: f32                  // Re(ψ)
field im: f32                  // Im(ψ)
field V: f32                   // Potential V(x), paintable

field prob: f32 derived        // |ψ|² for visualization
field phase: f32 derived       // arg(ψ) for the phase colorer

// |ψ|² — standard quantum probability density. Black where the
// particle isn't, bright where it is.

// arg(ψ) — color wheel. The richest visualization: a dispersing
// wavepacket fills with rapid color rotations, two wavepackets
// meeting trace clear hyperbolic interference fringes.

// Re(ψ) directly — signed, so use the diverging palette. Reads like
// the amplitude of a real wave; the carrier oscillation is visible
// as it traverses the sphere.

// V(x) — paintable potential. Wells appear blue, barriers red.

// CFL: the leapfrog step is stable when K·Δt·max_eig(∇²) < 2. With
// the graph Laplacian's max eigenvalue ≈ 12 and Δt = (1/60)·rate at
// the default rate=4, K_max ≈ 2/(0.067·12) ≈ 2.5. The slider stays
// inside that bound. If you push K to the right you'll see the
// integrator go unstable — phase color will start flickering at the
// pixel level and ‖ψ‖² will spike.
param kinetic   slider 0..2.5  step 0.02   default 1.0    label "K = ℏ²/2m"
// Tiny phenomenological damping. Set to 0 for true symplectic
// integration that preserves ‖ψ‖² indefinitely; nonzero values bleed
// energy slowly so long-running scenarios don't accumulate
// numerical noise.
param damping   slider 0..0.02 step 0.0005 default 0.001  label "DAMPING"
// Initial wavepacket momentum (used by the packet and doubleSlit
// scenarios). Higher = faster traveling wave.
param k0        slider 0..40   step 1      default 12     label "INITIAL k"
param simRateHz slider 0..120  step 1      default 60     label "SIM RATE"
param rate      slider 1..10   step 1      default 4      label "RATE"

step {
  // Stage 1 — Real part update.
  //
  //   re_{n+1} = re_n + Δt·(-K·∇²im - V·im) - damping·re
  //
  // The graph Laplacian \`sum n in neighbors { im@n - im }\` returns
  // 6·im_avg - 6·im (or 5·... at the 12 pentagonal cells). It's
  // unitless: the discretization absorbs the cell-spacing into the
  // kinetic constant K rather than into the operator.
  stage updateRe "Real part step" {
    reads re, im, V
    writes re
    cell {
      let lap_im = sum n in neighbors { im@n - im }
      let dre = -kinetic * lap_im - V * im
      add re = dre * dt * rate - re * damping * dt * rate
    }
  }

  // Stage 2 — Imaginary part update.
  //
  //   im_{n+1} = im_n + Δt·(+K·∇²re_{n+1} + V·re_{n+1}) - damping·im
  //
  // Reads the just-written re from stage 1 (the runtime swaps the
  // re buffer between stages, so this stage's \`re\` is the
  // updated value). That sequencing is what makes the integrator
  // symplectic — without it the leapfrog falls back to forward-
  // Euler, which doesn't preserve ‖ψ‖² and has a much tighter CFL.
  stage updateIm "Imaginary part step" {
    reads re, im, V
    writes im
    cell {
      let lap_re = sum n in neighbors { re@n - re }
      let dim = kinetic * lap_re + V * re
      add im = dim * dt * rate - im * damping * dt * rate
    }
  }

  // Stage 3 — Diagnostics for the renderer / metrics.
  //
  // |ψ|² and arg(ψ) are pure functions of re/im. Computing them
  // here keeps them out of the time-integration hot loop and gives
  // the metric reductions a fresh post-tick read.
  stage diagnostics "Probability density + phase" {
    reads re, im
    writes prob, phase
    cell {
      set prob = re * re + im * im
      set phase = atan2(im, re)
    }
  }
}

// Live observables.
//
// ‖ψ‖² should be exactly constant under undamped symplectic
// integration (and observably stable to second order in Δt with
// nonzero damping). vPot = ⟨V⟩ tracks potential energy. Peak gives
// a sense of how localized the wavefunction is — a freshly-released
// packet has high peak; after long dispersion it spreads thin and
// peak drops. (Kinetic energy ⟨-K·∇²⟩ would need a separate gradient
// stage; skipping for now to keep the recipe tight.)
metric norm   = sum  cells { prob }
metric vPot   = sum  cells { V * prob }
metric peak   = max  cells { prob }
metric spread = mean cells { prob }

views {
  palette PROB {
    stop 0 color [4, 6, 16]
    stop 1 color [255, 220, 90]
  }

  palette DIVERGE {
    stop 0 color [40, 100, 240]
    stop 1 color [235, 76, 70]
  }

  view prob "Probability |ψ|²" {
    color ramp prob range [0, 0.2] palette PROB
  }

  view phase "Phase arg(ψ)" {
    color wheel phase
  }

  view re "Re(ψ)" {
    color ramp re range [-0.667, 0.667] palette DIVERGE
  }

  view V "Potential V(x)" {
    color ramp V range [-0.2, 0.2] palette DIVERGE
  }
}

stamps {
  stamp packetStamp "Wavepacket (no momentum)" {
    // Drop a Gaussian bump in re. Spreads outward immediately
    // (zero-momentum packets disperse fastest because every
    // wavevector contributes equally to the spreading rate).
    spot re at brush.pos, radius=brush.r, amount=1
  }

  stamp well "Potential well" {
    // Negative V — attractive. The wave gets trapped, oscillating
    // in place at the well's bound-state frequency.
    spot V at brush.pos, radius=brush.r, amount=-3
  }

  stamp barrier "Potential barrier" {
    // Positive V — repulsive. The wave reflects off the wall,
    // some leaks through (quantum tunneling). The reflection picks
    // up a phase shift visible in the phase view.
    spot V at brush.pos, radius=brush.r, amount=3
  }

  stamp clearV "Clear potential" {
    spot V at brush.pos, radius=brush.r, amount=-1000
  }
}

scenarios {
  scenario packet "Eastward Gaussian wavepacket" {
    // ψ(x) = exp(-r²/(2σ²)) · exp(i·k·lon)
    // Real and imaginary parts encode position localization × plane-
    // wave momentum. The packet starts off-center so its travel is
    // visually obvious: it propagates eastward at group velocity
    // proportional to k, dispersing as it goes.
    set re = 0
    set im = 0
    set V = 0
    for each cell {
      let dlon = lon - 0.6
      let dlat = lat
      let r2 = dlon*dlon + dlat*dlat
      let env = exp(-r2 / 0.04)
      let theta = lon * k0
      set re = env * cos(theta)
      set im = env * sin(theta)
    }
  }

  scenario doubleSlit "Two packets meeting" {
    // Antipodal release — packets travel toward each other and
    // collide at the equator. The collision is a clean two-source
    // interference pattern.
    set re = 0
    set im = 0
    set V = 0
    for each cell {
      let env1 = exp(-(((lon + 1.2)*(lon + 1.2)) + lat*lat) / 0.04)
      let env2 = exp(-(((lon - 1.2)*(lon - 1.2)) + lat*lat) / 0.04)
      let theta1 = lon * k0
      let theta2 = lon * (-k0)
      set re = env1 * cos(theta1) + env2 * cos(theta2)
      set im = env1 * sin(theta1) + env2 * sin(theta2)
    }
  }

  scenario eigenmode "Standing wave (eigenmode-like)" {
    // cos(2·lat) initial real part with zero imaginary. A standing
    // wave that oscillates in place rather than traveling — the
    // ‖ψ‖² is constant in time, only the phase rotates uniformly.
    set re = 0
    set im = 0
    set V = 0
    for each cell {
      set re = cos(lat * 4) * 0.5
    }
  }

  scenario quietGround "Flat low-amplitude background" {
    // Tiny uniform amplitude — useful for seeing how the WELL stamp
    // localizes the wavefunction from a near-zero ground state.
    set re = 0.05
    set im = 0
    set V = 0
  }
}
`;

export const pipeline = compileV2(pipelineDsl);
