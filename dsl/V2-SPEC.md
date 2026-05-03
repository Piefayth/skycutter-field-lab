# Field Lab DSL — v2 Specification

This document is the source of truth for v2 syntax, semantics, and validator
rules. The implementation in `dsl/cst-v2.mjs`, `dsl/cst-to-ast-v2.mjs`,
`dsl/validate-v2.mjs`, and `dsl/compile-v2.mjs` should be checked against
this. If the implementation and the spec disagree, the spec wins (or the spec
is updated explicitly).

## Philosophy

The unifying principle: **simulation state is a 4D tensor `time × cell ×
field`. Every construct in the DSL is either a query into that tensor or an
update of one slice of it.**

Reads happen at coordinates: bare `u` means `(now, this_cell, u)`; `u@prev`
means `(now − 1, this_cell, u)`; inside a neighbor reduction, `u@n` means
`(now, neighbor_cell, u)`. The compiler dispatches based on the kind of
coordinate.

Writes happen at `(now+1, this_cell, this_field) ← expression`. Stages declare
which fields they read and write. Tick boundaries are explicit (`step { }`).

Compared to v1:
- `prev(u)` is no longer a magic function call — it's `u@prev` (a coordinate
  query, not a Call expression).
- Neighbor reductions are cell-centered: `sum n in neighbors { u@n - u + v@n }`
  binds a *cell coordinate* `n`, then any field can be read at `n`. Replaces
  v1's field-centered `neighbor sum n in u { ... }`.
- Special primitives (`diffuse`, `clamp`, `advect`, `wind`, `normalize`)
  collapse into the universal `cell { ... }` block. Each is now expressible as
  one or two lines of cell expression.
- Stage shape: exactly one `cell { }` block per stage. Locals do sequencing.
- `prev(u)` history declarations gone — history depth is inferred from
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
```

### Types

- `f32` — scalar
- `vec2` — 2D vector. Storage buffer is `array<vec2<f32>>`; member
  access `.x` / `.y` is supported; arithmetic mixes scalars and
  vec2s with WGSL-compatible broadcast semantics; `vec2(x, y)`,
  `length(v)`, `gradient(scalarField)`, and `divergence(vec2Field)`
  are first-class builtins.
- `vec3`, `u32` — reserved grammar; not implemented yet.

Type checking happens in `dsl/typecheck-v2.mjs`. Assignment-shape
mismatches (`set u = wind` where `u: f32` and `wind: vec2`),
`gradient`-on-vec2, `divergence`-on-scalar, vec2 in scalar reductions,
and non-bool `when` conditions all error at recipe load with a clear
message.

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
- not be written by `diffuse`/`clamp`/`advect`/etc. — but those primitives
  don't exist in v2, so this rule is automatic

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
grammar: no `@prev` / `@n` / `@upstream` (scenarios run once at start,
no previous tick exists; stamps run on click without GPU stencil
topology), no neighbor reductions, no `gradient` / `divergence`. Use
bare-field reads + math functions only. The validator emits clear
errors with redirect hints if you reach for a stage-only construct.

## Stamps

All `stamp` blocks live inside a single top-level `stamps { ... }`
container:

```
stamps {
  stamp ripple "Drop ripple" {
    spot u at brush.pos, radius=brush.r, amount=1
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
restricted subset of the cell-expression grammar: no `@prev` / `@n` /
`@upstream` coord queries, no neighbor reductions, no `gradient` /
`divergence`, no field writes (only `set red = ...` / `set green =
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
}
```

The `step { }` block makes tick boundaries explicit. Stages execute in source
order within a step.

Reserved for future: `step at 30hz { ... }` for tick-rate decoupling, multiple
steps for multi-rate simulations.

### Stage rules (validator-enforced)

- Exactly one `cell { }` block per stage. (No multiple `cell` blocks; no `each`
  block; no `event` block — events fold into `cell` via `when`.)
- One `set` per field per `cell` block. Use locals for sequential
  computation.
- `add f = expr` is sugar for `set f = f + expr` (using stage-input `f`).
- `reads` clause must list every field read in the cell body.
- `writes` clause must list every field written.
- Multiple stages may write the same field (last write in source order wins).
  EXCEPTION: a field with any `@prev` read anywhere can be written by exactly
  one stage per step.

## Expressions

### Coordinate queries (the unifying construct)

```
u                                  # this cell, current tick
u@prev                             # this cell, previous tick (triggers history allocation)
u@n                                # neighbor cell, current tick (only valid inside a reduction
                                   # body where `n` is a bound neighbor coordinate)
u@upstream(velX, velY, dt)         # continuous-position semi-Lagrangian sample —
                                   # walks back along the (velX, velY) tangent
                                   # vector for `dt` seconds, gathers self +
                                   # neighbors with inverse-distance weighting.
                                   # Replaces the v1 advect kernel.
```

Reserved for future:
- `u@prev(N)` for N-deep history
- `u@anti` for antipodal cell on a sphere
- `u@boundary` for boundary lookup

### Cell-level reductions (cell-centered)

```
sum  n in neighbors { u@n - u }
mean n in neighbors { u@n }
max  n in neighbors { temperature@n }
min  n in neighbors { distance(self, n) }
```

`n` is a cell coordinate; expression body can read any field at `n` via
`field@n`. Inner expression has full cell-expression grammar (locals, math
functions, conditionals).

A reduction body MAY contain another expression but MAY NOT contain another
reduction (no nested reductions on the geodesic substrate — no
neighbor-of-neighbor).

### Math functions and globals (always available, no `use` clauses)

- Math: `clamp`, `min`, `max`, `abs`, `sin`, `cos`, `asin`, `exp`, `sqrt`,
  `pow`, `hypot`, `wrapAngle`, `smoothstep`
- Noise: `cellNoise(seed=, scale=)`
- Globals: `dt`, `frame`, `PI`, `TAU`, `N` (cell count)
- Substrate-specific (geodesic): `lon`, `lat`, `x`, `y`, `z`, `i`

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
full cell-expression grammar: math functions, locals (via `let`?), neighbor
reductions, coordinate queries.

Wait — locals in metric expressions are tricky since metric is a single
expression. Resolution: **no `let` inside metric expressions in v2 first
cut.** If you need locals, write a derived field that holds the intermediate
and reduce over it. Defers the question of "what scope do metric-local lets
have?"

`count` is special: it has a `where` clause but no expression body (the body
is implicitly `1`):
```
metric active = count cells where abs_u > 0.1
# Equivalent semantically to: sum cells where abs_u > 0.1 { 1 }, but
# `count` is the canonical spelling. The runtime uses u32 accumulation.
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
- Metric expression must produce `f32` scalar (or u32 for count). Vector or
  enum results are rejected; wrap in `length()`/`f32()`.
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
metric predator_spawn = count cells where u > threshold && cellNoise() < 0.001
```

If the event needs per-cell visibility (rendering, downstream stages, paint),
make it a derived field and let other stages and metrics consume it:

```
field spawning: f32 derived

stage mark_spawning {
  reads u
  writes spawning
  cell {
    set spawning = u > threshold && cellNoise() < 0.001 ? 1 : 0
  }
}

metric spawning_count = sum cells { spawning }
```

A future explicit event system — separate from the cell action grammar —
could add real event-stream semantics (replay, ordering, fan-out). It is not
in v2 first cut.

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
- Each stage has exactly one `cell { }` block. *(parser)*
- `add f = expr` requires `f` in `reads`. *(v1)*
- `set f = expr` requires `f` in `writes`. *(v1)*
- Every `reads` and `writes` field must be declared. *(v1)*
- Every `derived` field must be in `writes` of at least one stage.
  *(v2)*
- Derived fields cannot be written by scenarios. *(v2)*
- Derived fields cannot be written by stamps. *(v2)*
- A field used with `@prev` anywhere must have exactly one writer stage
  per step. *(v1, from history-fields branch)*
- Metric reduction op must be one of {sum, max, min, mean, count}. *(v2)*
- Metric expressions are pure (no `set`/`add`/`emit`). *(v2)*
- `MetricReduce` only at top of `metric` declarations; never nested. *(v2)*
- `vec2` field types implemented (klausmeier `slope`, future wind
  recipes); `vec3` / `u32` reserved but not parsed. *(parser)*
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

## Compiler architecture

The compile path:

- `cst-v2.mjs` produces a tolerant concrete syntax tree with source ranges.
  `cst-to-ast-v2.mjs` strictly projects it into the compiler-facing v2 AST:
  CoordRead nodes for `field@coord` (kinds: `prev`, `neighbor`, `upstream`),
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
  `NeighborReduce { op: "sum", coord: "n", body: ... }` where the body
  contains `CoordRead { field: "u", coord: { kind: "neighbor", binding: "n" } }`.
  `emitReduction` walks the body to derive per-field bindings,
  synthesizes `let _n_u: f32 = f_u[neighborIdx]`, then compiles the
  body with the locals in scope.
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
- `vec3`, `u32` field types (vec2 is implemented)
- `@prev(N)` for N>1
- `@anti`, `@boundary` queries
- `step at Nhz` multi-rate
- Multiple substrates (square, torus, voxel)
- Eager metric evaluation (`metric x rate Nhz`)
- `let` inside metric expressions
- `on <event>` unified event handlers (replacing scenario / stamp)

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
