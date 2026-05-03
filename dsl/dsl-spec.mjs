// =============================================================================
// Field Lab DSL — canonical v2 surface specification.
//
// Single source of truth for every keyword, primitive, math function,
// builtin, and modifier the recipe DSL exposes. Every user-facing
// consumer (editor highlighter, tooltips, docs window, autocomplete)
// reads `allDslSymbolsFlat()` from this module — adding a new v2
// symbol HERE makes it visible everywhere.
//
// V2 LANGUAGE SURFACE (what users see):
//   substrate      — `substrate geodesic frequency 64`
//   field          — `field u: f32 [derived]`
//   param          — `param x slider 0..1 default 0.5 label "X"`
//   const          — `const c = 2.998`
//   import         — `import sin, cos, neighbor` (optional)
//   scenario       — `scenario droplet "Single drop" { ... }`
//   stamp          — `stamp ripple "Drop ripple" { ... }`
//   step           — `step { stage propagate { reads ...; writes ...;
//                                              cell { ... } } }`
//   metric         — `metric peak = max cells [where pred] { expr }`
//
// V2 EXPRESSION SURFACE:
//   - bare identifiers resolve to fields, params, consts, locals, builtins
//   - `field@prev` reads the previous-tick value (CoordRead)
//   - `field@n` (inside `<op> n in neighbors { ... }`) reads at neighbor n
//   - math fns, neighbor reductions, position helpers (lon/lat/x/y/...)
//
// V2 STAGE PRIMITIVES (kept until coord-query / vec types replace them):
//   wind, advect — encapsulate kernels that don't fold into cell { }
//
// LEGACY v1 KEEPS THE INTERNAL CATALOG (for parse.mjs / validate.mjs
// that still serve weather.mjs), but those entries are tagged
// `v1Only: true` and filtered out of the v2 user-facing projection.
//
// Doc strings are user-facing — what they read in the in-app docs
// window. Treat as API documentation.
// =============================================================================

// ---------------------------------------------------------------------------
// Math functions usable in any expression. `target` is the runtime callee
// (`c.foo` for our compiled context, `Math.foo` for things we route
// straight to the host). `arity` lists allowed argument counts.
// ---------------------------------------------------------------------------

export const MATH_FUNCTIONS = [
  {
    name: "max",
    target: "c.max",
    arity: [1, 2],
    importNamespace: "core",
    signature: "max(a, b)",
    doc: "Returns the larger of two values.",
  },
  {
    name: "min",
    target: "c.min",
    arity: [1, 2],
    importNamespace: "core",
    signature: "min(a, b)",
    doc: "Returns the smaller of two values.",
  },
  {
    name: "abs",
    target: "c.abs",
    arity: [1],
    importNamespace: "core",
    signature: "abs(x)",
    doc: "Absolute value.",
  },
  {
    name: "hypot",
    target: "Math.hypot",
    arity: [2],
    importNamespace: "core",
    signature: "hypot(x, y)",
    doc: "Vector magnitude — `sqrt(x² + y²)`. Used for wind magnitude, distance computations.",
  },
  {
    name: "sin",
    target: "c.sin",
    arity: [1],
    importNamespace: "core",
    signature: "sin(x)",
    doc: "Sine. Argument in radians.",
  },
  {
    name: "asin",
    target: "Math.asin",
    arity: [1],
    importNamespace: "core",
    signature: "asin(x)",
    doc: "Arcsine. Returns radians in [-π/2, π/2].",
  },
  {
    name: "cos",
    target: "c.cos",
    arity: [1],
    importNamespace: "core",
    signature: "cos(x)",
    doc: "Cosine. Argument in radians.",
  },
  {
    name: "exp",
    target: "c.exp",
    arity: [1],
    importNamespace: "core",
    signature: "exp(x)",
    doc: "e^x.",
  },
  {
    name: "sqrt",
    target: "c.sqrt",
    arity: [1],
    importNamespace: "core",
    signature: "sqrt(x)",
    doc: "Square root.",
  },
  {
    name: "pow",
    target: "c.pow",
    arity: [2],
    importNamespace: "core",
    signature: "pow(x, n)",
    doc: "x^n.",
  },
  {
    name: "smoothstep",
    target: "c.smoothstep",
    arity: [3],
    importNamespace: "core",
    signature: "smoothstep(edge0, edge1, x)",
    doc: "Smooth Hermite interpolation. Returns 0 if x ≤ edge0, 1 if x ≥ edge1, smooth S-curve in between.",
    example: "let mix = smoothstep(0.18, 0.9, catalyst)",
  },
  {
    name: "clamp",
    target: "c.clamp",
    arity: [3],
    importNamespace: "core",
    // `clamp` has TWO surface forms — function and stage primitive. The
    // signature reflects both; the parser disambiguates via `(`-lookahead.
    signature: "clamp(x, lo, hi)     (function form)\nclamp FIELD LO HI    (primitive form)",
    doc: "Two surface forms. As a function (parens, in any expression): returns x clamped to [lo, hi]. As a stage primitive (no parens, top-level in stage body): clamps FIELD into [LO, HI] in one pass.",
    example: "let y = clamp(x, 0, 1)   # function\nclamp moisture 0 1.4    # primitive",
    alsoPrimitive: true,  // `PIPELINE_PRIMITIVES` doesn't list clamp again — this flag carries the dual form.
  },
  {
    name: "cellNoise",
    target: "c.cellNoise",
    arity: [1, 2],
    importNamespace: "core",
    signature: "cellNoise(seed) | cellNoise(seed, scale)",
    doc: "Spatially-coherent 3D noise sampled at the cell's unit-sphere position. Geometrically correct on a sphere — no pole distortion. `scale` controls spatial frequency (default 1; higher = finer texture). Returns [-1, 1]. In preset top-level (no cell context), falls back to a deterministic per-seed scalar — useful for randomizing spot positions. Use this when you want SMOOTHLY-VARYING noise (basins, terrain). For statistically independent per-cell values use `cellRand` instead.",
    example: "let basin = cellNoise(31, 2.5)\nadd moisture = cellNoise(frame * 0.13) * amp * 0.25",
  },
  {
    name: "cellRand",
    target: "c.cellRand",
    arity: [1],
    importNamespace: "core",
    signature: "cellRand(seed)",
    doc: "IID per-cell hash: each cell produces a statistically independent value from (cell index, seed). Returns [-1, 1]. Use for stochastic processes — heterogeneous parameters, Monte Carlo sampling, omega distributions in oscillator networks. Different from `cellNoise(seed)`, which is spatially correlated (neighbors tend to have similar values).",
    example: "set omega = cellRand(7) * omegaSpread",
  },
  {
    name: "wrapAngle",
    target: "c.wrapAngle",
    arity: [1],
    importNamespace: "core",
    signature: "wrapAngle(x)",
    doc: "Wraps an angle (radians) into [-π, π]. Useful any time you accumulate phase that would otherwise grow unbounded — Kuramoto, XY model, active nematics, anywhere a `theta` keeps integrating `omega * dt`.",
    example: "set theta = wrapAngle(theta)",
  },
];

// ---------------------------------------------------------------------------
// Stencil helpers — read neighbor cells. The validator special-cases
// these because they need a field-name as the first arg; otherwise they
// behave like math fns called inside a `each {}` body.
// ---------------------------------------------------------------------------

export const STENCIL_HELPERS = [
  {
    name: "neighbor",
    importNamespace: "core",
    // V2 surface: cell-centered neighbor reductions. The binding name
    // is a neighbor coordinate; the body reads any field at that
    // neighbor via `field@coord`. Replaces v1's field-centered
    // `neighbor MOD BIND in FIELD { EXPR }` form.
    signature: "<op> n in neighbors { EXPR with field@n }",
    doc: "Per-neighbor reduction. For each neighbor cell of the current cell, evaluate EXPR (which reads any field at that neighbor via `field@n`), then combine via op ∈ {sum, max, min, mean}. Reductions are neighbors-only — the center cell is not included. Use inside `cell { }` blocks. Examples: discrete Laplacian `mean n in neighbors { u@n } - u`; Kuramoto coupling `sum n in neighbors { sin(theta@n - theta - alpha) }`; multi-field gradient `sum n in neighbors { u@n + v@n - u - v }`.",
    example: "let lap      = mean n in neighbors { u@n } - u\nlet coupling = sum n in neighbors { sin(theta@n - theta - alpha) }\nlet onFire   = max n in neighbors { burning@n } > 0.5",
  },
];

// ---------------------------------------------------------------------------
// Time builtins. `use clock NAME` brings each as a bare identifier.
// ---------------------------------------------------------------------------

export const CLOCK_BUILTINS = [
  {
    name: "dt",
    importNamespace: "clock",
    signature: "dt",
    doc: "Tick duration in seconds (typically 1/60). Multiply rate-style accumulations by dt to get rate-per-second behavior.",
  },
  {
    name: "frame",
    importNamespace: "clock",
    signature: "frame",
    doc: "Tick counter. Use as a noise seed or a time index (`sin(frame * 0.013)`).",
  },
];

// ---------------------------------------------------------------------------
// Time-domain helpers. Function-form like math fns, but they're temporal
// state lookups rather than spatial / arithmetic operations — kept in the
// `clock` namespace alongside `dt` and `frame` for that reason.
// ---------------------------------------------------------------------------

export const CLOCK_HELPERS = [
  {
    name: "prev",
    arity: 1,
    importNamespace: "clock",
    // V2 surface: `field@prev` is a CoordRead — a first-class
    // temporal coordinate query, not a function call. The compiler
    // emits f_<field>_prev[cell] in WGSL.
    signature: "field@prev",
    doc: "Reads FIELD's value as of the previous tick. History depth is inferred — using `u@prev` anywhere triggers triple-buffer rotation for u. History fields can be written by exactly one stage per step; the writer's value becomes the next tick's `current` after end-of-tick rotation. Stamps deliberately update the current buffer only — the asymmetry between current and prev is the launch velocity for stamps targeting wave-style fields. Use for second-order time integration: the wave equation reads `u_new = 2*u - u@prev + c²·dt²·∇²u`.",
    example: "field u: f32\nstep {\n  stage propagate {\n    reads u\n    writes u\n    cell {\n      let lap = sum n in neighbors { u@n - u }\n      set u = 2 * u - u@prev + c * c * dt * dt * lap\n    }\n  }\n}",
  },
];

// ---------------------------------------------------------------------------
// Geodesic-substrate position builtins. Per-cell, `use geo NAME` to
// import. Recipe authors can shadow these by declaring a same-named
// field — the field wins per the validator's resolution order.
// ---------------------------------------------------------------------------

export const GEO_BUILTINS = [
  {
    name: "lon",
    importNamespace: "geo",
    signature: "lon",
    doc: "Longitude of the current cell, radians in [-π, π]. East-positive.",
  },
  {
    name: "lat",
    importNamespace: "geo",
    signature: "lat",
    doc: "Latitude of the current cell, radians in [-π/2, π/2]. North-positive.",
  },
  {
    name: "x",
    importNamespace: "geo",
    signature: "x",
    doc: "Equirect-projection x of the current cell, in [0, 1]. (lon + π) / 2π.",
  },
  {
    name: "y",
    importNamespace: "geo",
    signature: "y",
    doc: "Equirect-projection y of the current cell, in [0, 1]. lat / π + 0.5.",
  },
  {
    name: "u",
    importNamespace: "geo",
    signature: "u",
    doc: "Alias for `x`. Use for parametric-coordinate-flavored math.",
  },
  {
    name: "v",
    importNamespace: "geo",
    signature: "v",
    doc: "Alias for `y`. Use for parametric-coordinate-flavored math.",
  },
  {
    name: "px",
    importNamespace: "geo",
    signature: "px",
    doc: "Cartesian x of the cell on the unit sphere, in [-1, 1].",
  },
  {
    name: "py",
    importNamespace: "geo",
    signature: "py",
    doc: "Cartesian y of the cell on the unit sphere, in [-1, 1]. py = sin(lat).",
  },
  {
    name: "pz",
    importNamespace: "geo",
    signature: "pz",
    doc: "Cartesian z of the cell on the unit sphere, in [-1, 1].",
  },
  {
    name: "i",
    importNamespace: "geo",
    signature: "i",
    doc: "Cell index in [0, N). Stable across frames; useful as a per-cell salt for noise.",
  },
];

// ---------------------------------------------------------------------------
// Geodesic constants. Tagged separately from per-cell positions because
// they're scalar, not per-cell.
// ---------------------------------------------------------------------------

export const GEO_CONSTANTS = [
  {
    name: "N",
    importNamespace: "geo",
    signature: "N",
    doc: "Total cell count of the current grid.",
  },
  {
    name: "PI",
    importNamespace: "geo",
    signature: "PI",
    doc: "π ≈ 3.14159. Use to express angular extents in radians.",
  },
  {
    name: "TAU",
    importNamespace: "geo",
    signature: "TAU",
    doc: "2π ≈ 6.28319. One full revolution in radians.",
  },
];

// ---------------------------------------------------------------------------
// Stamp-context extras. Inside a stamp body, the brush radius `r` is
// implicit. Otherwise stamps see the full GEO_BUILTINS surface so
// `lon`, `lat`, etc. resolve to the click position.
// ---------------------------------------------------------------------------

export const STAMP_EXTRAS = [
  {
    name: "r",
    importNamespace: null,
    // V2 form: `brush.r` reads the radius; the parser lowers it to
    // bare `r` to match the v1 stamp environment that the runtime
    // already binds. Recipe authors should write `brush.r` (and
    // `brush.pos` for the position) — see stamp examples.
    signature: "brush.r",
    doc: "Brush angular radius in radians (stamp body only). Typed by the user via the RADIUS slider. Use as `brush.r` for clarity (`brush.r * 1.4` for sub-spots). The companion `brush.pos` shorthand expands to lon=brush.pos, lat=brush.pos in spot/ellipse `at` clauses.",
    example: "spot u at brush.pos, radius=brush.r, amount=1\nspot v at brush.pos, radius=brush.r * 1.6, amount=0.4",
    stampOnly: true,
  },
];

// ---------------------------------------------------------------------------
// Pipeline primitives. Top-level statements inside a stage body. Each
// has bespoke parsing (see `parsePrimitiveLine` in parse.mjs); the spec
// entry powers tooltips / docs / autocomplete + serves as documentation.
// ---------------------------------------------------------------------------

export const PIPELINE_PRIMITIVES = [
  {
    name: "wind",
    importNamespace: "sim",
    signature: "wind PRESSURE -> windU, windV[, lift] strength EXPR",
    doc: "Pressure-gradient wind primitive. Reads PRESSURE; writes velocity (windU, windV) and divergence (lift) in tangent-frame coordinates. Includes a Coriolis term based on latitude. Stays as a v2 primitive until vector field types arrive — at which point it'll become a regular cell stage with `set wind = vec2(...)`.",
    example: "stage compute_wind {\n  reads pressure\n  writes windU, windV, lift\n  wind pressure -> windU, windV, lift strength windStrength\n}",
  },
  {
    name: "advect",
    importNamespace: "sim",
    signature: "advect FIELD by windU, windV dt EXPR",
    doc: "Semi-Lagrangian transport of FIELD by velocity (windU, windV). Per-tick displacement = velocity·EXPR. Stays as a v2 primitive until continuous-position coordinate queries arrive (`field@(self - velocity*dt)`) — at which point it'll become a regular cell stage.",
    example: "stage flow {\n  reads moisture, windU, windV\n  writes moisture\n  advect moisture by windU, windV dt dt * 1.0\n}",
  },
  // diffuse / clamp / normalize are deliberately ABSENT from the v2
  // surface. The parser rejects them with a redirect:
  //   diffuse → `add field = (mean n in neighbors { field@n } - field) * <amount>`
  //   clamp   → `set field = clamp(field, <lo>, <hi>)` inside cell { }
  //   normalize → no v2 equivalent yet (needs scalar reduction + broadcast)
];

// ---------------------------------------------------------------------------
// Stage body block keywords — control-flow heads inside a stage.
// ---------------------------------------------------------------------------

export const STAGE_BLOCKS = [
  {
    name: "cell",
    importNamespace: "sim",
    signature: "cell { ... per-cell math ... }",
    doc: "Per-cell continuous math. Each cell runs the body in parallel; reads field values from the start-of-stage snapshot, writes via `add` (accumulate) or `set` (overwrite). Use for reaction terms, growth, decay, neighbor reductions, coordinate queries — every per-cell computation in v2 lives here. v2 stages contain exactly one `cell { }` block; sequencing within the cell is via `let` locals.",
    example: "cell {\n  let lap = mean n in neighbors { u@n } - u\n  let damp = damping * (u - u@prev)\n  set u = 2 * u - u@prev + speed*speed*lap - damp\n}",
  },
  // `each` and `event` are v1 block forms. v2 has only `cell { }` with
  // optional `when` blocks for predicates; emit-style events are
  // expressed as metrics instead (`metric x = count cells where ...`).
];

// ---------------------------------------------------------------------------
// Init verbs — used inside `preset` and `stamp` bodies, plus `eachCell`.
// ---------------------------------------------------------------------------

export const INIT_VERBS = [
  // Note: `set` and `add` are documented under ACTION_VERBS — they
  // work the same way in scenario / stamp / cell bodies. The init-verb
  // group contains only the verbs unique to scenarios and stamps
  // (spot / ellipse / region / for).
  {
    name: "spot",
    importNamespace: "init",
    signature: "spot FIELD at lon=LON, lat=LAT, radius=R, amount=A",
    doc: "Adds a Gaussian spherical spot to FIELD. Inside scenarios, lon/lat are explicit. Inside stamps, use `at brush.pos, radius=brush.r, amount=A` for the brush position shorthand. Named args after `at` — `lon=`, `lat=`, `radius=`, `amount=`.",
    example: "spot u at lon=0, lat=0.5, radius=0.18, amount=1\n// stamp:\nspot u at brush.pos, radius=brush.r, amount=1",
  },
  {
    name: "ellipse",
    importNamespace: "init",
    signature: "ellipse FIELD at lon=LON, lat=LAT, rx=RX, ry=RY, amount=A, angle=ANG",
    doc: "Adds a Gaussian elliptical spot. Like `spot` but with separate semi-axes rx (along east) and ry (along north). angle is rotation in radians.",
    example: "ellipse pressure at lon=0, lat=0, rx=0.4, ry=0.1, amount=1, angle=0.7",
  },
  {
    name: "region",
    importNamespace: "init",
    signature: "region FIELD at lonMin=LO, lonMax=HI, latMin=LO, latMax=HI, amount=A",
    doc: "Hard-edged rectangular assign in lon/lat space. Sets every cell whose lon ∈ [lonMin, lonMax] AND lat ∈ [latMin, latMax] to amount (overwrite, not additive).",
    example: "region u at lonMin=-0.6, lonMax=0.6, latMin=0, latMax=PI/2, amount=1",
  },
  {
    name: "for",
    importNamespace: "init",
    signature: "for each cell { ... per-cell init math ... }",
    doc: "Per-cell programmable init (scenario/stamp bodies). Has access to position coords (lon, lat, x, y, ...) for spatially-varying initialization. Inside the body use `let`, `set`, `add`, `when`. Replaces v1's `eachCell { }`.",
    example: "scenario standing {\n  for each cell {\n    set u = cos(lon * 2) * 0.6\n  }\n}",
  },
];

// ---------------------------------------------------------------------------
// Action verbs inside per-cell bodies (cell / event / each / eachCell).
// Always in scope — no `use` required.
// ---------------------------------------------------------------------------

export const ACTION_VERBS = [
  {
    name: "let",
    signature: "let NAME = EXPR",
    doc: "Declares a per-cell local. Single-assignment within the block. Values can reference any in-scope identifier.",
    example: "let cubic = u * (1 - u) * (u - threshold)",
  },
  {
    name: "add",
    signature: "add FIELD = EXPR",
    doc: "Accumulates EXPR into FIELD for the current cell. Reads the field's pre-stage value, writes pre + EXPR. Most reaction-term writes are `add`.",
    example: "add cloud = net * dt",
  },
  {
    name: "set",
    signature: "set FIELD = EXPR",
    doc: "Overwrites FIELD with EXPR for the current cell. Use for state transitions (events) or saturation (`set cloud = clamp(...)`).",
    example: "set burning = 1",
  },
];

// ---------------------------------------------------------------------------
// Top-level decl directives. Always in scope.
// ---------------------------------------------------------------------------

export const DECL_DIRECTIVES = [
  {
    name: "recipe",
    signature: 'recipe "Display name"',
    doc: "Names the recipe. First thing in every DSL file.",
    example: 'recipe "Belousov-Zhabotinsky"',
  },
  {
    name: "summary",
    signature: 'summary "One-line description of the simulation."',
    doc: "One-paragraph summary shown in the recipe picker. Keep under ~200 chars.",
  },
  {
    name: "recommendedPreset",
    signature: "recommendedPreset SCENARIO_ID",
    doc: "Which scenario to apply on first load. Must match a `scenario X` id.",
    example: "recommendedPreset droplet",
  },
  {
    name: "substrate",
    signature: "substrate geodesic frequency N",
    doc: "Defines the simulation substrate. Currently only `geodesic` is supported (icosahedron-subdivided sphere mesh). N is the subdivision frequency — N=64 produces ~40k cells. Future substrates (square, torus, voxel) reuse the same syntax with different topology.",
    example: "substrate geodesic frequency 64",
  },
  {
    name: "field",
    signature: "field NAME: TYPE [derived]",
    doc: "Declares per-cell state. TYPE is `f32` for now (`vec2`, `vec3`, `u32` reserved). Optional `derived` annotation marks the field as computed-by-stage — derived fields must be written by ≥1 stage and cannot be written by scenarios or stamps. History is inferred: any `field@prev` read anywhere allocates triple-buffer rotation for that field.",
    example: "field u: f32\nfield abs_u: f32 derived",
  },
  {
    name: "const",
    signature: "const NAME = VALUE",
    doc: "Recipe-shipped numeric constant. Stage-readable by bare name. Immutable. Use the `=` form (v1's `const NAME VALUE` no-equals form is rejected).",
    example: "const c = 2.998\nconst PI_HALF = 1.5707963",
  },
  {
    name: "import",
    signature: "import name1, name2, ...",
    doc: "Optional flat import list. When present, ONLY listed builtin names are accessible (math fns, neighbor reductions, clock helpers, position helpers). Unknown imports error fast. When the recipe declares no `import` line, all builtins are in scope by default — every shipped recipe takes that path.",
    example: "import sin, cos, neighbor, prev, smoothstep",
  },
  {
    name: "param",
    signature: 'param NAME slider LO..HI [step S] default V label "L"',
    doc: "Stage-readable knob. Numeric form: `slider LO..HI [step S] default V`. Boolean form: `toggle default true|false`. Renders in the side panel; read by bare name in stages and metric expressions.",
    example: 'param speed slider 0..0.29 step 0.005 default 0.25 label "WAVE SPEED"\nparam enableForcing toggle default true label "FORCING"',
  },
  {
    name: "metric",
    signature: "metric NAME = <op> cells [where PRED] { EXPR }",
    doc: "Scalar reduction over post-step state. op ∈ {sum, max, min, mean, count}. count takes only a `where` clause (no body — the body is implicitly 1). Other reductions take a body expression. The body uses the full cell-expression grammar (math fns, neighbor reductions, coordinate queries). Computed on the GPU each tick (per-cell pass + workgroup tree-reduce); async readback populates the metrics panel via `dsl:<id>` sources.",
    example: "metric peak   = max cells { abs(u) }\nmetric active = count cells where abs(u) > 0.1\nmetric energy = sum cells { 0.5*v*v + 0.5*c*c * sum n in neighbors { (u@n - u)*(u@n - u) } }",
  },
];

// ---------------------------------------------------------------------------
// Block keywords — introduce stage / preset / stamp blocks.
// ---------------------------------------------------------------------------

export const BLOCK_KEYWORDS = [
  {
    name: "step",
    signature: "step { stage X { ... } stage Y { ... } ... }",
    doc: "Tick boundary. Runs every simulation tick; stages inside execute in declaration order. End-of-step is when history fields rotate and metrics dispatch their reduce passes. Multi-rate steps (`step at Nhz { ... }`) are reserved for future v2 work.",
  },
  {
    name: "stage",
    signature: 'stage NAME [\"Label\"] { reads ... writes ... cell { ... } }',
    doc: "A pipeline stage inside `step { }`. v2 stages contain exactly one `cell { }` block (plus `reads`/`writes` clauses). The legacy stage primitives `wind` and `advect` may also appear as the only body (for kernels that don't fold into cell expressions yet).",
    example: 'stage propagate "Wave step" {\n  reads u\n  writes u\n  cell {\n    let lap = sum n in neighbors { u@n - u }\n    set u = 2*u - u@prev + speed*speed*lap\n  }\n}',
  },
  {
    name: "scenario",
    signature: 'scenario NAME [\"Label\"] { ... }',
    doc: "An initial-state recipe. Fires on Reset / on first load (if `recommendedPreset` matches its id). Body uses init verbs (`set`, `spot`, `ellipse`, `region`, `for each cell`). Scenarios cannot write `derived` fields — derived fields are computed by stages.",
    example: 'scenario droplet "Single droplet" {\n  set u = 0\n  spot u at lon=0, lat=0, radius=0.08, amount=1\n}',
  },
  {
    name: "stamp",
    signature: 'stamp NAME [\"Label\"] { ... }',
    doc: "A paint-brush composite. User clicks the canvas with this stamp selected to apply. Body uses init verbs scoped to the click position via `brush.pos` and `brush.r`. Stamps cannot write `derived` fields. Stamps deliberately leave the prev buffer of history fields untouched — the asymmetry between current and prev is the launch velocity.",
    example: 'stamp ripple "Drop ripple" {\n  spot u at brush.pos, radius=brush.r, amount=1\n}',
  },
];

// ---------------------------------------------------------------------------
// Stage I/O list keywords.
// ---------------------------------------------------------------------------

export const STAGE_IO_KEYWORDS = [
  {
    name: "reads",
    signature: "reads field1, field2, ...",
    doc: "Lists fields the stage's body reads. Required — used by the compiler for dependency analysis and to decide which buffers to bind.",
  },
  {
    name: "writes",
    signature: "writes field1, field2, ...",
    doc: "Lists fields the stage's body mutates via `add`/`set`. Required — names must already be declared via `field`.",
  },
  {
    name: "declares",
    signature: "declares field1, field2, ...",
    doc: "Declares NEW fields produced by this stage's primitive (e.g. `wind` declares `windU`, `windV`, `lift`). Allocated automatically.",
  },
];

// ---------------------------------------------------------------------------
// Control-flow keywords inside body blocks.
// ---------------------------------------------------------------------------

export const CONTROL_KEYWORDS = [
  {
    name: "when",
    signature: "when CONDITION { ... }",
    doc: "Conditional block inside `cell` / `each` / `eachCell`. Body runs only on cells where CONDITION evaluates truthy.",
    example: "when params.enableForcing and forcing > 0 {\n  set moisture = ...\n}",
  },
  { name: "if",   signature: "if CONDITION { ... } else { ... }", doc: "Reserved keyword; currently use `when` for conditional bodies. The parser recognises `if`/`else` for future expansion." },
  { name: "else", signature: "else { ... }",                        doc: "Reserved keyword paired with `if`." },
];

// ---------------------------------------------------------------------------
// Logical operators.
// ---------------------------------------------------------------------------

export const LOGICAL_OPS = [
  { name: "and", signature: "EXPR and EXPR", doc: "Logical AND. Compiles to `&&`." },
  { name: "or",  signature: "EXPR or EXPR",  doc: "Logical OR. Compiles to `||`." },
  { name: "not", signature: "not EXPR",      doc: "Logical NOT. Compiles to `!`." },
];

// ---------------------------------------------------------------------------
// Literals.
// ---------------------------------------------------------------------------

export const LITERALS = [
  { name: "true",      signature: "true",      doc: "Boolean literal." },
  { name: "false",     signature: "false",     doc: "Boolean literal." },
  { name: "null",      signature: "null",      doc: "Null literal." },
  { name: "undefined", signature: "undefined", doc: "Undefined literal." },
];

// ---------------------------------------------------------------------------
// Trailing-arg modifiers used by primitives, init verbs, and param decls.
// ---------------------------------------------------------------------------

export const MODIFIERS = [
  // v2 stage I/O annotations
  { name: "previous", signature: "reads u previous",                             doc: "Marks a `reads` entry as a previous-tick read. Optional — history depth is inferred from `field@prev` usage. Use the explicit form to document intent; when present, the validator checks the explicit list bidirectionally against inferred uses." },
  { name: "derived",  signature: "field NAME: TYPE derived",                     doc: "Annotates a field as computed-by-stage. Derived fields must be in `writes` of ≥1 stage; cannot be written by scenarios or stamps. Used for fields that are pure functions of other state." },
  // v2 metric reduction shape
  { name: "cells",    signature: "metric x = <op> cells [where PRED] { EXPR }", doc: "Marks a grid-level reduction. Required after the reduction op in a metric declaration." },
  { name: "where",    signature: "metric x = <op> cells where PRED { ... }",    doc: "Predicate that filters cells contributing to the reduction. Available on every metric op; for `count`, it's the only argument." },
  // v2 init-verb arg keywords
  { name: "at",       signature: "spot FIELD at lon=L, lat=L, radius=R, amount=A", doc: "Introduces named-arg position arguments to spot/ellipse/region. Inside stamps, also accepts `brush.pos` shorthand." },
  // v2 stage primitive args
  { name: "by",       signature: "advect FIELD by U, V dt EXPR",                doc: "Velocity-fields modifier on `advect`. Names the two scalar fields used as east/north components." },
  { name: "strength", signature: "wind ... strength EXPR",                       doc: "Multiplicative gain on the `wind` primitive." },
  // Spot/ellipse arg names (used as `name=value`)
  { name: "amount",   signature: "spot ... amount=EXPR",                         doc: "Magnitude on init verbs. Negative amounts subtract." },
  { name: "radius",   signature: "spot ... radius=EXPR",                         doc: "Angular radius for `spot` (radians). Use `brush.r` in stamps for the user-set brush radius." },
  { name: "rx",       signature: "ellipse ... rx=EXPR ry=EXPR",                  doc: "Semi-axis along east for `ellipse` (radians)." },
  { name: "ry",       signature: "ellipse ... rx=EXPR ry=EXPR",                  doc: "Semi-axis along north for `ellipse` (radians)." },
  { name: "angle",    signature: "ellipse ... angle=EXPR",                       doc: "Rotation of the ellipse in radians (0 = aligned to east)." },
  // Param decl modifiers
  { name: "slider",   signature: "param NAME slider LO..HI default V",           doc: "Renders the param as a numeric slider. Range form is `LO..HI` (no `min`/`max` keywords)." },
  { name: "toggle",   signature: "param NAME toggle default true|false",         doc: "Renders the param as a checkbox." },
  { name: "label",    signature: 'param ... label "DISPLAY LABEL"',              doc: "Display label shown next to the control in the side panel." },
  { name: "step",     signature: "param ... step EXPR",                          doc: "Slider step size — granularity of slider drags. Also the v2 tick-block keyword (`step { ... }`); context disambiguates." },
  { name: "default",  signature: "param ... default V",                          doc: "Default value at recipe load. Numeric for sliders, true/false for toggles." },
];

// ---------------------------------------------------------------------------
// Grid declaration sub-keywords.
// ---------------------------------------------------------------------------

// V2 substrate sub-keywords. The top-level `substrate` directive lives
// in DECL_DIRECTIVES; these are the trailing arg keywords that follow.
export const GRID_KEYWORDS = [
  {
    name: "geodesic",
    signature: "substrate geodesic frequency N",
    doc: "Geodesic substrate marker. Subdivides an icosahedron and welds shared cells. Cell count ≈ 10·N² + 2 — N=64 is ~40k cells.",
  },
  {
    name: "frequency",
    signature: "substrate geodesic frequency N",
    doc: "Geodesic subdivision frequency. Higher = more cells, higher resolution, more compute.",
  },
];

// ---------------------------------------------------------------------------
// Internal coverage-check. Module-load-time assertion that no two
// canonical groups have a duplicate name (which would imply spec drift
// or a typo in this file). Cheap; runs once on import.
// ---------------------------------------------------------------------------

// Names that legitimately appear in two groups because v2 syntax
// reuses the keyword in different roles. The user sees them as one
// concept; the catalog tracks them separately so docs can describe
// both uses. Adding entries here is OK — but only when the dual role
// is genuinely user-facing, not an internal accident.
const DUAL_USE_NAMES = new Set([
  // `step` opens a tick-block AND modifies a param slider's granularity.
  "step",
]);

(function assertSpecUnique() {
  const seen = new Map();
  function track(group, items) {
    for (const item of items) {
      if (!item.name) throw new Error(`dsl-spec: ${group} entry missing name`);
      const prior = seen.get(item.name);
      if (prior && prior !== group && !DUAL_USE_NAMES.has(item.name)) {
        throw new Error(`dsl-spec: name "${item.name}" appears in both "${prior}" and "${group}" — group lookup would be ambiguous (add to DUAL_USE_NAMES if intentional)`);
      }
      seen.set(item.name, group);
    }
  }
  // `clamp` deliberately appears in MATH_FUNCTIONS with `alsoPrimitive: true`,
  // not in PIPELINE_PRIMITIVES, so the check still finds a single canonical
  // entry.
  track("MATH_FUNCTIONS", MATH_FUNCTIONS);
  track("STENCIL_HELPERS", STENCIL_HELPERS);
  track("CLOCK_BUILTINS", CLOCK_BUILTINS);
  track("CLOCK_HELPERS", CLOCK_HELPERS);
  track("GEO_BUILTINS", GEO_BUILTINS);
  track("GEO_CONSTANTS", GEO_CONSTANTS);
  track("STAMP_EXTRAS", STAMP_EXTRAS);
  track("PIPELINE_PRIMITIVES", PIPELINE_PRIMITIVES);
  track("STAGE_BLOCKS", STAGE_BLOCKS);
  track("INIT_VERBS", INIT_VERBS);
  track("ACTION_VERBS", ACTION_VERBS);
  track("DECL_DIRECTIVES", DECL_DIRECTIVES);
  track("BLOCK_KEYWORDS", BLOCK_KEYWORDS);
  track("STAGE_IO_KEYWORDS", STAGE_IO_KEYWORDS);
  track("CONTROL_KEYWORDS", CONTROL_KEYWORDS);
  track("LOGICAL_OPS", LOGICAL_OPS);
  track("LITERALS", LITERALS);
  track("MODIFIERS", MODIFIERS);
  track("GRID_KEYWORDS", GRID_KEYWORDS);
})();

// ---------------------------------------------------------------------------
// Convenience helpers for consumers.
// ---------------------------------------------------------------------------

// Names reserved across the whole DSL — anything a recipe author cannot
// declare without breaking semantics. Driven by the spec so adding a
// math fn or stencil helper automatically reserves its name.
export const RESERVED_NAMES = new Set([
  ...LITERALS.map((s) => s.name),
  ...MATH_FUNCTIONS.map((s) => s.name),
  ...STENCIL_HELPERS.map((s) => s.name),
  ...CLOCK_HELPERS.map((s) => s.name),
]);

// All symbols flat, with an attached `kind` matching the visual catalog's
// taxonomy. Consumers downstream (visual/dsl-symbols.mjs) use this to
// build the rich Symbol entries the editor surfaces.
//
// Math fns with `alsoPrimitive: true` (currently only `clamp`) are
// emitted twice — once with kind "mathFn" (so they're suggested in
// expression contexts) and once with kind "primVerb" (so they're
// suggested at stage-header level). Both records share the same name
// and doc; the docs window happily files them under both categories.
export function allDslSymbolsFlat() {
  const out = [];
  const push = (group, kind, items, extra = {}) => {
    for (const item of items) out.push({ ...item, kind, group, ...extra });
  };
  push("MATH_FUNCTIONS",     "mathFn",        MATH_FUNCTIONS);
  push("STENCIL_HELPERS",    "mathFn",        STENCIL_HELPERS);
  push("CLOCK_BUILTINS",     "builtin",       CLOCK_BUILTINS);
  push("CLOCK_HELPERS",      "mathFn",        CLOCK_HELPERS);
  push("GEO_BUILTINS",       "builtin",       GEO_BUILTINS);
  push("GEO_CONSTANTS",      "mathConst",     GEO_CONSTANTS);
  push("STAMP_EXTRAS",       "builtin",       STAMP_EXTRAS);
  push("PIPELINE_PRIMITIVES","primVerb",      PIPELINE_PRIMITIVES);
  // Dual-form math fns also surface as primitives at the stage-header
  // level. Emitted via the PIPELINE_PRIMITIVES group so the catalog's
  // category mapping files them under "Pipeline primitives".
  push(
    "PIPELINE_PRIMITIVES",
    "primVerb",
    MATH_FUNCTIONS.filter((m) => m.alsoPrimitive),
  );
  push("STAGE_BLOCKS",       "controlKw",     STAGE_BLOCKS);
  push("INIT_VERBS",         "initVerb",      INIT_VERBS);
  push("ACTION_VERBS",       "actionVerb",    ACTION_VERBS);
  push("DECL_DIRECTIVES",    "declKeyword",   DECL_DIRECTIVES);
  push("BLOCK_KEYWORDS",     "blockKeyword",  BLOCK_KEYWORDS);
  push("STAGE_IO_KEYWORDS",  "declarationKw", STAGE_IO_KEYWORDS);
  push("CONTROL_KEYWORDS",   "controlKw",     CONTROL_KEYWORDS);
  push("LOGICAL_OPS",        "logicalOp",     LOGICAL_OPS);
  push("LITERALS",           "literal",       LITERALS);
  push("MODIFIERS",          "modifier",      MODIFIERS);
  push("GRID_KEYWORDS",      "gridKeyword",   GRID_KEYWORDS);
  return out;
}
