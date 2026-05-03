// Nonlocal resource-competition ecology on the geodesic mesh.
//
// Biomass grows from locally available resource, but competition is
// gathered over a wider annulus. That makes the interaction explicitly
// spatial without being diffusion: nearby resource helps you, plants at
// a broader radius suppress you. The result is ecological patch spacing
// set by metric distance, not graph-hop count.

import { compileV2 } from "../dsl/compile-v2.mjs";

export const overlays = [];

export const metrics = [
  { id: "biomassMean", label: "BIOMASS", source: "dsl:biomassMean", spark: true, precision: 3 },
  { id: "resourceMean", label: "RESOURCE", source: "dsl:resourceMean", spark: true, precision: 3 },
  { id: "activityMean", label: "ACTIVITY", source: "dsl:activityMean", mini: true, precision: 3 },
  { id: "vegArea", label: "PATCHES", source: "dsl:vegArea", mini: true, precision: 0 },
  { id: "fps", label: "FPS", source: "fps", mini: true },
];

export const regime = {
  silent: { activityMean: 0.0001 },
  intermittent: { activityMean: 0.004 },
  active: { activityMean: 0.02 },
  runaway: { vegArea: 8000 },
};

export const pipelineDsl = `
recipe "Nonlocal ecology"
summary "Resource-biomass ecology with nonlocal competition. Plants read nearby resource through a center-weighted metric kernel, while wider annular biomass creates crowding pressure. The competition radius sets patch spacing, producing gaps, mosaics, and invasion fronts without ordinary diffusion."
recommendedPreset mosaic

substrate geodesic frequency 32

field biomass: f32
field resource: f32
field food: f32 derived
field crowding: f32 derived
field activity: f32 derived

param growth slider 0..6 step 0.01 default 2.40 label "GROWTH"
param mortality slider 0..2 step 0.01 default 0.42 label "MORTALITY"
param crowdLoss slider 0..8 step 0.01 default 2.20 label "CROWDING"
param replenish slider 0..3 step 0.01 default 0.58 label "REPLENISH"
param consume slider 0..6 step 0.01 default 2.70 label "CONSUME"
param foodWidth slider 0.025..0.050 step 0.001 default 0.038 label "FOOD WIDTH"
param crowdRadius slider 0.070..0.125 step 0.001 default 0.100 label "CROWD RADIUS"
param crowdWidth slider 0.010..0.020 step 0.001 default 0.016 label "CROWD WIDTH"
param simRateHz slider 0..120 step 1 default 45 label "SIM RATE"
param rate slider 1..10 step 1 default 1 label "RATE"

step {
  stage grow "Nonlocal resource competition" {
    reads biomass, resource
    writes biomass, resource, food, crowding, activity
    cell {
      // Local resource access. bell(0, width) includes the current cell
      // strongly, so this behaves like a soft feeding disk.
      let f = mean n in kernel bell(0, foodWidth) { resource@n }
      // Wider annular biomass competition. Moving crowdRadius changes
      // the spacing between mature patches.
      let c = mean n in kernel bell(crowdRadius, crowdWidth) { biomass@n }

      let carrying = max(1 - biomass, 0)
      let biomassDot = growth * f * biomass * carrying - crowdLoss * c * biomass - mortality * biomass
      let resourceDot = replenish * (1 - resource) - consume * biomass * resource
      let nextBiomass = clamp(biomass + biomassDot * dt * rate, 0.001, 0.999)
      let nextResource = clamp(resource + resourceDot * dt * rate, 0.001, 0.999)

      set food = f
      set crowding = c
      set activity = abs(nextBiomass - biomass)
      set biomass = nextBiomass
      set resource = nextResource
    }
  }
}

metric biomassMean = mean cells { biomass }
metric resourceMean = mean cells { resource }
metric activityMean = mean cells { activity }
metric vegArea = count cells where biomass > 0.25

views {
  palette BIOMASS {
    stop 0 color [18, 24, 18]
    stop 0.35 color [48, 92, 52]
    stop 0.7 color [130, 195, 90]
    stop 1 color [238, 230, 150]
  }

  palette RESOURCE {
    stop 0 color [78, 54, 40]
    stop 0.45 color [82, 112, 95]
    stop 1 color [70, 160, 220]
  }

  palette PRESSURE {
    stop 0 color [10, 12, 18]
    stop 0.5 color [84, 120, 220]
    stop 1 color [245, 190, 70]
  }

  view biomass "Biomass" {
    color ramp biomass range [0, 1] palette BIOMASS
  }

  view resource "Resource" {
    color ramp resource range [0, 1] palette RESOURCE
  }

  view crowding "Crowding pressure" {
    color ramp crowding range [0, 0.7] palette PRESSURE
  }

  view activity "Patch activity" {
    color ramp activity range [0, 0.06] palette PRESSURE
  }
}

stamps {
  stamp seed "Seed biomass" {
    spot biomass at brush.pos, radius=brush.r, amount=0.45
  }

  stamp clear "Clear biomass" {
    spot biomass at brush.pos, radius=brush.r, amount=-0.75
  }

  stamp irrigate "Add resource" {
    spot resource at brush.pos, radius=brush.r, amount=0.45
  }
}

scenarios {
  scenario mosaic "Patch mosaic" {
    set resource = 0.78
    for each cell {
      let r = cellRand(71) * 0.5 + 0.5
      let bands = sin(lon * 4) * cos(lat * 5)
      set biomass = (r + bands * 0.18) > 0.62 ? 0.36 : 0.04
    }
  }

  scenario invasion "Invasion front" {
    set resource = 0.92
    set biomass = 0.02
    spot biomass at lon=-1.4, lat=0.15, radius=0.32, amount=0.65
  }

  scenario refugia "Scattered refugia" {
    set resource = 0.70
    for each cell {
      let r = cellRand(73) * 0.5 + 0.5
      set biomass = r > 0.88 ? 0.72 : 0.02
    }
  }

  scenario gradient "Resource gradient" {
    for each cell {
      let wet = clamp(0.55 + 0.35 * cos(lat), 0.05, 0.98)
      let r = cellRand(79) * 0.5 + 0.5
      set resource = wet
      set biomass = wet > 0.68 && r > 0.55 ? 0.38 : 0.03
    }
  }
}
`;

export const pipeline = compileV2(pipelineDsl);
