// Wilson-Cowan neural field on the geodesic mesh.
//
// This is a continuous excitation-inhibition model: nearby activity
// excites a cell, a wider annulus suppresses it, and a sigmoid converts
// that net drive into the target firing rate. The two radial interactions
// are metric bell kernels over great-circle distance, so the authored
// scales are spatial scales rather than graph-hop counts.

import { compileV2 } from "../dsl/compile-v2.mjs";

export const overlays = [];

export const metrics = [
  { id: "meanU", label: "MEAN", source: "dsl:meanU", spark: true, precision: 3 },
  { id: "activityMean", label: "ACTIVITY", source: "dsl:activityMean", spark: true, precision: 3 },
  { id: "activeArea", label: "AREA", source: "dsl:activeArea", mini: true, precision: 0 },
  { id: "fps", label: "FPS", source: "fps", mini: true },
];

export const regime = {
  silent: { activityMean: 0.0001 },
  intermittent: { activityMean: 0.004 },
  active: { activityMean: 0.02 },
  runaway: { activeArea: 8000 },
};

export const pipelineDsl = `
recipe "Wilson-Cowan neural field"
summary "Excitation-inhibition neural field on a sphere. A narrow metric bell kernel gathers local excitation; a wider annular bell kernel gathers inhibition. The sigmoid firing response turns random seed activity into pulses, labyrinths, and breathing cortical-wave patterns."
recommendedPreset cortex

substrate geodesic frequency 32

field u: f32
field excitation: f32 derived
field inhibition: f32 derived
field drive: f32 derived
field activity: f32 derived

param excite slider 0..4 step 0.01 default 2.25 label "EXCITE"
param inhibit slider 0..4 step 0.01 default 2.10 label "INHIBIT"
param threshold slider -1..1 step 0.01 default 0.12 label "THRESHOLD"
param sharpness slider 1..16 step 0.1 default 8.0 label "SHARPNESS"
param response slider 0..8 step 0.01 default 2.6 label "RESPONSE"
param inhibitCenter slider 0.06..0.14 step 0.001 default 0.105 label "INHIBIT RADIUS"
param simRateHz slider 0..120 step 1 default 45 label "SIM RATE"
param rate slider 1..10 step 1 default 1 label "RATE"

step {
  stage evolve "Excitation-inhibition field" {
    reads u
    writes u, excitation, inhibition, drive, activity
    cell {
      // Short-range excitation: center-weighted smoothing around self.
      let e = mean n in kernel bell(0, 0.040) { u@n }
      // Longer-range inhibition: an annular gather. Moving inhibitCenter
      // changes the wavelength of the resulting patches and fronts.
      let h = mean n in kernel bell(inhibitCenter, 0.014) { u@n }
      let d = excite * e - inhibit * h - threshold
      let firing = 1 / (1 + exp(-sharpness * d))
      let next = clamp(u + (firing - u) * response * rate * dt, 0.001, 0.999)

      set excitation = e
      set inhibition = h
      set drive = d
      set activity = abs(next - u)
      set u = next
    }
  }
}

metric meanU = mean cells { u }
metric activityMean = mean cells { activity }
metric activeArea = count cells where u > 0.5

views {
  palette FIRING {
    stop 0 color [8, 10, 18]
    stop 0.25 color [32, 55, 100]
    stop 0.55 color [70, 175, 150]
    stop 0.8 color [230, 210, 95]
    stop 1 color [255, 245, 215]
  }

  palette DRIVE {
    stop 0 color [42, 72, 190]
    stop 0.5 color [18, 20, 28]
    stop 1 color [235, 95, 70]
  }

  palette ACTIVITY {
    stop 0 color [8, 10, 14]
    stop 0.5 color [80, 125, 230]
    stop 1 color [255, 220, 80]
  }

  view u "Firing rate" {
    color ramp u range [0, 1] palette FIRING
  }

  view drive "Net drive" {
    color ramp drive range [-0.8, 0.8] palette DRIVE
  }

  view excitation "Excitation field" {
    color ramp excitation range [0, 1] palette FIRING
  }

  view inhibition "Inhibition field" {
    color ramp inhibition range [0, 1] palette DRIVE
  }

  view activity "Activity" {
    color ramp activity range [0, 0.08] palette ACTIVITY
  }
}

stamps {
  stamp excite "Excite" {
    spot u at brush.pos, radius=brush.r, amount=0.55
  }

  stamp silence "Silence" {
    spot u at brush.pos, radius=brush.r, amount=-0.55
  }

  stamp bias "Nudge" {
    spot u at brush.pos, radius=brush.r, amount=0.18
  }
}

scenarios {
  scenario cortex "Random cortical sheet" {
    for each cell {
      let r = cellRand(61) * 0.5 + 0.5
      let bands = sin(lon * 5) * cos(lat * 4)
      set u = clamp(0.28 + r * 0.22 + bands * 0.10, 0.001, 0.999)
    }
  }

  scenario pulse "Single pulse" {
    set u = 0.08
    spot u at lon=0, lat=0, radius=0.22, amount=0.85
  }

  scenario twins "Two competing pulses" {
    set u = 0.10
    spot u at lon=-0.7, lat=0.25, radius=0.20, amount=0.75
    spot u at lon=1.25, lat=-0.35, radius=0.20, amount=0.75
  }

  scenario band "Biased equator" {
    for each cell {
      let noise = cellRand(67) * 0.5 + 0.5
      let belt = abs(lat) < 0.35
      set u = belt ? 0.45 + noise * 0.12 : 0.12 + noise * 0.08
    }
  }
}
`;

export const pipeline = compileV2(pipelineDsl);
