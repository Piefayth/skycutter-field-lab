// Conservative runoff over first-class graph edges.
//
// Water moves from each cell to lower neighboring terrain via `edge`
// flux. The next cell stage uses the resulting wet, fast-flowing
// channels to erode height. This is intentionally compact rather than
// geologically strict: it exists to make the edge primitive visible.

import { compileV2 } from "../dsl/compile-v2.mjs";

export const overlays = [];

export const metrics = [
  { id: "water", label: "WATER", source: "dsl:waterMean", spark: true, precision: 3 },
  { id: "flow", label: "FLOW", source: "dsl:flowMean", spark: true, precision: 3 },
  { id: "relief", label: "RELIEF", source: "dsl:relief", mini: true, precision: 3 },
  { id: "fps", label: "FPS", source: "fps", mini: true },
];

export const regime = {
  silent: { flow: 0.001 },
  intermittent: { flow: 0.01 },
  active: { flow: 0.04 },
  runaway: { water: 0.95 },
};

export const pipelineDsl = `
recipe "Runoff erosion"
summary "Rain collects on terrain and moves downhill through conservative edge flux. Wet channels erode the height field, carving drainage basins and ridges on the sphere."
recommendedPreset highlands

substrate geodesic frequency 32

field height: f32
field water: f32
field flow: f32 derived
field slope: f32 derived

param simRateHz slider 0..240 step 1 default 60 label "SIM RATE"
param rate      slider 1..45  step 1 default 18 label "RATE"
param rain      slider 0..0.6 step 0.005 default 0.12 label "RAIN"
param runoff    slider 0..8   step 0.01 default 2.8 label "RUNOFF"
param evap      slider 0..3   step 0.01 default 0.55 label "EVAP"
param erode     slider 0..1.2 step 0.005 default 0.20 label "ERODE"
param uplift    slider 0..0.25 step 0.005 default 0.025 label "UPLIFT"

step {
  stage rainStep "Rain + slope diagnostics" {
    reads height, water
    writes water, slope, flow
    cell {
      let slopeMag = length(gradient(height))
      let rainBands = 0.55 + 0.45 * max(0, cos(lat * 2 + frame * 0.003))
      let nextWater = clamp(water + (rain * rainBands - evap * water) * dt * rate, 0, 1.4)
      set water = nextWater
      set slope = (slopeMag * 2.0) / (1 + slopeMag * 2.0)
      set flow = (nextWater * slopeMag * 2.4) / (1 + nextWater * slopeMag * 2.4)
    }
  }

  stage runoffStep "Conservative downhill water flux" {
    reads water, height
    writes water
    edge n in neighbors {
      let drop = max((height + water * 0.15) - (height@n + water@n * 0.15), 0)
      flux water = water * clamp(drop * runoff * dt * rate, 0, 0.12)
    }
  }

  stage erosionStep "Water cuts channels" {
    reads height, water, slope
    writes height
    cell {
      let cut = erode * water * slope
      let smoothing = mean n in neighbors { height@n } - height
      let tectonic = uplift * (0.55 + 0.45 * cellNoise(2, 1.5))
      let nextHeight = clamp(height + (tectonic + smoothing * 0.08 - cut) * dt * rate, 0, 1.5)
      set height = nextHeight
    }
  }
}

metric waterMean = mean cells { water }
metric flowMean = mean cells { flow }
metric relief = max cells { height }

views {
  palette TERRAIN {
    stop 0 color [38, 48, 42]
    stop 0.28 color [74, 104, 54]
    stop 0.58 color [164, 148, 92]
    stop 0.82 color [126, 118, 108]
    stop 1 color [236, 238, 224]
  }

  palette WATER {
    stop 0 color [22, 24, 28]
    stop 0.18 color [48, 76, 92]
    stop 0.55 color [42, 132, 180]
    stop 1 color [220, 245, 255]
  }

  palette FLOW {
    stop 0 color [18, 18, 24]
    stop 0.35 color [62, 112, 170]
    stop 0.75 color [90, 220, 210]
    stop 1 color [255, 245, 150]
  }

  view terrain "Terrain" {
    color ramp height range [0, 1.3] palette TERRAIN
  }

  view water "Water" {
    color ramp water range [0, 1.1] palette WATER
  }

  view flow "Flow channels" {
    color ramp flow range [0, 0.8] palette FLOW
  }
}

stamps {
  stamp storm "Add rainwater" {
    spot water at brush.pos, radius=brush.r, amount=0.8
  }

  stamp raise "Raise terrain" {
    spot height at brush.pos, radius=brush.r, amount=0.25
  }

  stamp carve "Carve basin" {
    spot height at brush.pos, radius=brush.r, amount=-0.30
  }
}

scenarios {
  scenario highlands "Noisy highlands" {
    for each cell {
      let ridge = 0.45 + 0.28 * cellNoise(4, 1.7) + 0.14 * sin(lon * 5) * cos(lat * 3)
      set height = clamp(ridge, 0.05, 1.35)
      set water = 0.08
    }
  }

  scenario crater "Crater lake" {
    for each cell {
      let d = sqrt(lon * lon + lat * lat)
      let rim = exp(-pow((d - 0.62) / 0.16, 2))
      let bowl = 0.95 - exp(-pow(d / 0.48, 2)) * 0.55 + rim * 0.45
      set height = clamp(bowl + cellNoise(6, 0.6) * 0.05, 0.05, 1.4)
      set water = d < 0.32 ? 0.7 : 0.04
    }
  }
}
`;

export const pipeline = compileV2(pipelineDsl);
