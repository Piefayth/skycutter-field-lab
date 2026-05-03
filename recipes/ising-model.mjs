// Ising model on a sphere — the first recipe that uses explicit
// per-cell RNG state.
//
// Each cell carries:
//   - spin: 0 or 1, interpreted as -1 or +1,
//   - rng: a persistent u32 random state,
//   - changed: whether the spin flipped this tick.
//
// Every tick each cell draws rand01(rng), decides whether to flip by
// the Boltzmann probability for its neighbor energy, then advances
// rng with rngNext(rng). The random draw and state transition are both
// ordinary expressions; there is no hidden mutable RNG behind a call.

import { compileV2 } from "../dsl/compile-v2.mjs";

export const overlays = [];

export const metrics = [
  { id: "magnet", label: "MAGNET", source: "dsl:magnet", spark: true, precision: 3 },
  { id: "flips", label: "FLIPS", source: "dsl:flips", spark: true, precision: 0 },
  { id: "walls", label: "WALLS", source: "dsl:walls", mini: true, precision: 3 },
  { id: "fps", label: "FPS", source: "fps", mini: true },
];

export const regime = {
  silent: { flips: 0 },
  intermittent: { flips: 20 },
  active: { flips: 400 },
  runaway: { flips: 20000 },
};

export const pipelineDsl = `
recipe "Ising model"
summary "Stochastic ferromagnet on a sphere. Each cell stores a spin and explicit RNG state; rand01(rng) proposes flips and rngNext(rng) advances the state. Low temperature coarsens into domains, high temperature boils."
recommendedPreset random

substrate geodesic frequency 48

field spin: u32
field rng: u32

field spinSigned: f32 derived
field changed: u32 derived
field wall: f32 derived

param temperature slider 0.05..6 step 0.01 default 2.2 label "TEMPERATURE"
param coupling slider 0..2 step 0.01 default 1 label "COUPLING J"
param fieldBias slider -1..1 step 0.01 default 0 label "FIELD BIAS"
param simRateHz slider 0..120 step 1 default 60 label "SIM RATE"
param rate slider 1..10 step 1 default 1 label "RATE"

step {
  stage flip "Metropolis spin flip" {
    reads spin, rng
    writes spin, changed, rng
    cell {
      // Normalize painted / initialized values to the two legal states.
      let current = spin > 0.5 ? 1 : 0
      let s = current > 0.5 ? 1 : -1
      let neighborSum = sum n in neighbors { (spin@n > 0.5) ? 1 : -1 }

      // Energy change if this spin flips. Negative means the flip
      // lowers energy and is always accepted.
      let deltaE = 2 * s * (coupling * neighborSum + fieldBias)
      let accept = deltaE <= 0 ? 1 : exp(-deltaE / max(temperature, 0.001))
      let r = rand01(rng)
      let doFlip = r < accept

      set spin = doFlip ? (1 - current) : current
      set changed = doFlip ? 1 : 0
      set rng = rngNext(rng)
    }
  }

  stage diagnostics "Signed spin + wall strength" {
    reads spin, changed
    writes spinSigned, wall
    cell {
      let s = spin > 0.5 ? 1 : -1
      let neighborMean = mean n in neighbors { (spin@n > 0.5) ? 1 : -1 }
      set spinSigned = s
      set wall = abs(s - neighborMean) * 0.5
    }
  }
}

metric magnet = mean cells { spinSigned }
metric flips = sum cells { changed }
metric walls = mean cells { wall }

views {
  palette SPIN {
    stop 0 color [35, 75, 200]
    stop 0.5 color [245, 245, 245]
    stop 1 color [210, 45, 45]
  }

  palette ACTIVITY {
    stop 0 color [10, 12, 18]
    stop 1 color [250, 220, 80]
  }

  view spin "Spin domains" {
    color ramp spinSigned range [-1, 1] palette SPIN
  }

  view wall "Domain walls" {
    color ramp wall range [0, 1] palette ACTIVITY
  }

  view changed "Recent flips" {
    color ramp changed range [0, 1] palette ACTIVITY
  }
}

stamps {
  stamp up "Magnetize up" {
    spot spin at brush.pos, radius=brush.r, amount=1
  }

  stamp down "Magnetize down" {
    spot spin at brush.pos, radius=brush.r, amount=-1
  }

  stamp scramble "Scramble RNG" {
    spot rng at brush.pos, radius=brush.r, amount=104729
  }
}

scenarios {
  scenario random "Random hot start" {
    for each cell {
      let r = cellRand(7) * 0.5 + 0.5
      set spin = r > 0.5 ? 1 : 0
      set rng = abs(cellRand(101) * 16777215)
    }
  }

  scenario ordered "All spins up" {
    set spin = 1
    for each cell {
      set rng = abs(cellRand(103) * 16777215)
    }
  }

  scenario domains "Two hemispheres" {
    for each cell {
      set spin = lat > 0 ? 1 : 0
      set rng = abs(cellRand(107) * 16777215)
    }
  }

  scenario droplet "Minority droplet" {
    set spin = 1
    for each cell {
      set rng = abs(cellRand(109) * 16777215)
    }
    spot spin at lon=0, lat=0, radius=0.35, amount=-1
  }
}
`;

export const pipeline = compileV2(pipelineDsl);
