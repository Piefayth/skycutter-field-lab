# DSL v2.5 Proposal

Status: proposal, not implemented.

## Thesis

Do not replace v2 stages yet.

The current recipe evidence does not justify a full v3 authoring surface. Many
important recipes are genuinely ordered numerical methods, and the v2
`step -> stage -> cell/edge` model expresses that honestly.

The better move is v2.5:

```text
A recipe is ordered phases.
Inside each phase, fields change through composable effects.
```

Keep v2's scheduling and lowering model, but add a small set of semantic
effects that remove real recipe awkwardness:

- `project` for explicit bounds/projection timing
- `budget` for source/sink/flux accounting on one field
- `transport` for scalar advection by a vector field
- `diffuse` for named standard neighbor diffusion
- `relax ... stable when` for bounded settling
- enum field declarations plus enum validation mode
- clearer computed-field vocabulary (`computed` plus `hidden`, names TBD)

Named model terms are still important, but the current evidence does not prove
that `rate` deserves a keyword beyond `let`. Treat it as a candidate convention
or future syntax, not an initial v2.5 feature.

This is deliberately not a second DSL layered above v2. It is a conservative
extension of the stage body language.

## Design Principles

### 1. Preserve Explicit Order

Sequential recipes should stay sequential:

```dsl
step {
  stage accelerate { ... }
  stage integrate { ... }
}
```

The compiler can still derive reads/writes and visualize dependencies, but v2.5
does not pretend that order is accidental. In wave equations, shallow water,
reaction-diffusion splitting, and many planet recipes, order is part of the
model.

### 2. Add Effects, Not A New Scheduler

New vocabulary should live inside stages first:

```dsl
stage ecology {
  reads ...
  writes ...
  cell {
    let uptake = w * n * n
    add n = ...
    project n to 0..4
  }
}
```

or:

```dsl
stage pollutionBudget {
  reads pollutant, factory, wind
  writes pollutant

  budget pollutant {
    source factory * emission
    sink pollutant * decay
    flux to n in neighbors { amount ... }
    project nonnegative
  }
}
```

This lets us improve recipes without committing to a replacement authoring
surface.

### 3. Every Keyword Must Have One Job

```text
project   = explicitly constrain a committed value
budget    = field accounting
transport = semi-Lagrangian scalar advection
diffuse   = standard neighbor diffusion
relax     = bounded repeated execution
enum mode = validate discrete state writes
```

If a keyword cannot keep one job across recipes, it should not ship.

`rate` currently fails this test as written. Most sketches use it exactly where
`let` would work. It should only return as syntax if real recipes need
stage-scope shared terms referenced by multiple effects, or cross-field budget
terms where `let` becomes confusing.

### 4. Lifecycles Are Generated Explanations

Authors often ask field-centered questions:

- "Why does heat dissipate?"
- "Where does pollution go?"
- "What moves moisture?"

The answer should be a generated field lifecycle view derived from the AST, not
necessarily field-centric authoring syntax.

## Proposed Surface

### `project`

Current v2:

```dsl
set T = clamp(nextT, -1.2, 1.45)
```

v2.5:

```dsl
write T = nextT
project T to -1.2..1.45
```

or:

```dsl
add T = heatDelta * dt * rate
project T to -1.2..1.45
```

Semantics:

- Applies inside the current stage.
- Must be terminal for that field inside the current block.
- Writes/adds/transports/diffusion to that field after `project` are compile
  errors.
- Is explicit; no hidden declaration-site clamp.
- Lowers to the same clamp expression or a fused equivalent.

This avoids ambiguous code such as:

```dsl
add T = heating * dt * rate
project T to -1..1
add T = cooling * dt * rate
```

If the author wants heating and cooling projected together, projection goes at
the end. If they want two projected substeps, they should use two stages.

Why useful:

- Removes noisy nested `clamp(...)`.
- Makes projection timing visible.
- Avoids the disliked ambiguity of implicit field constraints.

Good recipe targets:

- `planet-heat`
- `predator-prey`
- `klausmeier`
- `weather-cycle`
- `wave-equation`

### Named Terms / Candidate `rate`

Named local terms are useful. The question is whether they need a keyword.

```dsl
let uptake = w * n * n
let plantGrowth = growth * habitability * biomass * max(1 - biomass, 0)
let predation = a * N * P / (N + hSat + 0.000001)
```

Current position:

- Do not ship `rate` in the first v2.5 pass.
- Use `let` for single-use local formulas.
- Reconsider `rate` only if we find terms referenced by multiple effects where
  ordinary `let` makes the accounting less clear.
- If `rate` returns, it should probably be stage-scope, not arbitrary cell-local
  decoration, and should be linted when referenced only once.
- If a named term should be viewed, stamped, or reduced, make it a computed
  field (`computed` plus optional `hidden`, names TBD).

Why this skepticism matters:

- A hypothetical `rate uptake = w * n * n` saves nothing over
  `let uptake = ...`.
- A hypothetical `rate predation = ...` saves nothing over
  `let predation = ...`.
- Planet biosphere sketches used many one-shot rates, which is a warning sign.
- Intent alone is not enough to justify a keyword unless it improves real ports.

Good future test cases:

- `nutrient-grazing-cycle`: `grazingLoss` affects plants, grazers, and nutrient.
- `planet-biosphere`: `biomassGrowth` affects biomass and moisture.
- weather: `evaporation` affects water, vapor, and temperature.

### `budget`

`budget` is the main candidate primitive, but it is deliberately narrow.

It expresses one field's local source/sink terms plus optional conservative
flux and projection as one transaction.

```dsl
stage pollutionBudget {
  reads pollutant, factory, wind
  writes pollutant

  budget pollutant {
    source factory * emission
    sink pollutant * decay

    flux to n in neighbors {
      let downwind = max(dot(wind, direction(n)), 0)
      let distWeight = clamp(0.050 / max(distance(n), 0.001), 0.55, 1.3)
      let push = crossMix + windBias * downwind
      amount pollutant * clamp(push * distWeight * transportRate, 0, 0.22)
    }

    project nonnegative
  }
}
```

Semantics:

```text
local_delta = dt * rate * (sum(source) - sum(sink))
raw_outgoing = per-edge amount requests
available = max(0, snapshot + local_delta)
scaled_outgoing = raw_outgoing scaled proportionally if raw total > available
incoming = sum neighbors' scaled outgoing amounts
next = project(snapshot + local_delta - scaled_outgoing + incoming)
```

Important constraints:

- First implementation supports one `budget FIELD` per stage.
- A budget writes exactly that field.
- `source` and `sink` are per-time terms; the budget applies `dt * rate` once.
- `amount` is a nonnegative directed flux request.
- Incoming flux uses neighbors' scaled outgoing amounts.
- Projection runs once at the end and must be terminal.
- Conservative budgets only support lower-bound projection such as
  `project nonnegative`.
- Conservative budgets do not support finite upper caps. This is not a temporary
  parser limitation; it is part of the semantics. Saturating fields use an
  explicit sink/overflow term or a future non-conservative effect.
- Proportional outgoing scaling is the default semantics, not an implementation
  detail. If we later want gradient-priority or capacity-priority allocation,
  that must be an explicit policy variant, not a silent behavior change.

Allocation policy, if made explicit later:

```dsl
flux proportional to n in neighbors { amount ... }
```

Do not add policy syntax until a recipe demonstrates need. The v2.5 budget
proposal commits to proportional allocation for its first version.

Why no implicit upper cap:

```dsl
budget water {
  source rain
  flux to n in neighbors { amount ... }
  project to 0..1.4
}
```

This looks harmless but silently destroys water when a receiver exceeds `1.4`.
For conservative budgets, saturation must be authored as a model term:

```dsl
sink spillRate * max(water - basinCapacity, 0)
project nonnegative
```

Pollution-like fields may intentionally saturate, but that should use an
explicit non-conservative projection spelling later, not the conservative
budget primitive.

#### Coupled Multi-Field Accounting

`budget` v1 does not solve coupled multi-field exchanges.

Weather exposes the gap:

```text
evaporation removes water
evaporation adds vapor
evaporation cools temperature
rain adds water
rain removes vapor
rain cools temperature
```

Under the one-budget-per-stage rule, that can be written as ordinary coupled
cell code, or split across multiple stages, but it is not a clean budget. That
is acceptable for v2.5 because the primitive is intentionally narrow:

```text
budget = one-field conservative/local accounting
coupled stage = multi-field exchange or numerical method
```

If real ports show that multi-field exchanges are common enough to deserve a
primitive, that is a separate proposal, likely something like `exchange` rather
than stretching `budget` past its job.

Why useful:

- Combines emission, decay, transport, and projection without artificial
  emit/transport/decay choreography.
- Makes "where did this field go?" auditable.
- Gives conservative edge flux a natural home with local source/sink terms.

Good recipe targets:

- `downwind-pollution`: strongest positive case.
- `runoff-erosion`: rain/evaporation/downhill flux water budget.
- `nutrient-grazing-cycle`: nutrient and grazer movement budgets.
- future planet pollution/moisture recipes.

Weak recipe targets:

- `wave-equation`
- `smoothlife`
- `shallow-water` momentum/continuity solver

### `transport`

Current v2:

```dsl
let p = upstream(windFlow, dt * rate)
set moisture = clamp(moisture@p, 0, 1.5)
```

v2.5:

```dsl
transport moisture by windFlow
project moisture to 0..1.5
```

or inside a stage:

```dsl
stage advect {
  reads moisture, windFlow
  writes moisture
  cell {
    transport moisture by windFlow
    project moisture to 0..1.5
  }
}
```

Semantics:

```dsl
transport FIELD by VEC
==
let displacement = clampLength(VEC * dt * rate, edgeLength)
let p = upstream(displacement)
write FIELD = FIELD@p
```

First-pass policy:

- `transport` applies the stage's implicit `dt * rate`.
- Default transport clamps displacement to one local cell step, using the
  current cell's minimum neighbor distance as the step length.
- The clamped sample position is used directly; this is stable but not
  conservative.
- `transport` does not include projection. Projection stays separate.
- `transport` does not include decay/fade. Use `add`, `project`, or a later
  budget/process term.
- Authors who want raw `upstream` behavior can ask for it explicitly:

```dsl
transport moisture by windFlow unchecked
```

The unchecked form lowers to the current v2 spelling:

```dsl
let p = upstream(windFlow, dt * rate)
write moisture = moisture@p
```

This makes the CFL footgun visible. The default is stable/clamped; the explicit
escape keeps the current power-user behavior.

Why useful:

- This is an authored intent primitive: "move this scalar by this flow."
- Avoids repeated upstream sampling boilerplate.
- Keeps wind generation separate from advection.

Good recipe targets:

- `planet-wind-moisture`
- `planet-biosphere`
- `weather-cycle`
- `klausmeier` water flow if we choose to spell it as transport

### `diffuse`

Current v2:

```dsl
add T = (mean n in neighbors { T@n } - T) * clamp(k * dt * rate, 0, 0.24)
```

v2.5:

```dsl
diffuse T by k using neighborMean
```

Semantics:

```text
add FIELD = (mean n in neighbors { FIELD@n } - FIELD)
          * clamp(k * dt * rate, 0, 0.24)
```

First version:

- Only `using neighborMean`.
- Coefficient may vary per cell.
- Projection remains explicit.

Why useful:

- Common enough to deserve a name.
- Makes stencils visible.
- Lower priority than `project` and `budget` because it mostly renames an
  existing one-liner.

Good recipe targets:

- `predator-prey`
- `planet-heat`
- `runoff-erosion`
- `planet-biosphere`
- many reaction-diffusion recipes

### `relax ... stable when`

Current sandpile can run bounded relaxation. Early-stop-to-stable is a more
expensive optional extension, not the default path.

v2.5:

```dsl
relax settle max_iters 64 stable when toppled == 0 {
  stage topple {
    reads h
    writes h, toppled
    cell {
      let willTopple = h >= THRESHOLD
      let incoming = count n in neighbors where h@n >= THRESHOLD

      write h = max(0, h + incoming - (willTopple ? THRESHOLD : 0))
      write toppled = willTopple ? 1 : 0
    }
  }
}
```

Semantics:

- `stable when PRED` is global over all cells.
- The relax loop stops only when every cell satisfies `PRED`.
- Each iteration reads the previous iteration's committed result.
- The loop resets each tick.
- First implementation should support one body stage.
- Fixed `max_iters` without `stable when` is the cheap GPU path.
- `stable when` requires a per-iteration global reduction and, in the simple
  runtime, a per-iteration sync/readback or equivalent GPU-side scheduling
  mechanism.
- For a 32-iteration sandpile tick, this can mean 32 reductions per tick.
  Authors should opt into `stable when` only when correctness or average
  iteration savings justify the synchronization cost.

Why useful:

- Sandpile/settling is not a single synchronous update.
- Makes bounded iterative behavior explicit.
- Avoids lexical load like `until all cells`.

Good recipe targets:

- `sandpile`
- future avalanches / settling / cellular relaxation models

### Enum Fields And Enum Mode

Current v2 uses magic `u32` state numbers.

v2.5:

```dsl
field state: u32 enum {
  empty = 0
  tree = 1
  burning = 2
}

stage burn mode enum {
  reads state
  writes state
  cell {
    let burnNbrs = count n in neighbors where state@n == burning
    let strike = rand01(frame) < F_LIGHTNING
    let sprout = rand01(frame * 31 + 7) < P_GROWTH

    write state =
      state == burning ? empty :
      state == tree && (burnNbrs > 0 || strike) ? burning :
      state == empty && sprout ? tree :
      state
  }
}
```

Validation:

- Written enum values must be declared cases.
- Each enum field gets at most one `write`.
- `add`, `multiply`, `diffuse`, and `flux` on enum fields are rejected.
- `dt` is not in scope by default.
- Compiler can lint missing cases.

Why useful:

- Clear win for cellular automata.
- Additive to v2; does not require v3.

Good recipe targets:

- `drossel-schwabl`
- `eden-growth`
- `greenberg-hastings`
- `cyclic-ca`

### Computed Field Vocabulary

Current confusion:

```dsl
field comfort: f32 derived
```

Users may read "derived" as "automatically computed from a formula." In v2 it
actually means "allocated field, written by stages, viewable/readable, not
paintable."

The current `derived` name is probably too overloaded, but visibility should be
orthogonal to field kind. A helper field is not a different type just because it
is hidden from pickers.

Better candidate vocabulary:

```dsl
field comfort: f32 computed
field evaporation: f32 computed hidden
```

Meaning:

- `computed`: allocated field written by stages; readable and viewable; not
  paintable by default.
- `hidden`: visibility modifier; hides the field from normal view/stamp/source
  pickers.
- `hidden` can be added or removed without changing the field's semantics.
- Reserve `derived` for a possible future formula-driven field, or keep it as a
  backward-compatible alias for `computed` with clear docs.

Why useful:

- Separates view diagnostics from internal scratch.
- Avoids pretending current v2 `derived` fields are spreadsheet formulas.

Good recipe targets:

- `planet-heat`: `ice`, `comfort`
- `sandpile`: `stress`, `activity`
- `weather-cycle`: `cloud`, `rain`, `lift`, possible hidden `evaporation`
- `planet-biosphere`: `habitability`

## Worked Examples

### Downwind Pollution

Current:

```text
emit -> transportStep -> decayAndDisplay
```

v2.5:

```dsl
stage pollutionBudget {
  reads pollutant, factory, wind
  writes pollutant

  budget pollutant {
    source factory * emission
    sink pollutant * decay

    flux to n in neighbors {
      let downwind = max(dot(wind, direction(n)), 0)
      let distWeight = clamp(0.050 / max(distance(n), 0.001), 0.55, 1.3)
      let push = crossMix + windBias * downwind
      amount pollutant * clamp(push * distWeight * transportRate, 0, 0.22)
    }

    project nonnegative
  }
}

stage display {
  reads pollutant, factory
  writes plume
  cell {
    let halo = mean n in disk(3) { pollutant@n }
    write plume = pollutant * 0.95 + halo * 1.55 + factory * 0.12
  }
}
```

Verdict: strong win. `budget` earns its place here.

### Runoff Erosion

Current:

```text
rainStep -> runoffStep -> erosionStep
```

v2.5:

```dsl
stage waterBudget {
  reads water, height
  writes water, slope, flow

  cell {
    let slopeMag = length(gradient(height))
    let rainBands = 0.55 + 0.45 * max(0, cos(lat * 2 + frame * 0.003))

    write slope = (slopeMag * 2.0) / (1 + slopeMag * 2.0)
    write flow = (water * slopeMag * 2.4) / (1 + water * slopeMag * 2.4)
  }

  budget water {
    source rain * rainBands
    sink evap * water
    sink max(water - 1.4, 0) * spillRate

    flux to n in neighbors {
      let drop = max((height + water * 0.15) - (height@n + water@n * 0.15), 0)
      amount water * clamp(drop * runoff, 0, 0.12)
    }

    project nonnegative
  }
}

stage erosionStep {
  reads height, water, slope
  writes height
  cell {
    let cut = erode * water * slope
    let smoothing = mean n in neighbors { height@n } - height
    let tectonic = uplift * (0.55 + 0.45 * cellNoise(2, 1.5))

    add height = (tectonic + smoothing * 0.08 - cut) * dt * rate
    project height to 0..1.5
  }
}
```

Verdict: strong for water; ordinary ordered process for erosion. This supports
mixed effects inside ordered stages.

### Klausmeier Vegetation

Current:

```text
waterFlow -> biomassDiffuse -> react -> clampPositive
```

v2.5:

```dsl
stage waterFlow {
  reads w, slope
  writes w
  cell {
    transport w by slope * flowSpeed * 0.015
  }
}

stage biomassDiffuse {
  reads n
  writes n
  cell {
    diffuse n by diffusion using neighborMean
    project n to 0..4
  }
}

stage react {
  reads n, w
  writes n, w
  cell {
    let uptake = w * n * n

    add w = (rainfall - w - uptake) * dt * rate
    add n = (uptake - mortality * n) * dt * rate

    project w to 0..6
    project n to 0..4
  }
}
```

Verdict: moderate win. The order remains explicit; the equation terms are
clearer.

### Planet Biosphere

Current:

```text
windField -> climate -> advect -> ecology -> spread
```

v2.5:

```dsl
stage climate {
  reads heat, moisture, ocean, biomass
  writes heat, moisture
  cell {
    let insolation = sun * max(0, cos(lat))
    let shade = biomass * 0.08
    let oceanHeatBuffer = ocean * (0.12 - heat) * 0.35
    let heatCooling = 0.75 * (heat + 0.18)
    let oceanEvaporation = ocean * evap * (0.35 + max(heat, 0) * 0.35)
    let landDrying = moisture * (0.22 + max(heat, 0) * 0.26) * (1 - ocean * 0.65)

    add heat = (insolation * (1 - shade) + oceanHeatBuffer - heatCooling) * dt * rate
    add moisture = (oceanEvaporation - landDrying) * dt * rate

    project heat to -1..1.2
    project moisture to 0..1.5
  }
}

stage advect {
  reads moisture, pollution, windFlow
  writes moisture, pollution
  cell {
    transport moisture by windFlow
    project moisture to 0..1.5

    transport pollution by windFlow
    project pollution to 0..1.8
  }
}

stage ecology {
  reads heat, moisture, biomass, pollution, fertility, industry
  writes biomass, moisture, pollution, habitability
  cell {
    let tempFit = clamp(1 - abs(heat - 0.18) * 1.8, 0, 1)
    let wetFit = clamp(moisture * 1.15, 0, 1)
    let cleanFit = clamp(1 - pollution * toxicity, 0, 1)
    let hab = tempFit * wetFit * clamp(fertility, 0, 1) * cleanFit
    let biomassGrowth = growth * hab * biomass * max(1 - biomass, 0)
    let biomassDeath = biomass * (0.08 + pollution * toxicity * 0.22 + max(-heat - 0.35, 0) * 0.35)
    let pollutionInput = industry * emit
    let pollutionLoss = pollution * (cleanup + biomass * 0.18)

    add biomass = (biomassGrowth - biomassDeath) * dt * rate
    add moisture = -biomassGrowth * 0.26 * dt * rate
    add pollution = (pollutionInput - pollutionLoss) * dt * rate
    write habitability = hab

    project biomass to 0..1
    project moisture to 0..1.5
    project pollution to 0..1.8
  }
}
```

Verdict: good enough. It does not shrink much, but it becomes more legible
without lying about the ordered phases.

### Wave Equation

v2.5 should not force budgets here.

```dsl
stage accelerate {
  reads u, v
  writes v
  cell {
    let lap = sum n in neighbors { u@n - u }
    add v = (speed * speed * lap - damping * v) * dt * rate
    project v to -24..24
  }
}

stage integrate {
  reads u, v
  writes u
  cell {
    add u = v * dt * rate
    project u to -2..2
  }
}
```

Verdict: small clarity win only. That is acceptable. Ordered solvers do not need
to become something else.

## GPU Lowering

All v2.5 pieces lower to existing patterns:

- `project`: clamp expression or fused post-write projection.
- `transport`: clamped displacement plus `upstream(...)` plus `FIELD@coord`;
  `unchecked` lowers to raw `upstream(vec, dt * rate)`.
- `diffuse`: neighbor mean cell pass.
- `budget` with flux: existing edge flux compute/apply plus local delta and
  projection.
- `relax stable when`: repeated dispatch with a global stable flag; early stop
  has synchronization cost.
- enum mode: existing gather-style cell pass plus validation.

The only truly new lowering complexity is `budget` with source/sink + flux.
Everything else is sugar, validation, or a clearer spelling over existing v2
machinery.

## Implementation Order

1. `project FIELD to ...`
   - Lowest risk.
   - Immediately useful.
   - Tests explicit projection syntax and compiler plumbing.

2. `transport FIELD by VEC`
   - Low/moderate risk.
   - Wraps existing `upstream`.
   - Default clamps displacement to one local cell step; `unchecked` keeps raw
     upstream behavior.
   - Use on `planet-wind-moisture`, `planet-biosphere`, `klausmeier`.

3. `budget FIELD { source/sink/flux/project }`
   - Load-bearing.
   - Do not ship a flux-less budget milestone; without flux it is mostly a
     structuring affordance over `add`.
   - Use on `downwind-pollution` and `runoff-erosion`.
   - Conservative budgets are lower-bound projection only.

4. `relax ... stable when`
   - Important for sandpile, but separate from budget work.
   - Document early-stop sync cost clearly.

5. enum declarations / mode enum
   - Important and likely clear win, but separate validation track.

6. Computed field vocabulary (`computed` plus `hidden`, names TBD)
   - Important for UX clarity.
   - Mostly parser/docs/UI naming unless it changes field behavior.

Do not implement `rate` in the first pass. Keep using `let` until a port proves
that a stricter shared-term construct earns its own syntax.

## Reflection

What feels solid:

- v2.5 admits the evidence: the ordered stage model remains useful.
- `project` is almost certainly worth doing.
- `budget` is a real abstraction for pollution/runoff/nutrient recipes.
- Field lifecycle is better as generated UI/docs than primary syntax.
- `rate` should be demoted until it does work that `let` cannot.

What still feels dangerous:

- `budget` semantics must be exact before implementation, especially flux
  scaling and the rejection of conservative upper caps.
- Upper caps inside conservative budgets are dangerous enough to reject in v1.
- `transport` needs an explicit displacement/CFL policy once it is promoted
  beyond raw `upstream` sugar.
- `relax stable when` has sync cost that authors should understand.
- `rate` is decorative unless a real port needs a shared-term construct.
- Too many tiny helpers could still become keyword soup if we do not enforce the
  one-job rule.
- Computed field vocabulary still needs careful wording so users do not expect
  automatic formula recomputation.

The core open question:

```text
Is budget common enough to justify its complexity?
```

The answer should come from two real ports:

1. `downwind-pollution`
2. `runoff-erosion`

If both become clearer and not slower/fragile, implement `budget`. If only one
does, keep `budget` as a design note and ship `project`, `transport`, relax
stability, and enum validation first.
