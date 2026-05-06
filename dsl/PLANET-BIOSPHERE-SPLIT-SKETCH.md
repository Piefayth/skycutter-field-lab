# Planet Biosphere Split Sketch

Status: exploratory, not implemented.

This is a term-by-term rewrite of `recipes/planet-biosphere.mjs` using the
current best candidate split:

```text
rate    = named local term
budget  = field accounting from sources/sinks/transport/projection
process = coupled or ordered computation
derive  = display/diagnostic field
```

The goal is not pretty syntax. The goal is to see whether this model preserves
the recipe while making the interacting systems easier to reason about.

## Current V2 Shape

```text
windField
  reads heat
  writes wind, windFlow

climate
  reads heat, moisture, ocean, biomass
  writes heat, moisture

advect
  reads moisture, pollution, windFlow
  writes moisture, pollution

ecology
  reads heat, moisture, biomass, pollution, fertility, industry
  writes biomass, moisture, pollution, habitability

spread
  reads biomass, moisture, pollution
  writes biomass, moisture, pollution
```

This is readable as a pass pipeline, but the model terms are hidden inside the
stages. `moisture` changes in three stages; `pollution` changes in three
stages; `habitability` is both a diagnostic and a causal intermediate.

## Split Sketch

```dsl
field heat: f32
field moisture: f32
field biomass: f32
field pollution: f32
field wind: vec2 derived
field windFlow: vec2 derived
derived habitability: f32

param rate      slider 1..80  default 16
param sun       slider 0..2   default 1.0
param evap      slider 0..2   default 0.55
param growth    slider 0..6   default 2.2
param spread    slider 0..2   default 0.32
param emit      slider 0..4   default 1.35
param cleanup   slider 0..2   default 0.28
param toxicity  slider 0..4   default 1.20
param flowScale slider 0..2   default 0.75
```

### Rates

```dsl
rate insolation on cells =
  sun * max(0, cos(lat))

rate shade on cells =
  biomass * 0.08

rate oceanHeatBuffer on cells =
  ocean * (0.12 - heat) * 0.35

rate heatCooling on cells =
  0.75 * (heat + 0.18)

rate oceanEvaporation on cells =
  ocean * evap * (0.35 + max(heat, 0) * 0.35)

rate landDrying on cells =
  moisture * (0.22 + max(heat, 0) * 0.26) * (1 - ocean * 0.65)

rate tempFit on cells =
  clamp(1 - abs(heat - 0.18) * 1.8, 0, 1)

rate wetFit on cells =
  clamp(moisture * 1.15, 0, 1)

rate cleanFit on cells =
  clamp(1 - pollution * toxicity, 0, 1)

rate hab on cells =
  tempFit * wetFit * clamp(fertility, 0, 1) * cleanFit

rate biomassGrowth on cells =
  growth * hab * biomass * max(1 - biomass, 0)

rate biomassDeath on cells =
  biomass * (0.08 + pollution * toxicity * 0.22 + max(-heat - 0.35, 0) * 0.35)

rate waterUse on cells =
  biomassGrowth * 0.26

rate pollutionInput on cells =
  industry * emit

rate pollutionLoss on cells =
  pollution * (cleanup + biomass * 0.18)
```

Readout:

- This is immediately clearer than the original `ecology` stage because the
  reusable biological terms have names.
- `hab` is both a rate-like causal intermediate and a viewable diagnostic. That
  argues for one concept with visibility, not a hard `derived`/`rate` split.
- The rates must have explicit snapshot semantics. `biomassGrowth`,
  `waterUse`, and `hab` must all be computed from the same ecology snapshot.

### Processes

```dsl
process windField on cells {
  let thermal = gradient(heat)
  let belts = vec2(0.75 + 0.35 * cos(lat * 3),
                   0.22 * sin(lon * 2 + frame / 520))
  let raw = belts + thermal * 0.45
  let mag = max(length(raw), 0.001)
  let flow = raw / mag

  write wind = flow
  write windFlow = flow * flowScale
}

derive habitabilityDisplay on cells {
  write habitability = hab
}
```

Readout:

- Wind is still a coupled process, not a budget. This is fine.
- The display field being just `write habitability = hab` shows the awkward
  current `derived` concept: some derived fields are diagnostics, some are
  causal intermediates, and some are hidden compiler conveniences.

### Budgets

```dsl
budget heat {
  source insolation * (1 - shade)
  source oceanHeatBuffer
  sink heatCooling
  project to -1..1.2
}

budget moisture {
  source oceanEvaporation
  sink landDrying
  project to 0..1.5
}

transport moisture by windFlow {
  sample upstream
  project to 0..1.5
}

transport pollution by windFlow {
  sample upstream
  project to 0..1.8
}

budget biomass {
  source biomassGrowth
  sink biomassDeath
  diffuse by spread
  project to 0..1
}

budget moisture ecology {
  sink waterUse
  diffuse by spread * 0.65
  project to 0..1.5
}

budget pollution ecology {
  source pollutionInput
  sink pollutionLoss
  diffuse by spread * 0.55
  project to 0..1.8
}
```

Readout:

- This is better at answering "what changes moisture/pollution?"
- It is worse at showing the original order. The current recipe does:

  ```text
  climate -> advect -> ecology -> spread
  ```

  The split sketch has to say whether `transport moisture` runs before
  `budget moisture ecology`, and whether diffusion is part of ecology or a
  later process. That order is not optional; it changes the model.
- Therefore budgets cannot be free-floating. They need either lexical schedule
  groups or an enclosing tick/process section.

## Same Idea With Explicit Phases

```dsl
tick {
  process windField on cells { ... }

  phase climate {
    budget heat {
      source insolation * (1 - shade)
      source oceanHeatBuffer
      sink heatCooling
      project to -1..1.2
    }

    budget moisture {
      source oceanEvaporation
      sink landDrying
      project to 0..1.5
    }
  }

  phase transport {
    transport moisture by windFlow sample upstream project 0..1.5
    transport pollution by windFlow sample upstream project 0..1.8
  }

  phase ecology {
    budget biomass {
      source biomassGrowth
      sink biomassDeath
      project to 0..1
    }

    budget moisture {
      sink waterUse
      project to 0..1.5
    }

    budget pollution {
      source pollutionInput
      sink pollutionLoss
      project to 0..1.8
    }

    derive habitability {
      write habitability = hab
    }
  }

  phase spread {
    diffuse biomass by spread project 0..1
    diffuse moisture by spread * 0.65 project 0..1.5
    diffuse pollution by spread * 0.55 project 0..1.8
  }
}
```

Readout:

- This is the first sketch that feels close to the actual recipe.
- It does not pretend scheduling is gone. The author still names phases when
  order is meaningful.
- Inside a phase, field budgets make same-field accounting explicit.
- The phases are basically v2 stages, but their bodies are more semantic:
  budgets, transport, diffuse, derive, process.
- This may be the real incremental direction: keep ordered `step` structure,
  but improve the inside of stages with budget/rate/process effects.

## Comparison To Current Recipe

What improves:

- Shared model terms get names (`hab`, `biomassGrowth`, `pollutionLoss`).
- Field accounting is easier to audit.
- Projection timing is visible at the field effect site.
- Moisture and pollution lifecycles are explainable.

What does not improve:

- The recipe is not shorter.
- The meaningful order remains explicit.
- Wind authoring is not improved.
- The derived/rate/diagnostic boundary is still conceptually muddy.

What this suggests:

1. Do not replace `stage` with an inferred free-for-all graph yet.
2. Add semantic effects inside ordered groups first:
   `budget`, `transport`, `diffuse`, `project`, `rate`.
3. Treat generated field lifecycles as UI/documentation derived from the AST.
4. Keep explicit phases/stages because many planet recipes use order as part
   of the model.

This is a more conservative direction than the old v3 proposal, and it better
matches the actual recipe evidence so far.
