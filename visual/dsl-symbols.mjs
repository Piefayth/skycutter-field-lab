// =============================================================================
// DSL symbol catalog.
//
// Single source of truth for "what is this identifier?" — every keyword,
// primitive, math function, and builtin the recipe DSL exposes, with its
// kind, category, signature, doc, and (where useful) an example. Tooltips,
// autocomplete, and the in-app docs window all read from this.
//
// Recipe-declared identifiers (declared fields, sources, params, consts,
// planet constants) live OUTSIDE this catalog — they're discovered by
// parsing the live DSL text, since they vary per recipe. The catalog
// covers the static DSL surface only.
// =============================================================================

// kinds: keyword | declKeyword | blockKeyword | declarationKw | controlKw |
//        actionVerb | initVerb | primVerb | mathFn | mathConst | builtin |
//        modifier | logicalOp | literal | gridKeyword
//
// categories (used for grouping in the docs window):
//   "Recipe identity"
//   "Schema declarations"
//   "Block forms"
//   "Stage I/O"
//   "Action verbs (cell/event/each)"
//   "Init verbs (presets/stamps)"
//   "Pipeline primitives"
//   "Control flow"
//   "Math functions"
//   "Math constants"
//   "Time builtins"
//   "Geodesic position builtins"
//   "Grid declaration"
//   "Param modifiers"
//   "Stamp/spot modifiers"
//   "Logical operators"
//   "Literals"
//
// `importLine` is the `use` directive a recipe needs to bring this
// symbol into scope (or `null` for things that are always in scope:
// keywords, control flow, top-level decl directives).

export const DSL_SYMBOLS = [
  // ----------------------------------------------------------------------
  // Recipe identity
  // ----------------------------------------------------------------------
  {
    name: "recipe",
    kind: "declKeyword",
    category: "Recipe identity",
    importLine: null,
    signature: 'recipe "Display name"',
    doc: "Names the recipe. First thing in every DSL file.",
    example: 'recipe "Belousov-Zhabotinsky"',
  },
  {
    name: "summary",
    kind: "declKeyword",
    category: "Recipe identity",
    importLine: null,
    signature: 'summary "One-line description of the simulation."',
    doc: "One-paragraph summary shown in the recipe picker. Keep under ~200 chars.",
  },
  {
    name: "recommendedPreset",
    kind: "declKeyword",
    category: "Recipe identity",
    importLine: null,
    signature: "recommendedPreset PRESET_ID",
    doc: "Which preset to apply on first load. Must match a `preset X` declaration.",
    example: "recommendedPreset spiral",
  },

  // ----------------------------------------------------------------------
  // Grid
  // ----------------------------------------------------------------------
  {
    name: "grid",
    kind: "gridKeyword",
    category: "Grid declaration",
    importLine: null,
    signature: "grid geodesic tiles N",
    doc: "Defines the simulation substrate. Geodesic grids subdivide an icosahedron N times — N=64 is ~40k cells.",
    example: "grid geodesic tiles 64",
  },
  {
    name: "geodesic",
    kind: "modifier",
    category: "Grid declaration",
    importLine: null,
    signature: "geodesic tiles N",
    doc: "Geodesic substrate marker on a `grid` line. Currently the only supported substrate.",
  },
  {
    name: "tiles",
    kind: "modifier",
    category: "Grid declaration",
    importLine: null,
    signature: "tiles N",
    doc: "Subdivision frequency. Cell count ≈ 10·N² + 2.",
  },

  // ----------------------------------------------------------------------
  // Schema declarations
  // ----------------------------------------------------------------------
  {
    name: "planet",
    kind: "declKeyword",
    category: "Schema declarations",
    importLine: null,
    signature: "planet NAME VALUE",
    doc: "Recipe-shipped planetary constant (gravity, radius, etc.). Read by bare name in stages — `gravity`, not `planet.gravity`.",
    example: "planet gravity 9.81",
  },
  {
    name: "const",
    kind: "declKeyword",
    category: "Schema declarations",
    importLine: null,
    signature: "const NAME VALUE",
    doc: "Recipe-shipped numeric constant. Stage-readable by bare name. Immutable.",
    example: "const rainoutBase 0.024",
  },
  {
    name: "use",
    kind: "declKeyword",
    category: "Schema declarations",
    importLine: null,
    signature: "use NAMESPACE name1, name2, ...",
    doc: "Imports identifiers from a namespace. Required for every primitive / math fn / builtin used in the recipe. Namespaces: `sim`, `init`, `core`, `clock`, `geo`.",
    example: "use sim diffuse, clamp, cell\nuse core sin, cos, smoothstep",
  },
  {
    name: "field",
    kind: "declKeyword",
    category: "Schema declarations",
    importLine: null,
    signature: "field name1, name2, ...",
    doc: "Declares mutable persistent state — Float32 values per cell, allocated once at recipe load. Stages can `add`/`set` field values.",
    example: "field pressure, moisture, cloud, temperature",
  },
  {
    name: "source",
    kind: "declKeyword",
    category: "Schema declarations",
    importLine: null,
    signature: "source name1, name2, ...",
    doc: "Declares immutable forcing maps — populated by presets, read-only inside stages. Use for terrain, solar input, fixed boundary maps.",
    example: "source moistureSource, heatSource",
  },
  {
    name: "setting",
    kind: "declKeyword",
    category: "Schema declarations",
    importLine: null,
    signature: 'setting NAME slider min N max N step N default V label "L"',
    doc: "Runtime knob — surfaces a slider in the side panel that the runtime reads (e.g. simRateHz). Not visible inside stage bodies.",
    example: 'setting simRateHz slider min 0 max 360 step 1 default 60 label "SIM RATE"',
  },
  {
    name: "param",
    kind: "declKeyword",
    category: "Schema declarations",
    importLine: null,
    signature: 'param NAME slider min N max N step N default V label "L"',
    doc: "Stage-readable knob. Renders as a slider (number) or checkbox (boolean). Read by bare name in stages.",
    example: 'param windStrength slider min 0 max 8 step 0.05 default 2.6 label "WIND"',
  },

  // ----------------------------------------------------------------------
  // Block forms
  // ----------------------------------------------------------------------
  {
    name: "stage",
    kind: "blockKeyword",
    category: "Block forms",
    importLine: null,
    signature: 'stage NAME "Display name" { reads ... writes ... cell { ... } }',
    doc: "A pipeline stage. Runs once per tick in declaration order. Body is `cell {}`, `event when ... {}`, `each {}`, or one of the pipeline primitives (wind/advect/diffuse/clamp/normalize).",
  },
  {
    name: "preset",
    kind: "blockKeyword",
    category: "Block forms",
    importLine: null,
    signature: 'preset NAME "Display name" { ... }',
    doc: "An initial-state recipe. Fires on Reset / on first load (if recommended). Body uses init verbs (`fill`, `spot`, `ellipse`, `region`, `eachCell`).",
  },
  {
    name: "stamp",
    kind: "blockKeyword",
    category: "Block forms",
    importLine: null,
    signature: 'stamp NAME "Display name" { ... }',
    doc: "A paint-brush composite. User clicks the canvas with this stamp selected to apply. Body uses init verbs scoped to the click position via `lon`/`lat`/`r`.",
  },

  // ----------------------------------------------------------------------
  // Stage I/O
  // ----------------------------------------------------------------------
  {
    name: "reads",
    kind: "declarationKw",
    category: "Stage I/O",
    importLine: null,
    signature: "reads field1, field2, ...",
    doc: "Lists fields the stage's body reads. Required — used by the compiler for dependency analysis and to decide which buffers to bind.",
  },
  {
    name: "writes",
    kind: "declarationKw",
    category: "Stage I/O",
    importLine: null,
    signature: "writes field1, field2, ...",
    doc: "Lists fields the stage's body mutates via `add`/`set`. Required — names must already be declared via `field`.",
  },
  {
    name: "declares",
    kind: "declarationKw",
    category: "Stage I/O",
    importLine: null,
    signature: "declares field1, field2, ...",
    doc: "Declares NEW fields produced by this stage's primitive (e.g. `wind` declares `windU`, `windV`, `lift`). Allocated automatically.",
  },

  // ----------------------------------------------------------------------
  // Control flow / block-body forms
  // ----------------------------------------------------------------------
  {
    name: "cell",
    kind: "controlKw",
    category: "Control flow",
    importLine: "use sim cell",
    signature: "cell { ... per-cell math ... }",
    doc: "Per-cell continuous math. Each cell runs the body in parallel; reads field values from the input snapshot, writes via `add` (accumulate) or `set` (overwrite). Use for reaction terms, growth, decay, etc.",
  },
  {
    name: "event",
    kind: "controlKw",
    category: "Control flow",
    importLine: "use sim event",
    signature: "event when CONDITION { ... }",
    doc: "Discrete per-cell event. Body runs only on cells where CONDITION is true. Increments an atomic counter so the metric strip can show event rates.",
    example: "event when tree > 0.5 and neighborMax(burning) > 0.5 {\n  set burning = 1\n  set tree = 0\n}",
  },
  {
    name: "each",
    kind: "controlKw",
    category: "Control flow",
    importLine: "use sim each",
    signature: "each { ... per-cell side-effect ... }",
    doc: "Like `cell`, but for stages that READ neighbors via `sample` or `neighborMax`. No event accounting — use for stencil reads that don't fire discrete events.",
  },
  {
    name: "eachCell",
    kind: "controlKw",
    category: "Control flow",
    importLine: "use init eachCell",
    signature: "eachCell { ... per-cell init math ... }",
    doc: "Per-cell programmable init (presets only). Has access to position coords (lon, lat, x, y, etc.) for spatially-varying initialization.",
    example: "eachCell {\n  let band = exp(-pow(sin(lon * 2), 2) / 0.018)\n  set moistureSource = band\n}",
  },
  {
    name: "when",
    kind: "controlKw",
    category: "Control flow",
    importLine: null,
    signature: "when CONDITION { ... }",
    doc: "Conditional block inside `cell` / `each` / `eachCell`. Body runs only on cells where CONDITION evaluates truthy.",
    example: "when params.enableForcing and forcing > 0 {\n  set moisture = ...\n}",
  },

  // ----------------------------------------------------------------------
  // Action verbs (cell/event/each bodies)
  // ----------------------------------------------------------------------
  {
    name: "let",
    kind: "actionVerb",
    category: "Action verbs (cell/event/each)",
    importLine: null,
    signature: "let NAME = EXPR",
    doc: "Declares a per-cell local. Single-assignment within the block. Values can reference any in-scope identifier.",
    example: "let cubic = u * (1 - u) * (u - threshold)",
  },
  {
    name: "add",
    kind: "actionVerb",
    category: "Action verbs (cell/event/each)",
    importLine: null,
    signature: "add FIELD = EXPR",
    doc: "Accumulates EXPR into FIELD for the current cell. Reads the field's pre-stage value, writes pre + EXPR. Most reaction-term writes are `add`.",
    example: "add cloud = net * dt",
  },
  {
    name: "set",
    kind: "actionVerb",
    category: "Action verbs (cell/event/each)",
    importLine: null,
    signature: "set FIELD = EXPR",
    doc: "Overwrites FIELD with EXPR for the current cell. Use for state transitions (events) or saturation (`set cloud = clamp(...)`).",
    example: "set burning = 1",
  },

  // ----------------------------------------------------------------------
  // Init verbs (preset / stamp bodies)
  // ----------------------------------------------------------------------
  {
    name: "fill",
    kind: "initVerb",
    category: "Init verbs (presets/stamps)",
    importLine: "use init fill",
    signature: "fill FIELD VALUE",
    doc: "Sets every cell of FIELD to VALUE. Runs at preset/stamp time. VALUE can be any constant expression.",
    example: "fill u 0\nfill catalyst 0.5",
  },
  {
    name: "spot",
    kind: "initVerb",
    category: "Init verbs (presets/stamps)",
    importLine: "use init spot",
    signature: "spot FIELD lon LON lat LAT radius R amount A",
    doc: "Adds a Gaussian spherical spot to FIELD centered at (LON, LAT). LON/LAT in radians. R is the angular radius in radians. A is the peak amount added at the center.",
    example: "spot u lon 0 lat 0.5 radius 0.18 amount 1",
  },
  {
    name: "ellipse",
    kind: "initVerb",
    category: "Init verbs (presets/stamps)",
    importLine: "use init ellipse",
    signature: "ellipse FIELD lon LON lat LAT rx RX ry RY amount A angle ANG",
    doc: "Adds a Gaussian elliptical spot. Like `spot` but with separate semi-axes RX (along east) and RY (along north). ANG is rotation in radians.",
    example: "ellipse pressure lon 0 lat 0 rx 0.4 ry 0.1 amount 1 angle 0.7",
  },
  {
    name: "region",
    kind: "initVerb",
    category: "Init verbs (presets/stamps)",
    importLine: "use init region",
    signature: "region FIELD lon LO..HI lat LO..HI amount A",
    doc: "Hard-edged rectangular assign in lon/lat space. Sets every cell whose lon ∈ [LO_lon, HI_lon] AND lat ∈ [LO_lat, HI_lat] to AMOUNT (overwrite, not additive).",
    example: "region u lon -0.6..0.6 lat 0..PI/2 amount 1",
  },
  {
    name: "copy",
    kind: "initVerb",
    category: "Init verbs (presets/stamps)",
    importLine: "use init copy",
    signature: "copy DESTINATION_FIELD from SOURCE_FIELD",
    doc: "Copies one field's per-cell values into another at preset time.",
  },

  // ----------------------------------------------------------------------
  // Pipeline primitives (stage bodies)
  // ----------------------------------------------------------------------
  {
    name: "wind",
    kind: "primVerb",
    category: "Pipeline primitives",
    importLine: "use sim wind",
    signature: "wind PRESSURE -> windU, windV, lift strength EXPR",
    doc: "Pressure-gradient wind primitive. Reads PRESSURE; writes velocity (windU, windV) and divergence (lift) in tangent-frame coordinates. Includes Coriolis based on latitude.",
    example: "wind pressure -> windU, windV, lift strength windStrength",
  },
  {
    name: "advect",
    kind: "primVerb",
    category: "Pipeline primitives",
    importLine: "use sim advect",
    signature: "advect FIELD by windU, windV dt EXPR",
    doc: "Semi-Lagrangian transport of FIELD by velocity (windU, windV). Per-tick displacement = velocity * EXPR.",
    example: "advect moisture by windU, windV dt dt * 1.0",
  },
  {
    name: "diffuse",
    kind: "primVerb",
    category: "Pipeline primitives",
    importLine: "use sim diffuse",
    signature: "diffuse FIELD amount EXPR",
    doc: "Laplacian smoothing — each cell averages with its neighbors weighted by EXPR. Stable for amount in [0, 1].",
    example: "diffuse moisture amount diffusion * 0.34 * dt",
  },
  {
    name: "clamp",
    kind: "primVerb",
    category: "Pipeline primitives",
    importLine: "use sim clamp",
    signature: "clamp FIELD LO HI    (primitive form)\nclamp(x, lo, hi)     (function form)",
    doc: "Two forms. As a stage primitive (no parens, top-level in stage body): clamps FIELD into [LO, HI] in one pass. As a function (parens, in any expression): returns x clamped to [lo, hi]. Disambiguated by the `(`-lookahead.",
    example: "clamp moisture 0 1.4    # primitive\nlet y = clamp(x, 0, 1)   # function",
  },
  {
    name: "normalize",
    kind: "primVerb",
    category: "Pipeline primitives",
    importLine: "use sim normalize",
    signature: "normalize FIELD damping EXPR when CONDITION",
    doc: "Damping toward zero-mean. NOTE: not yet wired on geodesic — currently throws if the `when` condition fires. Track for the reductions roadmap.",
  },

  // ----------------------------------------------------------------------
  // Math functions (callable in any expression)
  // ----------------------------------------------------------------------
  {
    name: "max",
    kind: "mathFn",
    category: "Math functions",
    importLine: "use core max",
    signature: "max(a, b)",
    doc: "Returns the larger of two values.",
  },
  {
    name: "min",
    kind: "mathFn",
    category: "Math functions",
    importLine: "use core min",
    signature: "min(a, b)",
    doc: "Returns the smaller of two values.",
  },
  {
    name: "abs",
    kind: "mathFn",
    category: "Math functions",
    importLine: "use core abs",
    signature: "abs(x)",
    doc: "Absolute value.",
  },
  {
    name: "hypot",
    kind: "mathFn",
    category: "Math functions",
    importLine: "use core hypot",
    signature: "hypot(x, y)",
    doc: "Vector magnitude — `sqrt(x² + y²)`. Used for wind magnitude, distance computations.",
  },
  {
    name: "sin",
    kind: "mathFn",
    category: "Math functions",
    importLine: "use core sin",
    signature: "sin(x)",
    doc: "Sine. Argument in radians.",
  },
  {
    name: "asin",
    kind: "mathFn",
    category: "Math functions",
    importLine: "use core asin",
    signature: "asin(x)",
    doc: "Arcsine. Returns radians in [-π/2, π/2].",
  },
  {
    name: "cos",
    kind: "mathFn",
    category: "Math functions",
    importLine: "use core cos",
    signature: "cos(x)",
    doc: "Cosine. Argument in radians.",
  },
  {
    name: "exp",
    kind: "mathFn",
    category: "Math functions",
    importLine: "use core exp",
    signature: "exp(x)",
    doc: "e^x.",
  },
  {
    name: "sqrt",
    kind: "mathFn",
    category: "Math functions",
    importLine: "use core sqrt",
    signature: "sqrt(x)",
    doc: "Square root.",
  },
  {
    name: "pow",
    kind: "mathFn",
    category: "Math functions",
    importLine: "use core pow",
    signature: "pow(x, n)",
    doc: "x^n.",
  },
  {
    name: "smoothstep",
    kind: "mathFn",
    category: "Math functions",
    importLine: "use core smoothstep",
    signature: "smoothstep(edge0, edge1, x)",
    doc: "Smooth Hermite interpolation. Returns 0 if x ≤ edge0, 1 if x ≥ edge1, smooth S-curve in between.",
    example: "let mix = smoothstep(0.18, 0.9, catalyst)",
  },
  {
    name: "noise",
    kind: "mathFn",
    category: "Math functions",
    importLine: "use core noise",
    signature: "noise(seed)",
    doc: "Spatially-coherent 3D hash noise. Uses the cell's (px, py, pz) plus seed. Returns [-1, 1]. Seed by `frame * something` to vary in time.",
    example: "add moisture = noise(frame * 0.13) * amp * 0.25",
  },
  {
    name: "noise2",
    kind: "mathFn",
    category: "Math functions",
    importLine: "use core noise2",
    signature: "noise2(x, y)",
    doc: "2D hash noise (preset eachCell only — not available in stage bodies). Use over (lon, lat) for spatially-coherent random init.",
    example: "set moistureSeed = noise2(lon * 1.4, lat * 1.7)",
  },
  {
    name: "sample",
    kind: "mathFn",
    category: "Math functions",
    importLine: "use core sample",
    signature: "sample(field, dx, dy)",
    doc: "Reads FIELD at the cell's neighbor offset (dx, dy). Used inside `each` blocks for stencil computations.",
  },
  {
    name: "neighborMax",
    kind: "mathFn",
    category: "Math functions",
    importLine: "use core neighborMax",
    signature: "neighborMax(field)",
    doc: "Maximum value of FIELD across the current cell's neighbors. Useful for threshold-spread events (fire spread, wave propagation).",
    example: "event when tree > 0.5 and neighborMax(burning) > 0.5 { set burning = 1 }",
  },

  // ----------------------------------------------------------------------
  // Math constants (always in scope, no import)
  // ----------------------------------------------------------------------
  {
    name: "PI",
    kind: "mathConst",
    category: "Math constants",
    importLine: "use geo PI",
    signature: "PI",
    doc: "π ≈ 3.14159. Use to express angular extents in radians.",
  },
  {
    name: "TAU",
    kind: "mathConst",
    category: "Math constants",
    importLine: "use geo TAU",
    signature: "TAU",
    doc: "2π ≈ 6.28319. One full revolution in radians.",
  },
  {
    name: "E",
    kind: "mathConst",
    category: "Math constants",
    importLine: "use geo E",
    signature: "E",
    doc: "Euler's number, e ≈ 2.71828.",
  },
  {
    name: "N",
    kind: "mathConst",
    category: "Math constants",
    importLine: "use geo N",
    signature: "N",
    doc: "Total cell count of the current grid.",
  },

  // ----------------------------------------------------------------------
  // Time builtins
  // ----------------------------------------------------------------------
  {
    name: "dt",
    kind: "builtin",
    category: "Time builtins",
    importLine: "use clock dt",
    signature: "dt",
    doc: "Tick duration in seconds (typically 1/60). Multiply rate-style accumulations by dt to get rate-per-second behavior.",
  },
  {
    name: "frame",
    kind: "builtin",
    category: "Time builtins",
    importLine: "use clock frame",
    signature: "frame",
    doc: "Tick counter. Use as a noise seed or a time index (`sin(frame * 0.013)`).",
  },

  // ----------------------------------------------------------------------
  // Geodesic position builtins
  // ----------------------------------------------------------------------
  {
    name: "lon",
    kind: "builtin",
    category: "Geodesic position builtins",
    importLine: "use geo lon",
    signature: "lon",
    doc: "Longitude of the current cell, radians in [-π, π]. East-positive.",
  },
  {
    name: "lat",
    kind: "builtin",
    category: "Geodesic position builtins",
    importLine: "use geo lat",
    signature: "lat",
    doc: "Latitude of the current cell, radians in [-π/2, π/2]. North-positive.",
  },
  {
    name: "x",
    kind: "builtin",
    category: "Geodesic position builtins",
    importLine: "use geo x",
    signature: "x",
    doc: "Equirect-projection x of the current cell, in [0, 1]. (lon + π) / 2π.",
  },
  {
    name: "y",
    kind: "builtin",
    category: "Geodesic position builtins",
    importLine: "use geo y",
    signature: "y",
    doc: "Equirect-projection y of the current cell, in [0, 1]. lat / π + 0.5.",
  },
  {
    name: "u",
    kind: "builtin",
    category: "Geodesic position builtins",
    importLine: "use geo u",
    signature: "u",
    doc: "Alias for `x`. Use for parametric-coordinate-flavored math.",
  },
  {
    name: "v",
    kind: "builtin",
    category: "Geodesic position builtins",
    importLine: "use geo v",
    signature: "v",
    doc: "Alias for `y`. Use for parametric-coordinate-flavored math.",
  },
  {
    name: "px",
    kind: "builtin",
    category: "Geodesic position builtins",
    importLine: "use geo px",
    signature: "px",
    doc: "Cartesian x of the cell on the unit sphere, in [-1, 1].",
  },
  {
    name: "py",
    kind: "builtin",
    category: "Geodesic position builtins",
    importLine: "use geo py",
    signature: "py",
    doc: "Cartesian y of the cell on the unit sphere, in [-1, 1]. py = sin(lat).",
  },
  {
    name: "pz",
    kind: "builtin",
    category: "Geodesic position builtins",
    importLine: "use geo pz",
    signature: "pz",
    doc: "Cartesian z of the cell on the unit sphere, in [-1, 1].",
  },
  {
    name: "i",
    kind: "builtin",
    category: "Geodesic position builtins",
    importLine: "use geo i",
    signature: "i",
    doc: "Cell index in [0, N). Stable across frames; useful as a per-cell salt for noise.",
  },

  // ----------------------------------------------------------------------
  // Logical operators
  // ----------------------------------------------------------------------
  {
    name: "and",
    kind: "logicalOp",
    category: "Logical operators",
    importLine: null,
    signature: "EXPR and EXPR",
    doc: "Logical AND. Compiles to `&&`.",
  },
  {
    name: "or",
    kind: "logicalOp",
    category: "Logical operators",
    importLine: null,
    signature: "EXPR or EXPR",
    doc: "Logical OR. Compiles to `||`.",
  },
  {
    name: "not",
    kind: "logicalOp",
    category: "Logical operators",
    importLine: null,
    signature: "not EXPR",
    doc: "Logical NOT. Compiles to `!`.",
  },

  // ----------------------------------------------------------------------
  // Literals
  // ----------------------------------------------------------------------
  {
    name: "true",
    kind: "literal",
    category: "Literals",
    importLine: null,
    signature: "true",
    doc: "Boolean literal.",
  },
  {
    name: "false",
    kind: "literal",
    category: "Literals",
    importLine: null,
    signature: "false",
    doc: "Boolean literal.",
  },
  {
    name: "null",
    kind: "literal",
    category: "Literals",
    importLine: null,
    signature: "null",
    doc: "Null literal.",
  },
  {
    name: "undefined",
    kind: "literal",
    category: "Literals",
    importLine: null,
    signature: "undefined",
    doc: "Undefined literal.",
  },

  // ----------------------------------------------------------------------
  // Trailing-argument modifiers
  // ----------------------------------------------------------------------
  {
    name: "by",
    kind: "modifier",
    category: "Stamp/spot modifiers",
    importLine: null,
    signature: "advect FIELD by U, V dt EXPR",
    doc: "Velocity-fields modifier on `advect`. Names the two scalar fields used as velocity components.",
  },
  {
    name: "amount",
    kind: "modifier",
    category: "Stamp/spot modifiers",
    importLine: null,
    signature: "spot ... amount EXPR",
    doc: "Magnitude modifier on init verbs (`spot`, `ellipse`, `region`) and `diffuse`. Negative amounts subtract.",
  },
  {
    name: "damping",
    kind: "modifier",
    category: "Stamp/spot modifiers",
    importLine: null,
    signature: "normalize FIELD damping EXPR",
    doc: "Damping factor on `normalize` (between 0 and 1).",
  },
  {
    name: "strength",
    kind: "modifier",
    category: "Stamp/spot modifiers",
    importLine: null,
    signature: "wind ... strength EXPR",
    doc: "Multiplicative gain on the `wind` primitive.",
  },
  {
    name: "radius",
    kind: "modifier",
    category: "Stamp/spot modifiers",
    importLine: null,
    signature: "spot FIELD lon ... lat ... radius EXPR amount EXPR",
    doc: "Angular radius for `spot` in radians. With brush radius `r`, write e.g. `radius r * 1.4` for a brush-relative spot.",
  },
  {
    name: "rx",
    kind: "modifier",
    category: "Stamp/spot modifiers",
    importLine: null,
    signature: "ellipse ... rx EXPR ry EXPR",
    doc: "Semi-axis along the east direction for `ellipse` (radians).",
  },
  {
    name: "ry",
    kind: "modifier",
    category: "Stamp/spot modifiers",
    importLine: null,
    signature: "ellipse ... rx EXPR ry EXPR",
    doc: "Semi-axis along the north direction for `ellipse` (radians).",
  },
  {
    name: "angle",
    kind: "modifier",
    category: "Stamp/spot modifiers",
    importLine: null,
    signature: "ellipse ... amount EXPR angle EXPR",
    doc: "Rotation of the ellipse in radians (0 = aligned to east).",
  },

  // ----------------------------------------------------------------------
  // Param declaration modifiers
  // ----------------------------------------------------------------------
  {
    name: "slider",
    kind: "modifier",
    category: "Param modifiers",
    importLine: null,
    signature: "param NAME slider min N max N step N default V",
    doc: "Renders the param as a numeric slider in the side panel.",
  },
  {
    name: "boolean",
    kind: "modifier",
    category: "Param modifiers",
    importLine: null,
    signature: "param NAME boolean default V",
    doc: "Renders the param as a checkbox. Default is `true` or `false`.",
  },
  {
    name: "label",
    kind: "modifier",
    category: "Param modifiers",
    importLine: null,
    signature: 'param ... label "DISPLAY LABEL"',
    doc: "Display label shown next to the slider/checkbox in the side panel.",
  },
  {
    name: "step",
    kind: "modifier",
    category: "Param modifiers",
    importLine: null,
    signature: "param ... step EXPR",
    doc: "Slider step size — the granularity of slider drags.",
  },
  {
    name: "default",
    kind: "modifier",
    category: "Param modifiers",
    importLine: null,
    signature: "param ... default V",
    doc: "Default value for the param at recipe load. Numeric for sliders, true/false for booleans.",
  },
];

// Quick lookup index by name (case-sensitive). Built once at module load.
const SYMBOL_BY_NAME = new Map(DSL_SYMBOLS.map((s) => [s.name, s]));

export function getSymbolInfo(name) {
  return SYMBOL_BY_NAME.get(name) ?? null;
}

// Group symbols by category in the order they first appear in the catalog.
// Used by the docs window to render section-by-section.
export function symbolsByCategory() {
  const out = new Map();
  for (const sym of DSL_SYMBOLS) {
    if (!out.has(sym.category)) out.set(sym.category, []);
    out.get(sym.category).push(sym);
  }
  return out;
}

// All known names — used by the autocomplete and tooltip extensions to
// decide which words are catalog-resolvable vs. user-declared.
export function allSymbolNames() {
  return [...SYMBOL_BY_NAME.keys()];
}
