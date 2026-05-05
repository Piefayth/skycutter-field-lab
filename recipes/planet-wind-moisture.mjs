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
field windFlow: vec2 derived

param simRateHz slider 0..240 step 1 default 60 label "SIM RATE"
param rate      slider 1..60  step 1 default 12 label "RATE"
param windSpeed slider 0..2   step 0.01 default 0.92 label "WIND SPEED"
param belts     slider 0..2   step 0.01 default 0.85 label "BELTS"
param meander   slider 0..2   step 0.01 default 0.80 label "MEANDER"
param eddies    slider 0..2   step 0.01 default 0.70 label "EDDIES"
param shear     slider 0..2   step 0.01 default 0.55 label "SHEAR"
param moisturePull slider 0..2 step 0.01 default 0.05 label "MOISTURE PULL"
param drift     slider 0..2   step 0.01 default 0.70 label "DRIFT"
param flowScale slider 0..1   step 0.01 default 0.45 label "ADVECTION SCALE"

step {
  stage windField "Wind field" {
    reads moisture
    writes wind, windFlow
    cell {
      let t = frame / 260 * drift
      let absLat = abs(lat)
      let cosLat = max(cos(lat), 0)
      let poleFade = pow(cosLat, 0.75)
      let equator = 1 - smoothstep(0.18, 0.48, absLat)
      let tropics = smoothstep(0.18, 0.44, absLat) * (1 - smoothstep(0.70, 0.98, absLat))
      let midLat = smoothstep(0.50, 0.75, absLat) * (1 - smoothstep(1.05, 1.32, absLat))
      let jetBand = smoothstep(0.55, 0.78, absLat) * (1 - smoothstep(0.92, 1.14, absLat))
      let hemisphere = lat >= 0 ? 1 : -1
      let waveA = lon * 3 + t + sin(lat * 2.0) * 1.2
      let waveB = lon * 5 - t * 0.7 + lat * 2.8
      let waveC = lon * 8 + t * 1.4 - lat * 4.6
      let beltEast = belts * (-hemisphere * tropics * 0.36 + hemisphere * midLat * 0.62 + equator * sin(lon * 2 - t * 0.35) * 0.10)
      let jetWobble = meander * jetBand * (vec2(0.16 * sin(waveA), 0.30 * hemisphere * cos(waveA)) + vec2(0.08 * sin(waveB), 0.16 * cos(waveB)))
      let eddyGate = (0.30 + 0.70 * tropics + 0.65 * midLat) * poleFade
      let cellA = sin(waveB) * cos(lat * 3.0 + t * 0.35)
      let cellB = cos(waveC) * sin(lat * 5.0 - t * 0.25)
      let eddyFlow = eddies * eddyGate * vec2(0.20 * cellA - 0.12 * cellB, 0.16 * cos(waveB) + 0.10 * sin(waveC))
      let shearFlow = shear * vec2(sin(lat * 5.0 + 0.7 * sin(lon * 2.0 - t)) * 0.18, cos(lon * 2.0 + lat * 2.0 + t * 0.5) * (tropics - midLat) * 0.12)
      let moistGrad = gradient(moisture)
      let moistFlow = moisturePull * vec2(-moistGrad.x * 0.28, -moistGrad.y * 0.28)
      let raw = vec2(beltEast, 0) + jetWobble + eddyFlow + shearFlow + moistFlow
      let flow = raw * windSpeed
      set wind = flow
      set windFlow = flow * flowScale
    }
  }

  stage advect "Wind moves moisture" {
    reads moisture, windFlow
    writes moisture
    cell {
      let p = upstream(windFlow, dt * rate)
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
    particles advect=windFlow count=1800 length=12 speed=1 fade=0.88 size=3.8 color [210, 238, 255]
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
