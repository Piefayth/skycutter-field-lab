// Edge-flux population movement.
//
// The herd is a conserved scalar that moves along graph edges toward
// nearby food and away from crowding. This is the ecological analogue
// of runoff: cells do not merely diffuse; they choose directed flows
// based on neighbor state.

import { compileV2 } from "../dsl/compile-v2.mjs";

export const overlays = [];

export const metrics = [
  { id: "herd", label: "HERD", source: "dsl:herdMean", spark: true, precision: 3 },
  { id: "food", label: "FOOD", source: "dsl:foodMean", spark: true, precision: 3 },
  { id: "move", label: "MOVE", source: "dsl:moveMean", mini: true, precision: 3 },
  { id: "fps", label: "FPS", source: "fps", mini: true },
];

export const regime = {
  silent: { move: 0.001 },
  intermittent: { move: 0.008 },
  active: { move: 0.025 },
  runaway: { herd: 0.9 },
};

export const pipelineDsl = `
recipe "Forager migration"
summary "A conserved herd moves through edge flux toward richer nearby food and away from crowding. Grazing depletes food; regrowth creates traveling fronts, refuges, and chase-like migration paths."
recommendedPreset savanna

substrate geodesic frequency 32

field food: f32
field herd: f32
field desirability: f32 derived
field movement: f32 derived

param simRateHz slider 0..240 step 1 default 60 label "SIM RATE"
param rate      slider 1..60  step 1 default 18 label "RATE"
param grow      slider 0..3   step 0.01 default 0.75 label "FOOD GROWTH"
param graze     slider 0..4   step 0.01 default 1.15 label "GRAZE"
param mobility  slider 0..10  step 0.01 default 3.6 label "MOBILITY"
param crowd     slider 0..3   step 0.01 default 1.0 label "CROWD AVOID"
param mortality slider 0..2   step 0.01 default 0.18 label "MORTALITY"
param birth     slider 0..2   step 0.01 default 0.44 label "BIRTH"

step {
  stage score "Per-cell desirability" {
    reads food, herd
    writes desirability, movement
    cell {
      let localCrowd = mean n in neighbors { herd@n }
      set desirability = clamp(food - crowd * (herd + localCrowd * 0.35), -1, 1)
      set movement = 0
    }
  }

  stage migrate "Conservative herd edge flux" {
    reads herd, desirability
    writes herd
    edge n in neighbors {
      let pull = max(desirability@n - desirability, 0)
      flux herd = herd * clamp(pull * mobility * dt * rate, 0, 0.10)
    }
  }

  stage grazeAndGrow "Grazing feedback" {
    reads food, herd, desirability
    writes food, herd, movement
    cell {
      let eat = graze * herd * food
      let regrow = grow * food * (1 - food) * (0.55 + 0.45 * cos(lat))
      let births = birth * herd * food * (1 - herd)
      let deaths = mortality * herd * max(0.15 - food, 0)
      let nextFood = clamp(food + (regrow - eat) * dt * rate, 0, 1)
      let nextHerd = clamp(herd + (births - deaths) * dt * rate, 0, 1.4)
      set food = nextFood
      set herd = nextHerd
      set movement = clamp(abs(desirability) * nextHerd, 0, 1)
    }
  }
}

metric herdMean = mean cells { herd }
metric foodMean = mean cells { food }
metric moveMean = mean cells { movement }

views {
  palette FOOD {
    stop 0 color [74, 48, 30]
    stop 0.35 color [118, 108, 54]
    stop 0.75 color [92, 178, 76]
    stop 1 color [220, 235, 128]
  }

  palette HERD {
    stop 0 color [18, 20, 24]
    stop 0.25 color [74, 66, 94]
    stop 0.62 color [188, 118, 82]
    stop 1 color [250, 230, 170]
  }

  palette DESIRE {
    stop 0 color [60, 88, 190]
    stop 0.5 color [24, 26, 30]
    stop 1 color [246, 196, 74]
  }

  view herd "Herd density" {
    color ramp herd range [0, 1.2] palette HERD
  }

  view food "Food" {
    color ramp food range [0, 1] palette FOOD
  }

  view desirability "Migration pressure" {
    color ramp desirability range [-1, 1] palette DESIRE
  }
}

stamps {
  stamp seedHerd "Add herd" {
    spot herd at brush.pos, radius=brush.r, amount=0.55
  }

  stamp plantFood "Plant food" {
    spot food at brush.pos, radius=brush.r, amount=0.55
  }

  stamp fence "Deplete food" {
    spot food at brush.pos, radius=brush.r, amount=-0.75
  }
}

scenarios {
  scenario savanna "Patchy savanna" {
    for each cell {
      let bands = 0.5 + 0.24 * sin(lon * 3.5) * cos(lat * 4)
      let noise = cellNoise(12, 1.6) * 0.18
      set food = clamp(bands + noise, 0.08, 0.98)
      set herd = food > 0.62 && cellRand(31) > 0.25 ? 0.38 : 0.02
    }
  }

  scenario oasis "Oasis chase" {
    set food = 0.12
    set herd = 0.01
    spot food at lon=0.8, lat=0.25, radius=0.42, amount=0.9
    spot food at lon=-1.2, lat=-0.2, radius=0.30, amount=0.65
    spot herd at lon=0.1, lat=0.0, radius=0.20, amount=0.75
  }
}
`;

export const pipeline = compileV2(pipelineDsl);
