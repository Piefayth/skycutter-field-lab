# Rate And Budget Sketches

Status: exploratory, not implemented.

This note tests the next candidate unifier:

```text
rate   = named local flow/change term, computed on cells from a snapshot
budget = accounting for one field from rates, fluxes, and projections
process = coupled local update or ordered numerical step
```

The hypothesis: many ecosystem/weather recipes are hard to read because the
same conceptual rates are used in several field updates. Naming rates may unify
budgets and processes better than another layer of `update` syntax.

## Candidate Vocabulary

```dsl
rate grazingLoss on cells =
  graze * grazers * plants

budget nutrient {
  source recycle * grazingLoss
  sink plantUptake
  flux to n in neighbors { amount ... }
  project to 0..1.8
}

process ecology on cells {
  add plants = (plantUptake - grazingLoss) * dt * rate
}
```

Semantics to test:

- A `rate` is cell-local unless explicitly declared otherwise.
- A `rate` reads a stable snapshot at the point it is scheduled.
- A `budget` consumes rates and commits one field.
- A coupled `process` can also consume rates when multiple fields need the same
  term.
- Rates are not automatically fields. If a rate should be viewed or stamped, it
  becomes a `derived` field.

## Nutrient Grazing Cycle

This recipe is the strongest argument for rates. The current stage computes
uptake, grazing, litter, births, and deaths inside one `ecology` block, but
those terms conceptually affect multiple fields.

Sketch:

```dsl
rate fertility on cells =
  clamp(0.25 + spring - badland * 0.7, 0, 1.4)

rate plantUptake on cells =
  plantGrow * nutrient * plants * max(1.15 - plants, 0) * (0.25 + fertility)

rate grazingLoss on cells =
  graze * grazers * plants

rate grazerBirths on cells =
  0.55 * grazingLoss * max(1 - grazers, 0)

rate grazerDeaths on cells =
  mortality * grazers * (0.25 + max(0.18 - plants, 0) * 2.0)

rate seasonalInput on cells =
  weather * spring * (0.18 + 0.12 * sin(frame / 180 + lat * 3))
```

```dsl
process habitat on cells {
  let wetSeason = 0.5 + 0.5 * sin(frame / 260 + lon * 0.8)
  let latitudeFertility = 0.55 + 0.25 * cos(lat * 2)
  let localGraze = mean n in neighbors { grazers@n }

  write soil = latitudeFertility + spring * 0.95 - badland * 0.85
             - plants * 0.18 + wetSeason * weather * 0.18
  project soil to -1..1

  write forage = plants + nutrient * 0.25
               - crowd * (grazers + localGraze * 0.35)
               - badland * 0.5
  project forage to -1..1
}
```

```dsl
budget nutrient {
  source seasonalInput
  source recycle * (grazingLoss + grazerDeaths)
  sink plantUptake
  sink badland * nutrient * 0.05

  flux to n in neighbors {
    let fertilityPull = max(soil@n - soil, 0)
    let concentration = max(nutrient - nutrient@n, 0) * 0.35
    amount nutrient * clamp((fertilityPull + concentration) * nutFlux * dt * rate, 0, 0.08)
  }

  project to 0..1.8
}

budget grazers {
  source grazerBirths
  sink grazerDeaths

  flux to n in neighbors {
    let pull = max(forage@n - forage, 0)
    amount grazers * clamp(pull * grazerMob * dt * rate, 0, 0.10)
  }

  project to 0..1.4
}

budget plants {
  source plantUptake
  sink grazingLoss
  sink badland * plants * 0.08
  project to 0..1.3
}
```

Readout:

- Strong win. Rates avoid duplicating `plantUptake`, `grazingLoss`, and
  `grazerDeaths` across budgets.
- This reads like ecosystem accounting.
- It introduces a scheduling question: rates that depend on `soil` or `forage`
  should run after `habitat`; rates that depend only on core fields can run from
  the tick snapshot. This must be inferred and visible in the graph.

## Predator-Prey

Current recipe has a classic shared response term:

```dsl
let response = a * N * P / (N + hSat + 0.000001)
add N = (r * N * (1 - N / Kcap) - response) * dt * rate
add P = (eEff * response - m * P) * dt * rate
```

Rate sketch:

```dsl
rate preyGrowth on cells =
  r * N * (1 - N / Kcap)

rate predation on cells =
  a * N * P / (N + hSat + 0.000001)

rate predatorMortality on cells =
  m * P

process spatialSpread on cells {
  add N = (mean n in neighbors { N@n } - N) * clamp(Dn * 0.18 * dt * rate, 0, 0.24)
  add P = (mean n in neighbors { P@n } - P) * clamp(Dp * 0.18 * dt * rate, 0, 0.24)
}

budget N after spatialSpread {
  source preyGrowth
  sink predation
  project to 0..3
}

budget P after spatialSpread {
  source eEff * predation
  sink predatorMortality
  project to 0..3
}
```

Readout:

- Moderate win conceptually: `predation` is the shared named flow from prey to
  predator.
- Line count is not better.
- Numerical semantics matter: both budgets must read the same post-spread,
  pre-reaction snapshot. That is exactly where rates help if their snapshot is
  explicit.
- If `budget N` and `budget P` are scheduled independently and compute
  `predation` at different snapshots, the model is wrong. Shared-rate snapshot
  semantics are load-bearing.

## Runoff Erosion

Runoff mixes local water input/loss, downhill conservative transport, and
terrain erosion.

Rate sketch:

```dsl
rate rainInput on cells =
  rain * (0.55 + 0.45 * max(0, cos(lat * 2 + frame * 0.003)))

rate evaporation on cells =
  evap * water

rate slopeMag on cells =
  length(gradient(height))

budget water {
  source rainInput
  sink evaporation

  flux to n in neighbors {
    let drop = max((height + water * 0.15) - (height@n + water@n * 0.15), 0)
    amount water * clamp(drop * runoff * dt * rate, 0, 0.12)
  }

  project to 0..1.4
}

process erosion on cells {
  let cut = erode * water * slope
  let smoothing = mean n in neighbors { height@n } - height
  let tectonic = uplift * (0.55 + 0.45 * cellNoise(2, 1.5))

  add height = (tectonic + smoothing * 0.08 - cut) * dt * rate
  project height to 0..1.5

  write slope = (slopeMag * 2.0) / (1 + slopeMag * 2.0)
  write flow = (water * slopeMag * 2.4) / (1 + water * slopeMag * 2.4)
}
```

Readout:

- Strong win for `water`: this is exactly a budget.
- Less clear for `height`: erosion is an ordered terrain process, not a
  conservative budget.
- Derived diagnostics (`slope`, `flow`) still want clearer lifecycle wording.
- This supports a mixed model: budgets for conserved-ish fields, processes for
  coupled/diagnostic updates.

## Chemotaxis Colony

Current recipe has an explicit derived `flux: vec2` because the validator
forbids let-locals inside `divergence(...)`.

Rate / process sketch:

```dsl
rate chemotacticDrive on cells =
  attract * gradient(food) - repel * gradient(toxin)

rate bugFlux on cells =
  bugs * chemotacticDrive

budget bugs {
  source growth * bugs * food * max(1 - bugs / maxBugs, 0)
  sink mortality * bugs
  sink toxinKill * toxin * bugs

  diffuse by bugDiff
  divergence sink bugFlux

  project to 0..maxBugs
}

budget food {
  source replenish * (baseFood - food)
  source emitRate * foodSpring
  sink eatRate * bugs * food
  diffuse by foodDiff
  project to 0..1.5
}

budget toxin {
  source emitRate * toxinVent
  sink toxinDecay * toxin
  diffuse by toxinDiff
  project to 0..1.5
}
```

Readout:

- Rates help describe the chemotactic vector flow.
- This reveals another primitive: field budgets need more than edge `flux`.
  They may need `diffuse by ...` and `divergence sink vec2Rate`.
- If `divergence sink bugFlux` exists, the recipe no longer needs a viewable
  `flux` field just to satisfy compiler limitations. That is a real abstraction
  improvement.
- But this is more numerical language surface. It should be justified by
  chemotaxis / fluids / active matter recipes, not added casually.

## Wave Equation

The wave equation is an ordered first-order solver:

```dsl
process accelerate on cells {
  let lap = sum n in neighbors { u@n - u }
  add v = (speed * speed * lap - damping * v) * dt
  project v to -24..24
}

process integrate on cells after accelerate {
  add u = v * dt
  project u to -2..2
}
```

Readout:

- Rates do not help much.
- Budgets do not help much.
- The order is the method. Hiding it would make the recipe worse.
- This is an important negative case: any v3 must leave ordered numerical
  processes first-class.

## Pattern So Far

Rates are useful when:

- one local term affects multiple fields (`predation`, `grazingLoss`)
- a term is conceptually a transfer between fields
- budgets need shared terms without duplicating expressions
- a vector flow should be named but not necessarily displayed

Budgets are useful when:

- one field has many local source/sink terms
- the field also moves by conservative edge flux
- projection/conservation timing matters
- authors ask "where did this stuff go?"

Processes remain the right tool when:

- fields are tightly coupled in one local computation
- the order is a numerical method
- diagnostics are just computed projections
- the recipe is already one clean cell stage

## Design Pressure

If rates/budgets become real, the important questions are:

1. Snapshot semantics: when a rate is read by multiple budgets, do they all see
   the same input snapshot?
2. Units: are rates raw per-time terms, or do authors include `dt * rate`?
   A perfect surface probably makes rates per-time and budgets apply `dt` once.
3. Visibility: are rates hidden by default, viewable on demand, or fields?
4. Field transaction: how do local rates and edge flux combine before
   projection?
5. Scheduling graph: can the existing pipeline graph explain rates feeding
   budgets without becoming unreadable?

Current conclusion: **rates + budgets are a stronger unifying direction than
process alone**, but only for ecosystem/weather/transport recipes. They do not
replace ordered solvers.
