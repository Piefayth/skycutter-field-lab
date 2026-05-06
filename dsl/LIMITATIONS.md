# Field Lab Known Limitations

This file tracks limitations we have actually hit while building recipes. The
goal is to keep recipe failures and missing abstractions visible instead of
rediscovering them through tuning.

## Primitive Queue

This is the current pragmatic readout from recipe work. The direction is not a
second authoring DSL. It is v2 plus small primitives that remove real awkwardness
from real recipes.

### Already Implemented / Usable

- `transport(vec2, coord)` — explicit vector basis transport for neighbor reads.
  Needed by vector alignment / flow recipes such as `vicsek-flock` and
  `toner-tu`.
- `upstream(vec2, dt) -> coord` — continuous semi-Lagrangian sampling point.
  Used by `planet-wind-moisture`, weather, and dye/advection recipes.
- `relax NAME max_iters N { ... }` — bounded repeated stage execution inside one
  tick. Used by `sandpile`.
- `count n in neighbors where PRED` — small readability primitive for cellular
  automata and toppling rules.
- GPU additive paint deltas — runtime primitive, not DSL syntax. Additive
  `spot` / `ellipse` stamps on float fields apply to the live GPU field without
  readback, which fixed drag rewind/rate drop.

### Next Best DSL Primitives

1. `relax ... until all cells { PRED }`
   - Why: `sandpile` is now much better, but still budgeted. It cannot express
     "drop one grain, settle fully, then continue" without burning a fixed
     iteration count every tick.
   - Shape:
     ```dsl
     relax settle max_iters 64 until all cells { toppled == 0 } {
       stage topple { ... }
     }
     ```

2. Enum/state declarations and validation mode
   - Why: `drossel-schwabl`, `eden-growth`, `greenberg-hastings`,
     `cyclic-ca`, and integer state recipes still use magic `u32` numbers.
   - This should be an additive v2 feature, not a replacement surface.
   - Shape:
     ```dsl
     field state: u32 enum { empty = 0, tree = 1, burning = 2 }
     stage burn mode enum { ... }
     ```

3. Explicit projection / constraint helpers
   - Why: recipe authors dislike implicit field clamps, and repeated
     `set x = clamp(...)` is noisy. `planet-heat`, predator/prey, and weather
     all carry "keep this field in range" logic.
   - Bias: keep projection explicit in stages first; declaration-site implicit
     constraints are still suspicious because "when does it clamp?" matters.
   - Shape:
     ```dsl
     project T to -1.2..1.45
     project water nonnegative
     ```

4. Hidden/diagnostic derived fields with clearer vocabulary
   - Why: `derived` currently means "computed field, not paintable," but that is
     easy to confuse with a temporary variable. Weather, heat, and diagnostics
     want viewable projections; they also sometimes want internal scratch.
   - Likely split:
     - `derived`: viewable computed field.
     - `hidden derived` or `internal`: computed field used by stages/metrics but
       hidden from normal view/stamp pickers.

5. Source/sink plus conservative flux transaction
   - Why: `downwind-pollution`, runoff, and future physical weather want "emit,
     decay, and transport this same field" without manual stage choreography.
     Existing `edge flux` is conservative, but local source/sink terms live in
     separate cell stages.
   - Conservative first version: one explicit transaction stage for one field,
     not magical cross-stage accumulation.

### Maybe Later

- Scalar `diffuse FIELD by k using neighborMean` sugar. This is readable, but it
  mostly renames the current one-liner:
  ```dsl
  add T = (mean n in neighbors { T@n } - T) * clamp(k * dt * rate, 0, 0.24)
  ```
  Useful, but lower impact than the items above.
- Field-centric transaction declarations. They might help conservative budgets,
  but they duplicate update bodies for coupled systems. Do not pursue until
  source/sink+flux recipes prove the need.
- Multi-resolution / approximate kernel primitives for SmoothLife-style models.
  Important for performance, but it is more numerical runtime design than core
  DSL syntax.

## Geometry And Vector Fields

### Raw `vec2` Neighbor Reads Are Literal

`vec2` fields store components in each cell's local tangent basis. A read such
as `wind@n` returns the neighbor cell's local components, not those components
rotated into the current cell's basis.

This matters for recipes that average or compare neighbor vectors:

```dsl
let avg = mean n in neighbors { heading@n }
```

That expression is only an approximation. It treats every neighbor's local
east/north basis as if it matched the current cell's basis. On a sphere this is
not geometrically exact.

Use explicit transport when that basis conversion matters:

```dsl
let avg = mean n in neighbors { transport(heading@n, n) }
```

`transport(vec, n)` transports a neighbor-local tangent vector into
the current cell's tangent basis. The explicit spelling is intentional:
`field@n` remains a literal neighbor read.

Recipe examples:

- `vicsek-flock`: local alignment is visually usable at low noise, but the
  vector averaging is not a geometrically correct Vicsek model on the sphere.
- `toner-tu`: vec2 diffusion/alignment has the same caveat anywhere it reads
  neighbor velocity vectors directly.
- `planet-wind-moisture`: advection uses `upstream(windFlow, dt * rate)`, which
  is the right primitive for "carry scalar moisture along a vector field." It
  does not by itself make a compelling wind field; that remains recipe modeling.

We should not silently change `field@n` semantics because existing recipes may
rely on literal component reads.

Primitive status: `transport(vec2, coord)` exists. The remaining work is recipe
auditing: vector neighbor averages should use it when geometry matters.

## Advection And Planet Flow

### `upstream` Moves Fields, It Does Not Create Flow

`upstream(wind, dt)` answers one question: "where did this cell's material come
from last timestep?" A scalar advection recipe is then:

```dsl
let p = upstream(windFlow, dt * rate)
set moisture = moisture@p
```

That is enough for the minimal `planet-wind-moisture` recipe. The hard part is
not the transport primitive; it is authoring a wind field that has believable
planet-scale structure without becoming polar swirl or equatorial suction.

Recipe examples:

- `planet-wind-moisture`: currently a good minimal advection testbed.
- `weather-cycle`: combines wind, vapor, condensation, rain, surface water, and
  temperature, so the wind field is only one part of the model.
- `shallow-water`: uses ordered numerical steps; a simple `upstream` helper does
  not replace the solver structure.

Primitive status: `upstream(vec2, dt)` exists and is probably enough for scalar
advection. The missing abstraction is more likely recipe-level wind generation
or reusable recipe snippets, not a new DSL core primitive.

## Derived Fields And Scratch Values

### `derived` Is A Field Annotation, Not A Formula

In v2, `derived` means:

- allocated like a field
- written by an ordinary stage
- viewable and readable
- not paintable by scenarios/stamps

It does **not** mean "temporary variable" and it does **not** automatically
recompute when inputs change. That has been confusing.

Recipe examples:

- `planet-heat`: `ice` and `comfort` are display/diagnostic fields computed in
  the same stage as `T`.
- `sandpile`: `stress` and `activity` are smoothed display fields, not core
  state.
- `weather-cycle`: cloud/rain/lift style fields blur the line between real
  model outputs and view helpers.

Likely primitive:

```dsl
field comfort: f32 derived          // viewable computed field
field evaporation: f32 hidden       // internal computed field, hidden from UI
```

or:

```dsl
hidden derived evaporation: f32
```

The important semantic rule is unchanged: a stage still computes it. The change
is vocabulary and UI behavior, not automatic spreadsheet recomputation.

## Projection And Bounds

### Repeated `clamp(...)` Is Noise, But Implicit Clamp Is Dangerous

Many recipes need bounds:

```dsl
set T = clamp(next, -1.2, 1.45)
set moisture = clamp(moisture@p, 0, 1.2)
set u = clamp(u, -0.4, 1.4)
```

Declaration-site constraints looked appealing, but they hide the timing of the
projection. That matters for numerical methods, flux conservation, and recipe
debugging.

Recipe examples:

- `planet-heat`: clamping temperature inside the heat budget is part of the
  authored model.
- `predator-prey`: a final positive clamp is boilerplate, but its order after
  diffusion/reaction matters.
- `runoff-erosion` / water recipes: upper bounds on a transported field can
  destroy mass unless overflow is modeled explicitly.

Likely primitive:

```dsl
project T to -1.2..1.45
project N to 0..3
project water nonnegative
```

This is still explicit and ordered inside a stage. It removes noise without
making the compiler silently clamp at surprising points.

## Cascades And Relaxation

### Bounded Relaxation Has No Stable Early Exit Yet

`step { relax NAME max_iters N { stage ... } }` can now repeat ordinary stages
inside one tick. That is enough for bounded cascade experiments such as the
current `sandpile` recipe, but it is still not a full "apply this rule until
stable, then continue" construct.

Recipe examples:

- `sandpile`: the authored recipe can express a bounded synchronous relaxation
  loop. It still cannot express the classic Abelian sandpile protocol exactly:
  drop one grain, fully relax the avalanche to quiescence with early exit, then
  drop the next grain.
- future avalanche, cascade, settling, and chain-reaction recipes will hit the
  same wall.

Likely future extension:

```dsl
relax settle max_iters 64 until all cells { toppled == 0 } {
  ...
}
```

The important semantics are: global stable condition, each relaxation iteration
reads the previous iteration's committed state, and the loop is bounded.

Status: bounded `relax` is implemented and `sandpile` uses it. The missing
piece is early exit / stable condition. The current recipe is intentionally
budgeted; it is not an exact Abelian sandpile solver.

## Conservative Budgets And Flux

### Local Source/Sink Terms Do Not Compose With Edge Flux In One Field Budget

V2 can express conservative nearest-neighbor flux:

```dsl
stage transport {
  reads pollutant, wind
  writes pollutant
  edge n in neighbors {
    flux pollutant = ...
  }
}
```

It can also express local sources and sinks:

```dsl
stage emitDecay {
  reads pollutant, factory
  writes pollutant
  cell {
    add pollutant = factory * emission * dt
    add pollutant = -pollutant * decay * dt
  }
}
```

But "source, sink, and transport the same conservative field as one budget" is
not first-class. Authors have to choose an order. Sometimes that order is a real
numerical choice; sometimes it is pass machinery leaking into the recipe.

Recipe examples:

- `downwind-pollution`: factory emission, decay, and downwind flux are one
  conceptual pollutant budget.
- `runoff-erosion`: rain/evaporation/runoff/terrain coupling pushes in this
  direction.
- future weather: rain adds water, evaporation removes water, downhill runoff
  should be conservative flux.

Likely primitive:

```dsl
stage pollutionBudget {
  budget pollutant {
    add factory * emission * dt
    add -pollutant * decay * dt
    flux to n in neighbors { amount ... }
  }
}
```

First version should be explicit and single-stage. Cross-stage automatic
contributor merging is too subtle until this simpler shape proves itself.

## Metric Kernels

### Fixed-Radius Kernels Scale Very Fast

`kernel bell(center, width)` is metric: it gathers cells by great-circle
distance. Increasing geodesic frequency increases both the number of cells and
the number of cells inside the same physical kernel radius.

Recipe examples:

- `smoothlife`: uses multiple metric kernels per tick, so raising geodesic
  frequency can make the work grow much faster than ordinary neighbor recipes.
- `wilson-cowan-field`, `lenia-lite`, and `nonlocal-ecology` share the same
  scaling concern.

This is not a correctness bug. It is the cost of dense local convolution on a
higher-resolution mesh. Future optimizations could include approximate kernels,
multi-resolution fields, or specialized blur/convolution paths.

## Rendering

### GPU Surface Renderer Does Not Compile `color expr` Yet

The custom GPU surface renderer supports `color ramp` and `color wheel` views.
It does not yet compile `color expr` view bodies to WGSL.

The GPU surface renderer is the default render path. If a recipe's selected view
is expression-only, the UI switches to the first ramp/wheel view rather than
showing a blank planet.

Recipe examples:

- `planet-biosphere`: the composite "Living planet" expression view is not yet
  GPU-surface-native; the surface path selects a ramp view such as `biomass`.
- reaction/composite views in recipes such as `predator-prey`, `sir-epidemic`,
  and `weather-cycle` will need WGSL expr-view compilation to be fully native.

## Integer Cellular Automata

### `u32` Reads As Scalar In Expressions

`u32` fields read as scalar values in the expression language. Assignments round
and cast back to integer storage. This is pragmatic and works for cellular
automata, but it means arithmetic expressions can temporarily behave like real
numbers before writeback.

Recipe examples:

- `eden-growth`, `drossel-schwabl`, `greenberg-hastings`, and `sandpile` all use
  integer-like state fields with scalar expression syntax.

This is acceptable for now, but enum/state-machine syntax would make many of
these recipes clearer and safer.
