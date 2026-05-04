// Nutrient grazing cycle.
//
// Persistent sources define the planet's substrate: springs add
// fertility, badlands suppress it. Nutrient and grazers move through
// conservative edge flux, while plants convert nutrient into biomass
// and grazers convert plants into more grazers.

import { compileV2 } from "../dsl/compile-v2.mjs";

export const overlays = [];

export const metrics = [
  { id: "plant", label: "PLANTS", source: "dsl:plantMean", spark: true, precision: 3 },
  { id: "grazer", label: "GRAZERS", source: "dsl:grazerMean", spark: true, precision: 3 },
  { id: "nutrient", label: "NUTRIENT", source: "dsl:nutrientMean", mini: true, precision: 3 },
  { id: "move", label: "MOVE", source: "dsl:moveMean", mini: true, precision: 3 },
  { id: "fps", label: "FPS", source: "fps", mini: true },
];

export const regime = {
  silent: { move: 0.001 },
  intermittent: { move: 0.006 },
  active: { move: 0.020 },
  runaway: { grazer: 1.1 },
};

export const pipelineDsl = `
recipe "Nutrient grazing cycle"
summary "Persistent springs and badlands shape a small ecosystem. Nutrient moves by conservative edge flux toward favorable soil; plants grow from nutrient; grazers move by edge flux toward good forage and reshape the vegetation."
recommendedPreset basin

substrate geodesic frequency 32

source spring: f32
source badland: f32

field nutrient: f32
field plants: f32
field grazers: f32
field soil: f32 derived
field forage: f32 derived
field movement: f32 derived

param simRateHz slider 0..240 step 1 default 60 label "SIM RATE"
param rate      slider 1..48  step 1 default 14 label "RATE"
param weather   slider 0..2   step 0.01 default 0.75 label "SEASONAL INPUT"
param plantGrow slider 0..5   step 0.01 default 1.45 label "PLANT GROWTH"
param graze     slider 0..5   step 0.01 default 1.65 label "GRAZING"
param grazerMob slider 0..10  step 0.01 default 3.20 label "GRAZER MOBILITY"
param nutFlux   slider 0..8   step 0.01 default 2.10 label "NUTRIENT FLOW"
param crowd     slider 0..4   step 0.01 default 1.25 label "CROWD AVOID"
param recycle   slider 0..2   step 0.01 default 0.32 label "RECYCLING"
param mortality slider 0..2   step 0.01 default 0.26 label "MORTALITY"

step {
  stage score "Soil and forage scores" {
    reads spring, badland, nutrient, plants, grazers
    writes soil, forage, movement
    cell {
      let wetSeason = 0.5 + 0.5 * sin(frame / 260 + lon * 0.8)
      let latitudeFertility = 0.55 + 0.25 * cos(lat * 2)
      let soilNow = latitudeFertility + spring * 0.95 - badland * 0.85 - plants * 0.18 + wetSeason * weather * 0.18
      let localGraze = mean n in neighbors { grazers@n }
      set soil = clamp(soilNow, -1, 1)
      set forage = clamp(plants + nutrient * 0.25 - crowd * (grazers + localGraze * 0.35) - badland * 0.5, -1, 1)
      set movement = 0
    }
  }

  stage nutrientFlow "Conservative nutrient edge flux" {
    reads nutrient, soil
    writes nutrient
    edge n in neighbors {
      let fertilityPull = max(soil@n - soil, 0)
      let concentration = max(nutrient - nutrient@n, 0) * 0.35
      flux nutrient = nutrient * clamp((fertilityPull + concentration) * nutFlux * dt * rate, 0, 0.08)
    }
  }

  stage grazerFlow "Conservative grazer edge flux" {
    reads grazers, forage
    writes grazers
    edge n in neighbors {
      let pull = max(forage@n - forage, 0)
      flux grazers = grazers * clamp(pull * grazerMob * dt * rate, 0, 0.10)
    }
  }

  stage ecology "Growth, grazing, and recycling" {
    reads nutrient, plants, grazers, spring, badland, forage
    writes nutrient, plants, grazers, movement
    cell {
      let fertility = clamp(0.25 + spring - badland * 0.7, 0, 1.4)
      let plantCapacity = max(1.15 - plants, 0)
      let uptake = plantGrow * nutrient * plants * plantCapacity * (0.25 + fertility)
      let eaten = graze * grazers * plants
      let litter = recycle * (eaten + mortality * grazers)
      let seasonalInput = weather * spring * (0.18 + 0.12 * sin(frame / 180 + lat * 3))
      let nextNutrient = clamp(nutrient + (seasonalInput + litter - uptake - badland * nutrient * 0.05) * dt * rate, 0, 1.8)
      let nextPlants = clamp(plants + (uptake - eaten - badland * plants * 0.08) * dt * rate, 0, 1.3)
      let births = 0.55 * eaten * max(1 - grazers, 0)
      let deaths = mortality * grazers * (0.25 + max(0.18 - plants, 0) * 2.0)
      let nextGrazers = clamp(grazers + (births - deaths) * dt * rate, 0, 1.4)
      set nutrient = nextNutrient
      set plants = nextPlants
      set grazers = nextGrazers
      set movement = clamp(abs(forage) * nextGrazers, 0, 1)
    }
  }
}

metric plantMean = mean cells { plants }
metric grazerMean = mean cells { grazers }
metric nutrientMean = mean cells { nutrient }
metric moveMean = mean cells { movement }
metric fertileArea = count cells where soil > 0.35

views {
  palette PLANTS {
    stop 0 color [24, 28, 20]
    stop 0.35 color [52, 96, 52]
    stop 0.75 color [118, 188, 80]
    stop 1 color [235, 230, 135]
  }

  palette GRAZERS {
    stop 0 color [12, 15, 20]
    stop 0.35 color [76, 66, 100]
    stop 0.7 color [200, 132, 72]
    stop 1 color [255, 238, 185]
  }

  palette NUTRIENT {
    stop 0 color [34, 28, 22]
    stop 0.5 color [98, 92, 54]
    stop 1 color [205, 160, 70]
  }

  palette PRESSURE {
    stop 0 color [54, 90, 195]
    stop 0.5 color [18, 22, 28]
    stop 1 color [245, 200, 76]
  }

  view ecosystem "Ecosystem composite" {
    color expr {
      let p = clamp(plants, 0, 1)
      let g = clamp(grazers, 0, 1)
      let n = clamp(nutrient, 0, 1)
      let s = clamp(spring, 0, 1)
      let b = clamp(badland, 0, 1)
      set red = 26 + n * 100 + g * 180 + b * 95
      set green = 34 + p * 205 + s * 80 - b * 38
      set blue = 28 + s * 120 + g * 62 - p * 18
    }
  }

  view plants "Plants" {
    color ramp plants range [0, 1.2] palette PLANTS
  }

  view grazers "Grazers" {
    color ramp grazers range [0, 1.2] palette GRAZERS
  }

  view nutrient "Nutrient" {
    color ramp nutrient range [0, 1.4] palette NUTRIENT
  }

  view pressure "Forage pressure" {
    color ramp forage range [-1, 1] palette PRESSURE
  }

  view sources "Sources" {
    color expr {
      let s = clamp(spring, 0, 1)
      let b = clamp(badland, 0, 1)
      set red = 25 + b * 220
      set green = 28 + s * 210
      set blue = 32 + s * 120 + b * 30
    }
  }
}

stamps {
  stamp seedPlants "Seed plants" {
    spot plants at brush.pos, radius=brush.r, amount=0.55
  }

  stamp seedGrazers "Add grazers" {
    spot grazers at brush.pos, radius=brush.r, amount=0.48
  }

  stamp addNutrient "Add nutrient" {
    spot nutrient at brush.pos, radius=brush.r, amount=0.75
  }

  stamp spring "Place spring" {
    spot spring at brush.pos, radius=brush.r, amount=0.65
  }

  stamp badland "Place badland" {
    spot badland at brush.pos, radius=brush.r, amount=0.65
  }

  stamp eraseTerrain "Erase sources" {
    set spring at brush.pos, radius=brush.r, value=0
    set badland at brush.pos, radius=brush.r, value=0
  }
}

scenarios {
  scenario basin "Fertile basins" {
    set spring = 0
    set badland = 0
    set nutrient = 0.26
    for each cell {
      let r = cellRand(41)
      set plants = clamp(0.28 + 0.12 * cellNoise(17, 2.0), 0.04, 0.62)
      set grazers = r > 0.88 ? 0.30 : 0.02
    }
    spot spring at lon=-1.2, lat=0.30, radius=0.26, amount=0.85
    spot spring at lon=0.85, lat=-0.20, radius=0.22, amount=0.75
    spot badland at lon=2.0, lat=0.12, radius=0.32, amount=0.75
  }

  scenario corridor "Spring corridor" {
    set spring = 0
    set badland = 0
    set nutrient = 0.18
    set plants = 0.16
    set grazers = 0.015
    spot spring at lon=-1.7, lat=-0.35, radius=0.18, amount=0.9
    spot spring at lon=-0.8, lat=-0.15, radius=0.18, amount=0.8
    spot spring at lon=0.1, lat=0.08, radius=0.18, amount=0.8
    spot spring at lon=1.0, lat=0.28, radius=0.18, amount=0.9
    spot badland at lon=0.2, lat=-0.55, radius=0.30, amount=0.85
    spot grazers at lon=-2.2, lat=-0.45, radius=0.20, amount=0.75
  }

  scenario collapse "Overgrazed pocket" {
    set spring = 0
    set badland = 0
    set nutrient = 0.34
    set plants = 0.55
    set grazers = 0.04
    spot spring at lon=0, lat=0, radius=0.42, amount=0.8
    spot grazers at lon=0.1, lat=0.05, radius=0.26, amount=0.95
  }
}
`;

export const pipeline = compileV2(pipelineDsl);
