// Chemotaxis colony: a population actively steers along chemical
// gradients instead of merely diffusing. The key pattern is:
//
//   flux = bugs * (attract * gradient(food) - repel * gradient(toxin))
//   d bugs / dt = -divergence(flux) + diffusion + growth - death
//
// The derived vec2 `flux` field is intentional. Today's validator
// forbids let-locals inside divergence(...), so landing the transport
// field explicitly keeps the recipe within the current DSL surface and
// gives us a concrete test case for a future `transport` primitive.

import { compileV2 } from "../dsl/compile-v2.mjs";

export const overlays = [];

export const metrics = [
  { id: "bugMean", label: "BUGS", source: "dsl:bugMean", spark: true, precision: 3 },
  { id: "foodMean", label: "FOOD", source: "dsl:foodMean", spark: true, precision: 3 },
  { id: "toxinMean", label: "TOXIN", source: "dsl:toxinMean", mini: true, precision: 3 },
  { id: "activityMean", label: "ACTIVITY", source: "dsl:activityMean", mini: true, precision: 3 },
  { id: "maxFlux", label: "MAX FLUX", source: "dsl:maxFlux", mini: true, precision: 3 },
  { id: "fps", label: "FPS", source: "fps", mini: true },
];

export const regime = {
  silent: { activityMean: 0.0001 },
  intermittent: { activityMean: 0.004 },
  active: { activityMean: 0.025 },
  runaway: { bugMean: 2.5 },
};

export const pipelineDsl = `
recipe "Chemotaxis colony"
summary "A population moves up food gradients and away from toxin gradients. Paint food, bugs, and repellent to watch active steering, clustering, trail collapse, and moving fronts. This recipe prototypes chemotactic transport using explicit flux fields: flux = bugs · gradient(signal), then bugs changes by -divergence(flux)."
recommendedPreset islands

substrate geodesic frequency 32

field bugs: f32
field food: f32
field toxin: f32
field flux: vec2 derived
field fluxSpeed: f32 derived
field activity: f32 derived

param attract    slider 0..6    step 0.02   default 2.10 label "FOOD ATTRACTION"
param repel      slider 0..8    step 0.02   default 3.20 label "TOXIN REPULSION"
param bugDiff    slider 0..0.20 step 0.002  default 0.018 label "BUG DIFFUSION"
param foodDiff   slider 0..0.40 step 0.002  default 0.075 label "FOOD DIFFUSION"
param toxinDiff  slider 0..0.30 step 0.002  default 0.040 label "TOXIN DIFFUSION"
param growth     slider 0..4    step 0.02   default 1.25 label "GROWTH"
param eatRate    slider 0..8    step 0.02   default 2.20 label "EAT RATE"
param mortality  slider 0..1    step 0.005  default 0.050 label "MORTALITY"
param toxinKill  slider 0..4    step 0.02   default 1.20 label "TOXIN KILL"
param replenish  slider 0..1    step 0.005  default 0.055 label "FOOD REPLENISH"
param baseFood   slider 0..0.5  step 0.005  default 0.045 label "BASE FOOD"
param toxinDecay slider 0..1    step 0.005  default 0.120 label "TOXIN DECAY"
param maxBugs    slider 0.5..4  step 0.02   default 2.20 label "MAX BUGS"
param simRateHz  slider 0..240  step 1      default 60 label "SIM RATE"
param rate       slider 1..18   step 1      default 6 label "RATE"

step {
  stage sense "Chemotactic flux" {
    reads bugs, food, toxin
    writes flux, fluxSpeed
    cell {
      let foodGrad = gradient(food)
      let toxinGrad = gradient(toxin)
      let drive = vec2(attract * foodGrad.x - repel * toxinGrad.x, attract * foodGrad.y - repel * toxinGrad.y)
      let f = vec2(bugs * drive.x, bugs * drive.y)
      set flux = f
      set fluxSpeed = length(f)
    }
  }

  stage move "Move, grow, and die" {
    reads bugs, food, toxin, flux
    writes bugs, activity
    cell {
      let lap = mean n in neighbors { bugs@n } - bugs
      let crowdLimit = max(1 - bugs / maxBugs, 0)
      let birth = growth * bugs * food * crowdLimit
      let death = mortality * bugs + toxinKill * toxin * bugs
      let next = bugs + (bugDiff * lap - divergence(flux) + birth - death) * dt * rate
      set activity = abs(next - bugs)
      set bugs = clamp(next, 0, maxBugs)
    }
  }

  stage chemicals "Diffuse, decay, and consume signals" {
    reads bugs, food, toxin
    writes food, toxin
    cell {
      let foodLap = mean n in neighbors { food@n } - food
      let toxinLap = mean n in neighbors { toxin@n } - toxin
      let eaten = eatRate * bugs * food
      let foodNext = food + (foodDiff * foodLap + replenish * (baseFood - food) - eaten) * dt * rate
      let toxinNext = toxin + (toxinDiff * toxinLap - toxinDecay * toxin) * dt * rate
      set food = clamp(foodNext, 0, 1.5)
      set toxin = clamp(toxinNext, 0, 1.5)
    }
  }
}

metric bugMean = mean cells { bugs }
metric foodMean = mean cells { food }
metric toxinMean = mean cells { toxin }
metric activityMean = mean cells { activity }
metric maxFlux = max cells { fluxSpeed }

views {
  palette BUGS {
    stop 0 color [8, 12, 12]
    stop 0.4 color [52, 130, 70]
    stop 1 color [230, 235, 120]
  }

  palette FOOD {
    stop 0 color [10, 14, 22]
    stop 1 color [70, 205, 240]
  }

  palette TOXIN {
    stop 0 color [10, 10, 14]
    stop 1 color [245, 70, 180]
  }

  palette SPEED {
    stop 0 color [12, 14, 24]
    stop 1 color [255, 210, 70]
  }

  view composite "Bugs + food + toxin" {
    color expr {
      let b = clamp(bugs / 2.2, 0, 1)
      let f = clamp(food, 0, 1)
      let t = clamp(toxin, 0, 1)
      set red = 18 + b * 210 + t * 150
      set green = 20 + b * 210 + f * 90 - t * 45
      set blue = 26 + f * 210 + t * 150 - b * 40
    }
  }

  view bugs "Bugs" {
    color ramp bugs range [0, 2.2] palette BUGS
  }

  view food "Food signal" {
    color ramp food range [0, 1] palette FOOD
  }

  view toxin "Toxin signal" {
    color ramp toxin range [0, 1] palette TOXIN
  }

  view flux "Chemotactic flux" {
    color ramp fluxSpeed range [0, 1.2] palette SPEED
  }
}

stamps {
  stamp seedBugs "Seed bugs" {
    spot bugs at brush.pos, radius=brush.r, amount=0.70
  }

  stamp feed "Add food" {
    spot food at brush.pos, radius=brush.r, amount=0.75
  }

  stamp poison "Add toxin" {
    spot toxin at brush.pos, radius=brush.r, amount=0.90
  }

  stamp clearBugs "Clear bugs" {
    spot bugs at brush.pos, radius=brush.r, amount=-1.20
  }
}

scenarios {
  scenario islands "Food islands" {
    set bugs = 0.025
    set food = baseFood
    set toxin = 0
    spot food at lon=-1.4, lat=0.15, radius=0.28, amount=0.90
    spot food at lon=0.25, lat=-0.35, radius=0.22, amount=0.75
    spot food at lon=1.65, lat=0.42, radius=0.24, amount=0.80
    spot bugs at lon=-2.2, lat=-0.25, radius=0.24, amount=0.85
    spot bugs at lon=0.9, lat=0.25, radius=0.18, amount=0.55
  }

  scenario barrier "Repellent barrier" {
    set bugs = 0.018
    set food = baseFood
    set toxin = 0
    spot food at lon=1.35, lat=0.05, radius=0.34, amount=1.00
    spot bugs at lon=-1.35, lat=0.00, radius=0.28, amount=1.10
    ellipse toxin at lon=0, lat=0, rx=0.12, ry=0.85, amount=1.00, angle=0
  }

  scenario scattered "Scattered colony" {
    set toxin = 0
    for each cell {
      let r = cellRand(101) * 0.5 + 0.5
      let q = cellRand(211) * 0.5 + 0.5
      set food = r > 0.74 ? 0.85 : baseFood
      set bugs = q > 0.90 ? 0.65 : 0.015
    }
  }

  scenario chase "Chase the signal" {
    set bugs = 0.02
    set food = baseFood
    set toxin = 0
    ellipse food at lon=0.65, lat=0, rx=0.22, ry=0.70, amount=0.85, angle=1.57
    spot bugs at lon=-1.55, lat=0, radius=0.28, amount=1.15
  }
}
`;

export const pipeline = compileV2(pipelineDsl);
