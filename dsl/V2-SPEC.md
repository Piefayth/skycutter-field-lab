# Field Lab DSL — v2 Specification

This document is the source of truth for v2 syntax, semantics, and validator
rules. The implementation in `dsl/parse-v2.mjs`, `dsl/validate-v2.mjs`, and
`dsl/compile-v2.mjs` should be checked against this. If the implementation and
the spec disagree, the spec wins (or the spec is updated explicitly).

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

substrate geodesic frequency 64

field u: f32
field abs_u: f32 derived

param speed   slider 0..0.29 default 0.25 label "WAVE SPEED"
param damping slider 0..0.05 default 0    label "DAMPING γ"

scenario droplet "Single droplet" { ... }
stamp ripple "Drop ripple"        { ... }

step {
  stage propagate { ... }
  stage derive_abs { ... }
}

metric peak   = max cells { abs_u }
metric active = count cells where abs_u > 0.1
```

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

### Types (reserved grammar; only `f32` implemented in v2 first cut)

- `f32` — scalar (only one fully supported)
- `vec2`, `vec3` — reserved, errors at validate time
- `u32` — reserved, errors at validate time

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

```
scenario droplet "Single droplet" {
  set u = 0
  spot u at lon=0, lat=0, radius=0.08, amount=1
}

scenario standing "Standing wave" {
  for each cell {
    set u = cos(lon * 2) * 0.6
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

## Stamps

Kept as v1's stamp construct (no `on click` unification in v2 first cut):

```
stamp ripple "Drop ripple" {
  spot u at brush.pos, radius=brush.r, amount=1
}

stamp impulse "Impulse" {
  spot v at brush.pos, radius=brush.r, amount=1
}
```

Available bindings in stamp body: `brush.pos` (current paint center as
{lon, lat}), `brush.r` (current paint radius). Stamps can target multiple
fields. Stamps CANNOT write derived fields.

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
u           # this cell, current tick
u@prev      # this cell, previous tick (triggers history allocation)
u@n         # neighbor cell, current tick (only valid inside a reduction
            # body where `n` is a bound neighbor coordinate)
```

Reserved for future:
- `u@prev(N)` for N-deep history
- `u@(continuous_pos)` for sampling at a non-cell position (advection)
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

Enforced today (split between `dsl/parse-v2.mjs` and `dsl/validate.mjs`
[v1 layer, reused] and `dsl/validate-v2.mjs`):

- Recipe must have exactly one `recipe "..."` declaration. *(parser)*
- Recipe must have exactly one `substrate ...` declaration. *(parser)*
- All names (fields, params, scenarios, stamps, stages, metrics) must be
  globally unique. *(v1 + v2 metric collision check)*
- Names cannot shadow builtins (math fns, globals, substrate helpers).
  *(v1 RESERVED_NAMES)*
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
- Vector types (`vec2`, `vec3`, `u32`) reserved; parser rejects all uses
  in v2 first cut. *(parser)*

Still TODO — partially-enforced or not yet:

- Each `cell { }` has at most one `set` per field at the same nesting
  level. *(currently lenient: last-write-wins matches v1 semantics; the
  recipe author can still do `when A { set u = X } when B { set u = Y }`
  for mutually-exclusive branches, which we want.)*
- Metric expressions produce `f32` scalar. *(top-level boolean
  expressions are now rejected — `mean cells { u > 0 }` errors with a
  redirect to `count cells where ...` or
  `mean cells { u > 0 ? 1 : 0 }`. Deep type checking inside arithmetic
  will need a real typer.)*
- Substrate-specific helpers gated by substrate type. *(only `geodesic`
  exists; non-issue until a second substrate lands.)*

## Compiler architecture

The v2 surface produces v2 AST nodes that flow through to the WGSL
compiler unchanged. Some AST shapes (NeighborReduce, stage cell
actions) are reused from the original implementation — they predate
v2 but model the same concepts. The compile path:

- `parse-v2.mjs` produces a v2 AST: CoordRead nodes for `field@coord`,
  NeighborReduce nodes carrying a `coord` binding name, plus the
  shared cell-action types (`set`, `add`, `let`, `when`).
- `validate-v2.mjs` owns ALL v2-specific semantics: flat-import
  constraint (replacing v1's namespaced `use sim cell` gating),
  derived-field rules, metric expression validation,
  explicit-previous-reads consistency.
- `validate.mjs` (originally v1) provides shape validators reused as
  utility code: `validateNameUniqueness`, `validatePresets`,
  `validateStamps`, `validateStages` check structural rules
  (reads/writes wiring, history-field single-writer-per-step) that
  apply equally in v2. The v1 namespaced import gating is bypassed
  via a `permitAll` sentinel on `schema.imports` — v2 doesn't need
  the `use NS name` machinery.
- `webgpu-geodesic-compiler.mjs`'s `compileExpr` dispatches on
  `CoordRead.coord.kind` directly. New coord kinds extend by adding
  cases here.
- The metric kernel pipeline (per-cell pass + workgroup tree-reduce)
  lives in `webgpu-geodesic-compiler.mjs` (`compileWebGpuMetric`,
  `metricReduceShader`) and `visual/webgpu-metric-runtime.mjs`.

What's NOT in v2's path anymore:
- v1 namespaced imports (`use sim cell`, `use core sin`). The user
  writes flat `import sin, cos, neighbor`; the v2 validator enforces
  it; the v1 validator's namespace gating is short-circuited.
- v1 INIT_VERBS / PIPELINE_PRIMITIVES catalog routing through to v1
  imports. Compile-v2 no longer translates v2 imports into the v1
  namespaced shape — there's no `buildV1ImportsFromV2` /
  `NAMESPACE_BY_NAME` / `V2_AUTO_INIT` / `V2_MAXIMAL_IMPORTS`.

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

All 10 v1 recipes will be rewritten to v2 syntax as part of v2 landing. v1
parser/validator stay alive in `dsl/` during development; once recipes are
fully ported, v1 files are removed.

## Deferred features

Reserved in grammar, not implemented in v2 first cut:
- `vec2`, `vec3`, `u32` field types
- `@prev(N)` for N>1
- `@(continuous_position)` sampling
- `@anti`, `@boundary` queries
- `step at Nhz` multi-rate
- Multiple substrates (square, torus, voxel)
- Eager metric evaluation (`metric x rate Nhz`)
- `let` inside metric expressions
- `on <event>` unified event handlers (replacing scenario / stamp)

## Open questions

- Multi-binding `NeighborReduce` in WGSL emitter — **DONE**.
  Cell-centered multi-field reductions like `sum n in neighbors { u@n +
  v@n - u - v }` lower correctly.
- Reduction kernel infrastructure — **DONE**. v2 metrics now compile to
  per-cell pass + workgroup-tree reduce + async readback. Per-tick the
  GPU reduces every declared metric and `state.dslMetrics[id]` is
  populated; the JS metrics panel resolves `dsl:<id>` sources against
  it. `mean` decomposes into [sum, count] primitives and the readback
  layer divides. Wave equation now uses the path
  (`metric peak = max cells { abs(u) }` etc).
- Imports — **REAL**. `import sin, cos, neighbor` constrains the recipe
  to those names; using `cos(x)` without importing `cos` errors at
  compile time. v2 imports are flat (no `from <namespace>` distinction);
  the compiler looks each name up in `dsl-spec.mjs` to route to v1's
  namespaced validator. No imports declared = all builtins in scope
  (current converted recipes work unchanged).
- Derived field UI: paint panel needs to auto-hide derived fields; views
  panel should show them. Editor concern, not DSL — wires through the
  recipe's `views[]` / paint stamp list. **Pending evidence** — only
  Kuramoto's `cosTheta` is currently derived, so the UI gap isn't yet
  user-visible.
- `wind` retired as a stage primitive — **DONE**. Recipes now express
  pressure-driven wind as a regular cell stage using two new tangent-frame
  builtins: `gradient(scalarField)` returns a vec2 of the field's
  east/north partial derivatives at the cell, and `divergence(vec2Field)`
  returns the scalar divergence. Per-(field, op) helper functions are
  emitted in the WGSL prelude when used. Parser rejects `wind` with a
  clear redirect to the cell-stage pattern.
- Editor / autocomplete v2-aware — **DONE**. Highlighter recognizes
  v2 keywords (substrate / scenario / step / for / metric / import /
  derived / previous / cells / where / at), drops v1-only ones (use /
  preset / source / setting / fill / each / event), and renders `@`
  in coordinate queries as an operator. Autocomplete classifies block
  context as v2 (cell / step / scenario / stamp), and auto-import
  inserts/extends flat `import name1, name2` lines instead of v1's
  per-namespace `use NS name` form. Docs categories updated to
  describe v2 constructs (no more "after `use core ...`" phrasing).
- Coordinate-query architecture — **DONE**. `u@prev` and `u@n` are
  first-class `CoordRead { field, coord }` AST nodes (NOT lowered to
  `Call(prev, [u])` or a synthetic Identifier). The WGSL compiler
  dispatches on `coord.kind` in `compileCoordRead` — `prev` emits
  `f_<field>_prev[cell]`, `neighbor` resolves to a per-binding local
  set up by `emitReduction`. History inference and metric-body
  validators walk for CoordRead nodes directly. Future coord kinds
  (`u@anti`, `u@prev(N)`, `u@(continuous_pos)` for advection sampling,
  `u@boundary`) extend by adding cases here — the AST stays uniform.
