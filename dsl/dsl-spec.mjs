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
//   - `field@n` (inside `<op> n in neighbors/ring/disk { ... }`) reads at neighbor n
//   - `field@upstream(velX, velY, dt)` continuous-position semi-Lagrangian
//   - math fns, neighbor reductions, position helpers (lon/lat/x/y/...)
//   - `vec2`, `length`, `gradient`, `divergence` for vec2 fields
//
// V2 has no stage primitives — every kernel operation is a cell stage.
// The parser rejects v1's `wind`/`advect`/`diffuse`/`clamp`/`normalize`
// statement forms with redirect messages pointing at the cell-stage
// equivalents (`gradient(...)`, `field@upstream(...)`, etc.).
//
// Doc strings are user-facing — what they read in the in-app docs
// window. Treat as API documentation.
// =============================================================================

// ---------------------------------------------------------------------------
// Math functions usable in any expression.
//
// Each entry is a one-stop registration that drives every consumer:
//   - dsl-spec metadata (signature / doc / example for the docs window)
//   - typecheck-v2: argTypes + returnType for type-shape checking
//   - WGSL compiler: `wgsl(args)` returns the WGSL call expression
//   - JS init runtime: `js(args, cell?)` evaluates the call at recipe-
//     scenario-time on the host. Some fns (gradient, divergence) have
//     no JS analogue and `js` is null — they're rejected upstream by
//     the init-context validator.
//
// arity is the array of allowed argument counts (`[1, 2]` means the fn
// is fine with either count). target is the legacy v1 EXPR_FUNC_TARGETS
// string ("c.foo" for the compiled cell context, "Math.foo" for the
// host) — kept for the v1 emitter that compile-v2 still routes
// through; new consumers prefer `wgsl` / `js`.
//
// Adding a new fn: drop one entry in this list. Don't touch
// typecheck-v2, the WGSL switch, or dsl-init-runtime.
// ---------------------------------------------------------------------------

const SCALAR1 = ["f32"];
const SCALAR2 = ["f32", "f32"];
const SCALAR3 = ["f32", "f32", "f32"];

// Generic "emit a passthrough WGSL call" — works for everything WGSL
// has builtin under the same name. atan2, sin, cos, exp, sqrt, pow,
// max, min, abs, smoothstep, clamp, length all fall through this.
function passthrough(name) {
  return (args) => `${name}(${args.join(", ")})`;
}

const RNG24_MASK = 0x00ffffff;
const RNG24_DENOM = 0x00ffffff;

function rngState24(value) {
  const rounded = Math.round(Number.isFinite(value) ? value : 0);
  return rounded & RNG24_MASK;
}

function rngHash24(value) {
  let x = (rngState24(value) + 0x9e3779b9) >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 2246822519) >>> 0;
  x ^= x >>> 13;
  x = Math.imul(x, 3266489917) >>> 0;
  x ^= x >>> 16;
  return x & RNG24_MASK;
}

function rngNext24(value) {
  const x = rngState24(value);
  return (Math.imul(1664525, x) + 1013904223) & RNG24_MASK;
}

export const MATH_FUNCTIONS = [
  {
    name: "max",
    target: "c.max",
    arity: [1, 2],
    argTypes: SCALAR2,    returnType: "f32",
    wgsl: passthrough("max"),
    js: (args) => Math.max(...args),
    importNamespace: "core",
    signature: "max(a, b)",
    doc: "Returns the larger of two values.",
  },
  {
    name: "min",
    target: "c.min",
    arity: [1, 2],
    argTypes: SCALAR2,    returnType: "f32",
    wgsl: passthrough("min"),
    js: (args) => Math.min(...args),
    importNamespace: "core",
    signature: "min(a, b)",
    doc: "Returns the smaller of two values.",
  },
  {
    name: "abs",
    target: "c.abs",
    arity: [1],
    argTypes: SCALAR1,    returnType: "f32",
    wgsl: passthrough("abs"),
    js: (args) => Math.abs(args[0]),
    importNamespace: "core",
    signature: "abs(x)",
    doc: "Absolute value.",
  },
  {
    name: "hypot",
    target: "Math.hypot",
    arity: [2],
    argTypes: SCALAR2,    returnType: "f32",
    // WGSL has no hypot; emit length(vec2(x, y)).
    wgsl: (args) => `length(vec2<f32>(${args[0]}, ${args[1]}))`,
    js: (args) => Math.hypot(...args),
    importNamespace: "core",
    signature: "hypot(x, y)",
    doc: "Vector magnitude — `sqrt(x² + y²)`. Used for wind magnitude, distance computations.",
  },
  {
    name: "sin",
    target: "c.sin",
    arity: [1],
    argTypes: SCALAR1,    returnType: "f32",
    wgsl: passthrough("sin"),
    js: (args) => Math.sin(args[0]),
    importNamespace: "core",
    signature: "sin(x)",
    doc: "Sine. Argument in radians.",
  },
  {
    name: "asin",
    target: "Math.asin",
    arity: [1],
    argTypes: SCALAR1,    returnType: "f32",
    wgsl: passthrough("asin"),
    js: (args) => Math.asin(args[0]),
    importNamespace: "core",
    signature: "asin(x)",
    doc: "Arcsine. Returns radians in [-π/2, π/2].",
  },
  {
    name: "cos",
    target: "c.cos",
    arity: [1],
    argTypes: SCALAR1,    returnType: "f32",
    wgsl: passthrough("cos"),
    js: (args) => Math.cos(args[0]),
    importNamespace: "core",
    signature: "cos(x)",
    doc: "Cosine. Argument in radians.",
  },
  {
    name: "atan2",
    target: "Math.atan2",
    arity: [2],
    argTypes: SCALAR2,    returnType: "f32",
    wgsl: passthrough("atan2"),
    js: (args) => Math.atan2(args[0], args[1]),
    importNamespace: "core",
    signature: "atan2(y, x)",
    doc: "Two-argument arctangent — returns the angle of the vector (x, y) in [-π, π]. Note the y-first argument order (matches WGSL / C / JS). Use to convert vec2 components into a heading angle for phase-coloring or angle-based logic.",
    example: "let heading = atan2(wind.y, wind.x)",
  },
  {
    name: "exp",
    target: "c.exp",
    arity: [1],
    argTypes: SCALAR1,    returnType: "f32",
    wgsl: passthrough("exp"),
    js: (args) => Math.exp(args[0]),
    importNamespace: "core",
    signature: "exp(x)",
    doc: "e^x.",
  },
  {
    name: "sqrt",
    target: "c.sqrt",
    arity: [1],
    argTypes: SCALAR1,    returnType: "f32",
    wgsl: passthrough("sqrt"),
    js: (args) => Math.sqrt(args[0]),
    importNamespace: "core",
    signature: "sqrt(x)",
    doc: "Square root.",
  },
  {
    name: "pow",
    target: "c.pow",
    arity: [2],
    argTypes: SCALAR2,    returnType: "f32",
    wgsl: passthrough("pow"),
    js: (args) => Math.pow(args[0], args[1]),
    importNamespace: "core",
    signature: "pow(x, n)",
    doc: "x^n.",
  },
  {
    name: "smoothstep",
    target: "c.smoothstep",
    arity: [3],
    argTypes: SCALAR3,    returnType: "f32",
    wgsl: passthrough("smoothstep"),
    js: (args, cell, helpers) => helpers.smoothstep(args[0], args[1], args[2]),
    importNamespace: "core",
    signature: "smoothstep(edge0, edge1, x)",
    doc: "Smooth Hermite interpolation. Returns 0 if x ≤ edge0, 1 if x ≥ edge1, smooth S-curve in between.",
    example: "let mix = smoothstep(0.18, 0.9, catalyst)",
  },
  {
    name: "clamp",
    target: "c.clamp",
    arity: [3],
    argTypes: SCALAR3,    returnType: "f32",
    wgsl: passthrough("clamp"),
    js: (args, cell, helpers) => helpers.clamp(args[0], args[1], args[2]),
    importNamespace: "core",
    signature: "clamp(x, lo, hi)",
    doc: "Returns x clamped to [lo, hi]. Use inside any expression — `set field = clamp(field, 0, 1)` is the v2 idiom (the v1 stage-primitive form is gone).",
    example: "let y = clamp(x, 0, 1)\nset moisture = clamp(moisture, 0, 1.4)",
  },
  {
    name: "cellNoise",
    target: "c.cellNoise",
    arity: [1, 2],
    argTypes: ["f32", "f32"], returnType: "f32",
    // Emits the spatial-noise call. The 1-arg form uses unit scale.
    wgsl: (args) => {
      if (args.length === 1) return `spatialNoise(vec3<f32>(px, py, pz), ${args[0]})`;
      return `spatialNoise((vec3<f32>(px, py, pz) * (${args[1]})), ${args[0]})`;
    },
    js: (args, cell, helpers) => {
      const seed = args[0] ?? 0;
      const scale = args.length >= 2 ? args[1] : 1;
      const px = (cell?.px ?? 0) * scale;
      const py = (cell?.py ?? 0) * scale;
      const pz = (cell?.pz ?? 0) * scale;
      return helpers.spatialNoise(px, py, pz, seed);
    },
    importNamespace: "core",
    signature: "cellNoise(seed) | cellNoise(seed, scale)",
    doc: "Stateless spatially-coherent 3D noise sampled at the cell's unit-sphere position. Geometrically correct on a sphere — no pole distortion. `scale` controls spatial frequency (default 1; higher = finer texture). Returns [-1, 1]. Same arguments always produce the same value; include `frame` in the seed deliberately when you want time variation. Use this when you want smoothly-varying noise (basins, terrain). For statistically independent per-cell values use `cellRand` instead.",
    example: "let basin = cellNoise(31, 2.5)\nadd moisture = cellNoise(frame + 17, 1.4) * amp * 0.25",
  },
  {
    name: "cellRand",
    target: "c.cellRand",
    arity: [1],
    argTypes: SCALAR1,    returnType: "f32",
    wgsl: (args) => `hashNoise(f32(i), ${args[0]})`,
    js: (args, cell, helpers) => helpers.hashNoise(cell?.i ?? 0, args[0] ?? 0),
    importNamespace: "core",
    signature: "cellRand(seed)",
    doc: "Stateless IID-ish per-cell hash: each cell produces an independent-looking value from (cell index, seed). Returns [-1, 1]. Same arguments always produce the same value and no hidden RNG state is advanced; include `frame` in the seed deliberately when you want per-tick variation. Different from `cellNoise(seed)`, which is spatially correlated (neighbors tend to have similar values). Persistent stochastic state should be modeled explicitly, not hidden behind this helper.",
    example: "set omega = cellRand(7) * omegaSpread\nlet kick = cellRand(frame + 19) * noise",
  },
  {
    name: "rand01",
    target: "c.rand01",
    arity: [1],
    argTypes: SCALAR1,    returnType: "f32",
    wgsl: (args) => `rngRand01(${args[0]})`,
    js: (args) => rngHash24(args[0] ?? 0) / RNG24_DENOM,
    importNamespace: "core",
    signature: "rand01(state)",
    doc: "Stateful-RNG draw helper. Given a per-cell RNG state value, returns a deterministic sample in [0, 1]. It does not mutate the state; pair it with `set rng = rngNext(rng)` where `rng` is usually a `field rng: u32`. The state is intentionally 24-bit so it round-trips exactly through the DSL's scalar expression space.",
    example: "let r = rand01(rng)\nset alive = r < birthRate ? 1 : alive\nset rng = rngNext(rng)",
  },
  {
    name: "rngNext",
    target: "c.rngNext",
    arity: [1],
    argTypes: SCALAR1,    returnType: "f32",
    wgsl: (args) => `rngNext24(${args[0]})`,
    js: (args) => rngNext24(args[0] ?? 0),
    importNamespace: "core",
    signature: "rngNext(state)",
    doc: "Advances a 24-bit per-cell RNG state and returns the next state as an exactly representable scalar. Store it back into a `u32` field with `set rng = rngNext(rng)`. Random draws stay explicit: use `rand01(rng)` for the sample and `rngNext(rng)` for the state transition.",
    example: "field rng: u32\nstage tick {\n  reads rng\n  writes rng\n  cell { set rng = rngNext(rng) }\n}",
  },
  {
    name: "wrapAngle",
    target: "c.wrapAngle",
    arity: [1],
    argTypes: SCALAR1,    returnType: "f32",
    // atan2(sin x, cos x) collapses any input into [-π, π] without
    // a floor / mod sign-handling dance.
    wgsl: (args) => `atan2(sin(${args[0]}), cos(${args[0]}))`,
    js: (args) => Math.atan2(Math.sin(args[0]), Math.cos(args[0])),
    importNamespace: "core",
    signature: "wrapAngle(x)",
    doc: "Wraps an angle (radians) into [-π, π]. Useful any time you accumulate phase that would otherwise grow unbounded — Kuramoto, XY model, active nematics, anywhere a `theta` keeps integrating `omega * dt`.",
    example: "set theta = wrapAngle(theta)",
  },
  {
    name: "vec2",
    target: null,        // Compile-time WGSL emit, no JS counterpart.
    arity: [2],
    argTypes: SCALAR2,    returnType: "vec2",
    wgsl: (args) => `vec2<f32>(${args[0]}, ${args[1]})`,
    // The init runtime represents vec2 values as tagged objects so
    // the expression-runtime arithmetic dispatch can detect them.
    js: (args, cell, helpers) => helpers.makeVec2(args[0], args[1]),
    importNamespace: "core",
    signature: "vec2(x, y)",
    doc: "Constructs a vec2 value from two scalars. Pair with a `field name: vec2` declaration for vector-valued fields (wind components, slope direction, etc). Components live in each cell's local tangent basis; raw neighbor reads such as `wind@n` return the neighbor's local components, not an implicitly transported vector. Component access via `.x` / `.y`. WGSL-native arithmetic: vec2 + vec2, vec2 * scalar, etc.",
    example: "field wind: vec2\nstage compute_wind {\n  reads pressure\n  writes wind\n  cell {\n    set wind = vec2(-grad_e, -grad_n) * strength\n  }\n}",
  },
  {
    name: "length",
    target: "Math.hypot",
    arity: [1],
    // length is polymorphic — accepts vec2 (returns magnitude) or
    // scalar (returns abs). Type checker handles both via "any".
    argTypes: ["any"],    returnType: "f32",
    wgsl: passthrough("length"),
    js: (args, cell, helpers) => {
      const v = args[0];
      if (helpers.isVec2(v)) return Math.hypot(v.x, v.y);
      return Math.abs(Number(v));
    },
    importNamespace: "core",
    signature: "length(v)",
    doc: "Vector magnitude. WGSL-native — works on vec2 / vec3. For scalars, use `abs`.",
    example: "let speed = length(wind)",
  },
  // Tangent-frame differential operators on the geodesic substrate.
  // These are stencil reads (gather over neighbors) compiled to per-cell
  // WGSL helpers — semantically the same as a neighbor reduction, but
  // specialized for vector calculus on the sphere. The argument MUST be
  // a bare field identifier (the compiler emits a per-(field, op)
  // helper function). Init-context evaluation is impossible (needs the
  // GPU neighbor topology); js is null and the init-subset validator
  // rejects them.
  {
    name: "gradient",
    target: null,
    arity: [1],
    argTypes: ["fieldId"], returnType: "vec2",
    wgsl: null,           // Special path in compileCall — emits a helper-fn call.
    js: null,
    importNamespace: "core",
    signature: "gradient(scalarField)",
    doc: "Tangent-frame gradient of a scalar field at the current cell, returned as `vec2(east, north)`. Computed from neighbor differences projected onto the local east/north basis. Use to express pressure-driven wind without a special primitive: `let grad = gradient(pressure); set wind = vec2(-grad.x, -grad.y) * strength`.",
    example: "let grad = gradient(pressure)\nset wind = vec2(-grad.x + cor * grad.y, -grad.y - cor * grad.x) * strength",
  },
  {
    name: "divergence",
    target: null,
    arity: [1],
    argTypes: ["fieldId"], returnType: "f32",
    wgsl: null,
    js: null,
    importNamespace: "core",
    signature: "divergence(vec2Field)",
    doc: "Tangent-frame divergence of a vec2 field — sum of east/north partial derivatives along the local tangent basis. Returns a scalar. Use for things like vertical lift (negative divergence of horizontal wind).",
    example: "set lift = -divergence(wind) * 0.7",
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
    signature: "<op> n in neighbors|ring(k)|disk(k) { EXPR with field@n }",
    doc: "Per-cell topological reduction. `neighbors` means immediate adjacency, `ring(k)` means cells at exact graph distance k, and `disk(k)` means graph distances 1..k; ring/disk currently require literal k in 1..3. For each selected cell, evaluate EXPR (which reads any field at that cell via `field@n`), then combine via op ∈ {sum, max, min, mean}. The center cell is not included. Canonical scalar diffusion uses `mean n in neighbors { u@n - u }`; broader kernels use ring/disk when the recipe intentionally wants topological distance rather than metric radius.",
    example: "let lap      = mean n in neighbors { u@n - u }\nlet smooth2  = mean n in disk(2) { u@n }\nlet shell    = sum n in ring(3) { activator@n }",
  },
  {
    name: "ring",
    signature: "<op> n in ring(k) { EXPR }",
    doc: "Exact topological shell for neighbor reductions. `ring(2)` selects cells two graph edges away from the current cell; the center and nearer shells are excluded. k must currently be a literal integer 1..3.",
  },
  {
    name: "disk",
    signature: "<op> n in disk(k) { EXPR }",
    doc: "Topological disk for neighbor reductions. `disk(2)` selects shells 1 and 2 around the current cell; the center cell is excluded. k must currently be a literal integer 1..3. This is not a metric radial kernel.",
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
    doc: "Reads FIELD's value as of the previous tick. History depth is inferred — using `u@prev` anywhere triggers triple-buffer rotation for u. History fields can be written by exactly one stage per step, and later stages cannot read that field after its writer. The writer deposits into `next`; `next` becomes current only after end-of-tick rotation. Stamps deliberately update the current buffer only — the asymmetry between current and prev is the launch velocity for wave-style fields. Use for second-order time integration: `u_new = 2*u - u@prev + c²·dt²·lap`.",
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

// V2 has no stage primitives. Every kernel operation is expressible as
// a cell stage; the parser rejects stage-level v1 primitives with a
// redirect to the cell-stage equivalent:
//   diffuse  → `add field = (mean n in neighbors { field@n } - field) * <amount>`
//   clamp    → `set field = clamp(field, <lo>, <hi>)` inside cell { }
//   wind     → `gradient(pressure)` + vec2 wind field. See dsl-spec
//              MATH_FUNCTIONS for `gradient` / `divergence`.
//   advect   → `set u = u@upstream(velX, velY, dt)` continuous-position
//              CoordRead. See "Coordinate queries" in dsl-spec for
//              the @-coord family.
//   normalize → no v2 equivalent yet (needs scalar reduction + broadcast)
export const PIPELINE_PRIMITIVES = [];

// ---------------------------------------------------------------------------
// Stage body block keywords — control-flow heads inside a stage.
// ---------------------------------------------------------------------------

export const STAGE_BLOCKS = [
  {
    name: "cell",
    // Block keyword; not an importable builtin. Leaving importNamespace
    // unset keeps `cell` out of the `import …` autocomplete and stops
    // the symbol catalog from synthesizing a bogus `import cell` line.
    signature: "cell { ... per-cell math ... }",
    doc: "Per-cell continuous math. Each cell runs the body in parallel; bare field reads come from the start-of-stage snapshot, while `add` / `set` update the output accumulator for the stage's target field. Use `let` locals for sequencing. Reaction terms, growth, decay, neighbor reductions, coordinate queries, diffusion, and advection all live here in v2. Each stage contains exactly one `cell { }` block.",
    example: "cell {\n  let lap = mean n in neighbors { u@n - u }\n  let damp = damping * (u - u@prev)\n  set u = 2 * u - u@prev + speed*speed*lap - damp\n}",
  },
];

// ---------------------------------------------------------------------------
// Init verbs — used inside `preset` and `stamp` bodies, plus `eachCell`.
// ---------------------------------------------------------------------------

export const INIT_VERBS = [
  // Note: `set` and `add` are documented under ACTION_VERBS — they
  // work the same way in scenario / stamp / cell bodies. The init-verb
  // group contains only the verbs unique to scenarios and stamps
  // (spot / ellipse / region / for).
  // Init verbs are syntactic block keywords — they appear at the front
  // of a scenario / stamp action, not as importable builtin names.
  // Leaving importNamespace unset keeps them out of the `import` line
  // autocomplete (which would otherwise synthesize bogus `import spot`
  // / `import for` lines that the v2 import validator rejects).
  {
    name: "spot",
    signature: "spot FIELD at lon=LON, lat=LAT, radius=R, amount=A",
    doc: "Adds a Gaussian spherical spot to FIELD. Inside scenarios, lon/lat are explicit. Inside stamps, use `at brush.pos, radius=brush.r, amount=A` for the brush position shorthand. Named args after `at` — `lon=`, `lat=`, `radius=`, `amount=`.",
    example: "spot u at lon=0, lat=0.5, radius=0.18, amount=1\n// stamp:\nspot u at brush.pos, radius=brush.r, amount=1",
  },
  {
    name: "ellipse",
    signature: "ellipse FIELD at lon=LON, lat=LAT, rx=RX, ry=RY, amount=A, angle=ANG",
    doc: "Adds a Gaussian elliptical spot. Like `spot` but with separate semi-axes rx (along east) and ry (along north). angle is rotation in radians.",
    example: "ellipse pressure at lon=0, lat=0, rx=0.4, ry=0.1, amount=1, angle=0.7",
  },
  {
    name: "region",
    signature: "region FIELD at lonMin=LO, lonMax=HI, latMin=LO, latMax=HI, amount=A",
    doc: "Hard-edged rectangular assign in lon/lat space. Sets every cell whose lon ∈ [lonMin, lonMax] AND lat ∈ [latMin, latMax] to amount (overwrite, not additive).",
    example: "region u at lonMin=-0.6, lonMax=0.6, latMin=0, latMax=PI/2, amount=1",
  },
  {
    name: "for",
    signature: "for each cell { ... per-cell init math ... }",
    doc: "Per-cell programmable init (scenario/stamp bodies). Has access to position coords (lon, lat, x, y, ...) for spatially-varying initialization. Inside the body use `let`, `set`, `add`, `when`. The body uses the cell-local subset of the cell-stage grammar — neighbor reductions, `gradient`/`divergence`, and coordinate queries (`@prev` / `@n` / `@upstream`) all need GPU-side stencil topology and aren't available here. Compute those in a stage cell and read the result in this scenario.",
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
    doc: "Accumulates EXPR into FIELD's output accumulator for the current cell. Bare FIELD reads inside EXPR still read the stage-input snapshot, not a prior `set` in the same block. Most reaction-term writes are `add`.",
    example: "add cloud = net * dt",
  },
  {
    name: "set",
    signature: "set FIELD = EXPR",
    doc: "Overwrites FIELD's output accumulator with EXPR for the current cell. Bare field reads inside EXPR read the stage-input snapshot. Use `let` locals when one formula needs to feed another.",
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
    doc: "Declares per-cell state. TYPE is `f32`, `vec2`, `u32`, or `bool`; `vec3` is reserved but not runtime-backed yet. `u32` and `bool` use integer storage and surface as scalar 0/1-style values in expressions; writes round/cast back to `u32`. Optional `derived` annotation marks the field as computed-by-stage — derived fields must be written by ≥1 stage and cannot be written by scenarios or stamps. History is inferred: any `field@prev` read anywhere allocates triple-buffer rotation for that field.",
    example: "field u: f32\nfield wind: vec2\nfield state: u32\nfield abs_u: f32 derived",
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
    doc: "Scalar reduction over post-step state. op ∈ {sum, max, min, mean, count}. count takes only a `where` clause (no body — the body is implicitly 1). Other reductions take a single expression; no `let` inside metric bodies, so promote intermediates to `derived` fields. Metric bodies can use math fns, neighbor reductions, and coordinate queries. Computed on the GPU each tick (per-cell pass + workgroup tree-reduce); async readback populates the metrics panel via `dsl:<id>` sources.",
    example: "metric peak   = max cells { abs(u) }\nmetric active = count cells where abs(u) > 0.1\nmetric energy = sum cells { 0.5*v*v + 0.5*c*c * sum n in neighbors { (u@n - u)*(u@n - u) } }",
  },
  {
    name: "overlay",
    signature: "overlay NAME",
    doc: "Toggleable visual overlay. One declaration per name. Currently only `grid` is registered (the geodesic graticule); future overlays (poles, lat/lon ticks, vector glyphs) will register the same way. Recipes don't author overlay content — they pick from the registered set.",
    example: "overlay grid",
  },
];

// ---------------------------------------------------------------------------
// Block keywords — introduce collapsible structural blocks.
// ---------------------------------------------------------------------------

export const BLOCK_KEYWORDS = [
  {
    name: "step",
    signature: "step { stage X { ... } stage Y { ... } ... }",
    doc: "Tick boundary. Runs every simulation tick. Stages inside execute in declaration order; ordinary field writes become visible to later stages, while history-field writes become visible only after end-of-tick rotation. Metrics dispatch after the step. Multi-rate steps (`step at Nhz { ... }`) are reserved for future v2 work.",
  },
  {
    name: "stage",
    signature: 'stage NAME [\"Label\"] { reads ... writes ... cell { ... } }',
    doc: "A pipeline stage inside `step { }`. v2 stages contain exactly one `cell { }` block (plus `reads` / `writes` clauses). Each pass reads the current buffers at dispatch; ordinary writes swap into visibility for later stages, but history-field writes wait for tick-end rotation.",
    example: 'stage propagate "Wave step" {\n  reads u\n  writes u\n  cell {\n    let lap = sum n in neighbors { u@n - u }\n    set u = 2*u - u@prev + speed*speed*lap\n  }\n}',
  },
  {
    name: "scenario",
    signature: 'scenario NAME [\"Label\"] { ... }',
    doc: "An initial-state recipe inside `scenarios { }`. Fires on Reset / on first load (if `recommendedPreset` matches its id). Body uses init verbs (`set`, `spot`, `ellipse`, `region`, `for each cell`). Scenarios cannot write `derived` fields — derived fields are computed by stages.",
    example: 'scenario droplet "Single droplet" {\n  set u = 0\n  spot u at lon=0, lat=0, radius=0.08, amount=1\n}',
  },
  {
    name: "stamp",
    signature: 'stamp NAME [\"Label\"] { ... }',
    doc: "A paint-brush composite inside `stamps { }`. User clicks the canvas with this stamp selected to apply. Body uses init verbs scoped to the click position via `brush.pos` and `brush.r`. Stamps cannot write `derived` fields. Stamps deliberately leave the prev buffer of history fields untouched — the asymmetry between current and prev is the launch velocity.",
    example: 'stamp ripple "Drop ripple" {\n  spot u at brush.pos, radius=brush.r, amount=1\n}',
  },
  {
    name: "palette",
    signature: "palette NAME { stop T color [R, G, B] ... }",
    doc: "A reusable color ramp inside `views { }`. Body lists ≥2 stops in ascending t order, with t in [0, 1] and r/g/b each in [0, 255]. Referenced by name from `view` blocks. Palettes are render-only — never read inside stage cells.",
    example: 'palette HEAT {\n  stop 0    color [12, 14, 30]\n  stop 0.5  color [240, 110, 40]\n  stop 1    color [255, 220, 90]\n}',
  },
  {
    name: "view",
    signature: 'view ID [\"Label\"] { color KIND ... }',
    doc: "A render selectable from the panel, declared inside `views { }`. Body has exactly one `color KIND ...` clause. Three kinds: `color ramp FIELD range [a, b] palette NAME` (linear lookup against a named palette or inline `stops { ... }`); `color wheel FIELD range [a, b]` (cyclic HSV cycle, range defaults to [0, 2π]); `color expr { let ... ; set red = ... ; set green = ... ; set blue = ... }` (per-cell programmable RGB — must assign all three channels at the body's root level). Range bounds accept numbers, declared `const`s, or PI / TAU.",
    example: 'view temperature "Temperature" {\n  color ramp T range [-0.8, 1.5] palette TEMP\n}\nview phase "Phase" {\n  color wheel theta range [0, TAU]\n}\nview composite "S / I / R" {\n  color expr {\n    let total = max(S + I + R, 0.000001)\n    set red   = (S / total) * 255\n    set green = (I / total) * 255\n    set blue  = (R / total) * 255\n  }\n}',
  },
  {
    name: "views",
    signature: "views { palette ... view ... overlay ... }",
    doc: "Render declaration section. Contains `palette`, `view`, and optional `overlay` declarations. Conventionally placed after `step { }` in shipped recipes and folded by default so the simulation body stays easy to scan.",
    example: 'views {\n  palette MONO {\n    stop 0 color [0, 0, 0]\n    stop 1 color [255, 255, 255]\n  }\n  view a "A" {\n    color ramp a range [0, 1] palette MONO\n  }\n}',
  },
  {
    name: "stamps",
    signature: "stamps { stamp ... }",
    doc: "Paint-brush declaration section. Contains `stamp` blocks. Conventionally placed after `step { }` in shipped recipes and folded by default.",
    example: 'stamps {\n  stamp ripple "Drop ripple" {\n    spot u at brush.pos, radius=brush.r, amount=1\n  }\n}',
  },
  {
    name: "scenarios",
    signature: "scenarios { scenario ... }",
    doc: "Initial-state declaration section. Contains `scenario` blocks. Conventionally placed after `step { }` in shipped recipes and folded by default.",
    example: 'scenarios {\n  scenario droplet "Single droplet" {\n    set u = 0\n    spot u at lon=0, lat=0, radius=0.08, amount=1\n  }\n}',
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
  // View-block modifiers — interior of `view ... { ... }`.
  { name: "color",    signature: "color KIND ...",                                doc: "Introduces the color clause inside a view. Followed by a `ramp` / `wheel` / `expr` kind plus its arguments." },
  { name: "ramp",     signature: "color ramp FIELD range [a, b] palette NAME",   doc: "Color a scalar field by remapping `range [a, b]` into a palette lookup. Range bounds accept numbers, consts, or PI / TAU. Palette is either a named `palette NAME` or an inline `stops { ... }` block." },
  { name: "wheel",    signature: "color wheel FIELD [range [a, b]]",             doc: "Color a scalar field by treating it as an angle and rotating through HSV. Range defaults to `[0, 2π]`. Use for phase / orientation / cyclic-state fields." },
  { name: "expr",     signature: "color expr { ... set red ... set green ... set blue ... }", doc: "Programmable per-cell RGB. Body uses the cell-expression grammar minus stage-only ops (no @prev/@n/@upstream, no neighbor reductions, no gradient/divergence). Must assign red, green, AND blue at the body's root level — `when`-conditional assignments aren't enough on their own." },
  { name: "range",    signature: "range [LO, HI]",                                doc: "Inclusive range for ramp/wheel mapping. Bounds accept numeric literals, declared consts, or PI / TAU. LO must differ from HI." },
  { name: "stops",    signature: "stops { stop T color [R, G, B] ... }",         doc: "Inline stop list — alternative to a named palette inside a `color ramp ... stops { ... }` clause. Same shape rules as a top-level `palette` block." },
  { name: "stop",     signature: "stop T color [R, G, B]",                       doc: "A single palette stop. T is in [0, 1] (ascending across the palette); colors are in 0..255." },
  { name: "palette",  signature: "color ramp FIELD ... palette NAME",            doc: "Inside a `color ramp` clause, references a top-level `palette NAME` declaration. Mutually exclusive with inline `stops { ... }`." },
  { name: "glyph",    signature: 'glyph "CHAR" [rotate=F] [size=F] [length=N] [stride=N]', doc: 'Optional sibling clause inside a `view` block. Rasterizes the literal character (anything the system font can draw — arrows like →, shapes like ● ○ ■ ▲ ★, letters, even emoji) and renders it on each cell. `rotate=FIELD` (vec2) orients via atan2(field.y, field.x). `size=FIELD` (scalar) scales by field magnitude. `length=N` is the base size (default 0.5, units of cell-radius). `stride=N` subsamples cells (default 1).' },
  { name: "rotate",   signature: "glyph ... rotate=VEC2_FIELD",                   doc: "Optional named arg on `glyph`. Vec2 field whose `atan2(y, x)` sets the glyph's rotation in the cell's east/north tangent plane. Most useful for `glyph arrow`; symmetric shapes (dot/square/plus) are unaffected by rotation." },
  { name: "size",     signature: "glyph ... size=SCALAR_FIELD",                   doc: "Optional named arg on `glyph`. Scalar field that multiplies glyph size per cell — magnitude > 0 required at runtime, cells with size ≈ 0 are skipped." },
  { name: "length",   signature: "glyph ... length=N",                           doc: "Optional named arg on `glyph`. Base size in units of cell-radius; total per-cell size is `length × (size_field magnitude or 1) × baseScale`. Default 0.5." },
  { name: "stride",   signature: "glyph ... stride=N",                           doc: "Optional named arg on `glyph`. Render every Nth cell only (default 1 = one glyph per cell). Higher values produce sparser glyph fields, useful when the underlying mesh resolution out-paces visual density." },
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
  // `palette` declares a top-level palette block AND appears as a
  // modifier inside a `color ramp ... palette NAME` clause.
  "palette",
  // `length` is a math fn (`length(vec2)` returns scalar magnitude) AND
  // a named arg on `arrows ... length=N` — context disambiguates.
  "length",
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

// WGSL reserved keywords that would collide if used as a bare local /
// field / param name in a recipe. The cell-shader compiler emits
// author-named locals directly into WGSL (a `let foo = ...` in the
// DSL becomes `let foo = ...` in WGSL), so a name collision produces
// an inscrutable "name `X` is a reserved keyword" error from the
// WGSL parser. Reserving them at recipe-load time turns the failure
// into a clear DSL-level rejection.
//
// Sources:
//   - Hard-reserved tokens (WGSL spec §2.6 Reserved words): the long
//     list of identifiers carved out for future-spec use.
//   - Type keywords (bool, f32, vec2, ...): used in `field x: TYPE`
//     declarations and the WGSL constructor calls.
//   - Control-flow keywords (if, else, for, while, ...): WGSL syntax.
//   - Address-space / declaration keywords (var, let, const, fn, ...).
//
// Attribute names like `align` / `binding` / `group` / `location` are
// NOT included — they're predeclared enumerants only special inside
// `@attribute(...)` position. WGSL accepts them as plain identifier
// names, so the Vicsek recipe's `align` field compiles fine.
const WGSL_RESERVED_WORDS = [
  // Declaration / module-scope
  "alias", "const", "fn", "let", "override", "requires", "struct", "var",
  // Control flow
  "break", "case", "continue", "continuing", "default", "discard",
  "else", "for", "if", "loop", "return", "switch", "while",
  // Address spaces / access modes
  "function", "private", "push_constant", "read", "read_write", "storage",
  "uniform", "workgroup", "write",
  // Scalar / vector / matrix types
  "bool", "f16", "f32", "i32", "u32", "vec2", "vec3", "vec4",
  "mat2x2", "mat2x3", "mat2x4", "mat3x2", "mat3x3", "mat3x4",
  "mat4x2", "mat4x3", "mat4x4",
  // Other type keywords
  "array", "atomic", "ptr", "sampler", "sampler_comparison", "texture_external",
  // The specific `target` reservation that triggered this list —
  // hits when recipe authors reach for it as the loop-variable name
  // ("next state" in cyclic CAs, "destination value" in updates, etc.)
  "target",
];

// Names reserved across the whole DSL — anything a recipe author cannot
// declare without breaking semantics. Driven by the spec so adding a
// math fn or stencil helper automatically reserves its name.
export const RESERVED_NAMES = new Set([
  ...LITERALS.map((s) => s.name),
  ...MATH_FUNCTIONS.map((s) => s.name),
  ...STENCIL_HELPERS.map((s) => s.name),
  ...CLOCK_HELPERS.map((s) => s.name),
  ...WGSL_RESERVED_WORDS,
]);

// All symbols flat, with an attached `kind` matching the visual catalog's
// taxonomy. Consumers downstream (visual/dsl-symbols.mjs) use this to
// build the rich Symbol entries the editor surfaces.
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
