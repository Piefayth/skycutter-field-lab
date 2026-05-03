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

import { compileDsl } from "../dsl/compiler.mjs";

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

export const metrics = [
  { id: "energy",   label: "ENERGY",   source: "max:u",          spark: true, precision: 3 },
  { id: "active",   label: "ACTIVE",   source: "coverage:u:0.1", mini: true,  precision: 3 },
  { id: "fps",      label: "FPS",      source: "fps",            mini: true },
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
grid geodesic tiles 64

use clock dt, frame, prev
use geo lon, lat, x, y, i, N, PI, TAU
use sim cell, clamp
use init fill, spot, eachCell
use core clamp, smoothstep, max, min, abs, hypot, sin, cos, cellNoise, neighbor

// History 1: each tick we read u_prev to integrate the second-order
// time derivative. The runtime keeps a separate history buffer that
// gets snapshotted at tick boundaries.
field u history 1

setting simRateHz slider min 0 max 360 step 1 default 60 label "SIM RATE"
// Effective wave speed coefficient. Per-tick update for a wavefront
// at a sharp gradient is ~ speed² · neighbor-count, so this also
// gates CFL stability. The discrete Laplacian on hexagonal cells
// has max eigenvalue ~12, giving the bound speed² · 12 < 1 →
// speed < ~0.29. Default 0.25 sits comfortably under the line.
param speed   slider min 0  max 0.29  step 0.005 default 0.25  label "WAVE SPEED"
// Linear damping (γ in the equation). 0 = energy never dissipates,
// waves bounce around the sphere indefinitely. Cranking up makes
// the system feel like a viscous medium — like ringing a struck bell
// underwater.
param damping slider min 0  max 0.05  step 0.001 default 0.0   label "DAMPING γ"

stamp ripple "Drop ripple" {
  // A pulse on u with prev(u) unchanged — the asymmetry creates an
  // outgoing wave (impulse velocity = u − prev_u, so post-stamp
  // velocity equals the stamp amplitude).
  spot u lon lon lat lat radius r amount 1
}

stamp lift "Lift surface" {
  // Smaller bump, broader area — gentler wavetrain.
  spot u lon lon lat lat radius r * 1.6 amount 0.4
}

stamp dampen "Quiet zone" {
  // Negative spot — pushes the medium toward zero locally.
  spot u lon lon lat lat radius r amount -1
}

preset still "Still surface" {
  fill u 0
}

preset droplet "Single droplet" {
  fill u 0
  spot u lon 0 lat 0 radius 0.08 amount 1
}

preset twoStones "Two pebbles" {
  // Two drops at antipodes — wave fronts will meet at the equator.
  fill u 0
  spot u lon -PI/2 lat 0.4 radius 0.06 amount 1
  spot u lon  PI/2 lat -0.4 radius 0.06 amount 1
}

preset standing "Standing wave seed" {
  // A cos(2·lon) pattern. With nonzero ω initial velocity, this
  // would sustain as a standing wave; with zero velocity (prev = u
  // by default), it splits into two counter-rotating travelling
  // waves whose superposition oscillates.
  fill u 0
  eachCell {
    set u = cos(lon * 2) * 0.6
  }
}

stage propagate "Leapfrog wave step" {
  reads u
  writes u
  cell {
    // Discrete Laplacian — sum of (neighbor − self) over neighbors.
    // For a sphere with mostly-hex tiling, this has max eigenvalue
    // ~12, which sets the CFL bound on \`speed\`.
    let lap = neighbor sum n in u { n - u }
    // Damping term: γ × (u − u_prev). Subtracted from the update so
    // it always opposes the local velocity.
    let damp = damping * (u - prev(u))
    let raw = 2 * u - prev(u) + speed * speed * lap - damp
    // Inline clamp keeps a CFL-violating speed from blowing up the
    // GPU buffer with NaN; saturation reads as a visible flat patch
    // rather than a silent black sphere. History fields can only be
    // written by one stage per tick, so the clamp folds in here.
    set u = clamp(raw, -2, 2)
  }
}
`;

export const pipeline = compileDsl(pipelineDsl);
