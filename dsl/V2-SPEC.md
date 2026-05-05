# Field Lab DSL — v2 Specification

This document is the source of truth for v2 syntax, semantics, and validator
rules. The implementation in `dsl/cst-v2.mjs`, `dsl/cst-to-ast-v2.mjs`,
`dsl/validate-v2.mjs`, and `dsl/compile-v2.mjs` should be checked against
this. If the implementation and the spec disagree, the spec wins (or the spec
is updated explicitly).

Known recipe-facing limitations and missing abstractions are tracked in
`dsl/LIMITATIONS.md`.

## Philosophy

The unifying principle: **simulation state is a 4D tensor `time × cell ×
field`. Every construct in the DSL is either a query into that tensor or an
update of one slice of it.**

Reads happen at coordinates: bare `u` means `(now, this_cell, u)`; `u@prev`
means `(now - 1, this_cell, u)`; inside a neighbor reduction or edge block,
`u@n` means `(now, neighbor_cell, u)`. A coordinate can also be a first-class
local expression: `let p = upstream(wind, dt)` followed by `u@p`. The compiler
dispatches based on the kind of coordinate.

Writes happen to the stage's output slice for that field. For ordinary fields,
the output becomes the field's current value immediately after the stage pass,
so later stages in source order can read it. For history fields, writes go to
the field's `next` slot and become current only at the end-of-tick history
rotation. Tick boundaries are explicit (`step { }`).

Compared to v1:
- `prev(u)` is no longer a magic function call — it's `u@prev` (a coordinate
  query, not a Call expression).
- Neighbor reductions are cell-centered: `sum n in neighbors { u@n - u + v@n }`
  binds a *cell coordinate* `n`, then any field can be read at `n`. Replaces
  v1's field-centered `neighbor sum n in u { ... }`.
- Continuous coordinate samples are first-class: `let p = upstream(wind, dt); u@p`.
- Special primitives (`diffuse`, `clamp`, `advect`, `wind`, `normalize`)
  collapse into the universal `cell { ... }` block. Each is now expressible as
  one or two lines of cell expression.
- Stage shape: exactly one compute block per stage: `cell { }` for per-cell
  updates or `edge n in neighbors { }` for conservative nearest-neighbor flux.
  Locals do sequencing.
- Manual `history N` field declarations are gone — history depth is inferred from
  `@prev` usage.
- New: `derived` fields (computed-by-stage, not paintable) and `metric`
  scalar reductions.

## Top-level structure

A v2 recipe is a sequence of top-level declarations in any order:

```
recipe "Wave equation"
summary "Hyperbolic wave on a sphere — leapfrog integration."
recommendedPreset droplet

substrate geodesic frequency 64

field u: f32
field abs_u: f32 derived
source wall: f32

param speed   slider 0..0.29 default 0.25 label "WAVE SPEED"
param damping slider 0..0.05 default 0    label "DAMPING γ"

step {
  stage propagate { ... }
  stage derive_abs { ... }
}

metric peak   = max cells { abs_u }
metric active = count cells where abs_u > 0.1

views {
  palette WAVE { stop 0 color [40, 90, 200]   stop 1 color [200, 50, 30] }
  view amp "Amplitude" {
    color ramp u range [-1, 1] palette WAVE
  }
}

stamps {
  stamp ripple "Drop ripple" { spot u at brush.pos, radius=brush.r, amount=1 }
  stamp erase_wall "Erase wall" { set wall at brush.pos, radius=brush.r, value=0 }
}

scenarios {
  scenario droplet "Single droplet" { ... }
  scenario standing "Standing wave" { ... }
}
```

Three things group: every `scenario` lives inside a single
`scenarios { ... }` block; every `stamp` inside a single `stamps { ... }`
block; every `palette` / `view` / `overlay` inside a single
`views { ... }` block. The grouped containers are themselves top-level
and may appear in any order relative to other top-level decls. The
parser rejects bare top-level `scenario` / `stamp` / `palette` /
`view` / `overlay` declarations — they have to live inside their
group.

Everything else (recipe identity, `substrate`, `field`, `const`,
`param`, `step`, `metric`, `import`) stays bare top-level.

### Recipe metadata

```
recipe "Name"           # required, becomes the recipe's display name
summary "Description"   # optional, one-line description
recommendedPreset id    # optional, scenario id to default to
```

## Substrate

Exactly one substrate declaration per recipe:

```
substrate geodesic frequency 64
```

In v2 first cut, only `geodesic` is implemented. Reserved syntax for future
substrates: `substrate square W H`, `substrate torus W H`, `substrate voxel
X Y Z`. Recipes target a specific substrate; substrate-specific helpers (e.g.
`lon`, `lat` for geodesic) are gated by validation.

## Fields

```
field u: f32                # primary state, paintable, written by stages
field abs_u: f32 derived    # computed per-cell by stages, not paintable
source wall: f32            # persistent user-authored state; stages read it
```

### Sources

A `source` is allocated like a field and has the same storage types, but it is
not part of the simulation update loop:

- stages may list sources in `reads`
- stages may not list sources in `writes`
- scenarios may initialize sources
- stamps may edit sources
- `set sourceName at brush.pos, radius=brush.r, value=0` assigns a source
  brush region exactly, which is the preferred way to erase persistent source
  layers
- `spot sourceName ... radius=0` targets exactly the nearest cell, which makes
  single-cell source editing possible even when the UI brush radius slider is
  larger

Use sources for persistent masks, walls, emitters, terrain/material layers, and
other authorable substrates that should remain fixed until the user explicitly
paints or erases them.

### Types

- `f32` — scalar
- `vec2` — 2D vector. Storage buffer is `array<vec2<f32>>`; member
  access `.x` / `.y` is supported; arithmetic mixes scalars and
  vec2s with WGSL-compatible broadcast semantics; `vec2(x, y)`,
  `length(v)`, `gradient(scalarField)`, and `divergence(vec2Field)`
  are first-class builtins.
- `coord` — expression-only geodesic coordinate. It is not a field storage
  type. It appears as a reduction / edge binder (`sum n in neighbors { ... }`,
  `edge n in neighbors { ... }`) or as the return type of coordinate helpers
  such as `upstream(wind, dt)`.
- `u32` — one unsigned integer per cell. Inside expressions it reads as
  `f32`; writes round and cast back to `u32`. This keeps arithmetic in
  scalar expression space while supporting cellular automata and state
  machines.
- `bool` — `u32`-backed boolean storage (`false` = 0, `true` = 1). Like
  `u32`, it reads as scalar `0` / `1` in expressions. Boolean RHS values
  can be assigned directly to `u32` / `bool` fields; predicates should use
  comparisons such as `alive > 0`.
- `vec3` — reserved grammar; not implemented yet.

Type checking happens in `dsl/typecheck-v2.mjs`. Assignment-shape
mismatches (`set u = wind` where `u: f32` and `wind: vec2`),
`gradient`-on-vec2, `divergence`-on-scalar, vec2 in scalar reductions,
and non-bool `when` conditions all error at recipe load with a clear
message.

### Vector-field coordinate policy

`vec2` fields are components in each cell's local tangent basis. A bare
`wind` read returns the current cell's local components. A neighbor read such
as `wind@n` returns the neighbor cell's own local components; it is **not**
implicitly parallel-transported into the current cell's basis.

That is a deliberate v2 contract: raw coordinate queries are literal reads.
Future intrinsic vector calculus should be added with explicit transport
syntax, not by silently changing the meaning of `field@n`. The existing
`gradient(scalarField)` and `divergence(vec2Field)` helpers are separate
geometry-aware operators and may perform their own basis work internally.

### `derived` annotation

A `derived` field:
- must be the target of `writes` in at least one stage (else: validator error)
- cannot be written by scenarios or stamps (validator rejects `set abs_u =`
  in scenario; rejects `spot abs_u` in stamp)
- is otherwise an ordinary field (readable by stages, viewable in UI,
  available to metric expressions)
- is **not** automatically computed — the recipe author orders the deriving
  stage. Document loudly: `derived` is a UI/readback annotation, not a live
  formula.

### History

History is **inferred** from `@prev` usage in cell expressions and metric
expressions. The compiler walks all expressions, finds every `field@prev`
read, and allocates triple-buffer rotation for each affected field. No
manual `history N` declaration in v2.

Optional explicit form for documentation (validator checks it matches
inferred set):
```
stage propagate {
  reads u, u previous   # explicit; equivalent forms: `reads u; reads previous u`
  writes u
  cell { set u = 2*u - u@prev + ... }
}
```

A history field (any field with `@prev` usage anywhere) must:
- be written by exactly one stage per `step { }` — single-writer rule
- not be read by a later stage after its writer in the same `step`
- not be written by `diffuse`/`clamp`/`advect`/etc. — but those primitives
  don't exist in v2, so this rule is automatic

Runtime model:
- History fields use three buffers: `{prev, current, next}`.
- At stage dispatch, bare field reads see `current`; `field@prev` reads
  `prev`; the writer writes `next`.
- History fields never swap after an individual pass.
- At the end of the tick, history rotates: `current -> prev`, `next ->
  current`, old `prev -> next`.
- Scenario application copies the freshly initialized current value into
  `prev`; stamps write current only and deliberately leave `prev` unchanged.
  For leapfrog wave recipes, that current/prev asymmetry is an explicit
  velocity impulse. Recipes that want literal velocity should model it as a
  separate field, e.g. `(u, v)`.

History depth is currently 1 (only `@prev`, not `@prev(2)`). Reserved for
future deepening.

## Params and constants

```
param speed   slider 0..0.29 default 0.25 label "WAVE SPEED"
param damping slider 0..0.05 default 0    label "DAMPING γ"
param flag    toggle default true         label "ENABLE X"

const c = 2.998e8
const PI = 3.14159265
```

`param` declarations create UI controls and are accessible by bare name in
expressions. `const` declarations are compile-time scalars.

## Scenarios

All `scenario` blocks live inside a single top-level `scenarios { ... }`
container:

```
scenarios {
  scenario droplet "Single droplet" {
    set u = 0
    spot u at lon=0, lat=0, radius=0.08, amount=1
  }

  scenario standing "Standing wave" {
    for each cell {
      set u = cos(lon * 2) * 0.6
    }
  }
}
```

`scenario` replaces v1's `preset`. Runs once when selected from the recipe's
scenario dropdown. Initialization actions:

- `set f = expr` — set field `f` to expression value (per-cell if expr uses
  `lon`/`lat`/etc., else flat fill)
- `spot f at lon=, lat=, radius=, amount=` — Gaussian spot
- `ellipse f at lon=, lat=, rx=, ry=, angle=, amount=` — elliptical spot
- `region f at lonMin=, lonMax=, latMin=, latMax=, amount=` — rectangular fill
- `for each cell { ... }` — per-cell init with full geo helpers

Scenarios CANNOT write derived fields (validator rejects).

The init-context expression subset is stricter than the cell-stage
grammar: no `@prev` / `field@n` / `field@coord` (scenarios run once at
start, no previous tick exists; stamps run on click without GPU stencil
topology), no neighbor reductions, no coordinate helpers (`upstream`,
`direction`, `distance`), no `gradient` / `divergence`. Use bare-field
reads + math functions only. The validator emits clear errors with
redirect hints if you reach for a stage-only construct.

## Stamps

All `stamp` blocks live inside a single top-level `stamps { ... }`
container:

```
stamps {
  stamp ripple "Drop ripple" {
    on press {
      spot u at brush.pos, radius=brush.r, amount=1
    }
    on drag {
      spot v at brush.pos, radius=brush.r, amount=16
    }
  }

  stamp impulse "Impulse" {
    spot v at brush.pos, radius=brush.r, amount=1
  }
}
```

Available bindings in stamp body: `brush.pos` (current paint center as
{lon, lat}), `brush.r` (current paint radius). Stamps can target multiple
fields. Stamps CANNOT write derived fields. Same expression-subset
restrictions as scenarios.

Stamp bodies can optionally split actions by stroke phase:

- `on press { ... }` runs once at pointer-down.
- `on drag { ... }` runs at pointer-down and on subsequent drag samples.
- Unwrapped actions keep the older continuous behavior and are treated like
  `on drag`.

This lets recipes combine a one-shot visible mark with continuous held
painting without forcing the same field every drag sample.

## Render: palettes, views, overlays

All render-side declarations live inside a single top-level
`views { ... }` container. The container holds three kinds of decls
in any order: `palette`, `view`, `overlay`.

```
views {
  palette HEAT {
    stop 0    color [12, 14, 30]
    stop 0.5  color [240, 110, 40]
    stop 1    color [255, 220, 90]
  }

  view temperature "Temperature" {
    color ramp T range [-0.8, 1.5] palette HEAT
  }

  view phase "Phase (θ)" {
    color wheel theta
  }

  view composite "S / I / R" {
    color expr {
      let total = max(S + I + R, 0.000001)
      set red   = (S / total) * 255
      set green = (I / total) * 255
      set blue  = (R / total) * 255
    }
  }

  overlay grid
}
```

The render layer materializes at recipe load — palettes resolve, views
are routed to the right per-cell colorer, the result populates the view
selector in the panel. Authoring is DSL-only; recipe `.mjs` files no
longer export a `views[]` array.

### Palette

```
palette NAME {
  stop T color [R, G, B]
  stop T color [R, G, B]
  ...
}
```

Two or more stops, each on its own line. `T` is in `[0, 1]` and stops
must appear in ascending `T` order. `R`, `G`, `B` are in `[0, 255]`.
Names are unique within a recipe.

Each stop becomes an interpolation knot for ramp views that reference
this palette by name.

### View

```
view ID "Display label" { color KIND ARGUMENTS }
```

Three view kinds:

**`color ramp FIELD range [LO, HI] palette NAME`** — scalar field, mapped
through a piecewise-linear lookup against the named palette. The
input value is remapped via `t = clamp((value - LO) / (HI - LO), 0, 1)`
before sampling the palette. `LO` must differ from `HI`. Range bounds
accept numeric literals, declared `const`s, or `PI` / `TAU`. The
palette can also be inlined as `stops { ... }` — same shape as a
top-level `palette` block — when you don't want to name and reuse
it.

```
view amp "Amplitude" {
  color ramp u range [-1, 1] palette WAVE
}

view density "Density" {
  color ramp rho range [0, 1] stops {
    stop 0 color [0, 0, 0]
    stop 1 color [255, 80, 0]
  }
}
```

**`color wheel FIELD [range [LO, HI]]`** — scalar field treated as an
angle, rotated through HSV. Default range is `[0, 2π]` (canonical
phase semantics). Use for fields that are inherently cyclic — phase
oscillators, heading angles, cyclic-CA states.

```
view phase "Phase (θ)" {
  color wheel theta range [0, TAU]
}
```

**`color expr { ... }`** — programmable per-cell RGB. Body uses a
restricted subset of the cell-expression grammar: no `@prev` /
`field@n` / `field@coord` coord queries, no neighbor reductions, no
coordinate helpers (`upstream`, `direction`, `distance`), no
`gradient` / `divergence`, no field writes (only `set red = ...` / `set green =
...` / `set blue = ...`), no `add` (`set` only). Each of the three
channels must be assigned at the body's *root level* — assignments
inside a `when` don't satisfy the requirement on their own (the
runtime defaults unset channels to zero, which silently masks bugs).

```
view composite "Composite" {
  color expr {
    let mag = length(wind)
    let lit = clamp(h, 0, 1)
    set red   = sin(lit * PI) * 200 + 40
    set green = mag * 100 + wind.x * 5
    set blue  = sqrt(max(lit, 0)) * 255
  }
}
```

Allowed identifiers in expr-view bodies:

- declared `field`s (scalar `f32` directly; `vec2` only via `.x` /
  `.y` or as the bare argument of `length(...)`)
- declared `param`s and `const`s
- `let`-locals declared earlier in the same body
- `PI`, `TAU`, `true`, `false`
- `red`, `green`, `blue` only as `set` targets — reading them is
  rejected

Allowed calls: `clamp`, `min`, `max`, `abs`, `sin`, `cos`, `asin`,
`atan2`, `exp`, `sqrt`, `pow`, `hypot`, `wrapAngle`, `smoothstep`,
`length`. Per-cell stage builtins (`cellNoise`, `cellRand`, `lon`,
`lat`, `frame`, `dt`) are stage-only — promote them to a derived
field if the view needs them.

### Glyph overlay

A view block may carry an optional `glyph` clause alongside its
`color` clause. Each cell gets a font character — whatever the
recipe author writes between the quotes — rasterized to a texture
and drawn on top of the tile, with optional rotation and size
driven by recipe fields.

```
view flow "Velocity" {
  color ramp speed range [0, 0.25] palette SPEED
  glyph "→" rotate=m length=0.6 stride=2
}

view density "Density dots" {
  color ramp rho range [0, 1] palette MONO
  glyph "●" size=rho length=0.4
}

view stars "Activity" {
  color ramp activity range [0, 1] palette ACT
  glyph "★" length=0.5
}

view marks "X marks the spot" {
  color ramp h range [0, 1] palette MONO
  glyph "X" length=0.4 stride=2
}
```

Surface:

```
glyph "CHAR" [rotate=VEC2_FIELD] [size=SCALAR_FIELD] [length=N] [stride=N]
```

- `"CHAR"` — the literal character (or short string) to rasterize.
  Anything the system font can draw works: arrows (→ ↑ ↗ ⇒),
  shapes (● ○ ■ ▲ ★), letters / numbers, even emoji.
- `rotate=FIELD` (optional) — vec2 field whose `atan2(y, x)` sets
  glyph orientation in the cell's east/north tangent plane. The
  glyph's natural facing is whatever the font draws — "→" points
  east when the field has angle 0; "↑" points north.
- `size=FIELD` (optional) — scalar field that multiplies glyph
  size per cell. Cells whose size-field is zero are skipped
  entirely.
- `length=N` (default `0.5`) — base size in units of mesh mean
  cell-radius. The total per-cell size is `length × (size_field
  magnitude or 1) × baseScale`.
- `stride=N` (default `1`) — render every Nth cell only.

Glyphs are auto-shaded for contrast against the underlying tile
color: bright tiles get dark glyphs (luma 0.05), dark tiles get
bright ones (luma 0.97). The system font and 128-px rasterization
are baked into the renderer.

The `color` clause and the `glyph` clause are independent — common
pattern: color the magnitude scalar, glyph the direction vector or
mark cells of interest.

### Particle trail overlay

A view block may also carry an optional `particles` clause alongside
its `color` clause. Particle trails are render-only tracers: they
sample a vec2 field as a tangent velocity, move over the sphere, and
leave short fading trails. They do not write simulation state.

```
view weather "Weather" {
  color expr {
    set red = ...
    set green = ...
    set blue = ...
  }
  particles advect=wind count=3500 length=18 speed=0.8 fade=0.9 size=4 color [235, 245, 255]
}
```

Surface:

```
particles advect=VEC2_FIELD [count=N] [length=N] [speed=N] [fade=N] [size=N] [color [R, G, B]]
```

- `advect=FIELD` — required vec2 field, interpreted in the cell's
  east/north tangent frame.
- `count=N` (default `2400`) — number of tracer particles.
- `length=N` (default `16`) — number of stored trail points per
  particle. Must be at least 2.
- `speed=N` (default `0.8`) — visual multiplier. This changes only
  tracer motion, not the simulation.
- `fade=N` (default `0.9`) — trail intensity falloff in [0, 1].
- `size=N` (default `4`) — visual particle size. Larger values
  make each tracer sample occupy more of the globe surface.
- `color [R, G, B]` (default `[235, 245, 255]`) — trail color.

### Overlay

```
overlay NAME
```

One-line declaration. `NAME` must be in the registered set; currently
only `grid` (the geodesic graticule) is registered. Future overlays
(poles, lat/lon ticks, vector glyphs) will register the same way.
Recipes don't author overlay content — they pick from the registered
catalog.

## Step block and stages

```
step {
  stage propagate {
    reads  u
    writes u
    cell {
      let lap = sum n in neighbors { u@n - u }
      set u = clamp(2*u - u@prev + speed*speed*lap, -2, 2)
    }
  }
  stage derive_abs {
    reads  u
    writes abs_u
    cell { set abs_u = abs(u) }
  }
  stage runoff {
    reads water, height
    writes water
    edge n in neighbors {
      flux water = water * max(height - height@n, 0) * runoffRate * dt
    }
  }
}
```

The `step { }` block makes tick boundaries explicit. Stages execute in source
order within a step.

Reserved for future: `step at 30hz { ... }` for tick-rate decoupling, multiple
steps for multi-rate simulations.

### Tick and write visibility

A `step { }` is one simulation tick.

- Stages execute in source order.
- Each stage pass reads the current buffers at dispatch time.
- For ordinary fields, a write becomes visible to later stages as soon as that
  pass swaps. Multiple stages may write the same ordinary field; the last
  writer in source order wins.
- For history fields, writes are not visible mid-tick. The sole writer deposits
  into `next`; the value becomes visible only after the end-of-tick history
  rotation.
- If a stage writes multiple ordinary fields, the compiler may emit multiple
  passes and delay their swaps until the end of that stage so every pass in
  the stage sees the same stage-input snapshot.

Inside one `cell { }` block, bare field reads are reads from the stage-input
snapshot, not from earlier `set` statements in the same block. `let` locals
are the sequencing tool. `add f = expr` updates the output accumulator for
`f`; its `f` read still means the stage-input `f`.

### Stage rules (validator-enforced)

- Exactly one compute block per stage: either one `cell { }` block or one
  `edge n in neighbors { }` block. No mixing cell+edge in the same stage.
- One `set` per field per `cell` block. Use locals for sequential
  computation.
- `add f = expr` is sugar for `set f = f + expr` (using stage-input `f`).
- `reads` clause must list every field read in the cell body.
- `writes` clause must list every field written.
- Multiple stages may write the same field (last write in source order wins).
  EXCEPTION: a field with any `@prev` read anywhere can be written by exactly
  one stage per step.

### Edge flux blocks

```
stage runoff {
  reads water, height
  writes water
  edge n in neighbors {
    let drop = max((height + water * 0.1) - (height@n + water@n * 0.1), 0)
    flux water = water * drop * runoff * dt
  }
}
```

`edge n in neighbors { ... }` is a graph-parallel pattern with a known safe
GPU lowering:

1. A directed-edge pass evaluates `flux FIELD = EXPR` for every
   `(cell -> neighbor)` edge.
2. An apply pass subtracts outgoing flux from each source cell and adds incoming
   flux from neighboring cells.
3. Negative flux clamps to zero. If a cell's raw outgoing total exceeds its
   current FIELD value, outgoing flux is scaled so the cell cannot send more
   mass than it has.

The first version is intentionally narrow:

- `flux` targets must be `f32` fields.
- Source is exactly `neighbors`; no `ring`, `disk`, or metric kernel edge flux
  yet.
- Edge expressions can read bare fields at the current cell and `field@n` at the
  neighbor endpoint. The edge binder `n` is a coord, so `direction(n)` and
  `distance(n)` are available for directional / distance-weighted flux. Nested
  stencils (`sum n in neighbors`, `gradient`, `divergence`, `@prev`) are
  rejected inside edge flux; compute those into fields in a preceding `cell`
  stage.

## Expressions

### Coordinate queries (the unifying construct)

```
u                                  # this cell, current tick
u@prev                             # this cell, previous tick (triggers history allocation)
u@n                                # bound coordinate read (reduction binder or edge binder)
let p = upstream(wind, dt)         # continuous coordinate one timestep upstream
u@p                                # sample field u at coordinate p
```

`coord` is an expression type, not a storage type. The currently implemented
coordinate values are:

- neighbor / edge binders such as `n`
- `upstream(vec2, dt)`, which walks back along a tangent vector field and returns
  a continuous point on the sphere

`field@coord` uses an exact neighbor read when `coord` is a neighbor / edge
binder. For arbitrary continuous coords, the first implementation supports
sampling `f32` fields by gathering the current cell and its immediate neighbors
with inverse-distance weighting.

Reserved for future:
- `u@prev(N)` for N-deep history
- `u@anti` for antipodal cell on a sphere
- `u@boundary` for boundary lookup

### Cell-level reductions (cell-centered)

```
sum  n in neighbors { u@n - u }
mean n in neighbors { u@n }
mean n in disk(2) { u@n }
sum  n in ring(3) { activator@n }
mean n in kernel bell(0, 0.05) { u@n }
mean n in kernel bell(0.12, 0.03) { u@n }
max  n in neighbors { temperature@n }
mean n in neighbors { max(dot(wind, direction(n)), 0) * pollutant@n }
min  n in neighbors { distance(n) }
```

`n` is a cell coordinate; expression body can read any field at `n` via
`field@n`, compute the tangent direction from the current cell with
`direction(n)`, and compute great-circle distance with `distance(n)`. The body
is a single expression: math functions, field reads, and conditionals are
allowed, but `let` locals are not.

A reduction body MAY contain another expression but MAY NOT contain another
reduction. Use the bounded source forms below instead of hand-nesting
neighbor-of-neighbor reductions.

Reduction sources:

- `neighbors` means immediate topological adjacency in the geodesic mesh.
- `ring(k)` means exact topological graph distance `k`.
- `disk(k)` means topological graph distances `1..k`.
- `kernel bell(center, width)` means a weighted metric neighborhood over
  great-circle distance on the unit sphere.

`ring(k)` / `disk(k)` currently require a literal integer `k` in `1..3`.
The center cell is excluded from the topological source forms. These are
topological neighborhoods: most cells have six immediate neighbors, the
twelve pentagonal cells have five, and wider rings inherit that geodesic
mesh irregularity. They are not metric radial kernels and not same-radius
stencils everywhere.

Metric kernel semantics:

```
weight(d) = exp(-0.5 * ((d - center) / width)^2)
cutoff    = center + 3 * width
```

Cells with great-circle distance `d <= cutoff` are gathered. `center` and
`width` may be number literals or global params, but not locals or fields.
The compiler/runtime precomputes packed gather tables for each resolved
kernel and rebuilds them lazily when kernel params change. Guardrails:
`center >= 0`, `width > 0`, and `cutoff <= 0.35`. Large kernels can be
expensive, but the DSL does not cap gathered cells per cell. `mean`
normalizes by total weight; `sum` returns the raw weighted sum.
Weighted kernels support `sum` and `mean` only. `max` / `min` are deliberately
not defined for weighted kernels.

Self-inclusion is literal: `bell(0, width)` strongly includes the current
cell and works as a smoother; `bell(center > 0, width)` is annular and gives
the current cell little weight.

Canonical scalar diffusion / Laplacian spelling for authored recipes:

```
let lap = mean n in neighbors { u@n - u }
```

Use that graph-Laplacian form unless a recipe intentionally wants the
separate tangent-frame operator `divergence(gradient(u))`. The two are not
numerically identical on a geodesic mesh, especially near pentagons. Do not
add a `laplacian(u)` helper until the numerical contract it names is settled.

Do not overload `ring` / `disk` to mean metric radius or distance-weighted
sampling. Use `kernel bell(...)` when authored semantics are metric.

### Math functions and globals (always available, no `use` clauses)

- Math: `clamp`, `min`, `max`, `abs`, `sin`, `cos`, `asin`, `exp`, `sqrt`,
  `pow`, `hypot`, `wrapAngle`, `smoothstep`, `dot`
- Coordinate helpers: `upstream(vec2, dt) -> coord`, `direction(coord) -> vec2`,
  `distance(coord) -> f32`
- Noise / RNG: `cellNoise(seed, scale?)`, `cellRand(seed)`,
  `rand01(state)`, `rngNext(state)`
- Globals: `dt`, `frame`, `PI`, `TAU`, `N` (cell count)
- Substrate-specific (geodesic): `lon`, `lat`, `x`, `y`, `z`, `i`

`direction(coord)` returns the unit tangent vector from the current cell toward
the coordinate in the current cell's local east/north basis. `distance(coord)`
returns great-circle distance on the unit sphere. These names are deliberately
generic; their behavior comes from the argument type, not from an `edge.*` or
`neighbor.*` namespace.

### RNG and reproducibility

The current random-looking builtins are stateless deterministic hashes:

- `cellRand(seed)` hashes `(cell index, seed)` and returns an IID-ish value in
  `[-1, 1]`.
- `cellNoise(seed, scale?)` samples coherent spatial noise from the cell's
  sphere position and seed.

They do not advance hidden RNG state, do not depend on stage/pass ordering,
and produce the same value for the same arguments. To vary over time, include
`frame` in the seed expression deliberately, e.g. `cellRand(frame + 17)`.

This is enough for repeatable heterogeneity and simple per-frame perturbation.
For stochastic Markov processes that require persistent per-cell random state,
declare that state explicitly:

```
field rng: u32

stage stochastic_step {
  reads state, rng
  writes state, rng
  cell {
    let r = rand01(rng)
    set state = r < birthRate ? 1 : state
    set rng = rngNext(rng)
  }
}
```

`rand01(state)` returns a deterministic sample in `[0, 1]` from the current
state. It does not mutate. `rngNext(state)` returns the next state; storing it
is an ordinary field write. The state is intentionally 24-bit so it can round
trip exactly through the DSL's scalar expression space while still using `u32`
storage.

### Imports (optional)

```
import sin, cos, clamp, neighbor   # optional, validates only listed names
```

Imports are validation-only; if omitted, all builtins are in scope. Editor
auto-inserts based on usage.

## Cell body actions

Inside `cell { ... }`:

- `let name = expr` — local binding, scoped to the cell block
- `set field = expr` — set field's next value (one set per field)
- `add field = expr` — sugar for `set field = field + expr`
- `when condition { actions }` — predicated actions
- (no `emit` action; see "Events" below for why)

Inside `edge n in neighbors { ... }`:

- `let name = expr` — local binding, scoped to the edge block
- `flux field = expr` — directed conservative transfer from this cell to `n`

Inside `for each cell { ... }` (in scenarios only): same actions plus
geo-helpers.

## Derived fields and metrics

### `field x: f32 derived`

See "Fields > derived annotation" above.

### `metric x = ...`

Scalar reductions over the post-step state, lazily evaluated.

```
metric peak   = max  cells { abs_u }
metric mass   = sum  cells { density }
metric mean_t = mean cells { temperature }
metric active = count cells where abs_u > 0.1

# all five reductions support `where`:
metric peak_active = max cells where abs_u > 0.1 { abs_u }
```

### Reduction grammar

```
metric ID = (sum|max|min|mean|count) cells [where PREDICATE] { EXPRESSION }
```

EXPRESSION is a single cell-expression (not a multi-line block). It uses the
cell-expression grammar for math functions, neighbor reductions, and coordinate
queries, but does not allow `let`. If you need locals, write a derived field
that holds the intermediate and reduce over it.

`count` is special: it has a `where` clause but no expression body (the body
is implicitly `1`):
```
metric active = count cells where abs_u > 0.1
# Equivalent semantically to: sum cells where abs_u > 0.1 { 1 }, but
# `count` is the canonical spelling.
```

### Reduction semantics

- Result type: `f32` for sum/mean/max/min/count. Count is implemented
  in the f32 reduction pipeline (each cell contributes 0.0 or 1.0)
  rather than a separate u32 path — at typical geodesic resolutions
  (≤ ~16M cells), f32's 24-bit mantissa is exact. The metrics panel
  renders count metrics as integers via `Math.round` at display time.
- Empty result (no cells matching `where`): `sum`/`count` → 0; `max` →
  `-FLT_MAX`; `min` → `+FLT_MAX`; `mean` → NaN. Document; UI renders NaN as
  "—".
- Implicit bool→f32 cast NOT allowed. `mean cells { abs_u > 0.1 }` is a
  validator error. Use `count cells where abs_u > 0.1` for the fraction-y use
  case (and divide by `N` if you want a fraction).
- Metric expression must produce `f32` scalar. Vector or boolean results are
  rejected; wrap vectors in `length()` and use `count cells where ...` for
  booleans.
- Pure: no `set`, `add`, `emit`, or stamp action calls. Validator rejects.

### Metric scheduling

- Lazy: metrics evaluate only when a consumer subscribes (the metrics panel
  auto-subscribes to all declared metrics).
- After all stages of `step { }` complete (post-step state). The runtime
  topologically orders: stage deps satisfied before metric kernel dispatch.
- Reserved syntax for explicit eager evaluation: `metric peak rate 30hz =
  ...` (not in v2 first cut).

### Compiler implementation

- Per-cell expression compiles via the existing cell-shader machinery,
  emitting to a per-cell scratch buffer.
- Reduction kernel runs over the scratch buffer (workgroup-level partial
  reduce, finalize via atomic for sum/count or second pass for max/min).
- Multiple metrics with similar shapes batch into a single dispatch when
  possible.
- Readback is async; metrics panel shows the most recent completed value.

### Nested reduction rules

- `NeighborReduce` (cell-level reduction) is allowed inside cell bodies
  and inside metric expressions.
- `MetricReduce` (grid-level reduction) is ONLY allowed at the top of a
  `metric` declaration. Nested inside another reduction or inside a stage
  cell body → validator error.

## Events (intentionally absent)

v2 deliberately has **no** `emit` action. The unifying spacetime-query model
says stages mutate per-cell state, metrics read scalar reductions. A
side-effect that increments a global counter from inside a per-cell body
punches a hole through that model — it brings its own reset timing,
ordering, naming, accumulation, UI, and replay semantics that compose
with nothing else.

Event-like observations are expressed as metrics directly:

```
metric predator_spawn = count cells where u > threshold && cellRand(frame + 31) > 0.998
```

If the event needs per-cell visibility (rendering, downstream stages, paint),
make it a derived field and let other stages and metrics consume it:

```
field spawning: f32 derived

stage mark_spawning {
  reads u
  writes spawning
  cell {
    set spawning = u > threshold && cellRand(frame + 31) > 0.998 ? 1 : 0
  }
}

metric spawning_count = sum cells { spawning }
```

A future explicit event system — separate from the cell action grammar —
could add real event-stream semantics (replay, ordering, fan-out). Cascade
events are intentionally deferred until their fixed-point / max-iteration /
depth-budget semantics are specified up front. They are not in v2 first cut.

## Validator rules summary

Enforced today (split across `dsl/cst-v2.mjs` + `dsl/cst-to-ast-v2.mjs`
(tolerant CST, strict syntactic shape, and compiler AST projection),
`dsl/validate.mjs` (structural / wiring rules — single-writer-per-step,
reads/writes consistency, name uniqueness), `dsl/validate-v2.mjs`
(v2-specific semantics — derived fields, metric purity, flat imports,
explicit-previous-reads), and `dsl/typecheck-v2.mjs` (assignment-shape
+ vec2 type rules)):

- Recipe must have exactly one `recipe "..."` declaration. *(parser)*
- Recipe must have exactly one `substrate ...` declaration. *(parser)*
- All names (fields, params, scenarios, stamps, stages, metrics) must be
  globally unique. *(v1 + v2 metric collision check)*
- Names cannot shadow callable builtins (math fns, stencil helpers,
  clock helpers, literals). They CAN shadow position-coord builtins
  (`u`, `v`, `x`, `y`, `lon`, `lat`, `i`, `N`, …) and clock identifier
  builtins (`dt`, `frame`) — common idiom: `field u: f32` in a wave
  recipe shadows the geo `u` projection coord, and the WGSL compiler
  resolves `u` to the field-read first by definition. *(`RESERVED_NAMES`
  in dsl-spec.mjs covers the cannot-shadow set)*
- Each stage has exactly one compute block: `cell { }` or
  `edge n in neighbors { }`. *(parser)*
- `add f = expr` requires `f` in `reads`. *(v1)*
- `set f = expr` requires `f` in `writes`. *(v1)*
- `flux f = expr` requires `f` in both `reads` and `writes`, and `f` must be
  an `f32` field. *(v1 + typecheck-v2)*
- Edge flux expressions only support bare current-cell field reads and
  `field@n` neighbor endpoint reads; nested stencil/temporal/continuous
  coordinate queries are rejected. *(v1 structural validator)*
- Every `reads` and `writes` field must be declared. *(v1)*
- Every `derived` field must be in `writes` of at least one stage.
  *(v2)*
- Derived fields cannot be written by scenarios. *(v2)*
- Derived fields cannot be written by stamps. *(v2)*
- A field used with `@prev` anywhere must have exactly one writer stage
  per step, and no later stage may read that history field after its writer.
  *(v1 structural validator)*
- Metric reduction op must be one of {sum, max, min, mean, count}. *(v2)*
- Metric expressions are pure (no `set`/`add`/`emit`). *(v2)*
- `MetricReduce` only at top of `metric` declarations; never nested. *(v2)*
- `f32`, `vec2`, `u32`, and `bool` field types implemented; `vec3`
  reserved but not runtime-backed. *(parser + runtime)*
- Assignment-shape type checking — `set f32_field = vec2_expr` and
  symmetric mismatches rejected with a clear DSL-level error.
  *(typecheck-v2)*
- Metric body must produce `f32` (vec2 in a scalar reduction errors
  out), bool top-level rejected with a redirect to `count cells
  where ...`. *(validate-v2 + typecheck-v2)*
- Render: `palette` names unique within the recipe; ≥2 stops; stops
  in ascending `T` order with `T ∈ [0, 1]`; `R`, `G`, `B` in
  `[0, 255]`. *(validate-v2)*
- Render: `view` ids unique. Ramp/wheel views reference a declared
  field; ramp views reference a declared palette OR carry inline
  `stops { ... }` (not both). Range bounds resolve to numbers via
  consts ∪ `{PI, TAU}`. Range `LO != HI`. *(validate-v2)*
- Render: expr-view bodies validated against the runtime's identifier
  + call whitelist; vec2 fields only through `.x` / `.y` or
  `length(...)`; `red` / `green` / `blue` must each be assigned at
  the body root (not under a `when`). *(validate-v2)*
- Render: overlay names in the registered catalog (currently
  `{grid}`); each registered name appears at most once. *(validate-v2)*

Still TODO — partially-enforced or not yet:

- Each `cell { }` has at most one `set` per field at the same nesting
  level. *(currently lenient: last-write-wins; the recipe author can
  still do `when A { set u = X } when B { set u = Y }` for mutually-
  exclusive branches, which we want.)*
- Substrate-specific helpers gated by substrate type. *(only `geodesic`
  exists; non-issue until a second substrate lands.)*

## DSL change policy

Every new surface construct or primitive pays the full integration cost in
the same feature batch:

- Update this spec and `dsl/dsl-spec.mjs` docs/catalog entries.
- Update CST parsing/projection, strict AST shape, validation, and typecheck
  as applicable.
- Update WGSL emit and JS/init/runtime evaluation for every context where the
  construct is valid; reject it clearly everywhere else.
- Update editor highlighting/autocomplete so the authoring surface stays in
  sync with the language.
- Add positive tests, negative validator tests, and fuzzer coverage.
- If the construct emits WGSL, add a WGSL harness assertion for the lowered
  shape.

This is feature cost, not optional cleanup. After roughly every ten commits,
check the recent mix of `feat:` / `fix:` / `correctness:` / `test:` / `docs:`
work. If feature work is outrunning semantics and harness work, the next batch
is correctness-first.

## Compiler architecture

The compile path:

- `cst-v2.mjs` produces a tolerant concrete syntax tree with source ranges.
  `cst-to-ast-v2.mjs` strictly projects it into the compiler-facing v2 AST:
  CoordRead nodes for `field@coord` (kinds: `prev`, `coord`),
  NeighborReduce nodes carrying a `coord` binding name, plus cell-action types
  (`set`, `add`, `let`, `when`). The v1 stage primitives (`wind`, `advect`,
  `diffuse`, `clamp`, `normalize`) are rejected during strict projection with
  redirect messages pointing at the cell-stage equivalents.
- `validate.mjs` runs shape / structural checks reusable across surface
  syntaxes: name uniqueness, reads/writes wiring, scenario / stamp /
  stage shape, history-field single-writer-per-step.
- `validate-v2.mjs` runs v2-specific semantics: flat import constraint,
  derived-field rules, metric expression purity / shape, explicit-
  previous-reads consistency.
- `typecheck-v2.mjs` runs assignment-shape and vec2-aware type checking
  over every cell body, scenario / stamp body, and metric body.
- `webgpu-geodesic-compiler.mjs`'s `compileExpr` dispatches on
  `CoordRead.coord.kind` directly. New coord kinds extend by adding
  cases here. The metric kernel pipeline (per-cell pass + workgroup
  tree-reduce) lives in the same file (`compileWebGpuMetric`,
  `metricReduceShader`) and is driven at runtime by
  `visual/webgpu-metric-runtime.mjs`.

Concrete shapes:
- v2 `u@prev` → `CoordRead { field: "u", coord: { kind: "prev" } }`.
  WGSL: `f_u_prev[cell]`.
- v2 `sum n in neighbors { u@n - u }` →
  `NeighborReduce { op: "sum", coord: "n", source: { kind: "neighbors" }, body: ... }` where the body
  contains `CoordRead { field: "u", coord: { kind: "coord", name: "n" } }`.
  `emitReduction` walks the body to derive per-field bindings,
  synthesizes `let _n_u: f32 = f_u[neighborIdx]` for exact field-at-neighbor
  reads and `let n = vec3<f32>(...)` for coord-valued geometry helpers, then
  compiles the body with the locals in scope.
- v2 `let p = upstream(wind, dt); set dye = dye@p` →
  a coord-valued local plus a field sampler helper. WGSL: `p` is a unit-sphere
  `vec3<f32>` and `dye@p` lowers to `_sample_dye_at_coord(cell, p)`.
- v2 `edge n in neighbors { flux water = water * max(dot(wind, direction(n)), 0) }`
  binds `n` as the neighbor endpoint coord; `direction(n)` and `distance(n)`
  lower to geometry helpers over the current cell and endpoint position.
- v2 `mean n in disk(2) { u@n }` uses the same AST shape with
  `source: { kind: "disk", radius: 2 }`. WGSL currently emits a bounded
  graph walk over the existing immediate-neighbor buffers, dedupes visited
  cells in a fixed local array, and reduces only the requested topological
  shells.
- v2 multi-field reductions (`sum n in neighbors { u@n + v@n - u - v }`)
  emit one local per coord-bound field; the WGSL emitter loops over
  neighbors once and reads each field at the resolved neighbor index.
- v2 `metric x = max cells { abs(u) }` → `compileWebGpuMetric` emits a
  per-cell shader writing scratch + a reduction shader; the runtime
  ping-pongs reduce passes until length is 1; `mean` decomposes into
  [sum, count] primitives and the readback layer divides.
- v2 `field x: f32 derived` → ordinary field plus a `derived: true`
  flag the validator gates against (no scenario/stamp writes; must
  have stage writer).

## Migration from v1

All recipes are v2; v1 parser / compiler / validator code is gone.
The only v1-flavored module remaining is `validate.mjs`, kept for its
shape validators (now surface-syntax-agnostic).

## Deferred features

Reserved in grammar, not implemented:
- `vec3` field type
- `@prev(N)` for N>1
- `@anti`, `@boundary` queries
- explicit vector transport between tangent bases
- `step at Nhz` multi-rate
- Multiple substrates (square, torus, voxel)
- Eager metric evaluation (`metric x rate Nhz`)
- `let` inside metric expressions
- explicit cascade / event system

## Open questions

- The historyFields side-channel still travels via `schema.imports`
  (a leftover from the v1 namespace-import object). It should be
  promoted to a proper top-level field on the parsed schema, after
  which the `imports` parameter can be removed from the shape
  validators entirely.
- Derived-field UI nuance: the paint panel currently lists every
  field as a stamp target; derived fields should be hidden (they're
  computed by stages, not paintable). Low-impact today since most
  recipes don't expose paint UI for their derived fields, but worth
  formalizing.
- Render escape hatches: `color expr` covers programmable scalar →
  RGB but assumes a single-layer view. Future render layers (vector
  glyphs, contour overlays, sparse markers) likely want a different
  shape inside `view { ... }` — additive layers or alternative
  `glyph` / `arrows` clauses alongside `color`. Grammar leaves room
  but no consumer exists yet.
