# Process Style Sketches

Status: exploratory, not implemented.

This note pressure-tests a possible v3 framing:

```text
process = named model step
scope   = where/how it runs (`cells`, `edges`, `relax`)
effects = what it does to fields (`write`, `add`, `flux`, `project`)
```

The question is whether this is actually more unified than v2 stages, or just a
new spelling. These sketches are intentionally close to existing recipes rather
than idealized examples.

## Proposed Shape

```dsl
process NAME on cells {
  let ...
  add FIELD = ...
  write FIELD = ...
  project FIELD to LO..HI
}

process NAME on edges(n) {
  flux FIELD to n = AMOUNT
}

process NAME relax max_iters N stable when PRED {
  on cells {
    ...
  }
}
```

Observations:

- `on cells` and `on edges(n)` replace `cell {}` / `edge n in neighbors {}` as
  scopes, not separate conceptual worlds.
- `write`, `add`, `flux`, and `project` are field effects.
- `relax` is a scheduler wrapper: repeat its body, with committed state between
  iterations, until stable or budget exhausted.
- This is still close to v2. That is probably good. The goal would be a more
  regular surface, not a new language layered above v2.

## Planet Heat

Current recipe shape: one cell stage computes heat budget plus diagnostics,
then another cell stage diffuses temperature.

Process-style sketch:

```dsl
process climate on cells {
  let season = seasonal * sin(frame / 900)
  let sunAngle = max(0, cos(lat - season * 0.55))
  let frozen = clamp((-0.12 - T) * 3.4, 0, 1)
  let reflect = clamp(albedo + frozen * iceFeedback * (1 - albedo), 0, 0.92)
  let absorbed = sun * sunAngle * (1 - reflect)
  let inertia = 1 - ocean * oceanInertia * 0.74
  let solarGain = absorbed * 0.54
  let greenhouseGain = greenhouse * 0.10
  let outgoing = cooling * max(T + 0.48, 0) * (0.26 + max(T, 0) * 0.18)
  let oceanMemory = ocean * sun * oceanInertia * (0.06 + sunAngle * 0.14 - T) * 0.12
  let next = T + (solarGain + greenhouseGain + oceanMemory - outgoing) * inertia * dt * rate

  write T = next
  project T to -1.2..1.45

  let iceNext = clamp((-0.12 - T) * 3.4, 0, 1)
  write ice = iceNext
  write comfort = clamp(1 - abs(T - 0.18) * 1.65 - iceNext * 0.22 - albedo * 0.10, 0, 1)
}

process heatExchange on cells {
  let k = clamp(diffusion * (0.55 + ocean * 0.70) * dt * rate, 0, 0.22)
  add T = (mean n in neighbors { T@n } - T) * k
}
```

Readout:

- Mild win. `project T` makes the clamp timing explicit and less noisy.
- The scope/effect framing is coherent here: climate is a cell process,
  exchange is another cell process.
- `ice` and `comfort` are still awkward because they are diagnostic fields. This
  supports a visibility primitive (`derived` vs `hidden`), not a new scheduler.

## Planet Wind Moisture

Current recipe shape: derive wind, then advect moisture by upstream sampling.

Process-style sketch:

```dsl
process windField on cells {
  let t = frame / 260 * drift
  let raw = beltsAndEddies(lon, lat, t, moisture)
  let flow = raw * windSpeed

  write wind = flow
  write windFlow = flow * flowScale
}

process advectMoisture on cells {
  let p = upstream(windFlow, dt * rate)
  write moisture = moisture@p
  project moisture to 0..1.2
}
```

Readout:

- Mostly rename. The current v2 version already says this clearly.
- `project moisture` is nicer than inline clamp.
- The actual hard problem remains the wind model, not DSL structure.
- This argues against overselling v3 on planet recipes. The DSL has enough
  vocabulary to move moisture; we need better authored flow functions.

## Sandpile

Current recipe shape: drive, clear activity, bounded `relax` toppling, derive
visuals.

Process-style sketch:

```dsl
process drive on cells {
  let r = rand01(frame)
  add h = r < DROP_RATE ? 1 : 0
}

process clearActivity on cells {
  write toppled = 0
}

process settle relax max_iters 48 stable when toppled == 0 {
  on cells {
    let willTopple = h >= THRESHOLD
    let incoming = count n in neighbors where h@n >= THRESHOLD

    write h = max(0, h + incoming - (willTopple ? THRESHOLD : 0))
    add toppled = willTopple ? 1 : 0
  }
}

process display on cells {
  let localStress = h / THRESHOLD
  let nbrStress = mean n in neighbors { h@n / THRESHOLD }
  let nbrActivity = mean n in neighbors { toppled@n }

  write stress = clamp(localStress * 0.68 + nbrStress * 0.32, 0, 1.4)
  write activity = clamp((toppled + nbrActivity * 0.45) / 5.0, 0, 1)
}
```

Readout:

- Real win if `stable when` exists. The process form makes relaxation a
  scheduler scope instead of another stage-like block.
- `stable when toppled == 0` is much better than `until all cells`.
- `add toppled` inside relax raises a semantic question: does `toppled` mean
  "this iteration" or "accumulate across relaxation"? The current recipe
  accumulates across the loop. The DSL needs to make this explicit or reserve a
  loop-local scratch field.

## Forest Fire

Current recipe shape: one synchronous state update plus diagnostic projections.

Process-style sketch:

```dsl
field state: u32 enum { empty = 0, tree = 1, burning = 2 }

process burnCycle on cells mode enum {
  let burnNbrs = count n in neighbors where state@n == burning
  let strike = rand01(frame) < F_LIGHTNING
  let sprout = rand01(frame * 31 + 7) < P_GROWTH

  write state =
    state == burning ? empty :
    state == tree && (burnNbrs > 0 || strike) ? burning :
    state == empty && sprout ? tree :
    state
}

process diagnostics on cells {
  write stateNorm = state / burning
  write isBurning = state == burning ? 1 : 0
  write isTree = state == tree ? 1 : 0
  write isEmpty = state == empty ? 1 : 0
}
```

Readout:

- The win is enum/state validation, not `process`.
- `mode enum` as a validation mode fits the unified model: still a cell process,
  just stricter writes.
- This supports adding enum fields to v2 even if v3 never ships.

## Downwind Pollution

Current recipe shape: derive wind, emit pollutant, edge flux transport, decay
and derive plume.

Process-style sketch without a budget primitive:

```dsl
process windField on cells {
  write wind = ...
  write windSpeed = ...
}

process emit on cells {
  add pollutant = factory * emission * dt * rate
  project pollutant to 0..2.2
}

process transport on edges(n) {
  let downwind = max(dot(wind, direction(n)), 0)
  let push = crossMix + windBias * downwind
  flux pollutant to n = pollutant * clamp(push * transportRate * dt * rate, 0, 0.22)
}

process decayAndDisplay on cells {
  add pollutant = -pollutant * decay * dt * rate
  project pollutant to 0..2.2
  write plume = pollutant * 0.95 + mean n in disk(3) { pollutant@n } * 1.55 + factory * 0.12
}
```

Readout:

- This is only a spelling change. It still forces an order:
  emit -> transport -> decay.
- If the intended model is "emission, decay, and transport are one pollutant
  budget," the unified primitive has to be a field transaction, not merely
  `process`.

Process-style sketch with a budget:

```dsl
process pollutionBudget on field pollutant {
  source factory * emission * dt * rate
  sink pollutant * decay * dt * rate

  flux to n in neighbors {
    let downwind = max(dot(wind, direction(n)), 0)
    let push = crossMix + windBias * downwind
    amount pollutant * clamp(push * transportRate * dt * rate, 0, 0.22)
  }

  project to 0..2.2
}
```

Readout:

- This is a real conceptual win, but it introduces a second primary shape:
  process-on-scope vs process-on-field.
- That may be justified for conservative budgets, but it is not yet unified.
  The semantics would need to be very clear: local delta, outgoing flux demand,
  donor-limited scaling, incoming sum, final projection.

## Overall Readout

The process framing helps, but it does not by itself solve the deeper design.

What genuinely falls out cleanly:

- `cells` / `edges` / `relax` as execution scopes.
- `write` / `add` / `flux` / `project` as field effects.
- enum mode as validation on a cell process.
- `stable when` as a property of relax scope.

What still does not unify cleanly:

- diagnostics vs hidden scratch vs real state (`derived` remains muddy).
- conservative budgets that mix local source/sink and edge flux.
- authored wind/flow structure for planet recipes.
- ordered PDE solvers, where the order is the model rather than boilerplate.

Conclusion: this style is promising as a regularized v2/v3 surface, but it is
not enough to justify "DSL v3" by itself. The likely next design step is not
more keywords; it is choosing whether **field budgets** are a first-class
concept alongside scoped processes. Pollution/runoff/weather are the recipes
that can answer that.
