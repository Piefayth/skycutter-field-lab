// =============================================================================
// Field Lab DSL — canonical surface specification.
//
// Single source of truth for every keyword, primitive, math function,
// builtin, and modifier the recipe DSL exposes. Every consumer
// (parser, expression compiler, validator, editor highlighter, tooltip,
// docs window, autocomplete) reads from this module — adding a new
// symbol HERE makes it visible everywhere.
//
// Adding e.g. a new math function: append an entry to MATH_FUNCTIONS
// with `name`, `target` (compile-time callee), `arity`, signature and
// doc. The expression parser's lookup, the validator's reserved-name
// check, and the visual catalog will all pick it up automatically.
//
// Adding a new pipeline primitive: append to PIPELINE_PRIMITIVES, then
// extend `parsePrimitiveLine` in `parse.mjs` and the WGSL compiler.
// The spec entry doesn't auto-generate a parser regex (parsing each
// primitive is bespoke), but the docs/tooltip/autocomplete infrastructure
// will surface the symbol the moment it lives in the spec.
//
// Doc strings are intentionally rich — they're what the user reads in
// the in-app docs window. Treat them as user-facing API documentation.
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
    name: "noise",
    target: "c.noise",
    arity: [1],
    importNamespace: "core",
    signature: "noise(seed)",
    doc: "Spatially-coherent 3D hash noise. Uses the cell's (px, py, pz) plus seed. Returns [-1, 1]. Seed by `frame * something` to vary in time.",
    example: "add moisture = noise(frame * 0.13) * amp * 0.25",
  },
  {
    name: "noise2",
    target: "c.noise2",
    arity: [2],
    importNamespace: "core",
    signature: "noise2(x, y)",
    doc: "2D hash noise (preset eachCell only — not available in stage bodies). Use over (lon, lat) for spatially-coherent random init.",
    example: "set moistureSeed = noise2(lon * 1.4, lat * 1.7)",
  },
];

// ---------------------------------------------------------------------------
// Stencil helpers — read neighbor cells. The validator special-cases
// these because they need a field-name as the first arg; otherwise they
// behave like math fns called inside a `each {}` body.
// ---------------------------------------------------------------------------

export const STENCIL_HELPERS = [
  {
    name: "sample",
    arity: 3,
    importNamespace: "core",
    signature: "sample(field, dx, dy)",
    doc: "Reads FIELD at the cell's neighbor offset (dx, dy). Used inside `each` blocks for stencil computations.",
  },
  {
    name: "neighborMax",
    arity: 1,
    importNamespace: "core",
    signature: "neighborMax(field)",
    doc: "Maximum value of FIELD across the current cell's neighbors. Useful for threshold-spread events (fire spread, wave propagation).",
    example: "event when tree > 0.5 and neighborMax(burning) > 0.5 { set burning = 1 }",
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
    importNamespace: null,  // Stamp-only — no `use` line needed.
    signature: "r",
    doc: "Brush angular radius in radians (stamp body only). Typed by the user via the RADIUS slider; multiply with `r * 1.4` etc. to size sub-spots.",
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
    signature: "wind PRESSURE -> windU, windV, lift strength EXPR",
    doc: "Pressure-gradient wind primitive. Reads PRESSURE; writes velocity (windU, windV) and divergence (lift) in tangent-frame coordinates. Includes Coriolis based on latitude.",
    example: "wind pressure -> windU, windV, lift strength windStrength",
  },
  {
    name: "advect",
    importNamespace: "sim",
    signature: "advect FIELD by windU, windV dt EXPR",
    doc: "Semi-Lagrangian transport of FIELD by velocity (windU, windV). Per-tick displacement = velocity * EXPR.",
    example: "advect moisture by windU, windV dt dt * 1.0",
  },
  {
    name: "diffuse",
    importNamespace: "sim",
    signature: "diffuse FIELD amount EXPR",
    doc: "Laplacian smoothing — each cell averages with its neighbors weighted by EXPR. Stable for amount in [0, 1].",
    example: "diffuse moisture amount diffusion * 0.34 * dt",
  },
  // `clamp` is also documented under MATH_FUNCTIONS with the dual-form
  // signature so we don't list it twice. The catalog merges them.
  {
    name: "normalize",
    importNamespace: "sim",
    signature: "normalize FIELD damping EXPR when CONDITION",
    doc: "Damping toward zero-mean. NOTE: not yet wired on geodesic — currently throws if the `when` condition fires. Track for the reductions roadmap.",
  },
];

// ---------------------------------------------------------------------------
// Stage body block keywords — control-flow heads inside a stage.
// ---------------------------------------------------------------------------

export const STAGE_BLOCKS = [
  {
    name: "cell",
    importNamespace: "sim",
    signature: "cell { ... per-cell math ... }",
    doc: "Per-cell continuous math. Each cell runs the body in parallel; reads field values from the input snapshot, writes via `add` (accumulate) or `set` (overwrite). Use for reaction terms, growth, decay, etc.",
  },
  {
    name: "event",
    importNamespace: "sim",
    signature: "event when CONDITION { ... }",
    doc: "Discrete per-cell event. Body runs only on cells where CONDITION is true. Increments an atomic counter so the metric strip can show event rates.",
    example: "event when tree > 0.5 and neighborMax(burning) > 0.5 {\n  set burning = 1\n  set tree = 0\n}",
  },
  {
    name: "each",
    importNamespace: "sim",
    signature: "each { ... per-cell side-effect ... }",
    doc: "Like `cell`, but for stages that READ neighbors via `sample` or `neighborMax`. No event accounting — use for stencil reads that don't fire discrete events.",
  },
];

// ---------------------------------------------------------------------------
// Init verbs — used inside `preset` and `stamp` bodies, plus `eachCell`.
// ---------------------------------------------------------------------------

export const INIT_VERBS = [
  {
    name: "fill",
    importNamespace: "init",
    signature: "fill FIELD VALUE",
    doc: "Sets every cell of FIELD to VALUE. Runs at preset/stamp time. VALUE can be any constant expression.",
    example: "fill u 0\nfill catalyst 0.5",
  },
  {
    name: "spot",
    importNamespace: "init",
    signature: "spot FIELD lon LON lat LAT radius R amount A",
    doc: "Adds a Gaussian spherical spot to FIELD centered at (LON, LAT). LON/LAT in radians. R is the angular radius in radians. A is the peak amount added at the center.",
    example: "spot u lon 0 lat 0.5 radius 0.18 amount 1",
  },
  {
    name: "ellipse",
    importNamespace: "init",
    signature: "ellipse FIELD lon LON lat LAT rx RX ry RY amount A angle ANG",
    doc: "Adds a Gaussian elliptical spot. Like `spot` but with separate semi-axes RX (along east) and RY (along north). ANG is rotation in radians.",
    example: "ellipse pressure lon 0 lat 0 rx 0.4 ry 0.1 amount 1 angle 0.7",
  },
  {
    name: "region",
    importNamespace: "init",
    signature: "region FIELD lon LO..HI lat LO..HI amount A",
    doc: "Hard-edged rectangular assign in lon/lat space. Sets every cell whose lon ∈ [LO_lon, HI_lon] AND lat ∈ [LO_lat, HI_lat] to AMOUNT (overwrite, not additive).",
    example: "region u lon -0.6..0.6 lat 0..PI/2 amount 1",
  },
  {
    name: "copy",
    importNamespace: "init",
    signature: "copy DESTINATION_FIELD from SOURCE_FIELD",
    doc: "Copies one field's per-cell values into another at preset time.",
  },
  {
    name: "eachCell",
    importNamespace: "init",
    signature: "eachCell { ... per-cell init math ... }",
    doc: "Per-cell programmable init (presets only). Has access to position coords (lon, lat, x, y, etc.) for spatially-varying initialization.",
    example: "eachCell {\n  let band = exp(-pow(sin(lon * 2), 2) / 0.018)\n  set moistureSource = band\n}",
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
    signature: "recommendedPreset PRESET_ID",
    doc: "Which preset to apply on first load. Must match a `preset X` declaration.",
    example: "recommendedPreset spiral",
  },
  {
    name: "planet",
    signature: "planet NAME VALUE",
    doc: "Recipe-shipped planetary constant (gravity, radius, etc.). Read by bare name in stages — `gravity`, not `planet.gravity`.",
    example: "planet gravity 9.81",
  },
  {
    name: "const",
    signature: "const NAME VALUE",
    doc: "Recipe-shipped numeric constant. Stage-readable by bare name. Immutable.",
    example: "const rainoutBase 0.024",
  },
  {
    name: "use",
    signature: "use NAMESPACE name1, name2, ...",
    doc: "Imports identifiers from a namespace. Required for every primitive / math fn / builtin used in the recipe. Namespaces: `sim`, `init`, `core`, `clock`, `geo`.",
    example: "use sim diffuse, clamp, cell\nuse core sin, cos, smoothstep",
  },
  {
    name: "field",
    signature: "field name1, name2, ...",
    doc: "Declares mutable persistent state — Float32 values per cell, allocated once at recipe load. Stages can `add`/`set` field values.",
    example: "field pressure, moisture, cloud, temperature",
  },
  {
    name: "source",
    signature: "source name1, name2, ...",
    doc: "Declares immutable forcing maps — populated by presets, read-only inside stages. Use for terrain, solar input, fixed boundary maps.",
    example: "source moistureSource, heatSource",
  },
  {
    name: "setting",
    signature: 'setting NAME slider min N max N step N default V label "L"',
    doc: "Runtime knob — surfaces a slider in the side panel that the runtime reads (e.g. simRateHz). Not visible inside stage bodies.",
    example: 'setting simRateHz slider min 0 max 360 step 1 default 60 label "SIM RATE"',
  },
  {
    name: "param",
    signature: 'param NAME slider min N max N step N default V label "L"',
    doc: "Stage-readable knob. Renders as a slider (number) or checkbox (boolean). Read by bare name in stages.",
    example: 'param windStrength slider min 0 max 8 step 0.05 default 2.6 label "WIND"',
  },
];

// ---------------------------------------------------------------------------
// Block keywords — introduce stage / preset / stamp blocks.
// ---------------------------------------------------------------------------

export const BLOCK_KEYWORDS = [
  {
    name: "stage",
    signature: 'stage NAME "Display name" { reads ... writes ... cell { ... } }',
    doc: "A pipeline stage. Runs once per tick in declaration order. Body is `cell {}`, `event when ... {}`, `each {}`, or one of the pipeline primitives (wind/advect/diffuse/clamp/normalize).",
  },
  {
    name: "preset",
    signature: 'preset NAME "Display name" { ... }',
    doc: "An initial-state recipe. Fires on Reset / on first load (if recommended). Body uses init verbs (`fill`, `spot`, `ellipse`, `region`, `eachCell`).",
  },
  {
    name: "stamp",
    signature: 'stamp NAME "Display name" { ... }',
    doc: "A paint-brush composite. User clicks the canvas with this stamp selected to apply. Body uses init verbs scoped to the click position via `lon`/`lat`/`r`.",
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
  { name: "by",       signature: "advect FIELD by U, V dt EXPR",                doc: "Velocity-fields modifier on `advect`. Names the two scalar fields used as velocity components." },
  { name: "amount",   signature: "spot ... amount EXPR",                         doc: "Magnitude modifier on init verbs (`spot`, `ellipse`, `region`) and `diffuse`. Negative amounts subtract." },
  { name: "damping",  signature: "normalize FIELD damping EXPR",                 doc: "Damping factor on `normalize` (between 0 and 1)." },
  { name: "strength", signature: "wind ... strength EXPR",                       doc: "Multiplicative gain on the `wind` primitive." },
  { name: "radius",   signature: "spot FIELD lon ... lat ... radius EXPR amount EXPR", doc: "Angular radius for `spot` in radians. With brush radius `r`, write e.g. `radius r * 1.4` for a brush-relative spot." },
  { name: "rx",       signature: "ellipse ... rx EXPR ry EXPR",                  doc: "Semi-axis along the east direction for `ellipse` (radians)." },
  { name: "ry",       signature: "ellipse ... rx EXPR ry EXPR",                  doc: "Semi-axis along the north direction for `ellipse` (radians)." },
  { name: "angle",    signature: "ellipse ... amount EXPR angle EXPR",           doc: "Rotation of the ellipse in radians (0 = aligned to east)." },
  { name: "slider",   signature: "param NAME slider min N max N step N default V", doc: "Renders the param as a numeric slider in the side panel." },
  { name: "boolean",  signature: "param NAME boolean default V",                 doc: "Renders the param as a checkbox. Default is `true` or `false`." },
  { name: "label",    signature: 'param ... label "DISPLAY LABEL"',              doc: "Display label shown next to the slider/checkbox in the side panel." },
  { name: "step",     signature: "param ... step EXPR",                          doc: "Slider step size — the granularity of slider drags." },
  { name: "default",  signature: "param ... default V",                          doc: "Default value for the param at recipe load. Numeric for sliders, true/false for booleans." },
];

// ---------------------------------------------------------------------------
// Grid declaration sub-keywords.
// ---------------------------------------------------------------------------

export const GRID_KEYWORDS = [
  {
    name: "grid",
    signature: "grid geodesic tiles N",
    doc: "Defines the simulation substrate. Geodesic grids subdivide an icosahedron N times — N=64 is ~40k cells.",
    example: "grid geodesic tiles 64",
  },
  {
    name: "geodesic",
    signature: "geodesic tiles N",
    doc: "Geodesic substrate marker on a `grid` line. Currently the only supported substrate.",
  },
  {
    name: "tiles",
    signature: "tiles N",
    doc: "Subdivision frequency. Cell count ≈ 10·N² + 2.",
  },
];

// ---------------------------------------------------------------------------
// Internal coverage-check. Module-load-time assertion that no two
// canonical groups have a duplicate name (which would imply spec drift
// or a typo in this file). Cheap; runs once on import.
// ---------------------------------------------------------------------------

(function assertSpecUnique() {
  const seen = new Map();
  function track(group, items) {
    for (const item of items) {
      if (!item.name) throw new Error(`dsl-spec: ${group} entry missing name`);
      const prior = seen.get(item.name);
      if (prior && prior !== group) {
        throw new Error(`dsl-spec: name "${item.name}" appears in both "${prior}" and "${group}" — group lookup would be ambiguous`);
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
