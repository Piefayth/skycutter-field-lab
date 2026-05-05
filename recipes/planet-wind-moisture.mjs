// Minimal planet wind/moisture mechanic.
//
// One scalar field is carried by one derived wind field. No sources, no
// drying, no clouds, no local mixing. This recipe exists to make advection
// direction and particle-trail direction easy to inspect.

import { compileV2 } from "../dsl/compile-v2.mjs";

export const overlays = [];

export const metrics = [
  { id: "moisture", label: "MOISTURE", source: "dsl:moistureMean", spark: true, precision: 3 },
  { id: "fps", label: "FPS", source: "fps", mini: true },
];

export const regime = {
  silent: { moisture: 0.02 },
  active: { moisture: 0.08 },
  runaway: { moisture: 0.7 },
};

export const pipelineDsl = `
recipe "Planet wind moisture"
summary "Minimal planet test: a derived wind field advects one moisture layer. No sources, drying, clouds, or diffusion."
recommendedPreset blob

substrate geodesic frequency 32

field moisture: f32
field wind: vec2 derived

param simRateHz slider 0..240 step 1 default 60 label "SIM RATE"
param rate      slider 1..60  step 1 default 12 label "RATE"
param windSpeed slider 0..2   step 0.01 default 0.80 label "WIND SPEED"
param tradeWind slider 0..2   step 0.01 default 0.85 label "TRADE WINDS"
param jetStream slider 0..2   step 0.01 default 0.95 label "JET STREAMS"
param stormWave slider 0..2   step 0.01 default 0.55 label "STORM WAVES"
param crossFlow slider 0..2   step 0.01 default 0.45 label "CROSS-FLOW"
param polarCalm slider 0..1   step 0.01 default 0.75 label "POLAR CALM"
param drift     slider 0..2   step 0.01 default 0.65 label "DRIFT"
param flowScale slider 0..1   step 0.01 default 0.45 label "ADVECTION SCALE"

step {
  stage windField "Wind field" {
    reads moisture
    writes wind
    cell {
      let t = frame / 210 * drift
      let absLat = abs(lat)
      let poleFade = pow(max(cos(lat), 0), 1.2 + polarCalm * 3.2)
      let equatorCalm = smoothstep(0.10, 0.36, absLat)
      let tropics = smoothstep(0.20, 0.52, absLat) * (1 - smoothstep(0.72, 1.02, absLat))
      let midLat = smoothstep(0.48, 0.82, absLat) * (1 - smoothstep(1.08, 1.34, absLat))
      let jetCore = smoothstep(0.56, 0.82, absLat) * (1 - smoothstep(0.96, 1.18, absLat))
      let hemisphere = lat >= 0 ? 1 : -1
      let trades = -hemisphere * tradeWind * tropics * 0.46
      let jets = hemisphere * jetStream * midLat * 0.62
      let waveA = sin(lon * 4 + t + hemisphere * 1.4)
      let waveB = sin(lon * 7 - t * 0.8 + lat * 2.2)
      let stormBand = stormWave * jetCore * poleFade
      let eddyEast = stormBand * 0.18 * waveA
      let eddyNorth = stormBand * crossFlow * 0.26 * waveB
      let east = (trades + jets + eddyEast) * poleFade * equatorCalm
      let north = eddyNorth
      set wind = vec2(east, north) * windSpeed
    }
  }

  stage advect "Wind moves moisture" {
    reads moisture, wind
    writes moisture
    cell {
      let p = upstream(wind * flowScale, dt * rate)
      set moisture = clamp(moisture@p, 0, 1.2)
    }
  }
}

metric moistureMean = mean cells { moisture }

views {
  palette MOISTURE {
    stop 0 color [35, 28, 22]
    stop 0.35 color [58, 82, 84]
    stop 0.7 color [70, 155, 190]
    stop 1 color [215, 245, 255]
  }

  view moisture "Moisture" {
    color ramp moisture range [0, 1] palette MOISTURE
    particles advect=wind count=1800 length=12 speed=1.25 fade=0.88 size=3.8 color [210, 238, 255]
  }
}

stamps {
  stamp wet "Add moisture" {
    spot moisture at brush.pos, radius=brush.r, amount=0.7
  }

  stamp dry "Remove moisture" {
    spot moisture at brush.pos, radius=brush.r, amount=-0.7
  }
}

scenarios {
  scenario blob "Moving blob" {
    set moisture = 0
    spot moisture at lon=-1.4, lat=0.2, radius=0.35, amount=1
    spot moisture at lon=0.9, lat=-0.45, radius=0.22, amount=0.65
  }

  scenario bands "Latitude bands" {
    for each cell {
      let band = abs(lat) < 0.32 ? 0.85 : 0
      let pocket = sin(lon * 5) > 0.58 ? 0.35 : 0
      set moisture = band + pocket
    }
  }

  scenario blank "Blank" {
    set moisture = 0
  }
}
`;

export const pipeline = compileV2(pipelineDsl);
