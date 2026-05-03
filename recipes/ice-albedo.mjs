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

import { compileV2 } from "../dsl/compile-v2.mjs";

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

substrate geodesic frequency 64

const freezePoint = 0.0
const eps         = 0.10
const albedoIce   = 0.7
const albedoOcean = 0.18

// T: surface temperature, normalized so 0 ≈ freezing point.
// albedo: derived from T each tick. Marked \`derived\` because the
// recipe never paints into it directly — it's always a function of T.
field T: f32
field albedo: f32 derived

// Multi-stop temperature palette tuned for the ice-albedo bistability.
// Freezing point (T=0) is a stark white seam between cold/blue
// (ice-covered) and warm/green-orange (ocean/land). The seam makes the
// ice line — the actually-interesting part of the simulation —
// visually unmistakable. Stop t-values normalized into [0, 1] across
// the chosen range [-0.8, 1.5].

param simRateHz   slider 0..360    step 1     default 60    label "SIM RATE"
// Solar constant. Around 1.0 is "modern Earth"; below ~0.6 the system
// snaps to snowball; above ~1.4 it stays warm regardless of perturbations.
param solar       slider 0..2      step 0.01  default 1.00  label "SOLAR"
param greenhouse  slider 0.5..2    step 0.01  default 1.10  label "GREENHOUSE"
param emissivity  slider 0..4      step 0.01  default 1.20  label "EMISSIVITY"
param diffusion   slider 0..4      step 0.01  default 0.40  label "DIFFUSION"
// Slow Milankovitch-like solar oscillation. At moderate amplitude, the
// planet flips between warm and snowball every few orbits.
param orbital     slider 0..0.5    step 0.005 default 0.18  label "ORBITAL VAR"
param orbitalRate slider 100..5000 step 50    default 1200  label "ORBIT FRAMES"
param volcanic    slider 0..0.5    step 0.005 default 0.04  label "VOLCANIC"
param rate        slider 1..100    step 1     default 30    label "RATE"

step {
  stage diffuseT "Surface heat conduction" {
    reads T
    writes T
    cell {
      add T = (mean n in neighbors { T@n } - T) * clamp(diffusion * 0.18 * dt * rate, 0, 0.24)
    }
  }

  stage radiate "Solar absorption + thermal emission" {
    reads T
    writes T, albedo
    cell {
      let frozen     = 1 - smoothstep(freezePoint - eps, freezePoint + eps, T)
      let alb        = albedoOcean + (albedoIce - albedoOcean) * frozen
      let solarMod   = solar * (1 + orbital * sin(frame / orbitalRate))
      let insolation = max(0, solarMod * cos(lat))
      let absorbed   = greenhouse * insolation * (1 - alb)
      let emitted    = emissivity * (T + 0.4)
      let volcanism  = cellRand(frame) * volcanic
      add T = (absorbed - emitted + volcanism) * dt * rate
      set albedo = alb
    }
  }
}

views {
  palette TEMP {
    stop 0.000 color [30, 60, 140]
    stop 0.174 color [120, 170, 230]
    stop 0.326 color [240, 248, 255]
    stop 0.370 color [255, 252, 240]
    stop 0.457 color [110, 180, 130]
    stop 0.609 color [230, 200, 90]
    stop 0.783 color [220, 80, 40]
    stop 1.000 color [120, 20, 20]
  }

  palette ALBEDO {
    stop 0 color [0, 0, 0]
    stop 1 color [255, 255, 255]
  }

  view T "Temperature" {
    color ramp T range [-0.8, 1.5] palette TEMP
  }

  view albedo "Albedo" {
    color ramp albedo range [0, 1] palette ALBEDO
  }
}

stamps {
  stamp warm "Warmth pulse" {
    spot T at brush.pos, radius=brush.r, amount=0.8
  }

  stamp freeze "Freeze patch" {
    spot T at brush.pos, radius=brush.r, amount=-0.8
  }
}

scenarios {
  scenario earth "Modern earth" {
    for each cell {
      set T = cos(lat) * 0.9 - 0.3
    }
  }

  scenario snowball "Snowball earth" {
    set T = -0.6
  }

  scenario edge "Edge of bistability" {
    for each cell {
      set T = 0.05 * cos(lat) + 0.02 * cellNoise(7, 1.5)
    }
  }
}
`;

export const pipeline = compileV2(pipelineDsl);
