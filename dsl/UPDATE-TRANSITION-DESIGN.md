# Update / Transition Design Sketch

Status: proposal, not implemented.

## Context

Field Lab is an interactive simulation playground. A recipe describes a system
on a geodesic sphere: fields live on cells, stages update those fields each
tick, stamps/scenarios initialize or edit them, metrics reduce them, and views
render them. The runtime lowers the recipe to WebGPU compute passes so recipes
can run live at tens of thousands of cells.

The DSL exists because recipe authors should not have to write raw WGSL or
manually wire GPU buffers for every model. A compact recipe should be able to
express systems like:

- reaction-diffusion
- waves
- predator-prey ecology
- weather and runoff
- cellular automata
- stochastic spin systems
- nonlocal kernel fields
- source-driven transport

The current v2 DSL is deliberately close to the execution model. Authors declare
fields and then write ordered `stage` blocks. A stage declares `reads` and
`writes`, then contains either a per-cell `cell { ... }` program or a
conservative `edge n in neighbors { flux ... }` program.

That form has been productive. It made the compiler, validator, fuzzer, WGSL
harness, and runtime tractable. It also exposed useful primitives such as
`source`, `derived`, `@prev`, `upstream(...)`, `direction(coord)`,
`distance(coord)`, metric reductions, kernel reductions, and edge flux.

But as recipes have gotten richer, the language has started to feel more like a
GPU pass DSL than a systems DSL. Many recipes are conceptually about processes:

- rain falls, then water runs downhill, then terrain erodes
- vapor advects, condenses into cloud, and rains out
- predators eat prey, prey decreases, predators increase
- a forest cell changes from tree to burning to empty
- a field is bounded or nonnegative after every update
- a source emits material but is not mutated by the dynamics

Today's DSL can express all of that, but often by spelling implementation
details: `stage`, `reads`, `writes`, `cell`, `edge`, repeated clamps, and
diagnostic projection stages.

This note explores whether the authored DSL should be replaced by more semantic
update forms while still lowering to the same safe GPU patterns. This is not a
proposal for a second DSL layered on top of v2. The hypothesis is to move the
authoring surface from "ordered GPU passes" toward "system update groups with
inferred dependencies"; current stage/cell/edge concepts may survive only as
compiler IR and migration scaffolding.

Important caveat: this document does not yet prove that replacement is
necessary. Several proposed wins, especially enum state, declaration-site field
constraints, and enum update validation, could be added to the current v2 stage
surface. The replacement case only holds if real recipe ports show that semantic
update groups reduce bugs, boilerplate, or conceptual noise beyond what
incremental v2 improvements would achieve.

## Problem

The current DSL is good at describing GPU update programs:

```dsl
step {
  stage react {
    reads N, P
    writes N, P
    cell {
      let response = a * N * P / (N + hSat + 0.000001)
      add N = (r * N * (1 - N / Kcap) - response) * dt * rate
      add P = (eEff * response - m * P) * dt * rate
    }
  }
}
```

This is explicit and close to the compiler, but it makes many recipes read like
execution plans rather than system descriptions. Authors repeatedly encode
concepts such as:

- continuous field evolution
- discrete state update
- conservative transport
- derived fields
- projection / bounds
- source / sink terms
- diagnostic fields

Those concepts exist today, but they are scattered across `stage`, `cell`,
`edge`, `derived`, `source`, `metric`, repeated `clamp(...)` calls, and
validator rules.

The design question: can the DSL expose a smaller set of semantic update forms
that better match simulation structure, while preserving deterministic lowering
to GPU passes?

## Current Forms

### Continuous Cell Stage

```dsl
stage surfaceCycle {
  reads water, vapor, rain, T, land
  writes water, vapor, T
  cell {
    let evaporation = evap * water
    set water = clamp(water + (rain - evaporation) * dt * rate, 0, 1.2)
    add vapor = evaporation * dt * rate
    set T = clamp(T + heating * dt * rate, -0.9, 1.4)
  }
}
```

### Edge Flux Stage

```dsl
stage runoffStep {
  reads water, height
  writes water
  edge n in neighbors {
    let drop = max((height + water * 0.15) - (height@n + water@n * 0.15), 0)
    flux water = water * clamp(drop * runoff * dt * rate, 0, 0.12)
  }
}
```

### Discrete CA Stage

```dsl
stage transition {
  reads state
  writes state
  cell {
    let burnNbrs = sum n in neighbors { (state@n >= 2) ? 1 : 0 }
    let treeIgnites = state == 1 && burnNbrs > 0
    set state = state >= 2 ? 0 : treeIgnites ? 2 : state
  }
}
```

### Derived Diagnostic Stage

```dsl
stage diagnostics {
  reads state
  writes stateNorm, isBurning
  cell {
    set stateNorm = state * 0.5
    set isBurning = state >= 2 ? 1 : 0
  }
}
```

These are all valid GPU programs, but the high-level intent is implicit.

## Candidate Core Form

If replacement survives the evidence gates below, the candidate surface is a
tick-local update graph:

```dsl
tick {
  update name [after a, b] [before c] {
    ...
  }
}
```

Each update group:

1. Reads a stable snapshot at group start.
2. Computes all writes from that snapshot.
3. Commits all writes together at group end.
4. Has dependencies inferred from its expression AST.
5. May add optional explicit order constraints with `after` / `before`.

Default scheduling should be Bevy-like:

- Data dependencies imply order.
- Independent groups may run in parallel.
- Explicit `after` / `before` adds author intent when order matters beyond data
  dependency.
- Write/write conflicts are rejected unless they are in one group, explicitly
  ordered, or use a compatible composition form.
- The inferred schedule is projected into the existing pipeline graph so authors
  can see why groups did or did not run together.

## Primitives Added Or Made Explicit

This proposal adds or makes explicit vocabulary that is not all present in
today's v2 surface. That should be visible early, because each addition is a
place where the abstraction chooses to grow instead of falling back to raw
stages.

- `tick { ... }` as the author-facing update graph
- `update NAME [after ...] [contributes FIELD...] { ... }`
- enum/discrete validation mode for updates that write enum fields
- `derive NAME { ... }` as pure derived-field update sugar
- declaration constraints: `range`, `nonnegative`, `maxLength`
- enum field declarations for discrete states
- `write`, `add`, `multiply`, `clamp`, `diffuse`, `flux ... amount ...`
- `diffuse FIELD by k using neighborMean` with explicit stencil naming
- hidden derived fields for shared field-dependent intermediates
- `count n in neighbors where PRED`, sugar for
  `sum n in neighbors { PRED ? 1 : 0 }`
- `rand01(seed)` as per-cell nonnegative RNG sugar; the cell id is mixed into
  `seed`, so `rand01(frame)` gives different cells different draws in one tick
- `upstream(vec2, dt)` as the canonical vector form of upstream sampling
- `relax ... max_iters ... stable when all cells { ... }`
- optional `reads` / `writes` assertions checked against derived dependencies

Existing primitives used by the examples, such as `gradient(...)`,
`upstream(...)`, `field@coord`, `direction(coord)`, and `distance(coord)`, stay
part of the expression layer.

## `update`

`update` is for numeric quantities changing by contributions.

Typical writes:

```dsl
write field = expr
add field = expr
multiply field by expr
clamp field to lo..hi
diffuse field by expr
flux field to n in neighbors { amount expr }
```

Within one update group, action order must be specified. A conservative first
rule:

1. A field's pending value starts as the group's input snapshot value.
2. A field may have at most one `write`, and if present it must be the first
   action for that field in the group.
3. `write` replaces the pending value.
4. `add` / `multiply` compose with that pending value in lexical order.
5. `flux` contributes through its conservative edge lowering.
6. `clamp` / projection runs after all same-field writes inside the group.

This avoids surprising cases such as `write water = 1; add water = 0.2; write
water = 0`, where a later write would otherwise erase earlier work.

Across groups, same-field writes are not automatically reordered unless the
author opts into a compatible composition mode.

## Field Transactions

`flux` and local source/sink terms can coexist only through a defined field
transaction. Do not leave this to lexical accident. For a field with local
additive terms and edge flux terms in the same update:

1. compute local additive delta from the group input snapshot
2. compute raw directed flux amounts from the group input snapshot
3. compute source availability as `max(0, snapshot + local_delta)`
4. if raw outgoing flux exceeds source availability, scale all outgoing edge
   amounts proportionally
5. incoming flux is the sum of neighbors' scaled outgoing edge amounts
6. commit `project(snapshot + local_delta - outgoing + incoming)`

That gives source/sink-plus-flux composition a real semantics instead of
forcing authors into artificial `after` chains.

The proportional scaling choice is a first-pass numerical policy, not a law of
nature. It preserves the relative size of each raw outgoing edge demand while
guaranteeing the donor cannot overspend. Other conservative policies, such as
gradient-priority allocation, are possible but should be explicit future
variants rather than hidden changes to the default.

Worked example:

```text
cell A water snapshot = 0.5
local contributors in the same transaction: +0.3 and -0.2
raw outgoing fluxes from A: edge1 = 0.25, edge2 = 0.15
range constraint: 0..1
```

Then:

```text
local_delta = +0.1
source_availability = max(0, 0.5 + 0.1) = 0.6
raw_outgoing = 0.4
scale = min(1, 0.6 / 0.4) = 1
A_next_before_projection = 0.5 + 0.1 - 0.4 + incoming
```

If the raw outgoing flux were `0.8`, the scale would be `0.6 / 0.8 = 0.75`,
so edge1 and edge2 would both be multiplied by `0.75`. If local contributors
drive the source negative, e.g. `local_delta = -0.8`, availability is zero and
no outgoing flux leaves that cell; final projection clamps the committed value.

The incoming term must use neighbors' scaled outgoing amounts, not their raw
requests. Each cell computes its own outgoing scale independently from its
snapshot and local delta; then the apply pass sums the scaled edge transfers
arriving from adjacent cells. That is still a local explicit update, not a
coupled global solve, because a cell's outgoing scale does not depend on the
incoming flux it will receive during the same transaction. Before final
projection, every scaled unit lost by one cell is gained by a neighbor.

Across groups, the transaction reads the latest committed value at the time the
group runs. If tick N first commits rainfall contributors so cell A's water goes
from `0.5` to `0.8`, then a later runoff update in the same tick uses `0.8` as
its input snapshot. If rainfall contributors and runoff flux target `water` at
the same schedule depth, they conflict unless the author writes them as one
field transaction. That keeps source/sink-plus-flux composition explicit and
deterministic.

The same rule applies across ticks. If tick `N` ends with `water = 0.8`, tick
`N+1` starts from `0.8`; contributors and flux in that tick never see partial
same-depth writes. This is explicit Euler splitting. For example, if `emit` and
`decay` both contribute to `pollutant` at the same depth, `decay` reads the
pre-emit pollutant value. That can under- or over-shoot compared with a
semi-implicit scheme, but it is deterministic and parallelizable. Recipes that
need partially updated state should use a coupled `update`, not parallel
contributors.

Range constraints need one hard rule. A lower bound such as `nonnegative`
composes naturally with donor-limited flux: it prevents cells from sending more
than they have. An upper `range` bound does not preserve conservation if
incoming flux would push a receiver over the maximum; post-commit projection
would clip the excess. Therefore a field that participates in conservative
flux may not have a silent upper projection. It must either be unbounded above,
or it must declare an explicit overflow/sink policy that accounts for clipped
mass. This pushes toward a field-level transaction protocol if conservative
fields become central.

## Shared Intermediates

The current stage-local `let` form does real work. Weather's surface cycle, for
example, computes `evaporation` once and uses it in the water budget, vapor
budget, and temperature cooling term. If the new design decomposes that stage
into contributors, the shared intermediate must remain shared.

The replacement surface needs shared scratch values, but `let start` is probably
the wrong answer. A better candidate is an ordinary derived field with a
visibility flag: a normal field-derived value in the dependency graph, hidden
from ordinary views/stamps unless explicitly exposed.

```dsl
derived surfaceWarm: f32 hidden = clamp((T + 0.4) / 1.6, 0, 1)
derived evaporation: f32 hidden =
  evap * clamp(water, 0, 1) * (0.16 + 0.52 * surfaceWarm) * (1 - 0.58 * land)

tick {
  update evaporation contributes water, vapor, T after clouds {
    add water = -evaporation * dt * rate
    add vapor =  evaporation * 0.22 * dt * rate
    add T     = -evaporation * 0.22 * dt * rate
  }
}
```

Inside an `update`, ordinary `let` remains local to that update and reads the
group input snapshot. Use update-local lets for coupled pipelines such as
`clouds`, where `warm -> saturation -> excess -> cloudNow -> rainNow` is one
coherent computation that should commit together.

Semantics:

- hidden derived fields are in the dependency graph like ordinary derived fields
- they may read mutable fields and update when their dependencies require it
- they are not shown in normal view/stamp/source pickers unless explicitly
  exposed
- if a scratch value needs to be viewed, stamped, persisted, or reduced as a
  metric, it should be an ordinary `derived` field instead

This keeps the language from growing a fourth scratch phase just to avoid
tooling clutter. `hidden` is a visibility attribute, not a new evaluation mode.
If a port genuinely needs a start-of-tick value decoupled from later
dependencies, that should be stated as a scheduling need, not hidden in a
special `let` spelling.

### Additive Contributors

The conservative default should reject independent groups that write the same
field. That is safe, but too restrictive for ordinary source/sink terms:

```dsl
update emit {
  add pollutant = factory * emission * dt
}

update decay {
  add pollutant = -decay * pollutant * dt
}
```

These are conceptually separate contributions to `pollutant`, but a strict
write/write conflict would force authors to fuse them or add artificial order.

By contrast, a regular update may `add` to a field while also writing other
fields. It is not a contributor because it has non-additive outputs:

```dsl
update clouds {
  add vapor = -rainNow * dt
  write cloud = cloudNow
  write rain = rainNow
}
```

That can coexist with later `contributes vapor` groups only through ordinary
scheduling: `clouds` commits first, then the later contributors read the
post-clouds snapshot and sum their deltas. `contributes` is for groups whose
writes are purely additive for the declared fields.

Proposed opt-in:

```dsl
update emit contributes pollutant {
  add pollutant = factory * emission * dt
}

update decay contributes pollutant {
  add pollutant = -decay * pollutant * dt
}
```

`contributes pollutant` means:

- the group may only `add` to `pollutant`, not `write`/`multiply`/`clamp` it
- the addend is computed from the group's input snapshot
- multiple contributors can run in parallel and have their deltas summed
- projection / field constraints run after the contribution sum commits

The projection point matters. If `pollutant` is `nonnegative`, contributors are
summed first and the final committed value is projected once:

```text
pollutant_next = project(pollutant_snapshot + sum(contributor_deltas))
```

The compiler should not project per-contributor intermediate values. Per-
contributor projection would make the result order-dependent and would break the
commutative reason `contributes` exists.

Contributor expressions that read the contributed field read the input snapshot,
not a partially accumulated value. "Input snapshot" means the latest committed
value after all upstream dependencies have run, before any same-depth
contributors to that field are applied. For example, decay reads pre-commit
`pollutant`, even if another parallel contributor is also adding pollutant:

```dsl
update decay contributes pollutant {
  add pollutant = -decay * pollutant * dt
}
```

If a contributor reads a field written by an upstream group, it sees the
upstream committed value. If it reads a field being contributed by another
parallel contributor, it sees the pre-contribution value. This is what makes
parallel contributor sums deterministic.

Contributors reading their contributed field are normal, not an edge case.
Decay, saturation, density-dependent mortality, and Michaelis-Menten source/sink
terms all do this:

```dsl
add pollutant = -decay * pollutant * dt
add biomass = -crowding * biomass * biomass * dt
add nutrient = -uptake * nutrient / (nutrient + K) * dt
```

The compiler should document the snapshot rule in hover/help and schedule
explanations, but it should not warn merely because the contributed field is
read. A lint is only useful when the expression appears to rely on sequencing
that contributors deliberately do not provide.

This model is for explicit additive integration. It is appropriate for terms
like emission, decay, rainfall, evaporation, and radiative cooling where all
deltas are computed from the same committed snapshot and summed once. Stiff,
implicit, or semi-implicit schemes that need to observe partially updated state
belong in one coupled `update` group, not in parallel contributors.

First implementation should likely allow scalar contributors only. Vector
contributors are algebraically additive, but vector field constraints such as
`maxLength` are nonlinear and need a stricter rule: vector contributions are
safe only when projection happens after the summed vector and authors understand
that the projected result may not equal any individual contribution direction.

This gives authors a principled way to express commutative source/sink terms
without making all `add` groups magically accumulatable.

An update may contribute to multiple scalar fields if every write is additive:

```dsl
update evaporation contributes water, vapor, T {
  add water = -evaporation * dt
  add vapor =  evaporation * dt
  add T     = -cooling * dt
}
```

Each contributed field has its own summed delta and projection.

### Field Constraints

Field declarations should be the primary place for invariants:

```dsl
field water: f32 range 0..1.4
field biomass: f32 nonnegative
field heading: vec2 maxLength 1
```

Declaration-site constraints mean "this field should never commit outside this
invariant." The compiler/runtime may enforce the invariant after every group
that writes the field, or fuse the projection into the writer when safe.

Update-site projection remains useful, but has narrower meaning:

```dsl
clamp water to 0..1.4
```

Inside a group, this means "clamp this group's pending value before commit."
Authors should rarely need update-site clamps when a declaration-site invariant
exists.

### Flux Guarantees

`flux` earns its place only if it provides a semantic guarantee, not just a
nicer spelling for edge code.

```dsl
flux water to n in neighbors {
  amount water * max(height - height@n, 0) * runoff * dt
}
```

Proposed semantics:

- `amount` is a nonnegative directed transfer from the current cell to `n`
- negative amounts are rejected or clamped to zero; first-pass should reject
  them statically when provable and clamp at runtime defensively
- total outgoing transfer is scaled so a cell cannot send more than it has
- receiver cells gain exactly what donor cells lose, except for explicitly
  declared overflow/sink policies
- the compiler rejects flux shapes it cannot lower through the conservative
  edge-flux path

Reverse flow should be expressed by changing the directed condition, not by
returning a negative amount.

Flux and local contributors compose through the field transaction rule above,
not by independent same-field groups:

```dsl
update waterCycle {
  add water = rain * dt

  flux water to n in neighbors { amount ... }
}
```

The transaction computes the local `add water` delta and the edge flux from the
same input snapshot, then commits one projected next value for `water`.

If local contributors and flux live in different update groups, normal
scheduling applies. A flux group that runs after contributor groups reads the
contributors' committed result. A flux group at the same depth as contributors
to the same field is a conflict unless the compiler can merge them into one
field transaction. V1 should require the explicit single-transaction form for
source-plus-flux composition.

Example: runoff erosion.

```dsl
field height: f32 range 0..1.5
field water: f32 range 0..1.4
derived slope: f32
derived flow: f32

tick {
  update waterCycle {
    let slopeMag = length(gradient(height))
    let rainBands = 0.55 + 0.45 * max(0, cos(lat * 2 + frame * 0.003))

    add water = (rain * rainBands - evap * water) * dt * rate
    write slope = (slopeMag * 2.0) / (1 + slopeMag * 2.0)
    write flow = (water * slopeMag * 2.4) / (1 + water * slopeMag * 2.4)

    flux water to n in neighbors {
      let drop = max((height + water * 0.15) - (height@n + water@n * 0.15), 0)
      amount water * clamp(drop * runoff * dt * rate, 0, 0.12)
    }
  }

  update erosion after waterCycle {
    let cut = erode * water * slope
    let smoothing = mean n in neighbors { height@n } - height
    let tectonic = uplift * (0.55 + 0.45 * cellNoise(2, 1.5))

    add height = (tectonic + smoothing * 0.08 - cut) * dt * rate
  }
}
```

Why this is better than the current form:

- It says "rain, then runoff, then erosion" instead of "three GPU stages".
- `flux` becomes a conservative transport term, not a separate pass-shaped
  spelling.
- Bounds attach to fields or update actions instead of repeated clamp boilerplate.

## Enum Update Validation

Discrete state machines need stricter validation, but they probably do not need
a separate top-level `transition` keyword. The compiler can infer or accept a
validation mode for an `update` whose primary writes target enum/bool state
fields. The execution model is still update-group semantics: one stable
snapshot, one simultaneous commit.

Example: Drossel-Schwabl forest fire.

```dsl
field state: u32 enum {
  empty = 0
  tree = 1
  burning = 2
}

derived stateNorm: f32
derived isBurning: u32
derived isTree: u32
derived isEmpty: u32

tick {
  update burnCycle mode enum {
    let burnNbrs = count n in neighbors where state@n == burning
    let strike = rand01(frame) < F_LIGHTNING
    let sprout = rand01(frame * 31 + 7) < P_GROWTH

    write state =
      state == burning ? empty :
      state == tree && (burnNbrs > 0 || strike) ? burning :
      state == empty && sprout ? tree :
      state
  }

  derive diagnostics {
    write stateNorm = state / 2
    write isBurning = state == burning ? 1 : 0
    write isTree = state == tree ? 1 : 0
    write isEmpty = state == empty ? 1 : 0
  }
}
```

Why this validation mode is useful:

- `dt` is usually irrelevant. One tick is one rule application.
- Valid states matter. `state = 3` should be invalid unless the enum permits it.
- The compiler can warn about missing enum cases or unreachable cases.
- Additive writes to the main state are suspicious and can be rejected or warned.
- Synchronous snapshot semantics are central: a newly burning cell should not
  ignite its neighbor in the same update unless the author explicitly asks
  for a cascade/relaxation form.

GPU lowering is still simple:

```text
for each cell in parallel:
  read old state
  read old neighbor states
  compute next state
  write output state
swap
```

This is one of the most GPU-friendly forms in the DSL.

Suggested static checks for enum-mode updates:

- primary targets should be enum-like `u32` / `bool` state fields
- an enum-mode update may write multiple discrete fields, such as `state` and
  `age`
- each enum-updated field gets at most one `write field = expr`
- no `add`, `multiply`, `diffuse`, or `flux` on enum-updated fields
- `dt` is not in scope unless explicitly imported/allowed
- written enum values must be valid declared cases
- optional lint: each enum case is handled or deliberately falls through

## Coupled Updates

Some processes write multiple fields at once and must share one pre-update
snapshot. Predator-prey predation is the canonical example.

```dsl
field N: f32 range 0..3
field P: f32 range 0..3

tick {
  update diffuse {
    diffuse N by Dn * 0.18
    diffuse P by Dp * 0.18
  }

  update predation after diffuse {
    let response = a * N * P / (N + hSat + 0.000001)

    add N = (r * N * (1 - N / Kcap) - response) * dt * rate
    add P = (eEff * response - m * P) * dt * rate
  }
}
```

Inside `predation`, both writes read the same pre-predation `N` and `P`.
`P` does not see already-reduced `N`, and `N` does not see already-increased
`P`.

This preserves the current "stage snapshot" property but makes it explicit as
the meaning of an update group.

Lowering may use one pass or many passes. The semantic boundary is the group
commit, not the physical pass count. A multi-output update can lower to:

- one multi-output compute pass, if the runtime supports it
- several field-specific passes that all read the same group input snapshot
- a mixture of cell and edge passes with delayed commits

No pass inside the group may observe another pass's writes from the same group.
All writes become visible together when the group commits.

## Derived Fields

Derived fields can be expressed as normal updates that only write derived
targets, or as sugar:

```dsl
derive plume {
  write plume = pollutant * 0.95 + mean n in disk(3) { pollutant@n } * 1.55
}
```

Possible lowering: `derive x { ... }` is an `update` with stricter validation:

- may write only derived fields
- should not mutate state fields
- can be scheduled whenever dependencies are ready

Avoid adding `after` to derive examples unless the order is genuinely not
inferable from data dependencies. If `derive plume` reads `pollutant` and
`transport` writes `pollutant`, the graph already places `derive plume` after
`transport`. Defensive `after` annotations teach authors not to trust the
scheduler.

Metrics can remain as their current top-level declarations. They are pure reads
from the post-tick state unless a later design needs phase-specific metrics. In
the pipeline graph, metric reductions can appear as read-only consumers of the
fields they reference.

Time-only or coordinate-only derives still run once per tick. If a derive reads
only `frame`, coordinates, constants, params, or sources, it has no upstream
field dependency, but any update that reads its output depends on it. Within a
tick, the derived value is memoized like any other committed field value.

## Ordering and Scheduling

Lexical order should remain readable, but not be the only scheduling source.
The compiler has complete dependency knowledge from the AST.

Example:

```dsl
tick {
  update wind {
    write wind = normalize(...)
  }

  update emit {
    add pollutant = factory * emission * dt
  }

  update transport {
    flux pollutant to n in neighbors {
      amount pollutant * max(dot(wind, direction(n)), 0)
    }
  }

  update display {
    write plume = pollutant + mean n in disk(3) { pollutant@n }
  }
}
```

The compiler derives:

```text
wind:      writes wind
emit:      reads factory, pollutant; writes pollutant
transport: reads pollutant, wind; writes pollutant
display:   reads pollutant; writes plume
```

Safe schedule:

```text
parallel: wind, emit
then:     transport
then:     display
```

This is a correctness feature only if the schedule is visible. A scheduling
error in the inferred model is harder to notice than in v2, where source order
is the schedule. The pipeline graph must therefore be treated as part of the
language experience: authors need to see inferred data edges, explicit order
edges, parallel groups, and conflicts while editing, not after a runtime bug.

The compiler should also lint redundant explicit order. If `update wind` writes
`wind` and `update transport` reads `wind`, `transport after wind` is redundant
and should be flagged as defensive ordering. Otherwise `after` will become
cargo-cult syntax and the inferred scheduler will lose the clarity it was meant
to provide.

Hidden derived fields participate in the same graph. If `evaporation` reads
`water` and `T`, every update that reads `evaporation` depends on the derived
field's scheduled value; it does not depend on any same-depth contributor's
partial result.

This schedule should not live in a separate reporting system. It should project
into Field Lab's existing pipeline graph:

- author-facing update groups appear as graph nodes
- inferred data edges and explicit `after` / `before` edges are visually
  distinguishable
- parallelizable groups share depth / columns
- each update node can expand to show lowering details such as `cell pass`,
  `edge flux compute/apply`, `kernel table`, or `metric reduce`

Explicit order remains necessary for:

- same-field write conflicts
- intentional numerical sequencing
- display/diagnostic timing
- processes that are independent in dataflow but conceptually ordered

Proposed syntax:

```dsl
update transport after wind, emit {
  ...
}

update display after transport {
  ...
}
```

## Conflict Rules

Suggested first-pass rules:

1. Two groups that write the same field conflict unless explicitly ordered.
2. Two `contributes FIELD` groups may run in parallel; their deltas are summed
   before projection.
3. A regular update that adds to `FIELD` does not compose in parallel with
   `contributes FIELD` groups. It must be ordered relative to them, and its
   `add` is treated as a normal write under the field transaction rule.
4. Multiple writes to the same field inside one group are allowed only through
   a defined field transaction: pending-value lexical composition, additive
   contribution, conservative flux, and final projection.
5. `clamp` / projection actions run after all writes to that field inside the
   group.
6. Field-level constraints run after each group that writes that field, unless
   the compiler can prove a fused equivalent.
7. `reads` / `writes` may remain as optional assertions on update groups. If
   present, they must match the compiler-derived dependency set.

Assertion errors should distinguish two cases:

- asserted reads/writes omit a derived dependency: the author misunderstood or
  changed the body without updating the assertion
- asserted reads/writes include unused dependencies: the assertion is stale or
  intentionally guarding an interface that the body no longer satisfies

In both cases, the compiler-derived set is authoritative.

## Built-In Process Terms

Terms such as `diffuse` must not hide numerical choices forever. First-pass
spelling should be explicit:

```dsl
diffuse T by k using neighborMean
```

V1 default lowering:

```text
diffuse FIELD by k using neighborMean
==
add FIELD = (mean n in neighbors { FIELD@n } - FIELD) * clamp(k * dt * rate, 0, 0.24)
```

`neighborMean` is the only supported stencil in v1. The surface should leave
room for future forms such as metric-kernel diffusion or anisotropic diffusion
without changing the meaning of the default.

The coefficient expression must be allowed to vary per cell:

```dsl
diffuse water by diffusion * (1 - 0.6 * land) using neighborMean
```

Weather's land/ocean mixing needs this: water mixes less over land, while vapor
and temperature use a different coefficient.

`diffuse FIELD ...` counts as both a read and a write of `FIELD` for scheduling.
Vector diffusion, if allowed in v1, should be per-component `neighborMean` with
any vector constraint such as `maxLength` projected after the update commits.

## GPU Lowering

This proposal is not asking for a less GPU-shaped runtime. It is asking for a
more semantic authoring layer that lowers to the same known patterns.

Likely lowerings:

- `update` with only cell writes -> one or more cell compute passes
- `update` with multiple field writes -> multi-output pass if supported, or
  separate passes with delayed swaps
- `contributes` groups -> one delta pass per contributor group plus one combine
  / projection pass per contributed field in v1; fusing contributors with the
  same dependency set is a later optimization
- `flux` term -> existing two-pass edge-flux compute/apply lowering
- `diffuse` term -> neighbor reduction cell pass or future optimized stencil
- enum-mode update -> gather-style cell pass over old state buffer
- `derive` -> cell pass
- `metric` -> existing reduction passes

Initial restrictions should stay GPU-safe:

- enum-mode updates are gather-style: read neighbors, write self
- no arbitrary scatter writes
- no unbounded loops
- cascades/avalanches require an explicit bounded relaxation construct
- atomics are not part of the first design

## Bounded Relaxation / Cascades

Some systems are not single synchronous updates. Sandpiles, settling, and
some avalanche models want "repeat this local rule until stable or until a
budget is exhausted."

Do not hide that inside enum update validation. It should be explicit:

```dsl
relax settle max_iters 32 until stable {
  update topple mode enum {
    let willTopple = h >= THRESHOLD
    let incoming = sum n in neighbors { h@n >= THRESHOLD ? 1 : 0 }

    write h = max(0, h + incoming - (willTopple ? THRESHOLD : 0))
    write toppled = willTopple ? 1 : 0
    stable when all cells { toppled == 0 }
  }
}
```

This would lower to repeated dispatches with a small reduction/flag that tells
the CPU or GPU scheduler whether another iteration is needed. It is intentionally
not part of the minimal first implementation, but the surface shape should be
reserved so enum update semantics do not get stretched to mean "run to fixed
point."

Two semantics must be fixed before implementing `relax`:

- `stable when ...` is a global condition over cells, not a per-cell exit.
  Sandpile-style relaxation continues while any cell toppled.
- Each relaxation iteration reads the committed result of the previous
  iteration. This is different from a normal tick group, which reads one
  start-of-group snapshot and commits once.

This makes `relax` a bounded iterative scheduler feature, not just another
single-pass enum update. Put differently, snapshot semantics belong to the
enclosing scheduler scope. An enum-mode update in a normal `tick` reads its
group-start snapshot and commits once. An enum-mode update inside `relax` reads
the previous relax iteration's committed state because `relax` is the scheduler
scope. The enum validation rules stay the same; the execution cadence is
provided by the container.

First-pass `relax` should probably contain one update body. Multiple
bodies per relaxation loop, or relax-scoped lets that re-evaluate each
iteration, are plausible future extensions but should not be smuggled into the
initial semantics.

A relax loop resets each tick. It runs up to `max_iters` inside that tick, then
the next tick starts a fresh relaxation loop. Internal derived fields read by a
relax body keep their scheduled meaning outside the loop; they are not
re-evaluated after each relax iteration unless the relax surface explicitly adds
relax-scoped derived values later.

## Reads / Writes Position

Do not introduce an embedded raw-stage escape hatch. A nested `raw_stage` would
make the language split-brained: some blocks would derive dependency knowledge
from the AST, while other blocks would go back to hand-authored pass contracts.
That undermines the unification this proposal is trying to test.

The design should pick one authoring stance:

1. **Primary stance:** update bodies derive reads and writes
   from their AST.
2. **Optional assertions:** `reads` / `writes` may appear on an update only as
   assertions checked against the derived set.
3. **No mixed escape hatch:** there is no `raw_stage` nested inside an update.

If the semantic forms are not expressive enough for a recipe, that is evidence
the proposal is incomplete. The answer should be to add a principled process
term, improve the expression language, or declare the replacement not ready.
Do not mix both models inside the same recipe surface.

This also rules out permanent per-recipe coexistence as the migration strategy.
The new form is a replacement for the authoring surface or it is not finished.
The current v2 stage form can remain as compiler IR during migration, but it
should have a finite deprecation horizon as an authored recipe language. If a
recipe cannot be ported, that blocks removing v2 authoring and produces a
missing-primitive proposal; it is not permission to keep both surfaces forever.

## Current Evidence-Based Recommendation

The conversion evidence does not currently justify replacing the authored stage
surface. It supports an incremental v2 path first:

1. Add enum fields and enum update validation.
2. Add declaration-site field constraints.
3. Add `rand01(seed)` and `count n in neighbors where PRED`.
4. Specify conservative field budgets/transactions separately, with field-level
   allocation and overflow policy.

The larger `tick { update ... }` replacement should remain speculative until
full weather/runoff/pollution ports prove that inferred update groups improve
transaction-heavy recipes enough to outweigh the cost of subtler scheduling.
If the additive v2 path captures most of the benefit, replacement should be
shelved rather than carried forward by inertia.

## Porting Methodology

Every recipe that resists the incremental path is data. The process should be:

1. Try the recipe under current v2 plus additive enum validation, constraints,
   RNG/count helpers, and any conservative budget primitive being evaluated.
2. Compare that result against the replacement semantic form, not against
   current v2 alone.
3. If the replacement form is not materially clearer or safer, prefer the
   additive path.
4. If neither path handles the recipe cleanly, identify the missing principled
   process term, expression feature, or scheduling rule.
5. Resolve that missing piece or declare the replacement design unfinished.

There is no third bucket named "use raw v2 stage here."

## Port Evidence

Before implementation, this proposal should be judged against real recipes. The
examples below are not exact migrations; they are pressure tests showing whether
the proposed surface captures the model better than the current stage surface.

### Predator-Prey

Current form:

```dsl
step {
  stage diffuseFields {
    reads N, P
    writes N, P
    cell {
      add N = (mean n in neighbors { N@n } - N) * clamp(Dn * 0.18 * dt * rate, 0, 0.24)
      add P = (mean n in neighbors { P@n } - P) * clamp(Dp * 0.18 * dt * rate, 0, 0.24)
    }
  }

  stage react {
    reads N, P
    writes N, P
    cell {
      let response = a * N * P / (N + hSat + 0.000001)
      add N = (r * N * (1 - N / Kcap) - response) * dt * rate
      add P = (eEff * response - m * P) * dt * rate
    }
  }

  stage clampPositive {
    reads N, P
    writes N, P
    cell {
      set N = clamp(N, 0, 3)
      set P = clamp(P, 0, 3)
    }
  }
}
```

Proposed form:

```dsl
field N: f32 range 0..3
field P: f32 range 0..3

tick {
  update spatialSpread {
    diffuse N by Dn * 0.18 using neighborMean
    diffuse P by Dp * 0.18 using neighborMean
  }

  update rosenzweigMacArthur after spatialSpread {
    let response = a * N * P / (N + hSat + 0.000001)

    add N = (r * N * (1 - N / Kcap) - response) * dt * rate
    add P = (eEff * response - m * P) * dt * rate
  }
}
```

What improves:

- the range invariant replaces a whole clamp stage
- the coupled reaction reads one shared snapshot, as today
- the recipe names model terms instead of pass machinery

What does not improve much:

- line count is roughly similar
- the value is clarity and invariant placement, not brevity

This may be the ceiling for small reaction-diffusion recipes: they already map
closely to one or two cell updates. If that is true, accept it explicitly rather
than inventing a recipe-shaped primitive just to save lines. If broader ports
show the same lukewarm result, the proposal is not earning replacement status.

### Forest Fire

Current form:

```dsl
field state: u32

step {
  stage transition {
    reads state
    writes state
    cell {
      let burnNbrs = sum n in neighbors { (state@n >= 2) ? 1 : 0 }
      let strike = (cellRand(frame) * 0.5 + 0.5) < F_LIGHTNING
      let sprout = (cellRand(frame * 31 + 7) * 0.5 + 0.5) < P_GROWTH

      let treeIgnites = state == 1 && (burnNbrs > 0 || strike)
      let emptySprouts = state == 0 && sprout
      let next1 = state >= 2 ? 0 : state
      let next2 = treeIgnites ? 2 : next1
      let next3 = emptySprouts ? 1 : next2
      set state = next3
    }
  }
}
```

Proposed form:

```dsl
field state: u32 enum {
  empty = 0
  tree = 1
  burning = 2
}

tick {
  update burnCycle mode enum {
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

What improves:

- enum cases replace magic numbers
- enum update validation matches the discrete CA mental model
- no `reads` / `writes` boilerplate
- `dt` is not in scope, so the author cannot accidentally half-continuize the
  CA rule

This is the clearest win.

### Weather Cycle

Weather is the load-bearing test because it has many stages and real ordering.
The sketch below is intentionally closer to the actual current recipe than the
earlier simplified port: the real recipe has shared intermediate values,
per-field diffusion coefficients, and several temperature terms that should not
be collapsed into one vague line.

Current shape:

```dsl
step {
  stage tideForcing { ... set tide = ... }
  stage windStep { ... set wind = ... }
  stage advectVapor { ... set vapor = vapor@upstream(...) }
  stage cloudsAndRain { ... set cloud = ...; set rain = ...; add vapor = ... }
  stage surfaceCycle { ... set water = ...; add vapor = ...; set T = ... }
  stage mix { ... add water = ...; add vapor = ...; add T = ... }
}
```

Proposed shape:

```dsl
field water: f32 range 0..1.2
field vapor: f32 range 0..2.5
field T: f32 range -0.9..1.4
field wind: vec2
derived cloud: f32 range 0..1
derived rain: f32 range 0..2
derived tide: f32
derived speed: f32
derived lift: f32
derived surfaceWarm: f32 hidden = clamp((T + 0.4) / 1.6, 0, 1)
derived surfaceWet: f32 hidden = clamp(water, 0, 1)
derived evaporation: f32 hidden =
  evap * surfaceWet * (0.16 + 0.52 * surfaceWarm) * (1 - 0.58 * land)

tick {
  derive tide {
    write tide = tideAmp * (1 - land) * sin(lon * 2 - frame / tidePeriod) * cos(lat)
  }

  update wind {
    let pressureGrad = gradient(water + tide)
    let thermalGrad = gradient(T)
    let f = rotation * sin(lat)
    let coriolis = vec2(f * wind.y, -f * wind.x)
    let accel = pressureGrad * -windDrive + thermalGrad * thermal + coriolis
    let damp = clamp(friction * dt * rate, 0, 0.35)
    let nextWind = (wind + accel * dt * rate) * (1 - damp)

    write wind = nextWind
    write speed = length(nextWind)
  }

  update advectVapor {
    let p = upstream(wind * flowScale, dt * rate)
    write vapor = vapor@p
  }

  update clouds {
    let warm = clamp((T + 0.6) / 1.8, 0, 1)
    let stormLift = land * 0.05 + clamp(length(gradient(land)) * length(wind) * 0.035, 0, 0.18)
    let saturation = 0.20 + 0.20 * warm + land * 0.05
    let cloudNow = max(vapor + stormLift - saturation, 0) * condense
    let rainNow = cloudNow * rainRate * 0.16

    write cloud = cloudNow
    write rain = rainNow
    write lift = stormLift * 4
  }

  update rainfall contributes water, vapor, T {
    add water = rain * 0.16 * dt * rate
    add vapor = -rain * 0.18 * dt * rate
    add T = -rain * 0.08 * dt * rate
  }

  update evaporation contributes water, vapor, T after clouds {
    add water = -evaporation * dt * rate
    add vapor = evaporation * 0.22 * dt * rate
    add T = -evaporation * 0.22 * dt * rate
  }

  update runoff contributes water after clouds {
    add water = -land * max(water - 0.8, 0) * 0.65 * dt * rate
  }

  update oceanRestore contributes water, T after clouds {
    let ocean = 1 - land

    add water = ocean * (1 - water) * 0.95 * dt * rate
    add T = ocean * (0.15 - T) * 0.25 * dt * rate
  }

  update radiation contributes T {
    let insolation = sun * max(0, cos(lat)) * (1 - 0.18 * rain)
    let cooling = 0.78 * (T + 0.15)
    let landHeat = land * (0.08 * max(0, cos(lat)) - 0.08 * water)

    add T = (insolation - cooling + landHeat) * dt * rate
  }

  update mix {
    diffuse water by diffusion * (1 - 0.6 * land) using neighborMean
    diffuse vapor by diffusion using neighborMean
    diffuse T by diffusion using neighborMean
  }
}
```

What improves:

- the causal order is visible at the process level
- field ranges remove much of the repeated clamp noise
- tide/cloud/rain/lift read as derived phenomena rather than ad hoc stages
- hidden derived values for `surfaceWarm`, `surfaceWet`, and `evaporation` let
  multiple contributor budgets share one computed value without adding viewable
  fields
- rainfall, evaporation, runoff, ocean restoration, and radiation decompose into
  separate contributors instead of one mixed surface block
- `mix` does not need defensive `after` annotations: it reads water/vapor/T, so
  the graph places it after the contributors automatically
- the pipeline graph can show author-facing groups while still expanding to
  the actual compute passes

T's journey in this sketch:

1. `clouds` commits `rain`; it does not write `T`.
2. `rainfall`, `evaporation`, `oceanRestore`, and `radiation` all contribute to
   `T` from the same post-clouds/pre-contributor `T` snapshot.
3. `radiation` reads post-clouds `rain`, because `clouds` is upstream.
4. None of the contributors sees another contributor's partial `T` result.
5. Their deltas are summed, then `T`'s `range -0.9..1.4` projection applies
   once.
6. `mix` reads the committed post-contributor `T`, `water`, and `vapor` by
   data dependency, without explicit `after`.

What still hurts:

- weather remains large because the model is large
- `clouds` is still correctly coarse-grained: its internal pipeline shares
  intermediates across vapor/cloud/rain/lift outputs, and forcing it into
  contributors would make the model worse
- the schedule is now richer and must be visualized well
- the exact `contributes` lowering is load-bearing, not optional future work
- a full port against the actual recipe should still be written and counted
  before implementation; this sketch is evidence of shape, not proof

Implementation should not begin until at least these three ports are written as
real side-by-sides and reviewed.

## Actual Recipe Conversion Pass

This pass converts several current recipes under the proposed semantics without
trying to make them compile. The goal is to see where the surface carries real
weight and where it merely renames v2 stages.

### Drossel-Schwabl Forest Fire

Current shape: one numeric-looking `stage transition` plus one diagnostics
stage. The proposed surface is a clear win because the model really is a
discrete state update.

```dsl
field state: u32 enum {
  empty = 0
  tree = 1
  burning = 2
}

derived stateNorm: f32
derived isBurning: u32
derived isTree: u32
derived isEmpty: u32

tick {
  update burnCycle mode enum {
    let burnNbrs = count n in neighbors where state@n >= burning
    let strike = rand01(frame) < F_LIGHTNING
    let sprout = rand01(frame * 31 + 7) < P_GROWTH

    write state =
      state >= burning ? empty :
      state == tree && (burnNbrs > 0 || strike) ? burning :
      state == empty && sprout ? tree :
      state
  }

  derive diagnostics {
    write stateNorm = state * 0.5
    write isBurning = state >= burning ? 1 : 0
    write isTree = state == tree ? 1 : 0
    write isEmpty = state == empty ? 1 : 0
  }
}
```

Difficulty: easy. This is the strongest evidence for enum update validation,
enum fields, `rand01`, and `count ... where`. It is not strong evidence that
the whole stage surface must be replaced, because most of the win could be
added to v2.

### Predator-Prey

Current shape: diffuse both fields, then react, then clamp both fields.
Declaration-site constraints remove clamp boilerplate, but the process remains
an ordered explicit integrator.

```dsl
field N: f32 range 0..3
field P: f32 range 0..3

tick {
  update spatialSpread {
    diffuse N by Dn * 0.18 using neighborMean
    diffuse P by Dp * 0.18 using neighborMean
  }

  update reaction after spatialSpread {
    let response = a * N * P / (N + hSat + 0.000001)
    let preyDot = r * N * (1 - N / Kcap) - response
    let predDot = eEff * response - m * P

    add N = preyDot * dt * rate
    add P = predDot * dt * rate
  }
}
```

Difficulty: easy, but the result is only modestly better. The explicit `after`
is numerical intent: this preserves today's diffuse-then-react splitting. If
many reaction-diffusion recipes look like this, the replacement case should not
lean on them.

### Downwind Pollution

Current shape: derive wind, emit pollutant, edge-flux transport, decay/display.
This is a better stress test because source, sink, conservative flux, and
derived display all touch the same field family.

```dsl
source factory: f32

field pollutant: f32 range 0..2.2
derived wind: vec2
derived windSpeed: f32
derived plume: f32

tick {
  derive windField {
    let jet = 0.62 + 0.30 * cos(lat * 2.5)
    let meander = 0.20 * sin(lon * 1.4 + frame / 420) + 0.08 * sin(lat * 5.0 + frame / 300)
    let sourceLift = 0.08 * factory * sin(lon * 2.0 + lat)
    let raw = vec2(jet, meander - 0.12 * sin(lat * 2.0) + sourceLift)
    let speed = max(length(raw), 0.001)

    write wind = raw / speed
    write windSpeed = speed
  }

  update pollutionBudget {
    add pollutant = factory * emission * dt * rate
    add pollutant = -pollutant * decay * dt * rate

    flux pollutant to n in neighbors {
      let downwind = max(dot(wind, direction(n)), 0)
      let distWeight = clamp(0.050 / max(distance(n), 0.001), 0.55, 1.3)
      let push = crossMix + windBias * downwind
      amount pollutant * clamp(push * distWeight * transport * dt * rate, 0, 0.22)
    }
  }

  derive display {
    let halo = mean n in disk(3) { pollutant@n }
    write plume = pollutant * 0.95 + halo * 1.55 + factory * 0.12
  }
}
```

Difficulty: moderate, and the result is genuinely better if the field
transaction rule is sound. Emission, decay, and directional transport become
one `pollutionBudget` instead of three ordered stages. This is exactly the
class that justifies source/sink-plus-flux semantics. It also proves that the
transaction rule cannot stay informal.

### Shallow Water

Current shape: momentum, continuity, viscosity, dye advection, diagnostics.
This is a deliberately hard case because it is an ordered numerical method more
than a set of independent semantic processes.

```dsl
field h: f32
field m: vec2
field dye: f32
derived dh: f32
derived speed: f32
derived divM: f32

tick {
  update momentum {
    let grad = gradient(h)
    let pressure = vec2(-gravity * h * grad.x, -gravity * h * grad.y)
    let f = 2 * rotation * sin(lat)
    let coriolis = vec2(f * m.y, -f * m.x)

    add m = (pressure + coriolis - m * friction) * dt * rate
  }

  update continuity after momentum {
    add h = -divergence(m) * dt * rate
    clamp h to hMin..inf
  }

  update viscosity after continuity {
    diffuse h by viscosity using neighborMean
  }

  update advectDye {
    let invH = 1.0 / max(h, hMin)
    let p = upstream(vec2(m.x * invH, m.y * invH), dt * rate * flowScale)
    write dye = dye@p * (1 - dyeFade * dt * rate)
  }

  derive diagnostics {
    write dh = h - 1
    write speed = length(m)
    write divM = divergence(m)
  }
}
```

Difficulty: medium, but the result is mostly a clearer spelling of the existing
pipeline, not a conceptual compression. The explicit `after` edges are real
numerical choices. This recipe argues for keeping the low-level lowering model
strong and for not claiming that update groups make every recipe simpler. It
also points at a separate missing feature: parameterized field constraints such
as `h >= hMin` are useful, but declaration-site constraints may need to accept
params before they can replace local clamps here.

### Conversion Readout

The semantics are not hard to apply, but the payoff is uneven:

- enum update validation is an obvious win for CA/state-machine recipes.
- field constraints are an obvious win almost everywhere.
- source/sink-plus-flux transactions are promising and directly improve
  downwind pollution-style recipes.
- ordinary reaction-diffusion is a wash.
- ordered PDE solvers still read like ordered PDE solvers, which is correct.

This weakens the argument for a wholesale replacement and strengthens a more
conditional plan: add enum validation/constraints if they prove useful
independently, and only replace the stage surface if transaction-heavy recipes
like weather, runoff, and pollution show enough improvement to justify it.

## Structural Alternative: Field-Centric Protocols

The proposal above makes update groups primary. That is not the only plausible
unification.

A field-centric design would declare each field's legal update protocols at the
declaration site, then let tick events feed those protocols:

```dsl
field water: f32 range 0..1.4 {
  contributors: rainfall, evaporation, oceanRestore
  flux: runoff
  diffuse: surfaceMix
}

tick {
  update rainfall { add water = rain * dt }
  update runoff {
    flux water to n in neighbors { amount ... }
  }
}
```

The attraction is real:

- field transactions become a property of `water`, not an emergent property of
  which update groups happen to touch it
- field constraints, projections, contributor summing, and flux composition sit
  in one place
- tooling can explain "how this field changes" directly from the declaration

The cost is also real:

- coupled multi-field updates such as predator/prey, cloud/rain/vapor, and
  wind/speed do not naturally belong to one field
- the field declaration can become a second scheduling language if it lists too
  many protocols
- authors may have to jump between field declarations and tick events to read
  one process

This alternative should be tested against the same three ports. If field-centric
protocols make weather/runoff clearer without making predator-prey and coupled
cloud updates worse, they may be a better foundation than update-groups as the
primary surface. The current proposal should not be treated as settled until it
beats this alternative on real recipes.

### Field-Centric Conversion Sketches

These are not polished syntax proposals. They test whether field-owned update
protocols explain the hard cases better than update-owned composition.

Forest fire mostly does not need field-centric protocols:

```dsl
field state: u32 enum {
  empty = 0
  tree = 1
  burning = 2
} mode enum

tick {
  update burnCycle {
    let burnNbrs = count n in neighbors where state@n >= burning
    let strike = rand01(frame) < F_LIGHTNING
    let sprout = rand01(frame * 31 + 7) < P_GROWTH

    write state =
      state >= burning ? empty :
      state == tree && (burnNbrs > 0 || strike) ? burning :
      state == empty && sprout ? tree :
      state
  }
}
```

Readout: field-centric adds little. Enum declaration plus enum-mode validation
is the whole win.

Predator-prey also does not gain much:

```dsl
field N: f32 range 0..3 {
  diffuse: spatialSpread
  coupled: reaction
}

field P: f32 range 0..3 {
  diffuse: spatialSpread
  coupled: reaction
}

tick {
  update spatialSpread {
    diffuse N by Dn * 0.18 using neighborMean
    diffuse P by Dp * 0.18 using neighborMean
  }

  update reaction after spatialSpread {
    let response = a * N * P / (N + hSat + 0.000001)
    add N = (r * N * (1 - N / Kcap) - response) * dt * rate
    add P = (eEff * response - m * P) * dt * rate
  }
}
```

Readout: the protocol lists duplicate what the update bodies already say. For
coupled multi-field dynamics, field-centric declarations risk becoming stale
contracts unless they are derived by the compiler.

Downwind pollution is where field-centric protocols are strongest:

```dsl
field pollutant: f32 nonnegative {
  transaction pollutionBudget {
    contributors: emission, decay
    flux: transport allocation proportional
  }
}

tick {
  derive windField { ... }

  update emission { add pollutant = factory * emission * dt * rate }
  update decay    { add pollutant = -pollutant * decay * dt * rate }

  update transport {
    flux pollutant to n in neighbors {
      let downwind = max(dot(wind, direction(n)), 0)
      amount pollutant * clamp((crossMix + windBias * downwind) * transport * dt * rate, 0, 0.22)
    }
  }
}
```

Readout: this directly answers the transaction problem. Allocation policy,
conservation policy, and projection policy live with `pollutant`, not scattered
across several update groups. The weakness is that the field declaration is now
part scheduler and part numerical contract.

Shallow water remains mostly an ordered method:

```dsl
field h: f32 nonnegative {
  coupled: continuity
  diffuse: viscosity
}

field m: vec2 {
  coupled: momentum
}

tick {
  update momentum { ... }
  update continuity after momentum { ... }
  update viscosity after continuity { ... }
  update advectDye { ... }
}
```

Readout: field-centric protocols do not clarify much here. The model is a
time-stepping scheme with real order constraints. The best improvement is still
field constraints plus derived diagnostics, not a new protocol surface.

Field-centric conclusion:

- It is better than update-groups for conservative field budgets.
- It is no better, and sometimes noisier, for coupled multi-field updates.
- It suggests a hybrid incremental path: field declarations own invariants and
  optional transaction protocols, while ordinary update bodies remain the main
  place where coupled physics is written.

## Why Replace The Stage Surface, If Proven

The argument for full replacement, if future ports support it:

1. Recipes become closer to the model:
   - weather: tide -> wind -> vapor advection -> rain -> surface cycle
   - erosion: rain -> runoff -> erosion
   - forest fire: discrete enum update, not numeric integration
   - wave: velocity update + displacement update
2. The compiler still has exact dependency knowledge and can schedule
   automatically.
3. `reads` / `writes` become derived facts instead of duplicated authoring
   burden.
4. Simultaneous multi-field updates are represented directly.
5. Continuous dynamics and discrete automata no longer pretend to be the same
   kind of thing.
6. Existing low-level stage/cell/edge concepts can remain as compiler IR during
   migration, but not as a permanent authoring escape hatch.

## Risks

- The port evidence may not justify replacement. If the clearest wins come from
  enum fields, field constraints, and enum update validation, those could be
  additive v2 improvements rather than a new authoring surface.
- `update` action ordering inside one group needs a precise spec.
- Same-field multi-writer composition is load-bearing; if field transactions are
  too weak, weather/runoff-style recipes will expose it immediately.
- hidden derived fields may become too invisible if tooling does not expose
  dependency and scheduling explanations clearly.
- enum update validation must stay a validation mode, not drift into a second
  execution model.
- Automatic scheduling must be explainable in the UI/debug graph.
- Migration must prove that common recipes are actually shorter or clearer, not
  merely renamed.

## Remaining Gates Before Implementation

Most of the earlier open questions are now decisions in this sketch:
enum update validation is a mode rather than a separate keyword, first-pass
contributors are scalar, shared field-dependent scratch is represented as hidden
derived fields, `diffuse` uses `neighborMean`, and missing recipe surface is
handled by proposing a principled primitive instead of falling back to raw
stages.

Before implementing the authoring surface, the remaining gates are:

1. Full side-by-side ports of predator-prey, forest fire, and the actual weather
   recipe, with a term-by-term conservation audit for weather. Each port should
   be compared against two baselines: current v2, and v2 plus additive enum /
   constraint / enum-validation improvements.
2. A small test matrix for field transactions: source-only, sink-only,
   source-plus-flux, sink-plus-flux, proportional outgoing scaling, and
   contributors reading their contributed field.
3. A field-centric protocol sketch for the same ports, so update-groups are not
   chosen by default without testing the main structural alternative.
4. A pipeline graph mock or prototype that shows several parallel contributors
   converging on one downstream update without turning into an unreadable graph.
5. A migration cutoff: before this ships as an authoring surface, every bundled
   recipe must either port cleanly or produce a missing-primitive proposal. If a
   bundled recipe still cannot port after two proposal iterations, the design is
   shelved or expanded; v2 stages may remain as compiler IR, but not as a
   second authored surface.
