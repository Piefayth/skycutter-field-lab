// Planet heat layer.
//
// One scalar temperature field plus permanent ocean/albedo masks. Latitude
// forcing, thermal inertia, greenhouse balance, ice feedback, and local
// diffusion create climate bands without needing a full weather model.

import { compileV2 } from "../dsl/compile-v2.mjs";

export const overlays = [];

export const metrics = [
  { id: "meanT", label: "MEAN T", source: "dsl:meanT", spark: true, precision: 3 },
  { id: "hot", label: "HOT AREA", source: "dsl:hotArea", mini: true, precision: 0 },
  { id: "cold", label: "COLD AREA", source: "dsl:coldArea", mini: true, precision: 0 },
  { id: "ice", label: "ICE AREA", source: "dsl:iceArea", mini: true, precision: 0 },
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
summary "Single-layer planetary temperature. Sunlight, albedo, ocean inertia, greenhouse balance, ice feedback, seasons, and diffusion form stable climate bands and hot/cold anomalies."
recommendedPreset continents

substrate geodesic frequency 32

source ocean: f32
source albedo: f32

field T: f32
field ice: f32 derived
field comfort: f32 derived

param simRateHz slider 0..180 step 1 default 45 label "SIM RATE"
param rate      slider 1..80  step 1 default 16 label "RATE"
param sun       slider 0..2   step 0.01 default 1.05 label "SUN"
param greenhouse slider 0..2 step 0.01 default 0.38 label "GREENHOUSE"
param cooling   slider 0..2   step 0.01 default 0.90 label "COOLING"
param oceanInertia slider 0..1 step 0.01 default 0.72 label "OCEAN INERTIA"
param diffusion slider 0..2   step 0.01 default 0.42 label "DIFFUSION"
param seasonal  slider 0..1   step 0.01 default 0.24 label "SEASONS"
param iceFeedback slider 0..1 step 0.01 default 0.68 label "ICE FEEDBACK"

step {
  stage climate "Radiation + thermal inertia" {
    reads T, ocean, albedo
    writes T, ice, comfort
    cell {
      let season = seasonal * sin(frame / 900)
      let sunAngle = max(0, cos(lat - season * 0.55))
      let frozen = clamp((-0.12 - T) * 3.4, 0, 1)
      let reflect = clamp(albedo + frozen * iceFeedback * (1 - albedo), 0, 0.92)
      let absorbed = sun * sunAngle * (1 - reflect)
      let inertia = 1 - ocean * oceanInertia * 0.74
      let solarGain = absorbed * 0.54
      let greenhouseGain = greenhouse * 0.10
      let outgoing = cooling * max(T + 0.48, 0) * (0.26 + max(T, 0) * 0.18)
      let oceanMemory = ocean * sun * oceanInertia * (0.06 + sunAngle * 0.14 - T) * 0.12
      let next = clamp(T + (solarGain + greenhouseGain + oceanMemory - outgoing) * inertia * dt * rate, -1.2, 1.45)
      let iceNext = clamp((-0.12 - next) * 3.4, 0, 1)
      set T = next
      set ice = iceNext
      set comfort = clamp(1 - abs(next - 0.18) * 1.65 - iceNext * 0.22 - albedo * 0.10, 0, 1)
    }
  }

  stage diffuse "Ocean/atmosphere heat exchange" {
    reads T, ocean
    writes T
    cell {
      let k = clamp(diffusion * (0.55 + ocean * 0.70) * dt * rate, 0, 0.22)
      add T = (mean n in neighbors { T@n } - T) * k
    }
  }
}

metric meanT = mean cells { T }
metric hotArea = count cells where T > 0.55
metric coldArea = count cells where T < -0.35
metric iceArea = count cells where ice > 0.35

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

  palette ICE {
    stop 0 color [20, 24, 34]
    stop 0.35 color [70, 110, 145]
    stop 1 color [235, 250, 255]
  }

  view temp "Temperature" {
    color ramp T range [-1, 1.2] palette TEMP
  }

  view ice "Ice" {
    color ramp ice range [0, 1] palette ICE
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
