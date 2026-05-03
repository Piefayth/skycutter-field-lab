// Field Lab DSL v2 parser.
//
// Parses v2 syntax into a parsed-recipe object the rest of the
// pipeline (validate.mjs / validate-v2.mjs / typecheck-v2.mjs /
// webgpu-geodesic-compiler.mjs) consumes. See dsl/V2-SPEC.md for the
// language definition.
//
// v2 surface in one breath:
//   - `substrate geodesic frequency N`
//   - `field u: f32 [derived]` (typed, with optional derived annotation)
//   - `scenario id "..." { ... }`
//   - `step { stages... }` wrapper around stages
//   - exactly one `cell { }` per stage (no multi-block, no `each`/`event`)
//   - `u@prev` / `u@n` / `u@upstream(velX, velY, dt)` coordinate queries
//   - cell-centered neighbor reductions: `sum n in neighbors { u@n - u }`
//   - `metric ID = REDUCTION cells [where PRED] { EXPR }` (top-level)
//   - history is inferred from `@prev` usage (no manual `history N`)
//   - imports are optional; all builtins are in scope by default
//   - named-arg `spot u at lon=0, lat=0, radius=0.08, amount=1`

// =============================================================================
// Public entry: parseV2
// =============================================================================
//
// Returns a parsed recipe object: { recipe, grid, planet, constants,
// imports, fields, sources, settings, parameters, presets, stamps,
// stages, metrics }.

export function parseV2(source) {
  const ctx = makeCtx(source);
  const recipe = {};
  let substrate = null;
  const fields = [];
  const params = [];
  const constants = [];
  const scenarios = [];
  const stamps = [];
  const stages = [];
  const metrics = [];
  const importedNames = [];      // flat list of names declared via `import ...`

  while (!atEnd(ctx)) {
    skipTrivia(ctx);
    if (atEnd(ctx)) break;
    const kw = peekKeyword(ctx);
    if (!kw) {
      const line = currentLine(ctx);
      throw new Error(`v2 parse: unexpected line "${line}"`);
    }
    switch (kw) {
      case "recipe":             recipe.name = parseQuotedDirective(ctx, "recipe"); break;
      case "summary":            recipe.summary = parseQuotedDirective(ctx, "summary"); break;
      case "recommendedPreset":  recipe.recommendedPreset = parseBareDirective(ctx, "recommendedPreset"); break;
      case "substrate":          substrate = parseSubstrate(ctx); break;
      case "field":              fields.push(parseField(ctx)); break;
      case "param":              params.push(parseParam(ctx)); break;
      case "const":              constants.push(parseConst(ctx)); break;
      case "scenario":           scenarios.push(parseScenario(ctx)); break;
      case "stamp":              stamps.push(parseStamp(ctx)); break;
      case "step":               stages.push(...parseStep(ctx)); break;
      case "metric":             metrics.push(parseMetric(ctx)); break;
      case "import":             importedNames.push(...parseImport(ctx)); break;
      default:
        throw new Error(`v2 parse: unknown top-level keyword "${kw}"`);
    }
  }

  if (!recipe.name) throw new Error("v2 parse: recipe must declare `recipe \"<name>\"`");
  if (!substrate) throw new Error("v2 parse: recipe must declare `substrate ...`");
  if (stages.length === 0) throw new Error("v2 parse: recipe must declare at least one stage inside `step { }`");

  // Lower scenarios → v1 presets (same shape, different label).
  const presets = scenarios.map((s) => ({ id: s.id, label: s.label, actions: s.actions }));

  return {
    recipe,
    grid: substrate,
    planet: {},
    constants,
    resolution: {},
    // v2 imports are a flat list of allowed builtin names. compile-v2
    // converts this to v1's namespaced shape (or synthesizes a maximal
    // list if the recipe declared no imports). null = no `import` line
    // present, all builtins in scope; non-null = only listed names are.
    importedNames: importedNames.length > 0 ? dedupe(importedNames) : null,
    imports: [],          // populated by compile-v2 from importedNames + auto-keywords
    fields,
    sources: [],          // v2 doesn't have `source` decls (yet)
    settings: [],         // v2 folds settings into params
    parameters: params,
    presets,
    stamps,
    stages,
    metrics,
  };
}

// Parse a single `import name1, name2, name3` line. Names are flat —
// v2 doesn't carry the namespace gating that v1's `use sim cell` did;
// the compiler resolves each name's v1 namespace from dsl-spec
// metadata. Used for validation only: a recipe with explicit imports
// can only reference builtin identifiers it lists.
function parseImport(ctx) {
  consumeKeyword(ctx, "import");
  const names = [];
  while (true) {
    skipInlineWs(ctx);
    if (atEnd(ctx) || ctx.source[ctx.i] === "\n") break;
    const tail = ctx.source.slice(ctx.i);
    const m = IDENT_RE.exec(tail);
    if (!m) break;
    ctx.i += m[0].length;
    names.push(m[0]);
    skipInlineWs(ctx);
    if (!tryConsumeChar(ctx, ",")) break;
  }
  if (names.length === 0) {
    throw new Error("v2 parse: `import` line lists no names");
  }
  skipLine(ctx);
  return names;
}

// =============================================================================
// Cursor / trivia helpers
// =============================================================================

function makeCtx(source) {
  return { source, i: 0 };
}

function atEnd(ctx) {
  return ctx.i >= ctx.source.length;
}

function skipTrivia(ctx) {
  while (!atEnd(ctx)) {
    const ch = ctx.source[ctx.i];
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === ";") {
      // Semicolons are accepted as optional inter-clause separators
      // (so single-line stages like `stage s { reads u; writes u; cell { ... } }`
      // parse the same as multi-line ones). They are not significant.
      ctx.i++;
      continue;
    }
    if (ch === "/" && ctx.source[ctx.i + 1] === "/") {
      while (!atEnd(ctx) && ctx.source[ctx.i] !== "\n") ctx.i++;
      continue;
    }
    break;
  }
}

function skipInlineWs(ctx) {
  while (!atEnd(ctx) && (ctx.source[ctx.i] === " " || ctx.source[ctx.i] === "\t")) ctx.i++;
}

function skipLine(ctx) {
  while (!atEnd(ctx) && ctx.source[ctx.i] !== "\n") ctx.i++;
  if (!atEnd(ctx)) ctx.i++;
}

function currentLine(ctx) {
  const start = ctx.i;
  let end = ctx.source.indexOf("\n", start);
  if (end === -1) end = ctx.source.length;
  return ctx.source.slice(start, end);
}

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*/;

function peekKeyword(ctx) {
  const tail = ctx.source.slice(ctx.i);
  const m = IDENT_RE.exec(tail);
  return m ? m[0] : null;
}

function readIdent(ctx, label = "identifier") {
  skipInlineWs(ctx);
  const tail = ctx.source.slice(ctx.i);
  const m = IDENT_RE.exec(tail);
  if (!m) throw new Error(`v2 parse: expected ${label} at "${tail.slice(0, 24)}"`);
  ctx.i += m[0].length;
  return m[0];
}

function consumeKeyword(ctx, expected) {
  skipInlineWs(ctx);
  const got = readIdent(ctx, `keyword "${expected}"`);
  if (got !== expected) throw new Error(`v2 parse: expected "${expected}", got "${got}"`);
  return got;
}

function consumeChar(ctx, ch) {
  skipInlineWs(ctx);
  if (ctx.source[ctx.i] !== ch) {
    throw new Error(`v2 parse: expected "${ch}" at "${currentLine(ctx).slice(0, 24)}"`);
  }
  ctx.i++;
}

function tryConsumeChar(ctx, ch) {
  skipInlineWs(ctx);
  if (ctx.source[ctx.i] !== ch) return false;
  ctx.i++;
  return true;
}

function readString(ctx) {
  skipInlineWs(ctx);
  if (ctx.source[ctx.i] !== "\"") {
    throw new Error(`v2 parse: expected string literal at "${currentLine(ctx).slice(0, 24)}"`);
  }
  ctx.i++;
  let value = "";
  while (!atEnd(ctx) && ctx.source[ctx.i] !== "\"") {
    if (ctx.source[ctx.i] === "\\" && ctx.i + 1 < ctx.source.length) {
      value += ctx.source[ctx.i + 1];
      ctx.i += 2;
      continue;
    }
    value += ctx.source[ctx.i++];
  }
  if (atEnd(ctx)) throw new Error("v2 parse: unterminated string literal");
  ctx.i++;
  return value;
}

function readNumber(ctx) {
  skipInlineWs(ctx);
  const tail = ctx.source.slice(ctx.i);
  // Require digits on both sides of the decimal so `0..0.29` parses as
  // (0)(..)(0.29) — necessary for slider-range syntax `lo..hi`. The
  // greedy-trailing-dot form `0.` would otherwise eat the first dot.
  const m = /^-?(?:\d+\.\d+|\.\d+|\d+)(?:e[+-]?\d+)?/i.exec(tail);
  if (!m) throw new Error(`v2 parse: expected number at "${tail.slice(0, 24)}"`);
  ctx.i += m[0].length;
  return Number(m[0]);
}

// Read text up to (but not including) end of line or one of the stop chars.
function readToLineEnd(ctx) {
  let s = "";
  while (!atEnd(ctx) && ctx.source[ctx.i] !== "\n") {
    s += ctx.source[ctx.i++];
  }
  return s.trim();
}

// Read a balanced { ... } block; return inner text, leave cursor after closing }.
function readBracedBlock(ctx) {
  skipTrivia(ctx);
  consumeChar(ctx, "{");
  let depth = 1;
  let body = "";
  while (!atEnd(ctx) && depth > 0) {
    const ch = ctx.source[ctx.i];
    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) { ctx.i++; break; }
    }
    body += ch;
    ctx.i++;
  }
  if (depth !== 0) throw new Error("v2 parse: unterminated `{ ... }` block");
  return body;
}

// =============================================================================
// Top-level directive parsers
// =============================================================================

function parseQuotedDirective(ctx, keyword) {
  consumeKeyword(ctx, keyword);
  const value = readString(ctx);
  skipLine(ctx);
  return value;
}

function parseBareDirective(ctx, keyword) {
  consumeKeyword(ctx, keyword);
  skipInlineWs(ctx);
  const value = readToLineEnd(ctx);
  skipLine(ctx);
  return value;
}

function parseSubstrate(ctx) {
  consumeKeyword(ctx, "substrate");
  const kind = readIdent(ctx, "substrate kind");
  if (kind !== "geodesic") {
    throw new Error(`v2 parse: only \`substrate geodesic ...\` is supported in v2 first cut, got "${kind}"`);
  }
  // Expect: `frequency N`. Reserved future: `square W H`, `torus W H`, etc.
  consumeKeyword(ctx, "frequency");
  const frequency = readNumber(ctx);
  skipLine(ctx);
  return { kind: "geodesic", frequency, tiles: frequency };
}

function parseField(ctx) {
  consumeKeyword(ctx, "field");
  const name = readIdent(ctx, "field name");
  consumeChar(ctx, ":");
  const type = readIdent(ctx, "field type");
  if (!["f32", "vec2", "vec3", "u32", "bool"].includes(type)) {
    throw new Error(`v2 parse: unknown field type "${type}" (allowed: f32, vec2, u32, bool)`);
  }
  if (type === "vec3") {
    throw new Error(`v2 parse: field type "vec3" is reserved but not yet implemented; use f32 or vec2`);
  }
  // Optional `derived` annotation.
  skipInlineWs(ctx);
  let derived = false;
  const next = ctx.source.slice(ctx.i);
  if (/^derived\b/.test(next)) {
    consumeKeyword(ctx, "derived");
    derived = true;
  }
  skipLine(ctx);
  return {
    name,
    kind: "field",
    history: 0,         // inferred later from @prev usage
    type,
    derived,
  };
}

function parseParam(ctx) {
  // param NAME slider LO..HI [step S] default V [label "..."]
  // param NAME toggle default true|false [label "..."]
  //
  // The shape we emit matches v1's parseControlDirective output so the
  // existing control / metadata layer doesn't need a v2-specific
  // adapter:
  //   { kind: "param", type: "number"|"boolean", control: "slider",
  //     min, max, step, default, label }
  // controls.mjs gates checkbox vs slider rendering on `type === "boolean"`.
  consumeKeyword(ctx, "param");
  const name = readIdent(ctx, "param name");
  const widget = readIdent(ctx, "param kind (slider|toggle)");
  const decl = { name, kind: "param", label: name };
  if (widget === "slider") {
    decl.type = "number";
    decl.control = "slider";
    skipInlineWs(ctx);
    decl.min = readNumber(ctx);
    consumeChar(ctx, ".");
    consumeChar(ctx, ".");
    decl.max = readNumber(ctx);
    skipInlineWs(ctx);
    if (/^step\b/.test(ctx.source.slice(ctx.i))) {
      consumeKeyword(ctx, "step");
      decl.step = readNumber(ctx);
    }
    consumeKeyword(ctx, "default");
    decl.default = readNumber(ctx);
  } else if (widget === "toggle") {
    decl.type = "boolean";
    consumeKeyword(ctx, "default");
    skipInlineWs(ctx);
    const word = readIdent(ctx, "toggle default (true|false)");
    if (word !== "true" && word !== "false") {
      throw new Error(`v2 parse: toggle default must be true|false, got ${word}`);
    }
    decl.default = word === "true";
  } else {
    throw new Error(`v2 parse: unknown param widget "${widget}" (allowed: slider, toggle)`);
  }
  skipInlineWs(ctx);
  if (/^label\b/.test(ctx.source.slice(ctx.i))) {
    consumeKeyword(ctx, "label");
    decl.label = readString(ctx);
  }
  skipLine(ctx);
  return decl;
}

function parseConst(ctx) {
  consumeKeyword(ctx, "const");
  const name = readIdent(ctx, "const name");
  consumeChar(ctx, "=");
  const value = readNumber(ctx);
  skipLine(ctx);
  return { name, value };
}

// =============================================================================
// Scenario / Stamp blocks
// =============================================================================

function parseScenario(ctx) {
  consumeKeyword(ctx, "scenario");
  const id = readIdent(ctx, "scenario id");
  skipInlineWs(ctx);
  let label = id;
  if (ctx.source[ctx.i] === "\"") label = readString(ctx);
  const body = readBracedBlock(ctx);
  return { id, label, actions: parseInitActions(body, `scenario ${id}`) };
}

function parseStamp(ctx) {
  consumeKeyword(ctx, "stamp");
  const id = readIdent(ctx, "stamp id");
  skipInlineWs(ctx);
  let label = id;
  if (ctx.source[ctx.i] === "\"") label = readString(ctx);
  const body = readBracedBlock(ctx);
  return { id, label, actions: parseInitActions(body, `stamp ${id}`, /*allowBrush=*/true) };
}

// Parses `set f = expr`, `spot f at ...`, `ellipse f at ...`, `region f at ...`,
// `for each cell { actions }` inside scenario / stamp bodies. Returns an array
// of action objects shaped like v1's preset/stamp action IR.
function parseInitActions(text, label, allowBrush = false) {
  const ctx = makeCtx(text);
  const actions = [];
  while (true) {
    skipTrivia(ctx);
    if (atEnd(ctx)) break;
    const kw = peekKeyword(ctx);
    if (!kw) throw new Error(`v2 parse: ${label}: expected action at "${currentLine(ctx).slice(0, 32)}"`);
    if (kw === "set") {
      consumeKeyword(ctx, "set");
      const field = readIdent(ctx, "set field");
      consumeChar(ctx, "=");
      const expr = parseExpressionUntilLine(ctx);
      // v1 represents preset/stamp `set f = expr` as `fill` for constant exprs;
      // we emit the same structure either way and let the runtime evaluate.
      actions.push({ type: "fill", field, value: expr });
    } else if (kw === "spot") {
      consumeKeyword(ctx, "spot");
      const field = readIdent(ctx, "spot field");
      // `at` keyword
      consumeKeyword(ctx, "at");
      // Named args separated by commas: lon=, lat=, radius=, amount=
      // OR a positional `brush.pos` shortcut for stamps.
      const args = parseNamedOrBrushArgs(ctx, allowBrush, label);
      actions.push({ type: "spot", field, ...args });
    } else if (kw === "ellipse") {
      consumeKeyword(ctx, "ellipse");
      const field = readIdent(ctx, "ellipse field");
      consumeKeyword(ctx, "at");
      const args = parseNamedOrBrushArgs(ctx, allowBrush, label, /*ellipse=*/true);
      actions.push({ type: "ellipse", field, ...args });
    } else if (kw === "region") {
      consumeKeyword(ctx, "region");
      const field = readIdent(ctx, "region field");
      consumeKeyword(ctx, "at");
      const args = parseNamedArgs(ctx, ["lonMin", "lonMax", "latMin", "latMax", "amount"], label);
      actions.push({ type: "region", field, ...args });
    } else if (kw === "for") {
      consumeKeyword(ctx, "for");
      consumeKeyword(ctx, "each");
      consumeKeyword(ctx, "cell");
      // Optional `where PRED` filter — runs the body only on cells
      // whose predicate is truthy. Without this, "init only the
      // northern hemisphere" requires wrapping the body in a `when`
      // block; with it, the filter is at the iteration boundary
      // where authors intuitively expect it.
      skipInlineWs(ctx);
      let predicate = null;
      if (/^where\b/.test(ctx.source.slice(ctx.i))) {
        consumeKeyword(ctx, "where");
        predicate = parseExpressionUntilBrace(ctx);
      }
      const body = readBracedBlock(ctx);
      actions.push({
        type: "eachCell",
        predicate,
        actions: parseCellActions(body, `${label} eachCell`, /*forScenario=*/true),
      });
    } else {
      throw new Error(`v2 parse: ${label}: unknown action "${kw}"`);
    }
  }
  return actions;
}

function parseNamedOrBrushArgs(ctx, allowBrush, label, ellipse = false) {
  skipInlineWs(ctx);
  // Detect `brush.pos` shorthand: replaces `lon=brush.pos.lon, lat=brush.pos.lat`
  let args = {};
  if (allowBrush && /^brush\b/.test(ctx.source.slice(ctx.i))) {
    consumeKeyword(ctx, "brush");
    consumeChar(ctx, ".");
    const member = readIdent(ctx, "brush member");
    if (member !== "pos") throw new Error(`v2 parse: ${label}: only \`brush.pos\` shorthand supported in spot/ellipse position`);
    args.lon = makeBrushIdent("lon");
    args.lat = makeBrushIdent("lat");
    tryConsumeChar(ctx, ",");
  }
  const expected = ellipse
    ? ["lon", "lat", "rx", "ry", "angle", "amount"]
    : ["lon", "lat", "radius", "amount"];
  const named = parseNamedArgs(ctx, expected, label, /*allowMissing=*/true);
  args = { ...args, ...named };
  return args;
}

function parseNamedArgs(ctx, allowedKeys, label, allowMissing = false) {
  const out = {};
  while (true) {
    skipInlineWs(ctx);
    if (atEnd(ctx) || ctx.source[ctx.i] === "\n") break;
    const tail = ctx.source.slice(ctx.i);
    const m = IDENT_RE.exec(tail);
    if (!m) break;
    const key = m[0];
    if (!allowedKeys.includes(key)) break;
    ctx.i += key.length;
    consumeChar(ctx, "=");
    const value = parseExpressionUntilCommaOrLine(ctx);
    out[key] = value;
    if (!tryConsumeChar(ctx, ",")) break;
  }
  if (!allowMissing) {
    for (const k of allowedKeys) {
      if (!(k in out)) throw new Error(`v2 parse: ${label}: missing named arg "${k}"`);
    }
  }
  return out;
}

function makeBrushIdent(component) {
  // Brush coords come from the runtime as bindings named `lon`, `lat`, `r`.
  // They're already the ambient stamp identifiers in v1, so referencing them
  // bare gives the stamp the same value. The v1 stamp-action shape uses
  // these names directly.
  if (component === "lon") return { type: "Identifier", name: "lon" };
  if (component === "lat") return { type: "Identifier", name: "lat" };
  throw new Error(`v2 parse: makeBrushIdent unknown component ${component}`);
}

// =============================================================================
// Step / Stage blocks
// =============================================================================

function parseStep(ctx) {
  consumeKeyword(ctx, "step");
  // Reserved future: `step at 30hz { ... }`. v2 first cut: bare `step { ... }`.
  skipInlineWs(ctx);
  if (/^at\b/.test(ctx.source.slice(ctx.i))) {
    throw new Error("v2 parse: `step at Nhz` is reserved syntax, not yet implemented; use `step { ... }`");
  }
  const body = readBracedBlock(ctx);
  // Parse stages out of body.
  const inner = makeCtx(body);
  const stages = [];
  while (true) {
    skipTrivia(inner);
    if (atEnd(inner)) break;
    const kw = peekKeyword(inner);
    if (kw !== "stage") throw new Error(`v2 parse: step body: expected "stage", got "${kw}"`);
    stages.push(parseStage(inner));
  }
  if (stages.length === 0) throw new Error("v2 parse: empty step block");
  return stages;
}

function parseStage(ctx) {
  consumeKeyword(ctx, "stage");
  const id = readIdent(ctx, "stage id");
  skipInlineWs(ctx);
  let name = id;
  if (ctx.source[ctx.i] === "\"") name = readString(ctx);
  const body = readBracedBlock(ctx);
  // Stage body has: reads CLAUSE, writes CLAUSE, cell { ... }
  // The v1 stage primitives (advect / wind / diffuse / clamp /
  // normalize) are rejected at parse time with redirect messages
  // pointing at the cell-stage equivalents (gradient, divergence,
  // field@upstream, neighbor reductions).
  const inner = makeCtx(body);
  const reads = [];
  const writes = [];
  const previousReads = new Set();
  const statements = [];
  let cellSeen = false;
  while (true) {
    skipTrivia(inner);
    if (atEnd(inner)) break;
    const kw = peekKeyword(inner);
    if (kw === "reads") {
      consumeKeyword(inner, "reads");
      const items = parseFieldList(inner);
      for (const item of items) {
        reads.push(item.name);
        if (item.previous) previousReads.add(item.name);
      }
    } else if (kw === "writes") {
      consumeKeyword(inner, "writes");
      const items = parseFieldList(inner);
      for (const item of items) writes.push(item.name);
    } else if (kw === "cell") {
      if (cellSeen) throw new Error(`v2 parse: stage ${id}: only one cell { } block per stage`);
      cellSeen = true;
      consumeKeyword(inner, "cell");
      const cellBody = readBracedBlock(inner);
      const cellActions = parseCellActions(cellBody, `stage ${id} cell`);
      statements.push({ type: "cell", actions: cellActions });
    } else if (kw === "advect") {
      // `advect` was a v1 primitive that bundled the semi-Lagrangian
      // sample into one statement. v2 expresses this as a cell stage
      // using the `field@upstream(velX, velY, dt)` coordinate query.
      throw new Error(
        `v2 parse: stage ${id}: \`advect\` is no longer a stage primitive in v2. ` +
        `Express it as a cell stage:\n` +
        `  stage flow {\n` +
        `    reads w, slope\n` +
        `    writes w\n` +
        `    cell { set w = w@upstream(slope.x, slope.y, dt * scale) }\n` +
        `  }`,
      );
    } else if (kw === "wind") {
      // `wind` was a v1 primitive that bundled pressure-gradient +
      // Coriolis + tangent-frame projection into one kernel. v2
      // expresses this as a regular cell stage using gradient(field)
      // (returns vec2 in tangent frame) and divergence(vec2_field)
      // (returns scalar). See V2-SPEC.md / dsl-spec.mjs for the full
      // pattern.
      throw new Error(
        `v2 parse: stage ${id}: \`wind\` is no longer a stage primitive in v2. ` +
        `Express it as a cell stage:\n` +
        `  field wind: vec2\n` +
        `  field lift: f32 derived\n` +
        `  stage compute_wind {\n` +
        `    reads pressure\n` +
        `    writes wind, lift\n` +
        `    cell {\n` +
        `      let grad = gradient(pressure)\n` +
        `      let cor = clamp(py, -1, 1) * 0.65\n` +
        `      set wind = vec2(-grad.x + cor*grad.y, -grad.y - cor*grad.x) * strength\n` +
        `      set lift = -divergence(wind) * 0.7\n` +
        `    }\n` +
        `  }`,
      );
    } else if (kw === "diffuse" || kw === "clamp" || kw === "normalize") {
      // V2 retires these — they're trivially expressible as cell-body
      // expressions (`add u = (mean n in neighbors { u@n } - u) *
      // amount`, `set u = clamp(u, lo, hi)`). Erroring here points
      // recipe authors at the v2 idiom instead of letting them write
      // syntax that looks like it should work.
      throw new Error(
        `v2 parse: stage ${id}: \`${kw}\` is no longer a stage primitive in v2. ` +
        `${redirectFor(kw)}`,
      );
    } else {
      throw new Error(`v2 parse: stage ${id}: unknown clause "${kw}"`);
    }
  }
  if (statements.length === 0) {
    throw new Error(`v2 parse: stage ${id}: missing cell { } block (or legacy primitive)`);
  }
  return {
    id,
    name,
    reads: dedupe(reads),
    writes: dedupe(writes),
    declares: [],
    body: { statements },
    previousReads: [...previousReads],
  };
}

function redirectFor(kw) {
  if (kw === "diffuse") {
    return `Use a cell expression instead:\n  add field = (mean n in neighbors { field@n } - field) * <amount>`;
  }
  if (kw === "clamp") {
    return `Use a cell expression instead:\n  set field = clamp(field, <lo>, <hi>)`;
  }
  if (kw === "normalize") {
    return `Normalize requires a global reduction; v2 has no equivalent yet. Compute the global mean as a metric and divide cell values by it from JS, or implement a reduction-and-broadcast stage when the kernel infra exists.`;
  }
  return "";
}

// Parse a comma-separated list of field references, optionally each tagged
// with `previous`. Examples:
//   reads u
//   reads u, v
//   reads u previous
//   reads u, u previous, v
function parseFieldList(ctx) {
  const items = [];
  while (true) {
    skipInlineWs(ctx);
    const tail = ctx.source.slice(ctx.i);
    const m = IDENT_RE.exec(tail);
    if (!m) break;
    const name = m[0];
    ctx.i += name.length;
    skipInlineWs(ctx);
    let previous = false;
    if (/^previous\b/.test(ctx.source.slice(ctx.i))) {
      consumeKeyword(ctx, "previous");
      previous = true;
    }
    items.push({ name, previous });
    if (!tryConsumeChar(ctx, ",")) break;
  }
  return items;
}

// =============================================================================
// Cell-body actions: let, set, add, when, emit
// =============================================================================

function parseCellActions(text, label, forScenario = false) {
  const ctx = makeCtx(text);
  const actions = [];
  while (true) {
    skipTrivia(ctx);
    if (atEnd(ctx)) break;
    const kw = peekKeyword(ctx);
    if (!kw) throw new Error(`v2 parse: ${label}: unexpected "${currentLine(ctx).slice(0, 32)}"`);
    if (kw === "let") {
      consumeKeyword(ctx, "let");
      const name = readIdent(ctx, "let name");
      consumeChar(ctx, "=");
      const expr = parseExpressionUntilLine(ctx);
      actions.push({ type: "let", name, expr });
    } else if (kw === "set") {
      consumeKeyword(ctx, "set");
      const field = readIdent(ctx, "set field");
      consumeChar(ctx, "=");
      const expr = parseExpressionUntilLine(ctx);
      actions.push({ type: "set", field, expr });
    } else if (kw === "add") {
      consumeKeyword(ctx, "add");
      const field = readIdent(ctx, "add field");
      consumeChar(ctx, "=");
      const expr = parseExpressionUntilLine(ctx);
      actions.push({ type: "add", field, expr });
    } else if (kw === "when") {
      consumeKeyword(ctx, "when");
      const condition = parseExpressionUntilBrace(ctx);
      const body = readBracedBlock(ctx);
      actions.push({ type: "when", condition, actions: parseCellActions(body, `${label} when`, forScenario) });
    } else if (kw === "emit") {
      // emit is intentionally not a v2 cell action. The unifying spacetime-
      // query model says: stages mutate per-cell state, metrics read scalar
      // reductions. A side-effect from inside a cell body — emit a global
      // counter — punches a hole through that model: it adds reset timing,
      // ordering, naming, and accumulation semantics that don't compose
      // with anything else. The same need is covered by:
      //
      //     metric thing = count cells where <condition>
      //
      // For a per-cell event-like flag, derive a field:
      //
      //     field spawning: f32 derived
      //     stage mark { reads u; writes spawning;
      //                  cell { set spawning = u > threshold ? 1 : 0 } }
      //     metric spawning_count = sum cells { spawning }
      throw new Error(
        `v2 parse: ${label}: \`emit\` is not a v2 cell action — use \`metric x = count cells where ...\` ` +
        `for the same observation, or derive a per-cell flag field and reduce it`,
      );
    } else {
      throw new Error(`v2 parse: ${label}: unknown action "${kw}"`);
    }
  }
  return actions;
}

// =============================================================================
// Metric declarations
// =============================================================================

function parseMetric(ctx) {
  consumeKeyword(ctx, "metric");
  const id = readIdent(ctx, "metric id");
  consumeChar(ctx, "=");
  skipInlineWs(ctx);
  // Read reduction op.
  const op = readIdent(ctx, "metric reduction (sum|max|min|mean|count)");
  if (!["sum", "max", "min", "mean", "count"].includes(op)) {
    throw new Error(`v2 parse: metric ${id}: unknown reduction "${op}"`);
  }
  consumeKeyword(ctx, "cells");
  // Optional `where PREDICATE`.
  let predicate = null;
  skipInlineWs(ctx);
  if (/^where\b/.test(ctx.source.slice(ctx.i))) {
    consumeKeyword(ctx, "where");
    predicate = parseExpressionUntilBraceOrLine(ctx);
  }
  // count has no body (implicit `1`); others require `{ EXPR }`.
  let body = null;
  skipInlineWs(ctx);
  if (op === "count" && ctx.source[ctx.i] !== "{") {
    skipLine(ctx);
  } else {
    consumeChar(ctx, "{");
    const inner = readUntilMatchingBrace(ctx);
    body = parseExpressionFromString(inner.trim(), `metric ${id}`);
    skipLine(ctx);
  }
  return { id, op, predicate, body };
}

// readUntilMatchingBrace: consume up to and including the closing `}` of a
// brace already-consumed by the caller.
function readUntilMatchingBrace(ctx) {
  let depth = 1;
  let s = "";
  while (!atEnd(ctx) && depth > 0) {
    const ch = ctx.source[ctx.i];
    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) { ctx.i++; break; }
    }
    s += ch;
    ctx.i++;
  }
  return s;
}

// =============================================================================
// Expressions — extended with v2 coordinate queries (@prev, @n) and
// cell-centered neighbor reductions.
//
// We implement these by transforming v2 expression source to a token stream,
// then producing an AST that matches v1's expression shape (so existing
// validation and WGSL emission work unchanged):
//   - `u@prev`   → Call(prev, [u])
//   - `u@n` (inside `sum n in neighbors { ... }`) → Identifier(_n_u)
//   - `sum n in neighbors { body }` → NeighborReduce { bindings, body }
//     where bindings collects every `field@n` reference in body and
//     gives each a unique synthetic local name.
// =============================================================================

function parseExpressionUntilLine(ctx) {
  // Read text up to end of line, semicolon, or matching outer brace
  // (depth-aware). Semicolon and newline are equivalent statement
  // terminators inside cell / scenario / stamp bodies.
  const text = readExpressionTextUntil(ctx, ["\n", ";"]);
  return parseExpressionFromString(text, "expression");
}

function parseExpressionUntilCommaOrLine(ctx) {
  const text = readExpressionTextUntil(ctx, [",", "\n", ";"]);
  return parseExpressionFromString(text, "expression");
}

function parseExpressionUntilBrace(ctx) {
  const text = readExpressionTextUntil(ctx, ["{"]);
  return parseExpressionFromString(text, "expression");
}

function parseExpressionUntilBraceOrLine(ctx) {
  const text = readExpressionTextUntil(ctx, ["{", "\n"]);
  return parseExpressionFromString(text, "expression");
}

// Read expression text up to the first occurrence of any stop char at brace
// depth 0 (so `{ ... }` blocks inside expressions are kept intact). Doesn't
// consume the stop char.
//
// Line comments (`// ...`) are eaten in place: when we hit `//` at depth 0
// we skip ahead to the next newline. Without this the trailing comment on
// a single-line metric like
//     metric m = count cells where x > 0   // some note
// would get pulled into the where-expression text and tokenize as `/ /`,
// blowing up parseExpressionFromString.
function readExpressionTextUntil(ctx, stops) {
  let depth = 0;
  let parens = 0;
  let s = "";
  while (!atEnd(ctx)) {
    const ch = ctx.source[ctx.i];
    if (depth === 0 && parens === 0 && stops.includes(ch)) break;
    // Strip `//` line comments — advance to (but don't consume) the
    // next newline. The newline itself is left for the caller's
    // stop-char handling.
    if (ch === "/" && ctx.source[ctx.i + 1] === "/") {
      while (!atEnd(ctx) && ctx.source[ctx.i] !== "\n") ctx.i++;
      continue;
    }
    if (ch === "{") depth++;
    if (ch === "}") {
      if (depth === 0) break;
      depth--;
    }
    if (ch === "(") parens++;
    if (ch === ")") parens--;
    s += ch;
    ctx.i++;
  }
  return s.trim();
}

// =============================================================================
// V2 expression tokenizer + parser
// =============================================================================

const V2_BINARY_PRECEDENCE = new Map([
  ["??", 1],
  ["||", 2],
  ["&&", 3],
  ["===", 4],
  ["!==", 4],
  ["==", 4],
  ["!=", 4],
  [">", 5],
  [">=", 5],
  ["<", 5],
  ["<=", 5],
  ["+", 6],
  ["-", 6],
  ["*", 7],
  ["/", 7],
  ["%", 7],
]);

function tokenizeV2Expr(source) {
  const tokens = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (/\s/.test(ch)) { i++; continue; }
    const number = /^(?:\d+\.\d*|\.\d+|\d+)(?:e[+-]?\d+)?/i.exec(source.slice(i));
    if (number) {
      tokens.push({ type: "number", value: number[0] });
      i += number[0].length;
      continue;
    }
    const ident = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(i));
    if (ident) {
      let value = ident[0];
      if (value === "and") value = "&&";
      if (value === "or") value = "||";
      if (value === "not") value = "!";
      const tokType = V2_BINARY_PRECEDENCE.has(value) || value === "!" ? "op" : "ident";
      tokens.push({ type: tokType, value });
      i += ident[0].length;
      continue;
    }
    const op = ["===", "!==", "??", "&&", "||", ">=", "<=", "==", "!=", "+", "-", "*", "/", "%", ">", "<", "!", "?", ":", ".", "(", ")", ",", "{", "}", "@"]
      .find((cand) => source.startsWith(cand, i));
    if (op) {
      const tokType = V2_BINARY_PRECEDENCE.has(op) || op === "!" ? "op" : "punc";
      tokens.push({ type: tokType, value: op });
      i += op.length;
      continue;
    }
    throw new Error(`v2 expr tokenize: unexpected char "${ch}" in "${source}" at ${i}`);
  }
  tokens.push({ type: "eof", value: "" });
  return tokens;
}

function parseExpressionFromString(text, label = "expression") {
  if (!text) throw new Error(`v2 parse: ${label}: empty expression`);
  const tokens = tokenizeV2Expr(text);
  const parser = { tokens, index: 0, neighborBinds: [] };
  const ast = parseV2Conditional(parser);
  if (parser.tokens[parser.index].type !== "eof") {
    throw new Error(`v2 parse: ${label}: unexpected token "${parser.tokens[parser.index].value}" after expression`);
  }
  return ast;
}

function parseV2Conditional(parser) {
  const test = parseV2Binary(parser, 0);
  if (parser.tokens[parser.index].value !== "?") return test;
  parser.index++;
  const consequent = parseV2Conditional(parser);
  expectV2(parser, ":");
  const alternate = parseV2Conditional(parser);
  return { type: "Conditional", test, consequent, alternate };
}

function parseV2Binary(parser, minPrec) {
  let left = parseV2Unary(parser);
  while (true) {
    const tok = parser.tokens[parser.index];
    const prec = tok.type === "op" ? V2_BINARY_PRECEDENCE.get(tok.value) : undefined;
    if (prec === undefined || prec < minPrec) break;
    parser.index++;
    const right = parseV2Binary(parser, prec + 1);
    left = { type: "Binary", op: tok.value, left, right };
  }
  return left;
}

function parseV2Unary(parser) {
  const tok = parser.tokens[parser.index];
  if (tok.value === "!" || tok.value === "-" || tok.value === "+") {
    parser.index++;
    return { type: "Unary", op: tok.value, expr: parseV2Unary(parser) };
  }
  return parseV2Postfix(parser);
}

function parseV2Postfix(parser) {
  let expr = parseV2Primary(parser);
  while (true) {
    const tok = parser.tokens[parser.index];
    if (tok.value === ".") {
      parser.index++;
      const prop = expectV2(parser, "ident");
      // Special case: `brush.X` lowers to bare Identifier(X) since v1's
      // stamp environment binds brush coords (lon, lat, r) as ambient
      // identifiers. `brush.pos` is handled separately as a positional
      // shorthand at the parseNamedOrBrushArgs site.
      if (expr.type === "Identifier" && expr.name === "brush") {
        expr = { type: "Identifier", name: prop.value };
      } else {
        expr = { type: "Member", object: expr, prop: prop.value };
      }
      continue;
    }
    if (tok.value === "(") {
      parser.index++;
      const args = [];
      if (parser.tokens[parser.index].value !== ")") {
        do { args.push(parseV2Conditional(parser)); }
        while (parser.tokens[parser.index].value === "," && (parser.index++, true));
        expectV2(parser, ")");
      } else {
        parser.index++;
      }
      expr = { type: "Call", callee: expr, args };
      continue;
    }
    if (tok.value === "@") {
      // Coordinate query: u@prev | u@<neighbor-binding-name>. Both
      // produce a CoordRead AST node — a first-class coordinate-query
      // primitive the compiler dispatches on. The v1 lowering (Call to
      // `prev`, synthetic Identifier locals) is gone.
      //
      // Future extensions (u@prev(2), u@anti, u@(<position-expr>),
      // u@boundary) extend by adding new `coord.kind` variants here and
      // matching cases in webgpu-geodesic-compiler.mjs's compileExpr —
      // the AST stays a uniform CoordRead.
      parser.index++;
      const coordTok = parser.tokens[parser.index];
      if (coordTok.type !== "ident") {
        throw new Error(`v2 parse: expected coordinate name after @, got "${coordTok.value || coordTok.type}"`);
      }
      parser.index++;
      const coord = coordTok.value;
      if (expr.type !== "Identifier") {
        throw new Error(`v2 parse: @ coordinate query must follow a bare field name (got ${expr.type})`);
      }
      const fieldName = expr.name;
      if (coord === "prev") {
        expr = { type: "CoordRead", field: fieldName, coord: { kind: "prev" } };
      } else if (coord === "upstream") {
        // Continuous-position coordinate query for semi-Lagrangian
        // advection: `field@upstream(velX, velY, dt)` samples FIELD at
        // the cell's position walked backward `dt` along the tangent
        // velocity (velX = east, velY = north). Replaces the v2-era
        // `advect` stage primitive — the kernel that primitive
        // encapsulated is now a per-(field) WGSL helper emitted on
        // demand by the compiler.
        if (parser.tokens[parser.index]?.value !== "(") {
          throw new Error(`v2 parse: \`${fieldName}@upstream\` requires \`(velX, velY, dt)\` arguments`);
        }
        parser.index++; // consume "("
        const args = [];
        if (parser.tokens[parser.index]?.value !== ")") {
          do {
            args.push(parseV2Conditional(parser));
          } while (parser.tokens[parser.index].value === "," && (parser.index++, true));
        }
        expectV2(parser, ")");
        if (args.length !== 3) {
          throw new Error(
            `v2 parse: \`${fieldName}@upstream\` takes exactly 3 args (velX, velY, dt); got ${args.length}`,
          );
        }
        expr = {
          type: "CoordRead",
          field: fieldName,
          coord: { kind: "upstream", velX: args[0], velY: args[1], dt: args[2] },
        };
      } else {
        // Neighbor read: validates against the enclosing reduction frame.
        // The frame's `coord` must match the binding name used here.
        ensureNeighborCoordInScope(parser, coord, fieldName);
        expr = { type: "CoordRead", field: fieldName, coord: { kind: "neighbor", binding: coord } };
      }
      continue;
    }
    return expr;
  }
}

function parseV2Primary(parser) {
  const tok = parser.tokens[parser.index];
  if (tok.type === "number") {
    parser.index++;
    return { type: "Number", value: tok.value };
  }
  if (tok.type === "ident") {
    // Reduction prefixes: `sum n in neighbors { body }` and friends.
    if (V2_REDUCTION_OPS.has(tok.value)) {
      const reductionAst = tryParseV2NeighborReduction(parser);
      if (reductionAst) return reductionAst;
    }
    parser.index++;
    return { type: "Identifier", name: tok.value };
  }
  if (tok.value === "(") {
    parser.index++;
    const inner = parseV2Conditional(parser);
    expectV2(parser, ")");
    return inner;
  }
  throw new Error(`v2 parse: expected expression, got "${tok.value || tok.type}"`);
}

const V2_REDUCTION_OPS = new Set(["sum", "max", "min", "mean"]);

// Try to parse `OP IDENT in neighbors { body }`. Returns null if the
// lookahead doesn't match (so a bare identifier named `sum` etc. still
// parses as a regular Identifier — though doing that is a bad idea).
function tryParseV2NeighborReduction(parser) {
  const start = parser.index;
  const opTok = parser.tokens[start];
  if (opTok.type !== "ident" || !V2_REDUCTION_OPS.has(opTok.value)) return null;
  // Need at least: IDENT IDENT `in` `neighbors` `{`
  const t1 = parser.tokens[start + 1];
  const t2 = parser.tokens[start + 2];
  const t3 = parser.tokens[start + 3];
  const t4 = parser.tokens[start + 4];
  if (!t1 || t1.type !== "ident") return null;
  if (!t2 || t2.type !== "ident" || t2.value !== "in") return null;
  if (!t3 || t3.type !== "ident" || t3.value !== "neighbors") return null;
  if (!t4 || t4.value !== "{") return null;

  // Commit.
  parser.index = start + 5;       // past `op coord in neighbors {`
  const op = opTok.value;
  const coord = t1.value;

  // Push a scope frame so `field@coord` inside the body validates as
  // bound. The body emits CoordRead nodes; the compiler walks them
  // later to derive the per-field neighbor bindings — there's no
  // pre-rewriting at parse time.
  parser.neighborBinds.push({ coord });
  const body = parseV2Conditional(parser);
  expectV2(parser, "}");
  parser.neighborBinds.pop();

  // Sanity: a reduction with no `field@coord` reference is almost
  // certainly a typo (you'd be reducing the same value over every
  // neighbor — equivalent to `<op> * neighborCount`). Catch early.
  if (!bodyHasNeighborCoordRead(body, coord)) {
    throw new Error(
      `v2 parse: reduction \`${op} ${coord} in neighbors\` body has no \`field@${coord}\` references — ` +
      `no neighbor data to reduce`,
    );
  }
  return {
    type: "NeighborReduce",
    op,
    coord,
    body,
  };
}

function ensureNeighborCoordInScope(parser, coord, fieldName) {
  const frame = parser.neighborBinds[parser.neighborBinds.length - 1];
  if (!frame || frame.coord !== coord) {
    throw new Error(
      `v2 parse: \`${fieldName}@${coord}\` outside its enclosing \`<op> ${coord} in neighbors { ... }\` reduction`,
    );
  }
}

function bodyHasNeighborCoordRead(ast, coord) {
  if (!ast || typeof ast !== "object") return false;
  if (ast.type === "CoordRead" && ast.coord?.kind === "neighbor" && ast.coord.binding === coord) return true;
  for (const k of Object.keys(ast)) {
    const v = ast[k];
    if (Array.isArray(v) && v.some((c) => bodyHasNeighborCoordRead(c, coord))) return true;
    if (v && typeof v === "object" && bodyHasNeighborCoordRead(v, coord)) return true;
  }
  return false;
}

function expectV2(parser, valueOrType) {
  const tok = parser.tokens[parser.index];
  if (tok.value === valueOrType || tok.type === valueOrType) {
    parser.index++;
    return tok;
  }
  throw new Error(`v2 parse: expected "${valueOrType}", got "${tok.value || tok.type}"`);
}

// =============================================================================
// Misc
// =============================================================================

function dedupe(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}
