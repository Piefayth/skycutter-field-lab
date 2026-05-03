// Wave equation on the sphere — second-order time integration.
//
// The classical wave equation ∂²u/∂t² = c²·∇²u, leapfrog-discretized:
//
//   u_new = 2·u − prev(u) + (c·dt)²·∇²u − γ·(u − prev(u))
//                                          \_________________/
//                                         optional damping term
//
// where prev(u) is the field's value as of the previous tick. The
// substrate is hyperbolic — energy moves but doesn't dissipate at
// γ=0, so a single seeded ripple bounces around the sphere forever.
// At the antipode of the source, two opposing wavefronts converge
// and produce a dramatic phase-amplification spike before
// continuing past each other.
//
// On a closed surface there's no boundary condition to handle, no
// reflections to worry about — clean physics, geodesic-native.

import { compileV2 } from "../dsl/compile-v2.mjs";

// Wave-amplitude colorer. u is signed (positive crests, negative
// troughs); a diverging palette with a stark white seam at zero
// makes the propagating wavefront read as a sharp line. Saturation
// boosts asymmetrically — small amplitudes already pop, large ones
// don't blow out to pure white.
function waveAmplitude(fieldName) {
  const NEG = [40, 90, 200];   // deep blue trough
  const NEG_MID = [120, 170, 230];
  const ZERO = [240, 240, 240];
  const POS_MID = [240, 160, 110];
  const POS = [200, 50, 30];   // hot red crest

  const stops = [
    { t: -1.0, c: NEG },
    { t: -0.3, c: NEG_MID },
    { t: -0.05, c: ZERO },
    { t:  0.05, c: ZERO },
    { t:  0.3,  c: POS_MID },
    { t:  1.0,  c: POS },
  ];

  function lookup(amp) {
    if (!Number.isFinite(amp)) return [80, 60, 90];
    const t = Math.max(-1.5, Math.min(1.5, amp));
    if (t <= stops[0].t) return stops[0].c;
    if (t >= stops[stops.length - 1].t) return stops[stops.length - 1].c;
    for (let s = 0; s < stops.length - 1; s++) {
      const a = stops[s];
      const b = stops[s + 1];
      if (t >= a.t && t <= b.t) {
        const f = (t - a.t) / (b.t - a.t);
        return [
          Math.round(a.c[0] + (b.c[0] - a.c[0]) * f),
          Math.round(a.c[1] + (b.c[1] - a.c[1]) * f),
          Math.round(a.c[2] + (b.c[2] - a.c[2]) * f),
        ];
      }
    }
    return [128, 128, 128];
  }

  const color = (i, fields) => lookup(fields[fieldName][i]);
  color.write = (i, fields, data, k) => {
    const [r, g, b] = lookup(fields[fieldName][i]);
    data[k + 0] = r; data[k + 1] = g; data[k + 2] = b;
  };
  color.fields = [fieldName];
  return color;
}

export const views = [
  { id: "u", label: "Amplitude (u)", color: waveAmplitude("u") },
];

export const overlays = [];

// Per-recipe FPS readout stays JS-side (it's not field state). The
// peak/active metrics moved into the DSL itself — see the
// `metric peak = ...` and `metric active = ...` lines in pipelineDsl
// below. The recipe metrics panel auto-merges DSL-declared metrics
// (via dsl:<id> sources) with these explicit JS-side entries.
export const metrics = [
  { id: "fps", label: "FPS", source: "fps", mini: true },
];

export const regime = {
  silent:        {},
  intermittent:  { active: 0.02 },
  active:        { active: 0.1 },
  runaway:       { active: 0.6 },
};

export const pipelineDsl = `
recipe "Wave equation"
summary "Hyperbolic wave on the sphere — leapfrog second-order time integration. A stamp drops a ripple; with no damping it bounces around the sphere forever, with two opposing wavefronts converging at the antipode in a phase-amplification spike. CFL-stable at default speed; cranking it past ~0.29 will make the integrator explode."
recommendedPreset droplet

substrate geodesic frequency 64

// History 1 buffer is allocated automatically when the compiler sees
// any \`u@prev\` reference — no manual \`history N\` declaration needed.
field u: f32

// Effective wave speed coefficient. Per-tick update for a wavefront
// at a sharp gradient is ~ speed² · neighbor-count, so this also
// gates CFL stability. The discrete Laplacian on hexagonal cells
// has max eigenvalue ~12, giving the bound speed² · 12 < 1 →
// speed < ~0.29. Default 0.25 sits comfortably under the line.
param speed   slider 0..0.29 step 0.005 default 0.25 label "WAVE SPEED"
// Linear damping (γ in the equation). 0 = energy never dissipates,
// waves bounce around the sphere indefinitely. Cranking up makes
// the system feel like a viscous medium — like ringing a struck bell
// underwater.
param damping slider 0..0.05 step 0.001 default 0    label "DAMPING γ"

stamp ripple "Drop ripple" {
  // A pulse on u; prev(u) is unchanged (paint never mirrors to prev),
  // so the asymmetry between current and prev creates an outgoing
  // wave with launch velocity equal to the stamp amplitude.
  spot u at brush.pos, radius=brush.r, amount=1
}

stamp lift "Lift surface" {
  // Smaller bump, broader area — gentler wavetrain.
  spot u at brush.pos, radius=brush.r * 1.6, amount=0.4
}

stamp dampen "Quiet zone" {
  // Negative spot — pushes the medium toward zero locally.
  spot u at brush.pos, radius=brush.r, amount=-1
}

scenario still "Still surface" {
  set u = 0
}

scenario droplet "Single droplet" {
  set u = 0
  spot u at lon=0, lat=0, radius=0.08, amount=1
}

scenario twoStones "Two pebbles" {
  // Two drops at antipodes — wave fronts will meet at the equator.
  set u = 0
  spot u at lon=-PI/2, lat=0.4,  radius=0.06, amount=1
  spot u at lon= PI/2, lat=-0.4, radius=0.06, amount=1
}

scenario standing "Standing wave seed" {
  // cos(2·lon) pattern. With zero initial velocity (prev = current
  // after init), this splits into two counter-rotating travelling
  // waves whose superposition oscillates.
  set u = 0
  for each cell {
    set u = cos(lon * 2) * 0.6
  }
}

step {
  stage propagate "Leapfrog wave step" {
    reads u
    writes u
    cell {
      // Discrete Laplacian — sum of (neighbor − self) over neighbors.
      // For a sphere with mostly-hex tiling, this has max eigenvalue
      // ~12, which sets the CFL bound on \`speed\`.
      let lap = sum n in neighbors { u@n - u }
      // Damping: γ × (u − u@prev). Always opposes local velocity.
      let damp = damping * (u - u@prev)
      let raw = 2 * u - u@prev + speed * speed * lap - damp
      // Inline clamp keeps a CFL-violating speed from blowing up the
      // GPU buffer with NaN; saturation reads as a visible flat patch
      // rather than a silent black sphere.
      set u = clamp(raw, -2, 2)
    }
  }
}

// V2 metric reductions — computed on the GPU each tick (per-cell pass +
// workgroup tree-reduce), async-read back to populate the metrics panel.
// The post-step state (final u after history rotation) is what reduces.
metric peak   = max cells { abs(u) }
metric active = count cells where abs(u) > 0.1
`;

export const pipeline = compileV2(pipelineDsl);
