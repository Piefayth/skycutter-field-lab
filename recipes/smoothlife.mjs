// SmoothLife-inspired continuous cellular automaton on the geodesic mesh.
//
// This recipe exists mostly to dogfood topological k-neighborhoods. Classic
// SmoothLife uses metric disks / annuli in the plane; field-lab currently has
// bounded topological `disk(k)` and `ring(k)` over the icosphere graph. That is
// intentionally not the same thing. If the pentagon-shell artifacts are too
// visible here, that is a useful signal that the next DSL primitive should be
// weighted metric kernels, not wider graph rings.

import { compileV2 } from "../dsl/compile-v2.mjs";

export const overlays = [];

export const metrics = [
  { id: "mass", label: "MASS", source: "dsl:mass", spark: true, precision: 3 },
  { id: "activityMean", label: "ACTIVITY", source: "dsl:activityMean", spark: true, precision: 3 },
  { id: "edgeMean", label: "EDGE", source: "dsl:edgeMean", mini: true, precision: 3 },
  { id: "fps", label: "FPS", source: "fps", mini: true },
];

export const regime = {
  silent: { activityMean: 0.0001 },
  intermittent: { activityMean: 0.004 },
  active: { activityMean: 0.02 },
  runaway: { activityMean: 0.35 },
};

export const pipelineDsl = `
recipe "SmoothLife topological"
summary "SmoothLife-style continuous cellular automaton using topological disk/ring reductions. disk(2) estimates local mass; ring(3) estimates the outer annulus. This is intentionally a dogfood recipe for graph-distance neighborhoods, not a faithful metric-kernel SmoothLife."
recommendedPreset islands

substrate geodesic frequency 48

field u: f32
field activity: f32 derived
field edge: f32 derived

param birthLo slider 0..1 step 0.001 default 0.278 label "BIRTH LOW"
param birthHi slider 0..1 step 0.001 default 0.365 label "BIRTH HIGH"
param deathLo slider 0..1 step 0.001 default 0.267 label "SURVIVE LOW"
param deathHi slider 0..1 step 0.001 default 0.445 label "SURVIVE HIGH"
param softness slider 0.005..0.2 step 0.001 default 0.030 label "SOFTNESS"
param response slider 0..8 step 0.01 default 2.4 label "RESPONSE"
param simRateHz slider 0..120 step 1 default 45 label "SIM RATE"
param rate slider 1..10 step 1 default 1 label "RATE"

step {
  stage evolve "Topological SmoothLife step" {
    reads u
    writes u, activity, edge
    cell {
      // Inner mass: local occupancy around the cell.
      let inner = mean n in disk(2) { u@n }
      // Outer annulus: exact graph shell three edges away. This is the
      // recipe's central dogfood point; classic SmoothLife wants a metric
      // annulus, but v2 now has a topological shell.
      let outer = mean n in ring(3) { u@n }

      // Window helper built from two smooth ramps:
      //   1 inside [lo, hi], 0 outside, soft boundaries.
      let birthWindow = smoothstep(birthLo, birthLo + softness, outer) * (1 - smoothstep(birthHi, birthHi + softness, outer))
      let surviveWindow = smoothstep(deathLo, deathLo + softness, outer) * (1 - smoothstep(deathHi, deathHi + softness, outer))

      // Blend between birth and survival rules based on whether the inner
      // disk is mostly dead or mostly alive.
      let aliveMix = smoothstep(0.5 - softness, 0.5 + softness, inner)
      let desired = birthWindow * (1 - aliveMix) + surviveWindow * aliveMix
      let next = clamp(u + (desired - u) * response * dt, 0, 1)

      set activity = abs(next - u)
      set edge = abs(outer - inner)
      set u = next
    }
  }
}

metric mass = mean cells { u }
metric activityMean = mean cells { activity }
metric edgeMean = mean cells { edge }

views {
  palette LIFE {
    stop 0 color [8, 12, 18]
    stop 0.35 color [45, 88, 118]
    stop 0.65 color [120, 205, 154]
    stop 1 color [245, 242, 190]
  }

  palette ACTIVITY {
    stop 0 color [8, 10, 14]
    stop 0.5 color [80, 120, 220]
    stop 1 color [255, 210, 70]
  }

  view u "Life field" {
    color ramp u range [0, 1] palette LIFE
  }

  view activity "Activity" {
    color ramp activity range [0, 0.08] palette ACTIVITY
  }

  view edge "Inner / outer contrast" {
    color ramp edge range [0, 0.5] palette ACTIVITY
  }
}

stamps {
  stamp seed "Seed life" {
    spot u at brush.pos, radius=brush.r, amount=1
  }

  stamp erase "Erase" {
    spot u at brush.pos, radius=brush.r, amount=-1
  }

  stamp soften "Half-tone" {
    spot u at brush.pos, radius=brush.r, amount=0.35
  }
}

scenarios {
  scenario islands "Random islands" {
    for each cell {
      let r = cellRand(17) * 0.5 + 0.5
      let bands = sin(lon * 5) * cos(lat * 4)
      set u = (r + bands * 0.25) > 0.58 ? 1 : 0
    }
  }

  scenario equator "Equatorial band" {
    for each cell {
      let width = abs(lat)
      let noise = cellRand(23) * 0.5 + 0.5
      set u = width < 0.35 && noise > 0.25 ? 1 : 0
    }
  }

  scenario droplets "Three droplets" {
    set u = 0
    spot u at lon=0, lat=0, radius=0.28, amount=1
    spot u at lon=1.7, lat=0.6, radius=0.22, amount=1
    spot u at lon=-1.4, lat=-0.55, radius=0.24, amount=1
  }

  scenario noise "Soft noise" {
    for each cell {
      set u = clamp(cellRand(31) * 0.5 + 0.5, 0, 1)
    }
  }
}
`;

export const pipeline = compileV2(pipelineDsl);
