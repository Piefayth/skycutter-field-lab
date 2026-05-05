// Planet moisture layer.
//
// A deliberately small planet mechanic: permanent ocean and spring sources
// feed one mobile moisture field. A simple latitude wind advects moisture,
// clouds are a derived saturated portion, and dry land slowly loses water.
// This is meant as a building block for later planet recipes, not a complete
// weather model.

import { compileV2 } from "../dsl/compile-v2.mjs";

export const overlays = [];

export const metrics = [
  { id: "moisture", label: "MOISTURE", source: "dsl:moistureMean", spark: true, precision: 3 },
  { id: "cloud", label: "CLOUD", source: "dsl:cloudMean", spark: true, precision: 3 },
  { id: "wet", label: "WET AREA", source: "dsl:wetArea", mini: true, precision: 0 },
  { id: "fps", label: "FPS", source: "fps", mini: true },
];

export const regime = {
  silent: { moisture: 0.08 },
  intermittent: { moisture: 0.18 },
  active: { moisture: 0.34 },
  runaway: { cloud: 0.75 },
};

export const pipelineDsl = `
recipe "Planet moisture"
summary "Single-layer planet moisture. Oceans and springs feed atmospheric water, wind advects it around the sphere, and saturation appears as cloud bands. A small building block for later planet recipes."
recommendedPreset continents

substrate geodesic frequency 32

source ocean: f32
source spring: f32

field moisture: f32
field wind: vec2 derived
field windFlow: vec2 derived
field cloud: f32 derived
field wetness: f32 derived

param simRateHz slider 0..240 step 1 default 60 label "SIM RATE"
param rate      slider 1..80  step 1 default 14 label "RATE"
param evap      slider 0..2   step 0.01 default 0.34 label "OCEAN EVAP"
param springFeed slider 0..3  step 0.01 default 0.62 label "SPRINGS"
param dryRate   slider 0..2   step 0.01 default 0.22 label "DRYING"
param flowScale slider 0..2   step 0.01 default 1.15 label "WIND FLOW"
param mixing    slider 0..2   step 0.01 default 0.18 label "MIXING"
param beltWind  slider 0..3   step 0.01 default 1.10 label "WIND STRENGTH"

step {
  stage windField "Latitude wind belts" {
    reads ocean
    writes wind, windFlow
    cell {
      let jet = beltWind * (0.28 + 0.34 * cos(lat * 3))
      let meander = 0.22 * sin(lon * 2 + frame / 120) * cos(lat)
      let pulse = 0.16 * sin(lon * 1.2 - frame / 180 + lat * 2.5)
      let oceanLift = ocean * 0.12 * sin(lon * 3 - frame / 160)
      let flow = vec2(jet + pulse, meander + oceanLift)
      set wind = flow
      set windFlow = flow * flowScale
    }
  }

  stage sources "Ocean/spring source and drying" {
    reads moisture, ocean, spring
    writes moisture
    cell {
      let land = 1 - ocean
      let latitudeDry = 0.26 + 0.20 * abs(sin(lat))
      let input = ocean * evap + spring * springFeed
      let loss = moisture * dryRate * (0.18 + land * latitudeDry)
      set moisture = clamp(moisture + (input - loss) * dt * rate, 0, 1.8)
    }
  }

  stage advect "Wind carries moisture" {
    reads moisture, windFlow
    writes moisture
    cell {
      let p = upstream(windFlow, dt * rate)
      set moisture = clamp(moisture@p, 0, 1.8)
    }
  }

  stage mix "Local mixing" {
    reads moisture
    writes moisture
    cell {
      let k = clamp(mixing * dt * rate, 0, 0.18)
      add moisture = (mean n in neighbors { moisture@n } - moisture) * k
    }
  }

  stage diagnostics "Clouds and wetness" {
    reads moisture, ocean, spring
    writes cloud, wetness
    cell {
      let saturation = 0.32 + 0.16 * ocean + 0.14 * cos(lat)
      set cloud = clamp(max(moisture - saturation, 0) * 2.4, 0, 1)
      set wetness = clamp(moisture * 0.72 + spring * 0.35 + ocean * 0.38, 0, 1)
    }
  }
}

metric moistureMean = mean cells { moisture }
metric cloudMean = mean cells { cloud }
metric wetArea = count cells where wetness > 0.45

views {
  palette WET {
    stop 0 color [55, 42, 28]
    stop 0.35 color [86, 110, 72]
    stop 0.7 color [62, 145, 160]
    stop 1 color [185, 235, 250]
  }

  palette CLOUD {
    stop 0 color [12, 18, 32]
    stop 1 color [245, 250, 255]
  }

  view moisture "Moisture" {
    color ramp moisture range [0, 1.2] palette WET
    particles advect=windFlow count=2200 length=12 speed=0.7 fade=0.88 size=3.5 color [205, 235, 255]
  }

  view cloud "Cloud" {
    color ramp cloud range [0, 1] palette CLOUD
    particles advect=windFlow count=2600 length=13 speed=0.8 fade=0.86 size=4 color [235, 248, 255]
  }
}

stamps {
  stamp ocean "Paint ocean" {
    set ocean at brush.pos, radius=brush.r, value=1
  }

  stamp land "Erase ocean" {
    set ocean at brush.pos, radius=brush.r, value=0
  }

  stamp spring "Place spring" {
    set spring at brush.pos, radius=brush.r * 0.35, value=1
  }

  stamp dry "Dry patch" {
    spot moisture at brush.pos, radius=brush.r, amount=-0.7
  }
}

scenarios {
  scenario continents "Oceans + continents" {
    set spring = 0
    for each cell {
      let landWave = sin(lon * 2.2) + 0.55 * sin(lat * 4.1 + lon)
      let polarSea = abs(lat) > 1.05 ? 1 : 0
      set ocean = (landWave < -0.10 || polarSea == 1) ? 1 : 0
      set moisture = ocean * 0.75 + (cellRand(4) * 0.5 + 0.5) * 0.08
    }
    spot spring at lon=-0.8, lat=0.35, radius=0.12, amount=1
    spot spring at lon=1.4, lat=-0.2, radius=0.10, amount=1
  }

  scenario aquaplanet "Aquaplanet" {
    set ocean = 1
    set spring = 0
    set moisture = 0.8
  }

  scenario dryWorld "Dry world" {
    set ocean = 0
    set spring = 0
    set moisture = 0.08
    spot spring at lon=0, lat=0, radius=0.18, amount=1
  }
}
`;

export const pipeline = compileV2(pipelineDsl);
