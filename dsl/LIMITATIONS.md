# Field Lab Known Limitations

This file tracks limitations we have actually hit while building recipes. The
goal is to keep recipe failures and missing abstractions visible instead of
rediscovering them through tuning.

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

We should not silently change `field@n` semantics because existing recipes may
rely on literal component reads.

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
