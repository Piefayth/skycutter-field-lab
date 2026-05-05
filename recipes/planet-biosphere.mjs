// Planet biosphere.
//
// A small composition recipe: heat, moisture, biomass, and pollution interact
// through shared fields. It is intentionally toy-like. The goal is to see
// whether a few single-field planet mechanics can merge into compelling
// emergent regions without turning into a full climate model.

import { compileV2 } from "../dsl/compile-v2.mjs";

export const overlays = [];

export const metrics = [
  { id: "bio", label: "BIOMASS", source: "dsl:bioMean", spark: true, precision: 3 },
  { id: "wet", label: "WET", source: "dsl:moistMean", spark: true, precision: 3 },
  { id: "tox", label: "POLLUTION", source: "dsl:pollMean", spark: true, precision: 3 },
  { id: "hab", label: "HAB AREA", source: "dsl:habArea", mini: true, precision: 0 },
  { id: "fps", label: "FPS", source: "fps", mini: true },
];

export const regime = {
  silent: { bio: 0.04 },
  intermittent: { bio: 0.14 },
  active: { bio: 0.34 },
  runaway: { tox: 0.65 },
};

export const pipelineDsl = `
recipe "Planet biosphere"
summary "Toy coupled planet layers. Oceans create moisture, latitude creates heat, vegetation grows where heat/moisture/fertility align, and industry emits pollution that suppresses biomass. Built to test simple interacting planet mechanics."
recommendedPreset continents

substrate geodesic frequency 32

source ocean: f32
source fertility: f32
source industry: f32

field heat: f32
field moisture: f32
field biomass: f32
field pollution: f32
field wind: vec2 derived
field windFlow: vec2 derived
field habitability: f32 derived

param simRateHz slider 0..240 step 1 default 60 label "SIM RATE"
param rate      slider 1..80  step 1 default 16 label "RATE"
param sun       slider 0..2   step 0.01 default 1.0 label "SUN"
param evap      slider 0..2   step 0.01 default 0.55 label "EVAP"
param growth    slider 0..6   step 0.01 default 2.2 label "GROWTH"
param spread    slider 0..2   step 0.01 default 0.32 label "SPREAD"
param emit      slider 0..4   step 0.01 default 1.35 label "INDUSTRY"
param cleanup   slider 0..2   step 0.01 default 0.28 label "CLEANUP"
param toxicity  slider 0..4   step 0.01 default 1.20 label "TOXICITY"
param flowScale slider 0..2   step 0.01 default 0.75 label "WIND FLOW"

step {
  stage windField "Prevailing wind" {
    reads heat
    writes wind, windFlow
    cell {
      let thermal = gradient(heat)
      let belts = vec2(0.75 + 0.35 * cos(lat * 3), 0.22 * sin(lon * 2 + frame / 520))
      let raw = belts + thermal * 0.45
      let mag = max(length(raw), 0.001)
      let flow = raw / mag
      set wind = flow
      set windFlow = flow * flowScale
    }
  }

  stage climate "Heat and moisture" {
    reads heat, moisture, ocean, biomass
    writes heat, moisture
    cell {
      let insolation = sun * max(0, cos(lat))
      let shade = biomass * 0.08
      let oceanBuffer = ocean * (0.12 - heat) * 0.35
      let nextHeat = heat + (insolation * (1 - shade) - 0.75 * (heat + 0.18) + oceanBuffer) * dt * rate
      let wetInput = ocean * evap * (0.35 + max(heat, 0) * 0.35)
      let dryLoss = moisture * (0.22 + max(heat, 0) * 0.26) * (1 - ocean * 0.65)
      set heat = clamp(nextHeat, -1, 1.2)
      set moisture = clamp(moisture + (wetInput - dryLoss) * dt * rate, 0, 1.5)
    }
  }

  stage advect "Wind moves moisture and pollution" {
    reads moisture, pollution, windFlow
    writes moisture, pollution
    cell {
      let p = upstream(windFlow, dt * rate)
      set moisture = clamp(moisture@p, 0, 1.5)
      set pollution = clamp(pollution@p, 0, 1.8)
    }
  }

  stage ecology "Biomass growth and pollution" {
    reads heat, moisture, biomass, pollution, fertility, industry
    writes biomass, moisture, pollution, habitability
    cell {
      let tempFit = clamp(1 - abs(heat - 0.18) * 1.8, 0, 1)
      let wetFit = clamp(moisture * 1.15, 0, 1)
      let clean = clamp(1 - pollution * toxicity, 0, 1)
      let hab = tempFit * wetFit * clamp(fertility, 0, 1) * clean
      let carrying = max(1 - biomass, 0)
      let grow = growth * hab * biomass * carrying
      let die = biomass * (0.08 + pollution * toxicity * 0.22 + max(-heat - 0.35, 0) * 0.35)
      let waterUse = grow * 0.26
      let pollutionInput = industry * emit
      let pollutionLoss = pollution * (cleanup + biomass * 0.18)
      set biomass = clamp(biomass + (grow - die) * dt * rate, 0, 1)
      set moisture = clamp(moisture - waterUse * dt * rate, 0, 1.5)
      set pollution = clamp(pollution + (pollutionInput - pollutionLoss) * dt * rate, 0, 1.8)
      set habitability = hab
    }
  }

  stage spread "Local spread and smoothing" {
    reads biomass, moisture, pollution
    writes biomass, moisture, pollution
    cell {
      let k = clamp(spread * dt * rate, 0, 0.14)
      add biomass = (mean n in neighbors { biomass@n } - biomass) * k
      add moisture = (mean n in neighbors { moisture@n } - moisture) * k * 0.65
      add pollution = (mean n in neighbors { pollution@n } - pollution) * k * 0.55
    }
  }
}

metric bioMean = mean cells { biomass }
metric moistMean = mean cells { moisture }
metric pollMean = mean cells { pollution }
metric habArea = count cells where habitability > 0.35

views {
  palette BIO {
    stop 0 color [44, 35, 24]
    stop 0.35 color [70, 105, 55]
    stop 0.75 color [115, 190, 82]
    stop 1 color [225, 230, 130]
  }

  palette POLLUTION {
    stop 0 color [12, 18, 28]
    stop 0.45 color [100, 85, 55]
    stop 1 color [245, 120, 42]
  }

  palette HAB {
    stop 0 color [34, 28, 48]
    stop 0.5 color [65, 150, 120]
    stop 1 color [215, 232, 145]
  }

  view living "Living planet" {
    color expr {
      let b = clamp(biomass, 0, 1)
      let m = clamp(moisture, 0, 1)
      let p = clamp(pollution, 0, 1)
      let h = clamp(habitability, 0, 1)
      let oceanMix = clamp(ocean, 0, 1)
      let baseR = 50 + heat * 45 + oceanMix * -20
      let baseG = 45 + m * 70 + b * 105
      let baseB = 38 + oceanMix * 105 + m * 45
      set red = baseR * (1 - p) + (235 + h * 20) * p
      set green = baseG * (1 - p) + (95 + h * 35) * p
      set blue = baseB * (1 - p) + 38 * p
    }
    particles advect=windFlow count=2500 length=12 speed=0.6 fade=0.88 size=3.5 color [225, 245, 210]
  }

  view biomass "Biomass" {
    color ramp biomass range [0, 1] palette BIO
  }

  view pollution "Pollution" {
    color ramp pollution range [0, 1] palette POLLUTION
    particles advect=windFlow count=2000 length=13 speed=0.55 fade=0.9 size=3 color [255, 210, 120]
  }

  view habitability "Habitability" {
    color ramp habitability range [0, 1] palette HAB
  }
}

stamps {
  stamp forest "Seed biomass" {
    spot biomass at brush.pos, radius=brush.r, amount=0.45
  }

  stamp industry "Place industry" {
    set industry at brush.pos, radius=brush.r * 0.35, value=1
  }

  stamp clean "Clean pollution" {
    spot pollution at brush.pos, radius=brush.r, amount=-0.75
  }

  stamp fertile "Paint fertility" {
    set fertility at brush.pos, radius=brush.r, value=1
  }
}

scenarios {
  scenario continents "Continents + industry" {
    for each cell {
      let landWave = sin(lon * 2.0) + 0.5 * sin(lat * 4.0 + lon * 0.7)
      let isOcean = landWave < -0.12 ? 1 : 0
      let temp = -0.15 + max(0, cos(lat)) * 0.55
      let wet = isOcean * 0.65 + (1 - isOcean) * (0.22 + 0.22 * cos(lat))
      let fertile = (1 - isOcean) * clamp(0.45 + 0.35 * cos(lat) + 0.18 * sin(lon * 3), 0, 1)
      let r = cellRand(14) * 0.5 + 0.5
      set ocean = isOcean
      set fertility = fertile
      set heat = temp
      set moisture = wet
      set biomass = fertile > 0.42 && r > 0.35 ? 0.28 : 0.03
      set pollution = 0
      set industry = 0
    }
    spot industry at lon=-1.0, lat=0.25, radius=0.10, amount=1
    spot industry at lon=1.2, lat=-0.35, radius=0.10, amount=1
  }

  scenario garden "Garden world" {
    set ocean = 0.35
    set fertility = 0.85
    set heat = 0.16
    set moisture = 0.55
    set biomass = 0.35
    set pollution = 0
    set industry = 0
  }

  scenario industrial "Industrial stress" {
    set ocean = 0.25
    set fertility = 0.7
    set heat = 0.25
    set moisture = 0.38
    set biomass = 0.22
    set pollution = 0.12
    set industry = 0
    spot industry at lon=-1.3, lat=0.2, radius=0.25, amount=1
    spot industry at lon=0.7, lat=-0.15, radius=0.22, amount=1
    spot industry at lon=2.4, lat=0.35, radius=0.18, amount=1
  }
}
`;

export const pipeline = compileV2(pipelineDsl);
