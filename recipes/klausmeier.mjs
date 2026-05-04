// Klausmeier semi-arid vegetation — biomass-water dynamics.
//
// The "tiger bush" pattern visible from satellites in the Sahel: in dry
// climates with sloping terrain, vegetation self-organizes into stripes
// perpendicular to the slope, separated by bare ground. The stripes
// migrate slowly uphill over decades. The same pattern appears in
// hillside grasslands and is a classic example of a self-organized
// biological landscape.
//
// Equations (per cell):
//   dw/dt = a − w − w·n² + v·∂w/∂x_downhill        (water)
//   dn/dt = w·n² − m·n + D·∇²n                      (biomass)
//
// Three terms compete for water:
//   - rainfall a (constant input)
//   - evaporation -w
//   - uptake by biomass -w·n²        ← nonlinear feedback
//
// Biomass grows where water is available, dies at rate m, diffuses
// slowly. The downhill water advection breaks symmetry: water arrives
// from upslope, biomass that establishes itself uphill consumes water
// before it reaches downhill cells, so a nascent stripe casts a
// "shadow" downhill where no biomass can grow → bands.
//
// At v=0 (flat ground), the system reduces to a Turing reaction-
// diffusion that produces spots instead of stripes — try the "spots"
// preset.

import { compileV2 } from "../dsl/compile-v2.mjs";

export const overlays = [];

export const metrics = [
  { id: "biomass",  label: "MEAN n", source: "n",                     spark: true, precision: 3 },
  { id: "water",    label: "MEAN w", source: "w",                     spark: true, precision: 3 },
  { id: "vegArea",  label: "VEG",    source: "coverage:n:0.4",        mini: true,  precision: 3 },
  { id: "fps",      label: "FPS",    source: "fps",                   mini: true },
];

export const regime = {
  silent:        {},
  intermittent:  { vegArea: 0.05 },
  active:        { vegArea: 0.2 },
  runaway:       { vegArea: 0.7 },
};

export const pipelineDsl = `
recipe "Klausmeier vegetation"
summary "Semi-arid biomass-water dynamics. Vegetation grows where water pools; water flows downhill, casting a 'shadow' that breaks the substrate into stripes oriented perpendicular to the slope. The tiger-bush pattern visible from satellites in the Sahel. With FLOW SPEED at zero (no slope) the same model produces Turing spots — try the 'spots' preset."
recommendedPreset bands

substrate geodesic frequency 64

field n: f32
field w: f32
// Slope direction as a vec2 — east in .x, north in .y. Set once per
// scenario; the advect primitive reads it directly.
field slope: vec2

param simRateHz slider 0..360   step 1     default 60   label "SIM RATE"
param rainfall  slider 0..4     step 0.01  default 1.80 label "RAINFALL a"
param mortality slider 0..1     step 0.005 default 0.45 label "MORTALITY m"
param flowSpeed slider 0..200   step 1     default 80   label "FLOW SPEED v"
param diffusion slider 0..4     step 0.01  default 0.50 label "DIFFUSION D"
param rate      slider 1..100   step 1     default 30   label "RATE"

step {
  // Water flows downhill along the slope vec2. upstream(...) computes the
  // continuous coordinate reached by walking backward along the tangent
  // velocity; w@p samples water at that coordinate.
  stage waterFlow "Water advects downhill" {
    reads w, slope
    writes w
    cell {
      let p = upstream(slope, flowSpeed * dt * rate * 0.015)
      set w = w@p
    }
  }

  stage biomassDiffuse "Biomass spatial spread" {
    reads n
    writes n
    cell {
      add n = (mean nb in neighbors { n@nb } - n) * clamp(diffusion * 0.18 * dt * rate, 0, 0.24)
    }
  }

  stage react "Klausmeier kinetics" {
    reads n, w
    writes n, w
    cell {
      let uptake = w * n * n
      add w = (rainfall - w - uptake)   * dt * rate
      add n = (uptake - mortality * n)  * dt * rate
    }
  }

  stage clampPositive "Keep populations non-negative" {
    reads n, w
    writes n, w
    cell {
      set n = clamp(n, 0, 4)
      set w = clamp(w, 0, 6)
    }
  }
}

views {
  palette N_RAMP {
    stop 0 color [22, 32, 22]
    stop 1 color [120, 200, 80]
  }

  palette W_RAMP {
    stop 0 color [80, 60, 40]
    stop 1 color [60, 140, 220]
  }

  view n "Biomass (n)" {
    color ramp n range [0, 0.6] palette N_RAMP
  }

  view w "Water (w)" {
    color ramp w range [0, 0.5] palette W_RAMP
  }
}

stamps {
  stamp seed "Plant patch" {
    spot n at brush.pos, radius=brush.r, amount=0.4
  }

  stamp clearcut "Clear-cut" {
    spot n at brush.pos, radius=brush.r, amount=-1
  }

  stamp irrigate "Add water" {
    spot w at brush.pos, radius=brush.r, amount=1
  }
}

scenarios {
  scenario bands "Tiger-bush bands" {
    set slope = vec2(1, 0)
    set w = 1
    set n = 0
    for each cell {
      when cellRand(7) > 0.65 {
        set n = 0.4
      }
    }
  }

  scenario spots "Turing spots (no slope)" {
    // Slope set to zero kills the slope-driven advection; flowSpeed=0
    // makes the kinetics-only Turing regime explicit so the slider
    // doesn't dangle a non-physical "downhill flow" knob over a
    // flat domain.
    param flowSpeed = 0
    set slope = vec2(0, 0)
    set w = 1
    for each cell {
      set n = cellRand(11) * 0.15 + 0.05
    }
  }

  scenario desertEdge "Edge of vegetation" {
    set slope = vec2(1, 0)
    set w = 1
    set n = 0
    for each cell {
      when cellRand(13) > 0.92 {
        set n = 0.3
      }
    }
  }
}
`;

export const pipeline = compileV2(pipelineDsl);
