// FitzHugh-Nagumo — excitable medium. u is the fast "membrane
// potential", v is the slow recovery variable. The cubic reaction
// u(1-u)(u-a) lets u spike past threshold; v rises in response and
// pulls u back down through the -v term, which then lets v decay
// (γv) and the cell becomes excitable again. Spatial diffusion of u
// turns local spikes into traveling waves; an asymmetric v gradient
// breaks a wave into a rotating spiral.

import { compileV2 } from "../dsl/compile-v2.mjs";

export const overlays = [];

export const metrics = [
  { id: "u", label: "U", source: "u", spark: true, precision: 3 },
  { id: "v", label: "V", source: "v", spark: true, precision: 3 },
  { id: "active", label: "U>0.5", source: "coverage:u:0.5", mini: true, precision: 3 },
  { id: "maxU", label: "MAX U", source: "max:u", mini: true, precision: 3 },
  { id: "fps", label: "FPS", source: "fps", mini: true },
];

export const regime = {
  silent: {},
  intermittent: { u: 0.01 },
  active: { "coverage:u:0.5": 0.05 },
  runaway: { "coverage:u:0.5": 0.6 },
};

export const pipelineDsl = `
recipe "FitzHugh-Nagumo"
summary "Excitable medium. Fast u spikes through a cubic threshold; slow v recovers and suppresses. Diffusion turns spikes into traveling fronts; an asymmetric seed breaks a front into a rotating spiral."
recommendedPreset pulses

substrate geodesic frequency 64

const a = 0.13
const epsilon = 0.005
const gamma = 1.0

field u: f32
field v: f32

palette MONO {
  stop 0 color [0, 0, 0]
  stop 1 color [255, 255, 255]
}

palette RECOVERY {
  stop 0 color [16, 22, 32]
  stop 1 color [220, 110, 110]
}

view u "U (membrane)" {
  color ramp u range [0, 1] palette MONO
}

view v "V (recovery)" {
  color ramp v range [0, 1] palette RECOVERY
}

param simRateHz slider 0..360 step 1   default 60  label "SIM RATE"
param diffusion slider 0..4   step 0.05 default 1.0 label "DIFF"
param rate      slider 1..100 step 1   default 30  label "RATE"

stamp pulse "Pulse" {
  spot u at brush.pos, radius=brush.r, amount=1
}

stamp refract "Refractory pad" {
  spot v at brush.pos, radius=brush.r, amount=0.5
}

scenario blank "Blank canvas" {
  set u = 0
  set v = 0
}

scenario spiral "Spiral wave seed" {
  set u = 0
  set v = 0
  region u at lonMin=-0.6, lonMax=0.6, latMin=0,    latMax=PI/2, amount=1
  region v at lonMin=-0.2, lonMax=0.4, latMin=-0.5, latMax=0,    amount=0.4
}

scenario pulses "Random pulses" {
  set u = 0
  set v = 0
  for each cell {
    when cellNoise(7, 0.6) > 0.45 {
      set u = 1
    }
  }
}

scenario front "Plane wave" {
  set u = 0
  set v = 0
  region u at lonMin=-0.2, lonMax=0.2, latMin=-PI/2, latMax=PI/2, amount=1
}

step {
  stage diffuseU "Diffuse u (only u diffuses; v is local recovery)" {
    reads u
    writes u
    cell {
      add u = (mean n in neighbors { u@n } - u) * clamp(diffusion * 0.16 * dt * rate, 0, 0.24)
    }
  }

  stage react "FitzHugh-Nagumo reaction" {
    reads u, v
    writes u, v
    cell {
      let cubic = u * (1 - u) * (u - a)
      add u = (cubic - v) * dt * rate
      add v = epsilon * (u - gamma * v) * dt * rate
    }
  }

  stage clampFields "Clamp to safe envelope" {
    reads u, v
    writes u, v
    cell {
      set u = clamp(u, -0.4, 1.4)
      set v = clamp(v, -0.4, 1.0)
    }
  }
}
`;

export const pipeline = compileV2(pipelineDsl);
