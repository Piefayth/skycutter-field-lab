// Edge heat exchange — minimal conservative edge-flux demo.
//
// This recipe is intentionally plain: a scalar `heat` field moves only
// from hotter cells to colder neighboring cells through `edge` flux.
// There are no births, sinks, sources, or clamps in the step, so the
// total heat metric is a direct check that conservative flux is doing
// what it says.

import { compileV2 } from "../dsl/compile-v2.mjs";

export const overlays = [];

export const metrics = [
  { id: "mass", label: "TOTAL HEAT", source: "dsl:mass", spark: true, precision: 3 },
  { id: "peak", label: "PEAK", source: "dsl:peak", spark: true, precision: 3 },
  { id: "spread", label: "SPREAD", source: "dsl:spread", mini: true, precision: 3 },
  { id: "fps", label: "FPS", source: "fps", mini: true },
];

export const regime = {
  silent: { spread: 0.001 },
  intermittent: { spread: 0.03 },
  active: { spread: 0.10 },
  runaway: { peak: 2.0 },
};

export const pipelineDsl = `
recipe "Edge heat exchange"
summary "A minimal conservative edge-flux recipe. Heat flows only from hotter cells to colder neighboring cells; total heat should stay constant while peaks spread out."
recommendedPreset hotSpot

substrate geodesic frequency 32

field heat: f32
field contrast: f32 derived

param simRateHz slider 0..360 step 1 default 60 label "SIM RATE"
param rate      slider 1..24  step 1 default 8 label "RATE"
param conduct   slider 0.02..0.8 step 0.01 default 0.18 label "CONDUCTIVITY"

step {
  stage exchange "Conservative heat edge flux" {
    reads heat
    writes heat
    edge n in neighbors {
      let drop = max(heat - heat@n, 0)
      flux heat = clamp(drop * conduct * dt * rate, 0, 0.02)
    }
  }

  stage diagnose "Local contrast" {
    reads heat
    writes contrast
    cell {
      let localMean = mean n in neighbors { heat@n }
      set contrast = abs(heat - localMean)
    }
  }
}

metric mass = sum cells { heat }
metric peak = max cells { heat }
metric spread = mean cells { contrast }

views {
  palette HEAT {
    stop 0 color [10, 12, 24]
    stop 0.35 color [65, 90, 170]
    stop 0.7 color [245, 165, 70]
    stop 1 color [255, 245, 180]
  }

  palette CONTRAST {
    stop 0 color [8, 12, 20]
    stop 1 color [80, 220, 255]
  }

  view heat "Heat" {
    color ramp heat range [0, 1.2] palette HEAT
  }

  view spread "Local contrast" {
    color ramp contrast range [0, 0.35] palette CONTRAST
  }
}

stamps {
  stamp warm "Add heat" {
    spot heat at brush.pos, radius=brush.r, amount=0.8
  }

  stamp chill "Remove heat" {
    spot heat at brush.pos, radius=brush.r, amount=-0.5
  }
}

scenarios {
  scenario hotSpot "Single hot spot" {
    set heat = 0
    spot heat at lon=0, lat=0, radius=0.16, amount=1.0
  }

  scenario twoSpots "Two hot spots" {
    set heat = 0
    spot heat at lon=-0.9, lat=0.2, radius=0.13, amount=1.0
    spot heat at lon=1.0, lat=-0.15, radius=0.13, amount=0.75
  }

  scenario noisy "Noisy field" {
    for each cell {
      set heat = cellRand(17) > 0.88 ? 1.0 : 0.02
    }
  }
}
`;

export const pipeline = compileV2(pipelineDsl);
