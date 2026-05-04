// Weather cycle — toy climate/water loop on a geodesic planet.
//
// This is not a full atmospheric model. It is a compact Field Lab
// recipe that exposes the pieces people expect from "weather":
//
//   - land/ocean mask as a persistent source
//   - surface water evaporates into vapor
//   - vapor advects along wind, condenses into clouds, then rains out
//   - rainfall refills surface water; evaporation cools the surface
//   - a periodic tide field pushes winds over oceans
//
// The goal is interaction and authoring variety: paint storms, oceans,
// deserts, and watch rain belts organize around flow rather than just
// diffusing as another scalar field.

import { compileV2 } from "../dsl/compile-v2.mjs";

export const overlays = [];

export const metrics = [
  { id: "cloud", label: "CLOUD", source: "dsl:cloudCover", spark: true, precision: 3 },
  { id: "rain",  label: "RAIN",  source: "dsl:rainMean",   spark: true, precision: 3 },
  { id: "water", label: "WATER", source: "dsl:waterMean",  spark: true, precision: 3 },
  { id: "wind",  label: "MAX |W|", source: "dsl:maxWind",  mini: true, precision: 3 },
  { id: "fps",   label: "FPS",   source: "fps",            mini: true },
];

export const regime = {
  silent:       { cloud: 0.02 },
  intermittent: { cloud: 0.12 },
  active:       { cloud: 0.35 },
  runaway:      { cloud: 0.75 },
};

export const pipelineDsl = `
recipe "Weather cycle"
summary "Toy planetary weather: ocean/land mask, surface water, vapor, clouds, rain, wind, temperature, and a periodic tide field. Evaporation feeds vapor, wind advects it, condensation rains it back out, and tides shove the pressure field over oceans."
recommendedPreset continents

// Frequency 32 keeps wind/advection readable without making the water
// cycle too sluggish. The recipe is intentionally painterly rather
// than numerically strict.
substrate geodesic frequency 32

source land: f32              // 1 = land, 0 = ocean

field water: f32              // surface water / ocean depth proxy
field vapor: f32              // atmospheric moisture
field T: f32                  // normalized surface temperature
field wind: vec2              // tangent-frame wind
field cloud: f32 derived      // condensed vapor
field rain: f32 derived       // precipitation intensity
field tide: f32 derived       // oscillating ocean tide anomaly
field speed: f32 derived      // wind speed for rendering

param simRateHz  slider 0..360    step 1      default 60    label "SIM RATE"
param rate       slider 1..80     step 1      default 18    label "RATE"
param sun        slider 0..2      step 0.01   default 1.0   label "SUN"
param evap       slider 0..2      step 0.01   default 0.55  label "EVAP"
param condense   slider 0..5      step 0.01   default 2.8   label "CONDENSE"
param rainRate   slider 0..6      step 0.01   default 3.2   label "RAINOUT"
param windDrive  slider 0..4      step 0.01   default 1.25  label "WIND DRIVE"
param thermal    slider 0..3      step 0.01   default 0.8   label "THERMAL WIND"
param friction   slider 0..3      step 0.01   default 0.8   label "FRICTION"
param rotation   slider 0..3      step 0.01   default 0.9   label "ROTATION"
param flowScale  slider 0..2      step 0.01   default 0.8   label "VAPOR FLOW"
param tideAmp    slider 0..0.8    step 0.005  default 0.24  label "TIDE AMP"
param tidePeriod slider 60..3000  step 10     default 720   label "TIDE PERIOD"
param diffusion  slider 0..2      step 0.01   default 0.35  label "MIXING"

step {
  stage tideForcing "Ocean tide field" {
    reads land
    writes tide
    cell {
      let ocean = 1 - land
      let wave = sin(lon * 2 - frame / tidePeriod) * cos(lat)
      set tide = tideAmp * ocean * wave
    }
  }

  stage windStep "Pressure + thermal wind" {
    reads water, tide, T, wind, land
    writes wind, speed
    cell {
      let pressureGrad = gradient(water + tide)
      let thermalGrad = gradient(T)
      let f = rotation * sin(lat)
      let coriolis = vec2(f * wind.y, -f * wind.x)
      let accel = pressureGrad * (-windDrive) + thermalGrad * thermal + coriolis
      let damp = clamp(friction * dt * rate, 0, 0.35)
      let nextWind = (wind + accel * dt * rate) * (1 - damp)
      set wind = nextWind
      set speed = length(nextWind)
    }
  }

  stage advectVapor "Wind carries vapor" {
    reads vapor, wind
    writes vapor
    cell {
      let adv = vapor@upstream(wind.x * flowScale, wind.y * flowScale, dt * rate)
      set vapor = clamp(adv, 0, 2.5)
    }
  }

  stage cloudsAndRain "Condensation + rainout" {
    reads vapor, T
    writes vapor, cloud, rain
    cell {
      let warm = clamp((T + 0.6) / 1.8, 0, 1)
      let saturation = 0.18 + 0.18 * warm
      let excess = max(vapor - saturation, 0)
      let cloudNow = excess * condense
      let rainNow = cloudNow * rainRate * 0.16
      let nextVapor = vapor + (-rainNow * 0.18) * dt * rate
      set vapor = clamp(nextVapor, 0, 2.5)
      set cloud = clamp(cloudNow, 0, 1)
      set rain = clamp(rainNow, 0, 2)
    }
  }

  stage surfaceCycle "Evaporation, rain, heating" {
    reads water, vapor, rain, cloud, T, land
    writes water, vapor, T
    cell {
      let ocean = 1 - land
      let warm = clamp((T + 0.4) / 1.6, 0, 1)
      let surfaceWet = clamp(water, 0, 1)
      let evaporation = evap * surfaceWet * (0.18 + 0.55 * warm) * (1 - 0.45 * land)
      let runoff = land * max(water - 0.8, 0) * 0.65
      let oceanRestore = ocean * (1 - water) * 0.8
      let nextWater = water + (rain * 0.16 - evaporation - runoff + oceanRestore) * dt * rate
      set water = clamp(nextWater, 0, 1.2)
      add vapor = evaporation * 0.22 * dt * rate

      let insolation = sun * max(0, cos(lat)) * (1 - 0.35 * cloud)
      let cooling = 0.65 * (T + 0.15) + evaporation * 0.25
      let oceanBuffer = ocean * (0.15 - T) * 0.25
      let nextT = T + (insolation - cooling + oceanBuffer) * dt * rate
      set T = clamp(nextT, -0.9, 1.4)
    }
  }

  stage mix "Horizontal mixing" {
    reads water, vapor, T
    writes water, vapor, T
    cell {
      let k = clamp(diffusion * dt * rate, 0, 0.18)
      add water = (mean n in neighbors { water@n } - water) * k
      add vapor = (mean n in neighbors { vapor@n } - vapor) * k
      add T = (mean n in neighbors { T@n } - T) * k
    }
  }
}

metric cloudCover = mean cells { cloud }
metric rainMean   = mean cells { rain }
metric waterMean  = mean cells { water }
metric maxWind    = max cells { speed }

views {
  palette TEMP {
    stop 0 color [50, 75, 160]
    stop 0.45 color [225, 238, 245]
    stop 0.62 color [120, 185, 120]
    stop 0.8 color [230, 180, 70]
    stop 1 color [190, 55, 35]
  }

  palette WATER {
    stop 0 color [42, 35, 20]
    stop 0.25 color [90, 130, 75]
    stop 1 color [35, 105, 210]
  }

  palette CLOUDS {
    stop 0 color [12, 18, 34]
    stop 1 color [245, 250, 255]
  }

  palette RAIN {
    stop 0 color [10, 15, 30]
    stop 1 color [70, 190, 255]
  }

  palette WIND {
    stop 0 color [8, 12, 22]
    stop 1 color [255, 210, 90]
  }

  view weather "Weather composite" {
    color expr {
      let l = clamp(land, 0, 1)
      let w = clamp(water, 0, 1)
      let c = clamp(cloud * 3.5, 0, 1)
      let p = clamp(rain * 2.0, 0, 1)
      let warm = clamp((T + 0.4) / 1.6, 0, 1)
      let oceanR = 20 + tide * 35
      let oceanG = 70 + w * 65 + tide * 30
      let oceanB = 125 + w * 105
      let landR = 62 + warm * 95 - w * 25
      let landG = 80 + w * 95 + warm * 35
      let landB = 45 + w * 45
      let baseR = oceanR * (1 - l) + landR * l
      let baseG = oceanG * (1 - l) + landG * l
      let baseB = oceanB * (1 - l) + landB * l
      let cloudR = 235 + p * 20
      let cloudG = 240 + p * 15
      let cloudB = 245 + p * 10
      set red = baseR * (1 - c) + cloudR * c
      set green = baseG * (1 - c) + cloudG * c
      set blue = baseB * (1 - c) + cloudB * c
    }
    glyph "→" rotate=wind length=0.45 stride=4
  }

  view water "Surface water" {
    color ramp water range [0, 1.2] palette WATER
  }

  view clouds "Clouds" {
    color ramp cloud range [0, 0.35] palette CLOUDS
  }

  view rain "Rain" {
    color ramp rain range [0, 0.6] palette RAIN
  }

  view temp "Temperature" {
    color ramp T range [-0.8, 1.2] palette TEMP
  }

  view wind "Wind" {
    color ramp speed range [0, 1.5] palette WIND
    glyph "→" rotate=wind length=0.6 stride=3
  }
}

stamps {
  stamp storm "Seed storm" {
    on press {
      spot vapor at brush.pos, radius=brush.r * 0.7, amount=0.9
      spot T at brush.pos, radius=brush.r * 0.8, amount=-0.25
    }
  }

  stamp rainmaker "Rainmaker" {
    spot vapor at brush.pos, radius=brush.r, amount=0.45
  }

  stamp dry "Dry air" {
    spot vapor at brush.pos, radius=brush.r, amount=-0.55
    spot water at brush.pos, radius=brush.r, amount=-0.25
  }

  stamp ocean "Paint ocean" {
    set land at brush.pos, radius=brush.r, value=0
    set water at brush.pos, radius=brush.r, value=1
  }

  stamp landBrush "Paint land" {
    set land at brush.pos, radius=brush.r, value=1
    set water at brush.pos, radius=brush.r, value=0.25
  }
}

scenarios {
  scenario continents "Continents + trade winds" {
    for each cell {
      let n = cellNoise(17, 1.2) + 0.45 * cellNoise(23, 2.1)
      let polarOcean = abs(lat) > 1.15 ? -0.35 : 0
      let continent = n + 0.25 * cos(lon * 2.0) + polarOcean
      set land = continent > 0.08 ? 1 : 0
      set water = land > 0.5 ? 0.28 + 0.08 * cellNoise(31, 3.0) : 1
      set vapor = 0.45 + 0.28 * max(0, cos(lat)) + 0.08 * cellNoise(41, 2.0)
      set T = 0.55 * max(0, cos(lat)) - 0.2 * land + 0.05 * cellNoise(47, 1.5)
      set wind = vec2(0.2 * sin(lat * 2), 0.08 * sin(lon))
    }
  }

  scenario aquaplanet "Aquaplanet" {
    set land = 0
    for each cell {
      set water = 1
      set vapor = 0.45 + 0.25 * max(0, cos(lat))
      set T = 0.65 * max(0, cos(lat)) - 0.05
      set wind = vec2(0.28 * sin(lat * 2), 0)
    }
  }

  scenario dryWorld "Dry world" {
    set land = 1
    for each cell {
      set water = 0.08 + 0.04 * cellNoise(5, 2.0)
      set vapor = 0.12 + 0.04 * cellNoise(7, 1.5)
      set T = 0.7 * max(0, cos(lat)) + 0.15
      set wind = vec2(0.18 * sin(lat * 2), 0.04 * cellNoise(9, 1.0))
    }
  }
}
`;

export const pipeline = compileV2(pipelineDsl);
