// Planet heat layer.
//
// One scalar temperature field plus permanent ocean/albedo masks. Latitude
// forcing, ocean buffering, and local diffusion create climate bands without
// needing a full weather model.

import { compileV2 } from "../dsl/compile-v2.mjs";

export const overlays = [];

export const metrics = [
  { id: "meanT", label: "MEAN T", source: "dsl:meanT", spark: true, precision: 3 },
  { id: "hot", label: "HOT AREA", source: "dsl:hotArea", mini: true, precision: 0 },
  { id: "cold", label: "COLD AREA", source: "dsl:coldArea", mini: true, precision: 0 },
  { id: "fps", label: "FPS", source: "fps", mini: true },
];

export const regime = {
  silent: { meanT: -0.35 },
  intermittent: { meanT: 0.05 },
  active: { meanT: 0.45 },
  runaway: { meanT: 0.95 },
};

export const pipelineDsl = `
recipe "Planet heat"
summary "Single-layer planetary temperature. Sunlight, albedo, ocean buffering, and diffusion form stable climate bands and hot/cold anomalies. A simple temperature substrate for later ecology and weather recipes."
recommendedPreset continents

substrate geodesic frequency 32

source ocean: f32
source albedo: f32

field T: f32
field comfort: f32 derived

param simRateHz slider 0..180 step 1 default 45 label "SIM RATE"
param rate      slider 1..80  step 1 default 16 label "RATE"
param sun       slider 0..2   step 0.01 default 1.05 label "SUN"
param cooling   slider 0..2   step 0.01 default 0.82 label "COOLING"
param oceanMix  slider 0..2   step 0.01 default 0.48 label "OCEAN BUFFER"
param diffusion slider 0..2   step 0.01 default 0.55 label "DIFFUSION"
param seasonal  slider 0..1   step 0.01 default 0.20 label "SEASONS"

step {
  stage climate "Latitude forcing + ocean buffer" {
    reads T, ocean, albedo
    writes T, comfort
    cell {
      let season = seasonal * sin(frame / 900)
      let sunAngle = max(0, cos(lat - season * 0.55))
      let reflect = clamp(albedo, 0, 1)
      let oceanTarget = 0.10 + 0.20 * sunAngle
      let landTarget = -0.28 + sun * sunAngle * (1 - 0.65 * reflect)
      let climateGoal = ocean * oceanTarget + (1 - ocean) * landTarget
      let buffer = ocean * oceanMix + (1 - ocean) * 0.35
      let tendency = (climateGoal - T) * buffer - cooling * max(T - 0.15, 0) * 0.18
      let next = clamp(T + tendency * dt * rate, -1.2, 1.4)
      set T = next
      set comfort = clamp(1 - abs(next - 0.18) * 1.65 - albedo * 0.18, 0, 1)
    }
  }

  stage diffuse "Atmosphere/ocean smoothing" {
    reads T
    writes T
    cell {
      let k = clamp(diffusion * dt * rate, 0, 0.20)
      add T = (mean n in neighbors { T@n } - T) * k
    }
  }
}

metric meanT = mean cells { T }
metric hotArea = count cells where T > 0.55
metric coldArea = count cells where T < -0.35

views {
  palette TEMP {
    stop 0 color [35, 65, 165]
    stop 0.35 color [190, 220, 235]
    stop 0.55 color [95, 170, 95]
    stop 0.78 color [230, 175, 65]
    stop 1 color [190, 48, 34]
  }

  palette COMFORT {
    stop 0 color [24, 22, 36]
    stop 0.5 color [75, 145, 105]
    stop 1 color [210, 228, 135]
  }

  view temp "Temperature" {
    color ramp T range [-1, 1.2] palette TEMP
  }

  view comfort "Habitable band" {
    color ramp comfort range [0, 1] palette COMFORT
  }
}

stamps {
  stamp hot "Heat anomaly" {
    spot T at brush.pos, radius=brush.r, amount=0.45
  }

  stamp cold "Cold anomaly" {
    spot T at brush.pos, radius=brush.r, amount=-0.45
  }

  stamp ice "Paint high albedo" {
    set albedo at brush.pos, radius=brush.r, value=1
  }

  stamp darken "Erase albedo" {
    set albedo at brush.pos, radius=brush.r, value=0
  }
}

scenarios {
  scenario continents "Continents + ice caps" {
    for each cell {
      let landWave = sin(lon * 2.0) + 0.65 * sin(lat * 3.3 + lon * 0.7)
      let ice = abs(lat) > 0.95 ? 1 : 0
      set ocean = landWave < -0.15 ? 1 : 0
      set albedo = ice
      set T = -0.2 + max(0, cos(lat)) * 0.6 - ice * 0.35
    }
  }

  scenario snowball "Snowball" {
    set ocean = 0.45
    set albedo = 0.85
    set T = -0.55
  }

  scenario warmHouse "Warm house" {
    set ocean = 0.55
    set albedo = 0.05
    for each cell {
      set T = 0.15 + max(0, cos(lat)) * 0.55
    }
  }
}
`;

export const pipeline = compileV2(pipelineDsl);
