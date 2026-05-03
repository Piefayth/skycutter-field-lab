// Single-channel Lenia on the geodesic mesh.
//
// Lenia is a continuous cellular automaton: compute a weighted neighborhood
// potential, pass it through a smooth growth curve, and add that growth back
// into the field. This recipe uses a metric bell kernel over great-circle
// distance, so the same center/width values mean the same thing at different
// geodesic frequencies.

import { compileV2 } from "../dsl/compile-v2.mjs";

export const overlays = [];

export const metrics = [
  { id: "mass", label: "MASS", source: "dsl:mass", spark: true, precision: 3 },
  { id: "growthMean", label: "GROWTH", source: "dsl:growthMean", spark: true, precision: 3 },
  { id: "activityMean", label: "ACTIVITY", source: "dsl:activityMean", mini: true, precision: 3 },
  { id: "fps", label: "FPS", source: "fps", mini: true },
];

export const regime = {
  silent: { activityMean: 0.0001 },
  intermittent: { activityMean: 0.004 },
  active: { activityMean: 0.02 },
  runaway: { activityMean: 0.30 },
};

export const pipelineDsl = `
recipe "Lenia metric"
summary "Single-channel Lenia on the sphere. A metric bell kernel computes a neighborhood potential by great-circle distance; a Gaussian growth curve nudges each cell up or down. Tune kernel center/width and growth center/width to find soft colonies, holes, and drifting organism-like patches."
recommendedPreset colonies

substrate geodesic frequency 32

field u: f32
field potential: f32 derived
field growth: f32 derived
field activity: f32 derived

param mu slider 0..1 step 0.001 default 0.31 label "GROWTH CENTER"
param sigma slider 0.01..0.25 step 0.001 default 0.065 label "GROWTH WIDTH"
param gain slider 0..8 step 0.01 default 2.1 label "GAIN"
param leak slider 0..0.25 step 0.001 default 0.025 label "LEAK"
param kernelCenter slider 0.03..0.12 step 0.001 default 0.085 label "KERNEL CENTER"
param kernelWidth slider 0.01..0.02 step 0.001 default 0.020 label "KERNEL WIDTH"
param simRateHz slider 0..120 step 1 default 45 label "SIM RATE"
param rate slider 1..10 step 1 default 1 label "RATE"

step {
  stage evolve "Lenia metric kernel" {
    reads u
    writes u, potential, growth, activity
    cell {
      let k = mean n in kernel bell(kernelCenter, kernelWidth) { u@n }

      // Bell-shaped growth centered on mu. g is +1 near mu and tends to -1
      // far away; leak damps dense regions so colonies do not pin at u=1.
      let offset = (k - mu) / max(sigma, 0.001)
      let g = clamp(2 * exp(-0.5 * offset * offset) - 1, -0.999, 0.999)
      let next = clamp(u + (g - leak * u) * gain * rate * dt, 0, 1)

      set potential = k
      set growth = g
      set activity = abs(next - u)
      set u = next
    }
  }
}

metric mass = mean cells { u }
metric growthMean = mean cells { growth }
metric activityMean = mean cells { activity }

views {
  palette LENIA {
    stop 0 color [6, 9, 16]
    stop 0.25 color [35, 48, 92]
    stop 0.55 color [72, 160, 145]
    stop 0.8 color [210, 220, 125]
    stop 1 color [255, 242, 210]
  }

  palette GROWTH {
    stop 0 color [45, 60, 160]
    stop 0.5 color [20, 20, 24]
    stop 1 color [235, 190, 70]
  }

  view u "Organisms" {
    color ramp u range [0, 1] palette LENIA
  }

  view potential "Kernel field" {
    color ramp potential range [0, 0.65] palette LENIA
  }

  view growth "Growth" {
    color ramp growth range [-1, 1] palette GROWTH
  }

  view activity "Activity" {
    color ramp activity range [0, 0.08] palette GROWTH
  }
}

stamps {
  stamp seed "Seed colony" {
    spot u at brush.pos, radius=brush.r, amount=0.8
  }

  stamp erase "Erase" {
    spot u at brush.pos, radius=brush.r, amount=-1
  }

  stamp feed "Feed" {
    spot u at brush.pos, radius=brush.r, amount=0.25
  }
}

scenarios {
  scenario colonies "Random soft colonies" {
    for each cell {
      let r = cellRand(41) * 0.5 + 0.5
      let bands = sin(lon * 4) * cos(lat * 5)
      let seed = r + bands * 0.18
      set u = seed > 0.62 ? 0.75 : 0
    }
  }

  scenario equator "Equatorial culture" {
    for each cell {
      let r = cellRand(43) * 0.5 + 0.5
      let belt = abs(lat) < 0.28
      set u = belt && r > 0.36 ? 0.65 : 0
    }
  }

  scenario droplets "Four inoculation drops" {
    set u = 0
    spot u at lon=0, lat=0, radius=0.18, amount=0.8
    spot u at lon=1.45, lat=0.45, radius=0.16, amount=0.8
    spot u at lon=-1.6, lat=-0.5, radius=0.18, amount=0.8
    spot u at lon=2.7, lat=-0.1, radius=0.14, amount=0.8
  }

  scenario haze "Low random haze" {
    for each cell {
      set u = (cellRand(47) * 0.5 + 0.5) * 0.45
    }
  }
}
`;

export const pipeline = compileV2(pipelineDsl);
