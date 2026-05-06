# Downwind Pollution Budget Sketch

Status: exploratory, not implemented.

This is a direct pressure test of the `budget` idea against
`recipes/downwind-pollution.mjs`. This is the recipe where a field budget should
look best: one field is emitted by sources, moved by conservative edge flux,
decayed locally, projected, and then displayed.

## Current V2 Shape

```text
windField
  reads factory
  writes wind, windSpeed

emit
  reads pollutant, factory
  writes pollutant

transportStep
  reads pollutant, wind
  writes pollutant
  edge flux pollutant

decayAndDisplay
  reads pollutant, factory
  writes pollutant, plume
```

The model is simple, but the pollutant lifecycle is split across three stages:
emit, transport, decay.

## Budget Rewrite

```dsl
source factory: f32

field pollutant: f32
field wind: vec2 derived
field windSpeed: f32 derived
field plume: f32 derived

process windField on cells {
  let jet = 0.62 + 0.30 * cos(lat * 2.5)
  let meander = 0.20 * sin(lon * 1.4 + frame / 420)
              + 0.08 * sin(lat * 5.0 + frame / 300)
  let sourceLift = 0.08 * factory * sin(lon * 2.0 + lat)
  let raw = vec2(jet, meander - 0.12 * sin(lat * 2.0) + sourceLift)
  let speed = max(length(raw), 0.001)

  write wind = raw / speed
  write windSpeed = speed
}

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

derive plumeDisplay on cells {
  let halo = mean n in disk(3) { pollutant@n }
  write plume = pollutant * 0.95 + halo * 1.55 + factory * 0.12
}
```

## What Improves

- The recipe now says the real thing: pollutant has an emission source, a decay
  sink, a directed conservative transport term, and a projection.
- The emission/transport/decay ordering is no longer accidental. They are one
  field transaction.
- This is easier to audit for conservation:

  ```text
  next = project(snapshot + sources - sinks - outgoing + incoming)
  ```

- `plume` is cleanly separated as display, not mixed into the decay stage.

## What Must Be Specified

This rewrite only works if `budget` has airtight semantics:

1. Rates are per-time terms and the budget applies `dt * rate` once.
   Otherwise authors will keep double-multiplying or forgetting timestep
   factors.
2. Local sources/sinks and edge flux read the same budget snapshot.
3. Outgoing flux is donor-limited after local source/sink terms:

   ```text
   available = max(0, pollutant + dtRate * (sources - sinks))
   ```

4. Incoming flux uses neighbors' scaled outgoing amounts, not raw requests.
5. Projection happens once after incoming/outgoing flux is applied.
6. Upper projection bounds are non-conservative. First-pass budget should avoid
   finite upper caps; saturation should be authored as an explicit sink or as a
   later explicit non-conservative projection form.

## Comparison To Process-Only Form

Process-only sketch:

```dsl
process emit on cells { add pollutant = factory * emission * dt * rate }
process transport on edges(n) { flux pollutant to n = ... }
process decay on cells { add pollutant = -pollutant * decay * dt * rate }
```

That is barely better than v2. It preserves stage choreography and makes the
author choose a numerical order.

Budget sketch:

```dsl
budget pollutant {
  source factory * emission
  sink pollutant * decay
  flux to n in neighbors { amount ... }
  project nonnegative
}
```

That is a real abstraction. It is not shorter because of syntax tricks; it is
shorter because it matches the thing being modeled.

## Verdict

`budget` passes this recipe strongly. This is better evidence than
predator-prey or planet wind/moisture.

The implementation surface should probably start with exactly this restricted
form:

```dsl
stage pollutionBudget {
  reads ...
  writes pollutant

  budget pollutant {
    source ...
    sink ...
    flux to n in neighbors { amount ... }
    project to ...
  }
}
```

That keeps v2 ordering and compiler structure while adding one principled
field-transaction body. If this works well for `downwind-pollution` and
`runoff-erosion`, then broader rate/budget syntax becomes worth considering.
