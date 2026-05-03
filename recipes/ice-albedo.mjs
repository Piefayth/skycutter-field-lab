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

import { gray } from "../prims/colorers.mjs";
import { compileV2 } from "../dsl/compile-v2.mjs";

// Multi-stop temperature palette tuned for the ice-albedo bistability.
// The freezing point (T=0) is a stark white seam between cold/blue
// (ice-covered) and warm/green-orange (ocean/land). This makes the
// ice line — which is the actually-interesting part of the simulation
// — visually unmistakable. A linear diverge() puts muddy purple
// exactly where you want the contrast.
const T_STOPS = [
  { t: -0.8, c: [ 30,  60, 140] },  // deep polar blue
  { t: -0.4, c: [120, 170, 230] },  // pale ice blue
  { t: -0.05, c: [240, 248, 255] }, // brittle frost / approach to seam
  { t:  0.05, c: [255, 252, 240] }, // seam — white-warm side of freezing
  { t:  0.25, c: [110, 180, 130] }, // cool ocean / cold biome green
  { t:  0.6,  c: [230, 200,  90] }, // dry / temperate amber
  { t:  1.0,  c: [220,  80,  40] }, // tropical hot
  { t:  1.5,  c: [120,  20,  20] }, // runaway hot
];

function tempColor(T) {
  if (T <= T_STOPS[0].t) return T_STOPS[0].c;
  if (T >= T_STOPS[T_STOPS.length - 1].t) return T_STOPS[T_STOPS.length - 1].c;
  for (let s = 0; s < T_STOPS.length - 1; s++) {
    const a = T_STOPS[s];
    const b = T_STOPS[s + 1];
    if (T >= a.t && T <= b.t) {
      const f = (T - a.t) / (b.t - a.t);
      return [
        Math.round(a.c[0] + (b.c[0] - a.c[0]) * f),
        Math.round(a.c[1] + (b.c[1] - a.c[1]) * f),
        Math.round(a.c[2] + (b.c[2] - a.c[2]) * f),
      ];
    }
  }
  return [128, 128, 128];
}

function temperaturePalette(fieldName) {
  const color = (i, fields) => tempColor(fields[fieldName][i]);
  color.write = (i, fields, data, k) => {
    const rgb = tempColor(fields[fieldName][i]);
    data[k + 0] = rgb[0];
    data[k + 1] = rgb[1];
    data[k + 2] = rgb[2];
  };
  color.fields = [fieldName];
  return color;
}

export const views = [
  { id: "T", label: "Temperature", color: temperaturePalette("T") },
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

stamp warm "Warmth pulse" {
  spot T at brush.pos, radius=brush.r, amount=0.8
}

stamp freeze "Freeze patch" {
  spot T at brush.pos, radius=brush.r, amount=-0.8
}

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
`;

export const pipeline = compileV2(pipelineDsl);
