// SIR spatial epidemic — Kendall / Murray model.
//
// The classical compartment model lifted to a spatial field: every cell
// holds three densities — Susceptible, Infected, Recovered — and a
// person can transition S → I (via local contact) or I → R (recovery).
// Adding diffusion of I models population mobility: an outbreak in one
// region spreads to neighbors over time.
//
// Equations per cell:
//   dS/dt = -beta * S * I
//   dI/dt =  beta * S * I - gamma * I        (+ diffusion of I)
//   dR/dt =  gamma * I
//
// What you see: a traveling wave of infection radiating outward from
// the seed, leaving a "burnout" trail of recovered behind it. Once
// the wave passes a region, S has been depleted and the wave can't
// re-enter — so isolated outbreaks burn through to extinction. R0
// (= beta / gamma) sets the wave speed and final attack rate.
//
// Murray's classic "rabies-fox" application of this model produces a
// ring of rabid foxes propagating across a continent.

import { compileV2 } from "../dsl/compile-v2.mjs";

export const overlays = [];

export const metrics = [
  { id: "infected",   label: "I",     source: "I",            spark: true, precision: 3 },
  { id: "recovered",  label: "R",     source: "R",            spark: true, precision: 3 },
  { id: "susceptible",label: "S",     source: "S",            spark: true, precision: 3 },
  { id: "outbreak",   label: "OUTBRK", source: "coverage:I:0.05", mini: true, precision: 3 },
  { id: "fps",        label: "FPS",   source: "fps",          mini: true },
];

export const regime = {
  silent: {},
  intermittent: { outbreak: 0.005 },
  active: { outbreak: 0.05 },
  runaway: { outbreak: 0.4 },
};

export const pipelineDsl = `
recipe "SIR epidemic"
summary "Spatial Susceptible-Infected-Recovered model. Outbreak waves propagate from seed points; burnt-out (recovered) regions can't re-infect, so the front always moves outward into susceptible territory. Beta / gamma is the basic reproduction number — slide it past 1.0 and the wave starts to travel."
recommendedPreset patientZero

substrate geodesic frequency 64

field S: f32
field I: f32
field R: f32

// Three compartments mapped to a high-contrast palette so each one
// occupies a different part of the lightness/temperature space rather
// than three pastel siblings. Visual language is forest-fire satellite
// imagery — untouched canopy = pale cream, active fire = orange,
// burn scar = deep navy.
//   S = [248, 232, 175]
//   I = [255,  85,  35]
//   R = [ 36,  50,  85]

palette I_RAMP {
  stop 0 color [12, 12, 22]
  stop 1 color [255, 110, 50]
}

palette R_RAMP {
  stop 0 color [16, 22, 28]
  stop 1 color [120, 200, 240]
}

palette S_RAMP {
  stop 0 color [0, 0, 0]
  stop 1 color [255, 255, 255]
}

view composite "S / I / R" {
  color expr {
    let total     = max(S + I + R, 0.000001)
    let ws        = S / total
    let wi        = I / total
    let wr        = R / total
    // Boost the Infected contribution — even a 5% I share saturates
    // the orange channel, so the wavefront stays visible against the
    // surrounding S+R blend.
    let iBoost    = clamp(wi * 6, 0, 1)
    let remaining = 1 - iBoost
    let srSum     = max(ws + wr, 0.000001)
    let sw        = ws / srSum * remaining
    let rw        = wr / srSum * remaining
    set red   = 248 * sw + 255 * iBoost + 36 * rw
    set green = 232 * sw + 85  * iBoost + 50 * rw
    set blue  = 175 * sw + 35  * iBoost + 85 * rw
  }
}

view I "Infected (I)" {
  color ramp I range [0, 1.5] palette I_RAMP
}

view R "Recovered (R)" {
  color ramp R range [0, 1] palette R_RAMP
}

view S "Susceptible (S)" {
  color ramp S range [0, 1] palette S_RAMP
}

param simRateHz slider 0..360 step 1 default 60 label "SIM RATE"
// Infection rate per S·I contact. Together with gamma sets R0 = β/γ.
// Default 1.4 gives R0 = 4 — moderate epidemic, visible but stable.
// Crank to ~3 for an explosive wave; drop below ~0.4 to make the
// outbreak die in place (R0 < 1).
param beta        slider 0..4     step 0.01     default 1.40    label "β (INFECT)"
// Recovery rate. Higher = faster transition out of I, narrower
// infected band. 0.35 gives a wavefront ~3 cell-diameters wide.
param gamma       slider 0..2     step 0.01     default 0.35    label "γ (RECOVER)"
// Mobility of infected — how fast the outbreak diffuses across cells.
param mobility    slider 0..4     step 0.01     default 0.70    label "MOBILITY"
// Waning immunity — R→S rate. With waning > 0 the model becomes
// SIRS instead of SIR; the planet supports recurrent epidemic waves.
param waning      slider 0..0.5   step 0.001    default 0.030   label "WANING (R→S)"
// Background introduction rate — fraction of S converted to I each tick.
param immigration slider 0..0.001 step 0.000005 default 0.00002 label "IMMIGRATE"
// Time scaling. Effective dt per tick = (1/60)·rate. Keep \`β·dt·rate\`
// well below 1 for stable wavefronts.
param rate        slider 1..100   step 1        default 12      label "RATE"

stamp seed "Plant outbreak" {
  spot I at brush.pos, radius=brush.r, amount=0.4
  spot S at brush.pos, radius=brush.r, amount=-0.3
}

stamp vaccinate "Vaccinate region" {
  spot R at brush.pos, radius=brush.r, amount=0.6
  spot S at brush.pos, radius=brush.r, amount=-0.6
}

stamp barrier "Recovered firewall" {
  spot R at brush.pos, radius=brush.r * 0.5, amount=0.85
  spot S at brush.pos, radius=brush.r * 0.5, amount=-0.85
}

scenario patientZero "Single seed" {
  set S = 0.95
  set I = 0
  set R = 0
  spot I at lon=0, lat=0, radius=0.08, amount=0.4
  spot S at lon=0, lat=0, radius=0.08, amount=-0.3
}

scenario multiSeed "Three seeds" {
  set S = 0.95
  set I = 0
  set R = 0
  spot I at lon=-1.5, lat=0.4,  radius=0.08, amount=0.4
  spot S at lon=-1.5, lat=0.4,  radius=0.08, amount=-0.3
  spot I at lon=1.5,  lat=-0.4, radius=0.08, amount=0.4
  spot S at lon=1.5,  lat=-0.4, radius=0.08, amount=-0.3
  spot I at lon=0,    lat=1.0,  radius=0.08, amount=0.4
  spot S at lon=0,    lat=1.0,  radius=0.08, amount=-0.3
}

scenario preVaccinated "Partial herd immunity" {
  set I = 0
  for each cell {
    let immune = cellNoise(11, 1.5) * 0.5 + 0.5
    when immune > 0.5 {
      set R = 0.7
      set S = 0.3
    }
    when immune <= 0.5 {
      set R = 0
      set S = 1
    }
  }
  spot I at lon=0, lat=0, radius=0.08, amount=0.4
  spot S at lon=0, lat=0, radius=0.08, amount=-0.3
}

step {
  stage spread "Spatial mobility of infected" {
    reads I
    writes I
    cell {
      add I = (mean n in neighbors { I@n } - I) * clamp(mobility * 0.18 * dt * rate, 0, 0.24)
    }
  }

  stage react "S→I→R(→S) reaction" {
    reads S, I, R
    writes S, I, R
    cell {
      let infect    = beta * S * I
      let recover   = gamma * I
      let wane      = waning * R
      let reseeding = immigration * S
      add S = (-infect + wane - reseeding) * dt * rate
      add I = (infect - recover + reseeding) * dt * rate
      add R = (recover - wane)              * dt * rate
    }
  }

  stage clampPositive "Keep populations non-negative" {
    reads S, I, R
    writes S, I, R
    cell {
      set S = clamp(S, 0, 1)
      set I = clamp(I, 0, 1)
      set R = clamp(R, 0, 1)
    }
  }
}
`;

export const pipeline = compileV2(pipelineDsl);
