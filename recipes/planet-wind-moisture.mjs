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
param bandFlow  slider 0..2   step 0.01 default 1.00 label "BAND FLOW"
param eddyFlow  slider 0..2   step 0.01 default 0.70 label "EDDY FLOW"
param northFlow slider 0..2   step 0.01 default 0.85 label "N/S FLOW"
param drift     slider 0..2   step 0.01 default 0.75 label "DRIFT"
param flowScale slider 0..1   step 0.01 default 0.45 label "ADVECTION SCALE"

step {
  stage windField "Wind field" {
    reads moisture
    writes wind
    cell {
      let t = frame / 180 * drift
      let trades = -0.34 * sin(lat * 2.4)
      let jet = 0.56 * sin(lat * 5.1)
      let polar = 0.22 * sin(lat * 8.0)
      let wave1 = sin(lon * 3 + t + sin(lat * 2))
      let wave2 = sin(lon * 5 - t * 0.7 + lat * 3)
      let bandEast = bandFlow * (trades + jet + polar)
      let eddyEast = eddyFlow * 0.22 * wave1 * sin(lat * 2)
      let eddyNorth = eddyFlow * northFlow * (0.28 * wave2 * cos(lat) + 0.14 * sin(lon * 2 - t) * sin(lat * 3))
      let east = bandEast + eddyEast
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
