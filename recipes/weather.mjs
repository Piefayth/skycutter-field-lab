// =============================================================================
// Weather recipe.
//
// Real JS module, but the simulation recipe itself is DSL-authored:
// fields, params, presets, stamps, and pipeline stages all live in
// `pipelineDsl` below. The remaining JS exports are render views,
// overlays, metrics, and regime thresholds.
// =============================================================================

// Sim operators and spherical author coordinates/helpers are injected
// into every stage body's compile scope by the runtime; no JS import needed.
// Colorers and state helpers are recipe-time data constructors — they
// run when the recipe loads / when a stamp fires — so they stay as
// static imports.

import {
  ramp, gray, diverge, heat, violet,
  composite, windMagnitude,
} from "../prims/colorers.mjs";

import { compileDsl } from "../dsl/compiler.mjs";

// -----------------------------------------------------------------------------
// Identity + summary
// -----------------------------------------------------------------------------

// Planet constants — Earth-like. Recipe-shipped, not user-tunable
// (parameters are user-tunable; planet is structural). Node bodies
// read these as `gravity` etc; they're immutable for the
// duration of a recipe load. Editing them means editing the recipe.
// Recipe-declared field bundle. Each entry is allocated as a Float32Array
// of length N at recipe-load time.
// windU/windV used to be top-level on `state`; now they're declared
// fields like everything else.
//
// `*Source` fields are forcing maps populated once at preset time
// (see `buildSources` below). They read like any other field; the
// recipe convention is to not mutate them tick-to-tick. Used to be a
// separate `sources` namespace; collapsed into `fields` so the schema
// has one mental category.
// -----------------------------------------------------------------------------
// Configuration data — knobs, toggles. (Pure declarations.)
// -----------------------------------------------------------------------------

// -----------------------------------------------------------------------------
// Views — per-cell colorers. Each entry's `color` is a function returning
// `[r, g, b]`. Most are one-line factory invocations from prims/colorers.
// -----------------------------------------------------------------------------

export const views = [
  { id: "composite", label: "Composite clouds", color: composite() },
  { id: "pressure", label: "Pressure", color: diverge("pressure", 0.75) },
  { id: "wind", label: "Wind magnitude", color: windMagnitude(0.7) },
  { id: "moisture", label: "Moisture", color: ramp("moisture", [8, 32, 60], [60, 150, 240]) },
  { id: "cloud", label: "Cloud density", color: gray("cloud") },
  { id: "exhaustion", label: "Exhaustion", color: ramp("exhaustion", [34, 28, 46], [255, 194, 84]) },
  { id: "temperature", label: "Temperature", color: heat("temperature") },
  { id: "catalyst", label: "Catalyst", color: violet("catalyst") },
  { id: "lift", label: "Lift / convergence", color: diverge("lift") },
  { id: "reaction", label: "Cloud growth rate", color: diverge("reaction", 4.0) },
];

// -----------------------------------------------------------------------------
// Metrics — derived measurements. (Same shape as current; no migration
// needed beyond moving from JSON to module export.)
// -----------------------------------------------------------------------------

export const metrics = [
  { id: "cloud", label: "CLOUD", source: "cloud", spark: true },
  { id: "variance", label: "VAR σ²", source: "cloudVariance", spark: true },
  { id: "events", label: "EVENTS", source: "events", spark: true },
  { id: "active", label: "ACTIVE", source: "activeArea", spark: true },
  { id: "wind", label: "WIND", source: "wind", mini: true },
  { id: "growth", label: "G/T", source: "growth", mini: true },
  { id: "fps", label: "FPS", source: "fps", mini: true },
];

// -----------------------------------------------------------------------------
// Regime thresholds. Same shape as current — declarative bucket → threshold
// map. Authors can wrap a predicate function in here too if they want.
// -----------------------------------------------------------------------------

export const regime = {
  intermittent: { events: 0, cloudVariance: 0.0008, cloud: 0.01 },
  active: { events: 100, cloudVariance: 0.012, activeArea: 0.06 },
  runaway: { events: 5000, activeArea: 0.6 },
};

// =============================================================================
// Pipeline — the simulation graph.
//
// `nodes` is keyed by id. Each node is { name, inputs, outputs, runIf?, run }.
// `edges` is the explicit dataflow wiring: each entry is
// `[fromNodeId.fromPort, toNodeId.toPort]`. The runtime topologically sorts
// the nodes from the edge set; cycles are an error.
//
// For weather, every stage that touches a field reads the latest version
// produced upstream — so the edge set is a long linear chain. In a less
// linear recipe, edges would fan in / out independently. The editor will
// (eventually) render this as a DAG with draggable connections.
// =============================================================================

export const pipelineDsl = `recipe "Weather"
summary "Forcing-driven weather pipeline. Single attractor; useful as a baseline."
recommendedPreset weather
grid geodesic tiles 64

planet mass 5.972e24
planet radius 6.371e6
planet gravity 9.81
planet rotationPeriod 86400
planet axialTilt 23.44
planet atmosphereHeight 1.0e5
const rainoutBase 0.024
const rainoutSink 0.05
const moistureForcingRate 0.018
const heatForcingRate 0.024
const catalystForcingRate 0.016

use clock dt, frame
use geo x, y, i, lon, lat, u, v, px, py, pz, N, PI, TAU
use sim wind, advect, diffuse, clamp, normalize, cell, event, each
use init fill, spot, ellipse, eachCell
use core clamp, smoothstep, max, min, abs, hypot, cellNoise, sin, asin, cos, exp, pow

field pressure, moisture, cloud, temperature, catalyst, exhaustion
source moistureSource, heatSource, catalystSource, sinkSource

setting simRateHz slider min 0 max 360 step 1 default 90 label "SIM RATE"
param windStrength slider min 0 max 8 step 0.05 default 2.6 label "WIND"
param diffusion slider min 0 max 1 step 0.01 default 0.16 label "DIFF"
param condense slider min 0 max 3 step 0.02 default 1.35 label "COND"
param feedback slider min 0 max 3 step 0.02 default 2 label "FBK"
param exhaustionRate slider min 0 max 3 step 0.02 default 0.3 label "EXH"
param forcing slider min 0 max 3 step 0.02 default 1 label "FORC"
param noiseAmp slider min 0 max 0.05 step 0.001 default 0.006 label "NOISE"
param catalystEffect slider min -2 max 2 step 0.02 default 0.75 label "CAT·E"
param enableCatalyst boolean default true label "catalyst coupling"
param enableFeedback boolean default true label "storm feedback"
param enableExhaustion boolean default true label "slow inhibition"
param enableForcing boolean default true label "sources / sinks"
param enableStochastic boolean default true label "stochasticity"

stamp stormSeed "Storm seed" {
  spot pressure lon lon lat lat radius r * 1.35 amount -0.72
  spot moisture lon lon lat lat radius r * 1.6 amount 0.44
  spot temperature lon lon lat lat radius r * 1.1 amount 0.28
  spot cloud lon lon lat lat radius r * 0.72 amount 0.52
  spot exhaustion lon lon lat lat radius r * 1.35 amount -0.28
}

stamp pressureCouplet "Pressure couplet" {
  spot pressure lon lon - r * 1.1 lat lat radius r amount 0.82
  spot pressure lon lon + r * 1.1 lat lat radius r amount -0.82
  spot moisture lon lon lat lat radius r * 1.1 amount 0.18
}

stamp coldFront "Cold front" {
  ellipse pressure lon lon - r * 0.8 lat lat rx r * 0.8 ry r * 2.8 amount 0.55 angle -0.42
  ellipse pressure lon lon + r * 0.8 lat lat rx r * 0.8 ry r * 2.8 amount -0.55 angle -0.42
  ellipse temperature lon lon - r * 0.7 lat lat rx r ry r * 2.6 amount -0.35 angle -0.42
  ellipse temperature lon lon + r * 0.8 lat lat rx r ry r * 2.6 amount 0.28 angle -0.42
  ellipse moisture lon lon lat lat rx r * 0.7 ry r * 2.7 amount 0.34 angle -0.42
}

stamp catalystSeed "Catalyst seed" {
  spot catalyst lon lon lat lat radius r * 1.55 amount 0.85
  spot moisture lon lon lat lat radius r * 1.2 amount 0.18
  spot exhaustion lon lon lat lat radius r amount -0.18
}

stamp drySlot "Dry slot" {
  ellipse moisture lon lon lat lat rx r * 1.2 ry r * 2.7 amount -0.56 angle 0.72
  ellipse cloud lon lon lat lat rx r * 1.1 ry r * 2.4 amount -0.72 angle 0.72
  ellipse exhaustion lon lon lat lat rx r * 1.25 ry r * 2.7 amount 0.38 angle 0.72
}

stamp cloud "Cloud only" {
  spot cloud lon lon lat lat radius r amount 0.85
  spot moisture lon lon lat lat radius r amount 0.24
}

stamp moisture "Moisture only" {
  spot moisture lon lon lat lat radius r amount 0.42
}

stamp pressureLow "Low pressure only" {
  spot pressure lon lon lat lat radius r amount -0.85
}

stamp pressureHigh "High pressure only" {
  spot pressure lon lon lat lat radius r amount 0.85
}

stamp temperature "Heat only" {
  spot temperature lon lon lat lat radius r amount 0.5
}

stamp catalyst "Catalyst only" {
  spot catalyst lon lon lat lat radius r amount 0.7
}

stamp erase "Erase cloud" {
  spot cloud lon lon lat lat radius r amount -0.8
  spot exhaustion lon lon lat lat radius r amount -0.22
}

preset blank "Blank canvas" {
  eachCell {
    let latitude = lat
    let equator = cos(latitude)
    let pole = 1 - max(0, equator)
    let basin = smoothstep(0.18, 0.82, cellNoise(31, 3) * 0.5 + 0.5)
    let coast = smoothstep(0.34, 0.62, cellNoise(17, 5) * 0.5 + 0.5)
    let moistureSeed = basin * (0.35 + 0.65 * max(0, equator)) + coast * 0.22
    let heatSeed = 0.78 * max(0, equator) - 0.55 * pole
    let band = exp(-pow(sin(x * TAU * 2.0 + y * 5.715), 2) / 0.018)
    set moistureSource = moistureSeed
    set heatSource = heatSeed
    set catalystSource = band * smoothstep(0.15, 0.95, basin)
    set sinkSource = 0.18 + pole * 0.38 + (1 - basin) * 0.16
  }
}

preset weather "Weather cells" {
  eachCell {
    let latitude = lat
    let equator = cos(latitude)
    let pole = 1 - max(0, equator)
    let basin = smoothstep(0.18, 0.82, cellNoise(31, 3) * 0.5 + 0.5)
    let coast = smoothstep(0.34, 0.62, cellNoise(17, 5) * 0.5 + 0.5)
    let moistureSeed = basin * (0.35 + 0.65 * max(0, equator)) + coast * 0.22
    let heatSeed = 0.78 * max(0, equator) - 0.55 * pole
    let band = exp(-pow(sin(x * TAU * 2.0 + y * 5.715), 2) / 0.018)
    set moistureSource = moistureSeed
    set heatSource = heatSeed
    set catalystSource = band * smoothstep(0.15, 0.95, basin)
    set sinkSource = 0.18 + pole * 0.38 + (1 - basin) * 0.16
    set moisture = 0.26 + 0.12 * cellNoise(13, 2)
    set temperature = 0.55 - abs(py) * 0.325 + 0.08 * cellNoise(19, 1.3)
    set catalyst = 0.08 * cellNoise(23, 2)
  }
  spot pressure lon -PI + TAU * 0.15 lat asin(1 - 2 * (0.42 + 0.08 * sin(0 * 1.7))) radius 24 * PI / 128 amount -0.34
  spot moisture lon -PI + TAU * 0.1890625 lat asin(1 - 2 * (0.45125 + 0.08 * sin(0 * 1.7))) radius 26 * PI / 128 amount 0.14
  spot pressure lon -PI + TAU * 0.33 lat asin(1 - 2 * (0.42 + 0.08 * sin(1 * 1.7))) radius 24 * PI / 128 amount 0.32
  spot moisture lon -PI + TAU * 0.3690625 lat asin(1 - 2 * (0.45125 + 0.08 * sin(1 * 1.7))) radius 26 * PI / 128 amount 0.14
  spot pressure lon -PI + TAU * 0.51 lat asin(1 - 2 * (0.42 + 0.08 * sin(2 * 1.7))) radius 24 * PI / 128 amount -0.34
  spot moisture lon -PI + TAU * 0.5490625 lat asin(1 - 2 * (0.45125 + 0.08 * sin(2 * 1.7))) radius 26 * PI / 128 amount 0.14
  spot pressure lon -PI + TAU * 0.69 lat asin(1 - 2 * (0.42 + 0.08 * sin(3 * 1.7))) radius 24 * PI / 128 amount 0.32
  spot moisture lon -PI + TAU * 0.7290625 lat asin(1 - 2 * (0.45125 + 0.08 * sin(3 * 1.7))) radius 26 * PI / 128 amount 0.14
  spot pressure lon -PI + TAU * 0.87 lat asin(1 - 2 * (0.42 + 0.08 * sin(4 * 1.7))) radius 24 * PI / 128 amount -0.34
  spot moisture lon -PI + TAU * 0.9090625 lat asin(1 - 2 * (0.45125 + 0.08 * sin(4 * 1.7))) radius 26 * PI / 128 amount 0.14
}

preset front "Cold front" {
  eachCell {
    let latitude = lat
    let equator = cos(latitude)
    let pole = 1 - max(0, equator)
    let basin = smoothstep(0.18, 0.82, cellNoise(31, 3) * 0.5 + 0.5)
    let coast = smoothstep(0.34, 0.62, cellNoise(17, 5) * 0.5 + 0.5)
    let moistureSeed = basin * (0.35 + 0.65 * max(0, equator)) + coast * 0.22
    let heatSeed = 0.78 * max(0, equator) - 0.55 * pole
    let band = exp(-pow(sin(x * TAU * 2.0 + y * 5.715), 2) / 0.018)
    set moistureSource = moistureSeed
    set heatSource = heatSeed
    set catalystSource = band * smoothstep(0.15, 0.95, basin)
    set sinkSource = 0.18 + pole * 0.38 + (1 - basin) * 0.16
    set moisture = 0.26 + 0.12 * cellNoise(13, 2)
    set temperature = 0.55 - abs(py) * 0.325 + 0.08 * cellNoise(19, 1.3)
    set catalyst = 0.08 * cellNoise(23, 2)
    set pressure = (x < 0.5 ? 0.5 : -0.45) + 0.06 * cellNoise(29, 5)
    add moisture = x < 0.48 ? 0.42 : 0.12
    add temperature = x < 0.5 ? 0.2 : -0.25
  }
}

preset catalystPlume "Catalyst plume" {
  eachCell {
    let latitude = lat
    let equator = cos(latitude)
    let pole = 1 - max(0, equator)
    let basin = smoothstep(0.18, 0.82, cellNoise(31, 3) * 0.5 + 0.5)
    let coast = smoothstep(0.34, 0.62, cellNoise(17, 5) * 0.5 + 0.5)
    let moistureSeed = basin * (0.35 + 0.65 * max(0, equator)) + coast * 0.22
    let heatSeed = 0.78 * max(0, equator) - 0.55 * pole
    let band = exp(-pow(sin(x * TAU * 2.0 + y * 5.715), 2) / 0.018)
    set moistureSource = moistureSeed
    set heatSource = heatSeed
    set catalystSource = band * smoothstep(0.15, 0.95, basin)
    set sinkSource = 0.18 + pole * 0.38 + (1 - basin) * 0.16
    set moisture = 0.26 + 0.12 * cellNoise(13, 2)
    set temperature = 0.55 - abs(py) * 0.325 + 0.08 * cellNoise(19, 1.3)
    set catalyst = 0.08 * cellNoise(23, 2)
  }
  spot pressure lon -PI + TAU * 0.35 lat 0 radius 24 * PI / 128 amount -1.0
  spot pressure lon -PI + TAU * 0.65 lat 0 radius 30 * PI / 128 amount 0.8
  spot catalyst lon -PI + TAU * 0.5 lat asin(1 - 2 * 0.52) radius 18 * PI / 128 amount 1.4
  spot catalyst lon -PI + TAU * 0.58 lat asin(1 - 2 * 0.38) radius 11 * PI / 128 amount 0.8
  spot moisture lon -PI + TAU * 0.45 lat asin(1 - 2 * 0.55) radius 34 * PI / 128 amount 0.65
}

preset pulse "Storm pulse" {
  eachCell {
    let latitude = lat
    let equator = cos(latitude)
    let pole = 1 - max(0, equator)
    let basin = smoothstep(0.18, 0.82, cellNoise(31, 3) * 0.5 + 0.5)
    let coast = smoothstep(0.34, 0.62, cellNoise(17, 5) * 0.5 + 0.5)
    let moistureSeed = basin * (0.35 + 0.65 * max(0, equator)) + coast * 0.22
    let heatSeed = 0.78 * max(0, equator) - 0.55 * pole
    let band = exp(-pow(sin(x * TAU * 2.0 + y * 5.715), 2) / 0.018)
    set moistureSource = moistureSeed
    set heatSource = heatSeed
    set catalystSource = band * smoothstep(0.15, 0.95, basin)
    set sinkSource = 0.18 + pole * 0.38 + (1 - basin) * 0.16
    set moisture = 0.26 + 0.12 * cellNoise(13, 2)
    set temperature = 0.55 - abs(py) * 0.325 + 0.08 * cellNoise(19, 1.3)
    set catalyst = 0.08 * cellNoise(23, 2)
  }
  spot pressure lon 0 lat 0 radius 34 * PI / 128 amount -0.85
  spot moisture lon 0 lat 0 radius 38 * PI / 128 amount 0.72
  spot temperature lon 0 lat 0 radius 24 * PI / 128 amount 0.42
  spot cloud lon 0 lat 0 radius 14 * PI / 128 amount 0.7
  spot exhaustion lon 0 lat 0 radius 12 * PI / 128 amount -0.35
}

preset boundary "Phase boundary" {
  eachCell {
    let latitude = lat
    let equator = cos(latitude)
    let pole = 1 - max(0, equator)
    let basin = smoothstep(0.18, 0.82, cellNoise(31, 3) * 0.5 + 0.5)
    let coast = smoothstep(0.34, 0.62, cellNoise(17, 5) * 0.5 + 0.5)
    let moistureSeed = basin * (0.35 + 0.65 * max(0, equator)) + coast * 0.22
    let heatSeed = 0.78 * max(0, equator) - 0.55 * pole
    let band = exp(-pow(sin(x * TAU * 2.0 + y * 5.715), 2) / 0.018)
    set moistureSource = moistureSeed
    set heatSource = heatSeed
    set catalystSource = band * smoothstep(0.15, 0.95, basin)
    set sinkSource = 0.18 + pole * 0.38 + (1 - basin) * 0.16
    set moisture = 0.26 + 0.12 * cellNoise(13, 2)
    set temperature = 0.55 - abs(py) * 0.325 + 0.08 * cellNoise(19, 1.3)
    set catalyst = 0.08 * cellNoise(23, 2)
  }
  spot moisture lon -PI + TAU * 0.18 lat 0 radius 18 * PI / 128 amount 0.28
  spot pressure lon -PI + TAU * 0.18 lat asin(-0.15625 * sin(0)) radius 16 * PI / 128 amount 0.45
  spot temperature lon -PI + TAU * 0.18 lat 0 radius 13 * PI / 128 amount -0.18
  spot moisture lon -PI + TAU * 0.285 lat 0 radius 18 * PI / 128 amount 0.315
  spot pressure lon -PI + TAU * 0.285 lat asin(-0.15625 * sin(1)) radius 16 * PI / 128 amount -0.55
  spot temperature lon -PI + TAU * 0.285 lat 0 radius 13 * PI / 128 amount -0.125
  spot moisture lon -PI + TAU * 0.39 lat 0 radius 18 * PI / 128 amount 0.35
  spot pressure lon -PI + TAU * 0.39 lat asin(-0.15625 * sin(2)) radius 16 * PI / 128 amount 0.45
  spot temperature lon -PI + TAU * 0.39 lat 0 radius 13 * PI / 128 amount -0.07
  spot moisture lon -PI + TAU * 0.495 lat 0 radius 18 * PI / 128 amount 0.385
  spot pressure lon -PI + TAU * 0.495 lat asin(-0.15625 * sin(3)) radius 16 * PI / 128 amount -0.55
  spot temperature lon -PI + TAU * 0.495 lat 0 radius 13 * PI / 128 amount -0.015
  spot moisture lon -PI + TAU * 0.6 lat 0 radius 18 * PI / 128 amount 0.42
  spot pressure lon -PI + TAU * 0.6 lat asin(-0.15625 * sin(4)) radius 16 * PI / 128 amount 0.45
  spot temperature lon -PI + TAU * 0.6 lat 0 radius 13 * PI / 128 amount 0.04
  spot moisture lon -PI + TAU * 0.705 lat 0 radius 18 * PI / 128 amount 0.455
  spot pressure lon -PI + TAU * 0.705 lat asin(-0.15625 * sin(5)) radius 16 * PI / 128 amount -0.55
  spot temperature lon -PI + TAU * 0.705 lat 0 radius 13 * PI / 128 amount 0.095
  spot moisture lon -PI + TAU * 0.81 lat 0 radius 18 * PI / 128 amount 0.49
  spot pressure lon -PI + TAU * 0.81 lat asin(-0.15625 * sin(6)) radius 16 * PI / 128 amount 0.45
  spot temperature lon -PI + TAU * 0.81 lat 0 radius 13 * PI / 128 amount 0.15
}

preset random "Random blobs" {
  eachCell {
    let latitude = lat
    let equator = cos(latitude)
    let pole = 1 - max(0, equator)
    let basin = smoothstep(0.18, 0.82, cellNoise(31, 3) * 0.5 + 0.5)
    let coast = smoothstep(0.34, 0.62, cellNoise(17, 5) * 0.5 + 0.5)
    let moistureSeed = basin * (0.35 + 0.65 * max(0, equator)) + coast * 0.22
    let heatSeed = 0.78 * max(0, equator) - 0.55 * pole
    let band = exp(-pow(sin(x * TAU * 2.0 + y * 5.715), 2) / 0.018)
    set moistureSource = moistureSeed
    set heatSource = heatSeed
    set catalystSource = band * smoothstep(0.15, 0.95, basin)
    set sinkSource = 0.18 + pole * 0.38 + (1 - basin) * 0.16
    set moisture = 0.26 + 0.12 * cellNoise(13, 2)
    set temperature = 0.55 - abs(py) * 0.325 + 0.08 * cellNoise(19, 1.3)
    set catalyst = 0.08 * cellNoise(23, 2)
  }
  spot pressure lon -PI + TAU * ((cellNoise(1) + 1) * 0.5) lat asin(1 - 2 * (0.14173228346456693 + (cellNoise(2) + 1) * 0.5 * 0.7244094488188977)) radius (13 + (cellNoise(3) + 1) * 0.5 * 18) * PI / 128 amount (cellNoise(4) > 0 ? 0.8 : -0.8)
  spot pressure lon -PI + TAU * ((cellNoise(5) + 1) * 0.5) lat asin(1 - 2 * (0.14173228346456693 + (cellNoise(6) + 1) * 0.5 * 0.7244094488188977)) radius (13 + (cellNoise(7) + 1) * 0.5 * 18) * PI / 128 amount (cellNoise(8) > 0 ? 0.8 : -0.8)
  spot pressure lon -PI + TAU * ((cellNoise(9) + 1) * 0.5) lat asin(1 - 2 * (0.14173228346456693 + (cellNoise(10) + 1) * 0.5 * 0.7244094488188977)) radius (13 + (cellNoise(11) + 1) * 0.5 * 18) * PI / 128 amount (cellNoise(12) > 0 ? 0.8 : -0.8)
  spot pressure lon -PI + TAU * ((cellNoise(13) + 1) * 0.5) lat asin(1 - 2 * (0.14173228346456693 + (cellNoise(14) + 1) * 0.5 * 0.7244094488188977)) radius (13 + (cellNoise(15) + 1) * 0.5 * 18) * PI / 128 amount (cellNoise(16) > 0 ? 0.8 : -0.8)
  spot pressure lon -PI + TAU * ((cellNoise(17) + 1) * 0.5) lat asin(1 - 2 * (0.14173228346456693 + (cellNoise(18) + 1) * 0.5 * 0.7244094488188977)) radius (13 + (cellNoise(19) + 1) * 0.5 * 18) * PI / 128 amount (cellNoise(20) > 0 ? 0.8 : -0.8)
  spot pressure lon -PI + TAU * ((cellNoise(21) + 1) * 0.5) lat asin(1 - 2 * (0.14173228346456693 + (cellNoise(22) + 1) * 0.5 * 0.7244094488188977)) radius (13 + (cellNoise(23) + 1) * 0.5 * 18) * PI / 128 amount (cellNoise(24) > 0 ? 0.8 : -0.8)
  spot pressure lon -PI + TAU * ((cellNoise(25) + 1) * 0.5) lat asin(1 - 2 * (0.14173228346456693 + (cellNoise(26) + 1) * 0.5 * 0.7244094488188977)) radius (13 + (cellNoise(27) + 1) * 0.5 * 18) * PI / 128 amount (cellNoise(28) > 0 ? 0.8 : -0.8)
  spot pressure lon -PI + TAU * ((cellNoise(29) + 1) * 0.5) lat asin(1 - 2 * (0.14173228346456693 + (cellNoise(30) + 1) * 0.5 * 0.7244094488188977)) radius (13 + (cellNoise(31) + 1) * 0.5 * 18) * PI / 128 amount (cellNoise(32) > 0 ? 0.8 : -0.8)
  spot pressure lon -PI + TAU * ((cellNoise(33) + 1) * 0.5) lat asin(1 - 2 * (0.14173228346456693 + (cellNoise(34) + 1) * 0.5 * 0.7244094488188977)) radius (13 + (cellNoise(35) + 1) * 0.5 * 18) * PI / 128 amount (cellNoise(36) > 0 ? 0.8 : -0.8)
  spot moisture lon -PI + TAU * ((cellNoise(37) + 1) * 0.5) lat asin(1 - 2 * (0.14173228346456693 + (cellNoise(38) + 1) * 0.5 * 0.7244094488188977)) radius (18 + (cellNoise(39) + 1) * 0.5 * 20) * PI / 128 amount 0.35 + (cellNoise(40) + 1) * 0.5 * 0.4
  spot moisture lon -PI + TAU * ((cellNoise(41) + 1) * 0.5) lat asin(1 - 2 * (0.14173228346456693 + (cellNoise(42) + 1) * 0.5 * 0.7244094488188977)) radius (18 + (cellNoise(43) + 1) * 0.5 * 20) * PI / 128 amount 0.35 + (cellNoise(44) + 1) * 0.5 * 0.4
  spot moisture lon -PI + TAU * ((cellNoise(45) + 1) * 0.5) lat asin(1 - 2 * (0.14173228346456693 + (cellNoise(46) + 1) * 0.5 * 0.7244094488188977)) radius (18 + (cellNoise(47) + 1) * 0.5 * 20) * PI / 128 amount 0.35 + (cellNoise(48) + 1) * 0.5 * 0.4
  spot moisture lon -PI + TAU * ((cellNoise(49) + 1) * 0.5) lat asin(1 - 2 * (0.14173228346456693 + (cellNoise(50) + 1) * 0.5 * 0.7244094488188977)) radius (18 + (cellNoise(51) + 1) * 0.5 * 20) * PI / 128 amount 0.35 + (cellNoise(52) + 1) * 0.5 * 0.4
  spot moisture lon -PI + TAU * ((cellNoise(53) + 1) * 0.5) lat asin(1 - 2 * (0.14173228346456693 + (cellNoise(54) + 1) * 0.5 * 0.7244094488188977)) radius (18 + (cellNoise(55) + 1) * 0.5 * 20) * PI / 128 amount 0.35 + (cellNoise(56) + 1) * 0.5 * 0.4
  spot moisture lon -PI + TAU * ((cellNoise(57) + 1) * 0.5) lat asin(1 - 2 * (0.14173228346456693 + (cellNoise(58) + 1) * 0.5 * 0.7244094488188977)) radius (18 + (cellNoise(59) + 1) * 0.5 * 20) * PI / 128 amount 0.35 + (cellNoise(60) + 1) * 0.5 * 0.4
  spot moisture lon -PI + TAU * ((cellNoise(61) + 1) * 0.5) lat asin(1 - 2 * (0.14173228346456693 + (cellNoise(62) + 1) * 0.5 * 0.7244094488188977)) radius (18 + (cellNoise(63) + 1) * 0.5 * 20) * PI / 128 amount 0.35 + (cellNoise(64) + 1) * 0.5 * 0.4
  spot moisture lon -PI + TAU * ((cellNoise(65) + 1) * 0.5) lat asin(1 - 2 * (0.14173228346456693 + (cellNoise(66) + 1) * 0.5 * 0.7244094488188977)) radius (18 + (cellNoise(67) + 1) * 0.5 * 20) * PI / 128 amount 0.35 + (cellNoise(68) + 1) * 0.5 * 0.4
}

stage forcing "Apply planet forcing" {
  reads pressure, moisture, temperature, catalyst, exhaustion, cloud, sinkSource, moistureSource, heatSource, catalystSource
  writes moisture, temperature, pressure, catalyst, exhaustion
  cell {
    when enableForcing and forcing != 0 {
      let strength = forcing
      let rainout = cloud * (rainoutBase + sinkSource * rainoutSink)
      set moisture = clamp(moisture + (moistureSource * moistureForcingRate * strength - rainout) * dt, 0, 1.4)
      set temperature = clamp(temperature + (heatSource * heatForcingRate * strength - cloud * 0.008) * dt, -1.2, 1.4)
      add pressure = (-heatSource * 0.004 + cloud * 0.0015) * strength * dt
      when enableCatalyst {
        set catalyst = clamp(catalyst + catalystSource * catalystForcingRate * strength * dt, 0, 1.8)
      }
      set exhaustion = clamp(exhaustion - sinkSource * 0.01 * strength * dt, 0, 1.5)
    }
  }
}

stage wind "Compute wind + lift" {
  reads pressure
  declares windU, windV, lift
  wind pressure -> windU, windV, lift strength windStrength
}

stage advect "Advect carried fields" {
  reads moisture, temperature, catalyst, cloud, windU, windV
  writes moisture, temperature, catalyst, cloud
  advect moisture by windU, windV dt dt * 1.0
  advect temperature by windU, windV dt dt * 0.45
  advect catalyst by windU, windV dt dt * 0.65
  advect cloud by windU, windV dt dt * 1.0
}

stage diffuseFields "Diffuse / smooth fields" {
  reads pressure, moisture, temperature, catalyst, cloud, exhaustion
  writes pressure, moisture, temperature, catalyst, cloud, exhaustion
  diffuse pressure amount diffusion * 0.18 * dt
  diffuse moisture amount diffusion * 0.34 * dt
  diffuse temperature amount diffusion * 0.18 * dt
  diffuse catalyst amount diffusion * 0.12 * dt
  diffuse cloud amount diffusion * 0.08 * dt
  diffuse exhaustion amount diffusion * 0.08 * dt
}

stage stochastic "Stochastic perturbation" {
  reads moisture, pressure, cloud
  writes moisture, pressure, cloud
  cell {
    when enableStochastic {
      let amp = noiseAmp
      let t = frame * 0.013
      let moistureWave = sin(lon * 3.1 + lat * 2.4 + t) + cos(px * 4.7 - py * 1.9 + pz * 2.6 - t * 0.7)
      let pressureWave = sin(lon * 4.3 - lat * 1.7 - t * 0.6) + cos(px * 2.2 + py * 3.8 + pz * 1.4 + t)
      let cloudWave = sin(lon * 5.2 + py * 3.1 + t * 0.8) + cos(pz * 4.1 - px * 1.6 - t * 0.5)
      add moisture = moistureWave * amp * 0.125
      add pressure = pressureWave * amp * 0.06
      add cloud = cloudWave * amp * 0.04
    }
  }
}

stage growClouds "Grow clouds" {
  reads pressure, moisture, lift, temperature, catalyst, exhaustion, cloud
  declares reaction
  writes cloud, moisture, temperature, catalyst, exhaustion, pressure
  cell {
    let catalystBoost = 1 + (enableCatalyst ? catalystEffect : 0) * smoothstep(0.18, 0.9, catalyst)
    let exhaustionStrength = enableExhaustion ? exhaustionRate : 0
    let instability = clamp(moisture * 1.25 + lift * 0.85 + temperature * 0.25, 0, 2)
    let inhibition = exhaustion * exhaustionStrength * 0.52
    let growth = max(0, instability * catalystBoost - 0.64 - inhibition) * condense
    let decay = 0.13 + max(0, -lift) * 0.12
    let net = growth * (1 - cloud) - decay * cloud

    set reaction = net
    add cloud = net * dt
    add moisture = (-growth * 0.11 + 0.012) * dt
    add temperature = -temperature * 0.01 * dt
    add catalyst = -catalyst * 0.006 * dt

    when enableExhaustion {
      add exhaustion = ((cloud * 0.05 + growth * 0.035) * exhaustionStrength - exhaustion * 0.035) * dt
    }
    when enableFeedback {
      add pressure = -cloud * feedback * 0.035 * dt
      add temperature = cloud * feedback * 0.018 * dt
    }
  }
}

stage clampFields "Clamp" {
  reads moisture, cloud, exhaustion, temperature, catalyst, pressure
  writes moisture, cloud, exhaustion, temperature, catalyst, pressure
  clamp moisture 0 1.4
  clamp cloud 0 1
  clamp exhaustion 0 1.5
  clamp temperature -1.2 1.4
  clamp catalyst 0 1.8
}
`;

export const pipeline = compileDsl(pipelineDsl);
