// Wave equation on the sphere — explicit displacement + velocity form.
//
// The classical wave equation ∂²u/∂t² = c²·∇²u can be written as a
// first-order system:
//
//   ∂v/∂t = c²·∇²u − γ·v
//   ∂u/∂t = v
//
// where u is displacement and v is velocity. This is slightly more
// verbose than the leapfrog `u@prev` form, but it is much better for
// interactive authoring: a brush can explicitly paint displacement
// (`u`) or impulse/velocity (`v`) instead of relying on hidden
// current-vs-previous-buffer asymmetry.
//
// On a closed surface there's no boundary condition to handle, no
// reflections to worry about — clean physics, geodesic-native.

import { compileV2 } from "../dsl/compile-v2.mjs";

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
summary "Hyperbolic wave on the sphere — displacement plus velocity first-order integration. The ripple stamp uses stroke phases: a one-shot surface drop on press, then velocity-only injection while held."
recommendedPreset droplet

substrate geodesic frequency 64

field u: f32      // displacement
field v: f32      // velocity / impulse

// Diverging palette with a stark white seam at zero — the propagating
// wavefront reads as a sharp line. Asymmetric saturation: small
// amplitudes already pop, large ones don't blow out to pure white.
// Stop t-values normalized into [0, 1] across the chosen range [-1, 1].

// Effective wave speed. The explicit first-order update uses
// dt directly; on frequency 64, speed around 1.2 gives visible
// propagation while staying comfortably stable at 60Hz.
param speed   slider 0..1.6 step 0.01 default 1.2 label "WAVE SPEED"
// Linear damping γ in ∂v/∂t = ... - γv. 0 = energy rings forever.
param damping slider 0..2   step 0.01 default 0   label "DAMPING γ"

step {
  stage accelerate "Velocity step" {
    reads u, v
    writes v
    cell {
      let lap = sum n in neighbors { u@n - u }
      let nextV = v + (speed * speed * lap - damping * v) * dt
      set v = clamp(nextV, -24, 24)
    }
  }

  stage integrate "Displacement step" {
    reads u, v
    writes u
    cell {
      set u = clamp(u + v * dt, -2, 2)
    }
  }
}

// V2 metric reductions — computed on the GPU each tick (per-cell pass +
// workgroup tree-reduce), async-read back to populate the metrics panel.
metric peak   = max cells { abs(u) }
metric active = count cells where abs(u) > 0.1
metric motion = mean cells { abs(v) }

views {
  palette WAVE {
    stop 0.000 color [40, 90, 200]
    stop 0.350 color [120, 170, 230]
    stop 0.475 color [240, 240, 240]
    stop 0.525 color [240, 240, 240]
    stop 0.650 color [240, 160, 110]
    stop 1.000 color [200, 50, 30]
  }

  view u "Amplitude (u)" {
    color ramp u range [-1, 1] palette WAVE
  }

  view v "Velocity (v)" {
    color ramp v range [-16, 16] palette WAVE
  }
}

stamps {
  stamp ripple "Drop ripple" {
    on press {
      // One-shot visible surface bump, matching the preset's "drop a
      // stone" moment without pinning u for the whole held stroke.
      spot u at brush.pos, radius=brush.r, amount=0.8
    }
    on drag {
      // Continuous impulse while held. This keeps adding wave energy
      // without fighting the displacement field's phase.
      spot v at brush.pos, radius=brush.r, amount=16
    }
  }

  stamp lift "Lift surface" {
    // Direct displacement edit. Useful for sculpting a raised surface;
    // unlike RIPPLE, holding this brush intentionally pins/lifts u.
    spot u at brush.pos, radius=brush.r * 1.6, amount=0.5
  }

  stamp dampen "Quiet zone" {
    // Exact local reset: quiet both displacement and velocity.
    set u at brush.pos, radius=brush.r, value=0
    set v at brush.pos, radius=brush.r, value=0
  }
}

scenarios {
  scenario still "Still surface" {
    set u = 0
    set v = 0
  }

  scenario droplet "Single droplet" {
    set u = 0
    set v = 0
    spot u at lon=0, lat=0, radius=0.08, amount=1
    spot v at lon=0, lat=0, radius=0.08, amount=5
  }

  scenario twoStones "Two pebbles" {
    // Two drops at antipodes — wave fronts meet at the equator.
    set u = 0
    set v = 0
    spot u at lon=-PI/2, lat=0.4,  radius=0.06, amount=1
    spot v at lon=-PI/2, lat=0.4,  radius=0.06, amount=5
    spot u at lon= PI/2, lat=-0.4, radius=0.06, amount=1
    spot v at lon= PI/2, lat=-0.4, radius=0.06, amount=5
  }

  scenario standing "Standing wave seed" {
    // cos(2·lon) displacement with zero initial velocity.
    set u = 0
    set v = 0
    for each cell {
      set u = cos(lon * 2) * 0.6
    }
  }
}
`;

export const pipeline = compileV2(pipelineDsl);
