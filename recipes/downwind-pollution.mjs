// Downwind pollution plume.
//
// Persistent factory sources emit pollutant. A derived wind field gives each
// cell an east/north tangent direction. Conservative edge flux then sends
// pollutant preferentially to neighbors aligned with direction(n), making the
// coord helper visible as a directed graph transport pattern.

import { compileV2 } from "../dsl/compile-v2.mjs";

export const overlays = [];

export const metrics = [
  { id: "pollution", label: "POLLUTION", source: "dsl:pollutionMean", spark: true, precision: 3 },
  { id: "peak", label: "PEAK", source: "dsl:peakPollution", spark: true, precision: 3 },
  { id: "sources", label: "FACTORIES", source: "dsl:factoryCount", mini: true, precision: 0 },
  { id: "fps", label: "FPS", source: "fps", mini: true },
];

export const regime = {
  silent: { pollution: 0.01 },
  intermittent: { pollution: 0.08 },
  active: { pollution: 0.25 },
  runaway: { peak: 1.8 },
};

export const pipelineDsl = `
recipe "Downwind pollution plume"
summary "Persistent single-cell factories emit pollutant. A wind field drives conservative edge flux only toward neighbors aligned with direction(n), producing streaking downwind plumes instead of isotropic diffusion."
recommendedPreset tradeWinds

substrate geodesic frequency 32

source factory: f32

field pollutant: f32
field wind: vec2 derived
field windSpeed: f32 derived
field plume: f32 derived

param simRateHz slider 0..240 step 1 default 60 label "SIM RATE"
param rate      slider 1..60  step 1 default 24 label "RATE"
param emission  slider 0..5   step 0.01 default 1.35 label "EMISSION"
param transport slider 0..12  step 0.01 default 4.80 label "TRANSPORT"
param windBias  slider 0..4   step 0.01 default 2.10 label "WIND BIAS"
param crossMix  slider 0..0.4 step 0.005 default 0.045 label "CROSS MIX"
param decay     slider 0..2   step 0.01 default 0.42 label "DECAY"

step {
  stage windField "Planetary wind field" {
    reads factory
    writes wind, windSpeed
    cell {
      let jet = 0.55 + 0.35 * cos(lat * 3.0)
      let meander = 0.26 * sin(lon * 1.7 + frame / 260)
      let sourceLift = 0.10 * factory * sin(lon * 2.0 + lat)
      let raw = vec2(jet, meander - 0.18 * sin(lat * 2.0) + sourceLift)
      let speed = max(length(raw), 0.001)
      set wind = raw / speed
      set windSpeed = speed
    }
  }

  stage emit "Factories emit pollutant" {
    reads pollutant, factory
    writes pollutant
    cell {
      let input = factory * emission
      set pollutant = clamp(pollutant + input * dt * rate, 0, 2.2)
    }
  }

  stage transportStep "Downwind edge transport" {
    reads pollutant, wind
    writes pollutant
    edge n in neighbors {
      let downwind = max(dot(wind, direction(n)), 0)
      let distWeight = clamp(0.045 / max(distance(n), 0.001), 0.45, 1.2)
      let push = crossMix + windBias * downwind
      flux pollutant = pollutant * clamp(push * distWeight * transport * dt * rate, 0, 0.16)
    }
  }

  stage decayAndDisplay "Decay + display helpers" {
    reads pollutant, factory
    writes pollutant, plume
    cell {
      let nextPollution = clamp(pollutant * (1 - decay * dt * rate), 0, 2.2)
      let halo = mean n in disk(2) { pollutant@n }
      set pollutant = nextPollution
      set plume = nextPollution * 0.55 + halo * 0.75 + factory * 0.35
    }
  }
}

metric pollutionMean = mean cells { pollutant }
metric peakPollution = max cells { pollutant }
metric factoryCount = count cells where factory > 0.1

views {
  palette PLUME {
    stop 0 color [12, 16, 22]
    stop 0.22 color [34, 58, 64]
    stop 0.55 color [130, 108, 52]
    stop 0.82 color [235, 132, 50]
    stop 1 color [255, 238, 170]
  }

  palette WIND {
    stop 0 color [16, 22, 32]
    stop 0.5 color [60, 138, 178]
    stop 1 color [220, 246, 255]
  }

  view plume "Pollution plume" {
    color ramp plume range [0, 1] palette PLUME
    particles advect=wind count=1800 length=14 speed=0.65 fade=0.90 size=2 color [230, 244, 255]
  }

  view pollutant "Pollutant" {
    color ramp pollutant range [0, 1.7] palette PLUME
  }

  view wind "Wind speed" {
    color ramp windSpeed range [0, 1.2] palette WIND
    particles advect=wind count=1400 length=12 speed=0.8 fade=0.88 size=2 color [210, 238, 255]
  }
}

stamps {
  stamp factory "Place factory" {
    spot factory at brush.pos, radius=0, amount=1
  }

  stamp eraseFactory "Erase factory" {
    set factory at brush.pos, radius=brush.r, value=0
  }

  stamp clean "Clean pollutant" {
    spot pollutant at brush.pos, radius=brush.r, amount=-1.0
  }
}

scenarios {
  scenario tradeWinds "Trade-wind factories" {
    set factory = 0
    set pollutant = 0
    spot factory at lon=-1.7, lat=0.12, radius=0, amount=1
    spot factory at lon=-0.9, lat=-0.32, radius=0, amount=1
    spot factory at lon=0.35, lat=0.42, radius=0, amount=1
  }

  scenario industrialBelt "Industrial belt" {
    set factory = 0
    set pollutant = 0
    spot factory at lon=-2.1, lat=-0.18, radius=0, amount=1
    spot factory at lon=-1.6, lat=-0.10, radius=0, amount=1
    spot factory at lon=-1.1, lat=-0.04, radius=0, amount=1
    spot factory at lon=-0.6, lat=0.02, radius=0, amount=1
  }

  scenario blank "Blank planet" {
    set factory = 0
    set pollutant = 0
  }
}
`;

export const pipeline = compileV2(pipelineDsl);
