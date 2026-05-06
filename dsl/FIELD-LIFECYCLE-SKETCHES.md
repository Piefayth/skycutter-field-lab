# Field Lifecycle Sketches

Status: exploratory, not implemented.

This note tests another possible unifier:

```text
field lifecycle = how one field is produced, transported, constrained, viewed
process         = named coupled computation that may affect several lifecycles
budget          = a lifecycle section for additive source/sink/flux accounting
```

The attraction is obvious: many author questions are field-centered. "Why did
my heat disappear?" "Where does pollution go?" "What moves moisture?" A field
lifecycle could make those answers visible in one place.

The risk is also obvious: if lifecycle declarations duplicate update bodies,
they become stale contracts. The compiler should derive as much as possible.
This sketch deliberately tests both sides.

## Candidate Shape

```dsl
field moisture: f32 {
  range 0..1.5
  produced by climate
  transported by advect
  consumed by ecology
  mixed by spread
}

process climate on cells { ... }
process advect on cells { ... }
process ecology on cells { ... }
process spread on cells { ... }
```

This mostly reads like documentation. A stronger version makes lifecycle
sections executable:

```dsl
field pollution: f32 {
  range 0..1.8

  budget ecology {
    source industry * emit
    sink pollution * (cleanup + biomass * 0.18)
  }

  transport advect {
    by windFlow
  }

  diffuse spread by spread * 0.55
}
```

The key question: does this make real recipes clearer, or does it scatter one
model across field declarations?

## Planet Biosphere

Current shape:

```text
windField -> climate -> advect -> ecology -> spread
```

Fields:

- `heat` is created by latitude/sun/ocean buffer, reduced by cooling/shade, and
  smoothed by spread.
- `moisture` is created by ocean evaporation, dried by heat/land, advected by
  wind, consumed by biomass growth, and smoothed by spread.
- `biomass` grows from habitability, dies from pollution/cold, and spreads.
- `pollution` is emitted by industry, cleaned by biomass/cleanup, advected by
  wind, and smoothed.

Lifecycle sketch:

```dsl
field heat: f32 {
  project to -1..1.2

  budget climate {
    source sun * max(0, cos(lat)) * (1 - biomass * 0.08)
    source ocean * (0.12 - heat) * 0.35
    sink 0.75 * (heat + 0.18)
  }

  diffuse spread by spread
}

field moisture: f32 {
  project to 0..1.5

  budget climate {
    source ocean * evap * (0.35 + max(heat, 0) * 0.35)
    sink moisture * (0.22 + max(heat, 0) * 0.26) * (1 - ocean * 0.65)
  }

  transport advect by windFlow

  budget ecology {
    sink biomassGrowth * 0.26
  }

  diffuse spread by spread * 0.65
}

field biomass: f32 {
  project to 0..1

  budget ecology {
    source biomassGrowth
    sink biomassDeath
  }

  diffuse spread by spread
}

field pollution: f32 {
  project to 0..1.8

  transport advect by windFlow

  budget ecology {
    source industry * emit
    sink pollution * (cleanup + biomass * 0.18)
  }

  diffuse spread by spread * 0.55
}

rate tempFit =
  clamp(1 - abs(heat - 0.18) * 1.8, 0, 1)

rate wetFit =
  clamp(moisture * 1.15, 0, 1)

rate habitability =
  tempFit * wetFit * clamp(fertility, 0, 1) * clamp(1 - pollution * toxicity, 0, 1)

rate biomassGrowth =
  growth * habitability * biomass * max(1 - biomass, 0)

rate biomassDeath =
  biomass * (0.08 + pollution * toxicity * 0.22 + max(-heat - 0.35, 0) * 0.35)
```

Readout:

- Strong explanatory win for field questions. The lifecycle makes it obvious
  that moisture is produced, transported, consumed, and diffused in four places.
- It also reveals that `ecology` is not one thing. It is a habitability
  calculation plus three field budgets.
- The downside is severe: the process order is no longer visible. The current
  recipe's `climate -> advect -> ecology -> spread` sequence matters, and the
  field-centric form hides it unless the lifecycle sections carry ordering.
- This suggests a compromise: field lifecycle should be a compiler/UI view
  derived from processes and budgets, not necessarily the authored primary
  surface.

## Klausmeier Vegetation

Current shape:

```text
waterFlow -> biomassDiffuse -> react -> clamp
```

Lifecycle sketch:

```dsl
field w: f32 {
  project to 0..6

  transport waterFlow by slope speed flowSpeed * 0.015

  budget react {
    source rainfall
    sink w
    sink uptake
  }
}

field n: f32 {
  project to 0..4

  diffuse biomassDiffuse by diffusion

  budget react {
    source uptake
    sink mortality * n
  }
}

rate uptake =
  w * n * n
```

Readout:

- Moderate win. The equations become field accounting: water enters, evaporates,
  is consumed; biomass grows and dies.
- But the order is still the method: advect water, diffuse biomass, then react.
  A pure field lifecycle makes this look more commutative than it is.
- The good abstraction is probably `rate uptake`, plus explicit `transport` and
  `diffuse` effects, not a whole field-primary syntax.

## Downwind Pollution

Lifecycle sketch:

```dsl
field pollutant: f32 {
  project to 0..2.2

  budget pollution {
    source factory * emission
    sink pollutant * decay

    flux to n in neighbors {
      let downwind = max(dot(wind, direction(n)), 0)
      let push = crossMix + windBias * downwind
      amount pollutant * clamp(push * transportRate, 0, 0.22)
    }
  }
}

derive windField on cells { ... }
derive display on cells { ... }
```

Readout:

- Strong win. Pollution is exactly a field budget.
- This is where field-owned transaction policy belongs: donor-limited flux,
  decay, emission, projection, and upper-bound overflow are all properties of
  the same accounting problem.
- If any field-centric authored syntax ships, it should probably start here,
  not with every field in every recipe.

## Weather Cycle

Lifecycle sketch, compressed:

```dsl
field vapor: f32 {
  project to 0..2.5
  transport advect by wind * flowScale
  budget clouds { sink rainOut }
  budget surface { source evaporation }
  diffuse mix by diffusion
}

field water: f32 {
  project to 0..1.2
  budget surface {
    source rainIn
    source oceanRestore
    sink evaporation
    sink runoff
  }
  diffuse mix by diffusion * (1 - 0.6 * land)
}

field T: f32 {
  project to -0.9..1.4
  budget surface {
    source insolation
    source oceanBuffer
    source landHeat
    sink radiativeCooling
    sink evaporativeCooling
    sink rainCooling
  }
  diffuse mix by diffusion
}
```

Readout:

- Good at showing budgets.
- Bad at showing the coupled `clouds` calculation. `cloud`, `rain`, `lift`, and
  vapor loss are one shared pipeline; splitting it by field makes the model
  harder to audit.
- Weather wants both forms: field budgets for `water/vapor/T`, and coupled
  processes for cloud formation and wind.

## Smoothlife / Lenia Class

Lifecycle sketch:

```dsl
field A: f32 {
  project to 0..1
  process neighborhoodKernel
  process growthResponse
}
```

Readout:

- Almost no win. These recipes are dominated by nonlocal kernels and response
  curves. The field lifecycle just says "kernel then growth", which the current
  stages already say.
- The missing abstraction here is not lifecycle. It is kernel cost/shape:
  kernel table limits, shell/ring helpers, and better visual defaults.

## Wave / Shallow Water / Ordered Solvers

Lifecycle sketch:

```dsl
field h { process continuity; process viscosity }
field m { process momentum }
field dye { process advectDye }
```

Readout:

- Weak. Ordered solvers are not best understood by asking "what is the lifecycle
  of h?" They are best understood as a numerical method.
- Field lifecycle could be a generated explanation panel, but authoring the
  solver field-first would obscure the algorithm.

## Current Conclusion

Field lifecycle is a great **explanation view** and a useful mental model for
budget-heavy fields. It is not a good universal authoring surface.

The strongest emerging split is:

```text
rate      = named reusable local term
budget    = field-owned accounting for source/sink/flux/project
process   = ordered or coupled computation over cells/edges/relax
lifecycle = generated UI/doc view of how a field changes
```

This is more unified than raw stages, but not by pretending every recipe has
one shape. It says there are only a few kinds of changes:

- local rates
- field budgets
- transport/diffusion
- coupled processes
- bounded relaxation
- derived/display projections

The next useful test is to rewrite one real recipe with this split, term by
term, and compare it to current v2. `planet-biosphere`, `downwind-pollution`,
or `klausmeier` are better candidates than predator-prey because they exercise
budgets and transport.
