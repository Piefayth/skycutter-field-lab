// Ice-albedo feedback — bistable climate.
//
// Each cell carries a temperature T. The atmosphere absorbs solar
// energy at a rate that depends on the surface's reflectivity (albedo):
// ice reflects most of it; bare ocean / land absorbs most of it. Albedo
// itself depends on temperature — cold cells freeze and become bright
// (high albedo); warm cells thaw and become dark (low albedo).
//
// That's a positive feedback: cold → ice → reflects more → stays cold.
// Same for warm. The system has TWO stable basins:
//
//   - "warm earth": ice only at the poles, equator hot.
//   - "snowball earth": ice everywhere, sphere frozen solid.
//
// At a marginal solar input you can sit on the boundary; a localized
// perturbation can flip the entire planet. Believed to have happened in
// real life ~600 Mya — multiple snowball events in geological history.
//
// Equation per cell:
//   albedo(T) = mix(albedoIce, albedoOcean, smoothstep(-eps, +eps, T - freezePoint))
//   absorbed  = solar(lat) * (1 - albedo(T))
//   emitted   = sigma * (T + offset)^4              (Stefan-Boltzmann-ish)
//   dT/dt     = greenhouse * absorbed - emitted + diffusion(T)

import { diverge, gray } from "../prims/colorers.mjs";
import { compileDsl } from "../dsl/compiler.mjs";

export const views = [
  { id: "T", label: "Temperature", color: diverge("T", 1.5) },
  { id: "albedo", label: "Albedo", color: gray("albedo") },
];

export const overlays = [];

export const metrics = [
  { id: "meanT",   label: "MEAN T",  source: "T",                  spark: true, precision: 3 },
  { id: "iceArea", label: "ICE",     source: "coverage:albedo:0.5", spark: true, precision: 3 },
  { id: "fps",     label: "FPS",     source: "fps",                mini: true },
];

export const regime = {
  silent:        { iceArea: 0.95 },
  intermittent:  { iceArea: 0.5 },
  active:        { iceArea: 0.2 },
  runaway:       { iceArea: 0.0 },
};

export const pipelineDsl = `
recipe "Ice-albedo (snowball earth)"
summary "Bistable climate. Cold cells freeze and reflect more sunlight, staying cold; warm cells thaw and absorb more, staying warm. Real Earth has done this — geological 'snowball' epochs are theorized for the late Proterozoic. Tip the solar knob past the threshold and the whole planet flips."
recommendedPreset earth
grid geodesic tiles 64

const freezePoint 0.0
const eps         0.10
const albedoIce   0.7
const albedoOcean 0.18

use clock dt, frame
use geo lon, lat, x, y, i, N, PI, TAU
use sim cell, diffuse
use init fill, spot, eachCell
use core clamp, smoothstep, max, min, abs, hypot, cos, sin, exp, pow, cellNoise, cellRand

// T: surface temperature, normalized so 0 ≈ freezing point.
// albedo: derived field — recomputed each tick from T. Useful as its
// own view to see the ice mask develop.
field T, albedo

setting simRateHz slider min 0 max 360 step 1 default 60 label "SIM RATE"
// Solar constant. Around 1.0 is "modern Earth"; below ~0.6 the system
// snaps to snowball; above ~1.4 it stays warm regardless of perturbations.
param solar       slider min 0 max 2    step 0.01 default 1.00 label "SOLAR"
// Greenhouse multiplier on absorbed sunlight. Higher = warmer overall.
param greenhouse  slider min 0.5 max 2  step 0.01 default 1.10 label "GREENHOUSE"
// How fast warm regions radiate energy back to space.
param emissivity  slider min 0    max 4 step 0.01 default 1.20 label "EMISSIVITY"
// Heat conduction across the surface. Higher = sharper smoothing of
// temperature gradients, less spatial structure.
param diffusion   slider min 0    max 4 step 0.01 default 0.40 label "DIFFUSION"
// Slow Milankovitch-like solar oscillation. Sets the system breathing
// across the bistability — at moderate amplitude, the planet flips
// between warm and snowball every few orbits, and you can watch the
// ice line march around the sphere. 0 = constant solar (equilibrium).
param orbital     slider min 0    max 0.5 step 0.005 default 0.18 label "ORBITAL VAR"
// Period of the orbital variation in frames. Lower = faster cycle.
param orbitalRate slider min 100  max 5000 step 50 default 1200 label "ORBIT FRAMES"
// Volcanic / stochastic per-cell forcing. Random thermal kicks each
// tick — keeps the system stirred even at zero orbital variation.
param volcanic    slider min 0    max 0.5 step 0.005 default 0.04 label "VOLCANIC"
// Time scaling. Climate responds slowly relative to per-frame sim — let
// users speed it up if they want to see equilibration faster.
param rate        slider min 1    max 100 step 1  default 30   label "RATE"

stamp warm "Warmth pulse" {
  // Drop a hot patch — useful for kicking a snowball back into the
  // warm basin near the threshold.
  spot T lon lon lat lat radius r amount 0.8
}

stamp freeze "Freeze patch" {
  // Inverse — drop a cold patch.
  spot T lon lon lat lat radius r amount -0.8
}

preset earth "Modern earth" {
  // Latitude-banded warm-cold gradient — equator hottest, poles below
  // freezing. Settles into a stable ice-cap distribution.
  fill albedo 0.18
  eachCell {
    set T = cos(lat) * 0.9 - 0.3
  }
}

preset snowball "Snowball earth" {
  // Whole planet frozen. Without enough solar/greenhouse to escape,
  // it stays this way.
  fill albedo 0.7
  fill T -0.6
}

preset edge "Edge of bistability" {
  // A near-uniform field at the threshold. Small perturbations will
  // decide the basin. Stamp warm or cold patches to influence the
  // outcome.
  fill albedo 0.4
  eachCell {
    set T = 0.05 * cos(lat) + 0.02 * cellNoise(7, 1.5)
  }
}

stage diffuseT "Surface heat conduction" {
  reads T
  writes T
  diffuse T amount diffusion * 0.18 * dt * rate
}

stage radiate "Solar absorption + thermal emission" {
  reads T
  writes T, albedo
  cell {
    // Albedo is a smooth step from ocean (warm) to ice (cold) around
    // the freeze point. Smoothstep eps controls how sharp the
    // ice-edge transition is.
    let frozen = 1 - smoothstep(freezePoint - eps, freezePoint + eps, T)
    let alb    = albedoOcean + (albedoIce - albedoOcean) * frozen
    // Slowly-varying solar (Milankovitch-flavored). The recipe runs
    // continuously even at low solar — no static equilibrium.
    let solarMod   = solar * (1 + orbital * sin(frame / orbitalRate))
    // Solar input falls off toward the poles; cos(lat) peaks at the
    // equator. \`max(0, ...)\` because cos can go slightly negative on
    // the curved geodesic representation in WGSL float math.
    let insolation = max(0, solarMod * cos(lat))
    let absorbed   = greenhouse * insolation * (1 - alb)
    // Linear emission instead of Stefan-Boltzmann's T^4 — keeps the
    // bistability structure but stays well within float precision and
    // doesn't need tiny dt to integrate stably.
    let emitted = emissivity * (T + 0.4)
    // Volcanic / stochastic per-cell kicks. Keeps the system from
    // settling perfectly even at zero orbital variation.
    let volcanism = cellRand(frame) * volcanic
    add T = (absorbed - emitted + volcanism) * dt * rate
    set albedo = alb
  }
}
`;

export const pipeline = compileDsl(pipelineDsl);
