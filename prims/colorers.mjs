// =============================================================================
// View colorers.
//
// Each factory returns a per-cell colorer function with the signature
//   (i, fields) → [r, g, b] (0-255 ints).
//
// Recipes don't call these directly — `palette` and `view` blocks in
// the DSL parse into structured records that materializeView() (below)
// routes to the right factory. The geodesic renderer then calls
// `view.color(i, fields)` once per cell.
// =============================================================================

import { clamp, lerp } from "../kernel/kernel.mjs";

// Generic stops-based ramp. `stops` is `[{t, color}, ...]` with t in
// [0, 1] in ascending order. `range` is `[a, b]` — input value gets
// remapped to t = clamp((value - a) / (b - a), 0, 1) before
// interpolation. Piecewise-linear between stops.
export function rampFromStops(fieldName, stops, range) {
  const [lo, hi] = range;
  const span = hi - lo;
  const sample = (value) => {
    if (!Number.isFinite(value)) return [80, 60, 90];
    const t = clamp((value - lo) / span, 0, 1);
    // Single-stop is just that color (validator should reject this
    // upstream, but be safe).
    if (stops.length === 1) return [...stops[0].color];
    // Find the segment containing t. Stops are sorted ascending.
    let i = 0;
    while (i < stops.length - 1 && t > stops[i + 1].t) i++;
    const a = stops[i];
    const b = stops[i + 1] ?? a;
    const segSpan = b.t - a.t;
    const segT = segSpan > 0 ? (t - a.t) / segSpan : 0;
    return [
      Math.round(lerp(a.color[0], b.color[0], segT)),
      Math.round(lerp(a.color[1], b.color[1], segT)),
      Math.round(lerp(a.color[2], b.color[2], segT)),
    ];
  };
  const color = (i, fields) => sample(fields[fieldName]?.[i] ?? 0);
  color.write = (i, fields, data, k) => {
    const rgb = sample(fields[fieldName]?.[i] ?? 0);
    data[k + 0] = rgb[0];
    data[k + 1] = rgb[1];
    data[k + 2] = rgb[2];
  };
  color.fields = [fieldName];
  return color;
}

// Wheel: hue-rotate by t = (value - a) / (b - a). Same HSV math as
// `phase` but the input range is configurable rather than implicitly
// [0, TAU]. A view with `range [0, 1]` maps a normalized phase
// directly; `range [0, TAU]` recovers the original `phase` semantics.
export function wheelFromRange(fieldName, range) {
  const [lo, hi] = range;
  const span = hi - lo;
  const sample = (value) => {
    if (!Number.isFinite(value)) return [80, 60, 90];
    // Wrap into [0, 1) — no clamp, so values outside [a, b] still
    // map to a hue (cyclic data is the whole point).
    const h = ((value - lo) / span % 1 + 1) % 1;
    const sector = Math.floor(h * 6);
    const f = h * 6 - sector;
    const q = Math.round((1 - f) * 255);
    const t = Math.round(f * 255);
    switch (sector % 6) {
      case 0: return [255, t, 0];
      case 1: return [q, 255, 0];
      case 2: return [0, 255, t];
      case 3: return [0, q, 255];
      case 4: return [t, 0, 255];
      default: return [255, 0, q];
    }
  };
  const color = (i, fields) => sample(fields[fieldName]?.[i] ?? 0);
  color.write = (i, fields, data, k) => {
    const rgb = sample(fields[fieldName]?.[i] ?? 0);
    data[k + 0] = rgb[0];
    data[k + 1] = rgb[1];
    data[k + 2] = rgb[2];
  };
  color.fields = [fieldName];
  return color;
}

// Block-form `color expr { ... }`. The body is a parsed cell-action
// AST; we run it per-cell on the JS side using a tiny evaluator that
// resolves field reads / locals / params / consts / `set red/green/
// blue` against the current cell context. Output is clamped to the
// 0..255 RGB range.
export function exprColorer(actions, fieldDecls, paramDecls, constDecls) {
  // Pre-collect the set of fields the body actually references —
  // drives the `color.fields` annotation that the renderer uses to
  // upload only the needed buffers per frame.
  const usedFields = new Set();
  collectFieldRefs(actions, new Set(fieldDecls.map((d) => d.name)), usedFields);

  const fieldTypes = new Map(fieldDecls.map((d) => [d.name, d.type ?? "f32"]));
  const sample = (i, fields, params, consts) => {
    const cell = { fields, params, consts, locals: Object.create(null), i };
    const out = { red: 0, green: 0, blue: 0 };
    runViewBody(actions, cell, out, fieldTypes);
    return [
      Math.max(0, Math.min(255, Math.round(out.red))),
      Math.max(0, Math.min(255, Math.round(out.green))),
      Math.max(0, Math.min(255, Math.round(out.blue))),
    ];
  };

  // Returned colorer signature is the same `(i, fields) → [r,g,b]` /
  // `.write(i, fields, data, k)` shape the renderer consumes for any
  // view. Params/consts are supplied via a closure the materialize
  // step injects.
  let cachedParams = {};
  let cachedConsts = {};
  const colorer = (i, fields) => sample(i, fields, cachedParams, cachedConsts);
  colorer.write = (i, fields, data, k) => {
    const rgb = sample(i, fields, cachedParams, cachedConsts);
    data[k + 0] = rgb[0];
    data[k + 1] = rgb[1];
    data[k + 2] = rgb[2];
  };
  colorer.fields = [...usedFields];
  // Bind params + consts at materialize time — recipes can change
  // params live, but the colorer's closures here re-read the live
  // params object on every call, so updates take effect immediately.
  colorer.bindContext = ({ params, consts }) => {
    cachedParams = params ?? {};
    cachedConsts = consts ?? {};
  };
  return colorer;
}

function runViewBody(actions, cell, out, fieldTypes) {
  for (const action of actions ?? []) {
    if (!action) continue;
    if (action.type === "let") {
      cell.locals[action.name] = evalViewExpr(action.expr, cell, fieldTypes);
      continue;
    }
    if (action.type === "set") {
      const v = evalViewExpr(action.expr, cell, fieldTypes);
      out[action.field] = typeof v === "number" ? v : Number(v);
      continue;
    }
    if (action.type === "when") {
      if (evalViewExpr(action.condition, cell, fieldTypes)) {
        runViewBody(action.actions ?? [], cell, out, fieldTypes);
      }
      continue;
    }
  }
}

function evalViewExpr(ast, cell, fieldTypes) {
  if (!ast) return 0;
  switch (ast.type) {
    case "Number":
      return Number(ast.value);
    case "Identifier":
      return resolveViewIdent(ast.name, cell, fieldTypes);
    case "Member": {
      const obj = evalViewExpr(ast.object, cell, fieldTypes);
      // vec2 fields surface as { __vec2: true, x, y } so .x / .y read
      // the right component.
      if (obj && typeof obj === "object" && (ast.prop === "x" || ast.prop === "y")) return obj[ast.prop];
      return 0;
    }
    case "Unary": {
      const v = evalViewExpr(ast.expr, cell, fieldTypes);
      if (ast.op === "-") return -v;
      if (ast.op === "+") return +v;
      if (ast.op === "!") return v ? 0 : 1;
      return v;
    }
    case "Binary": {
      const a = evalViewExpr(ast.left, cell, fieldTypes);
      const b = evalViewExpr(ast.right, cell, fieldTypes);
      switch (ast.op) {
        case "+": return a + b;
        case "-": return a - b;
        case "*": return a * b;
        case "/": return a / b;
        case "%": return a - b * Math.floor(a / b);
        case "==": return a === b ? 1 : 0;
        case "!=": return a !== b ? 1 : 0;
        case "<":  return a < b ? 1 : 0;
        case "<=": return a <= b ? 1 : 0;
        case ">":  return a > b ? 1 : 0;
        case ">=": return a >= b ? 1 : 0;
        case "&&": return (a && b) ? 1 : 0;
        case "||": return (a || b) ? 1 : 0;
        case "??": return Number.isFinite(a) ? a : b;
        default: throw new Error(`view expr: unsupported binary "${ast.op}"`);
      }
    }
    case "Conditional":
      return evalViewExpr(ast.test, cell, fieldTypes)
        ? evalViewExpr(ast.consequent, cell, fieldTypes)
        : evalViewExpr(ast.alternate, cell, fieldTypes);
    case "Call":
      return evalViewCall(ast, cell, fieldTypes);
  }
  return 0;
}

function resolveViewIdent(name, cell, fieldTypes) {
  if (name === "true") return 1;
  if (name === "false") return 0;
  if (Object.hasOwn(cell.locals, name)) return cell.locals[name];
  if (Object.hasOwn(cell.params ?? {}, name)) return cell.params[name];
  if (Object.hasOwn(cell.consts ?? {}, name)) return cell.consts[name];
  if (name === "PI") return Math.PI;
  if (name === "TAU") return Math.PI * 2;
  // Field read at the cell's index.
  const arr = cell.fields?.[name];
  if (arr) {
    const ftype = fieldTypes.get(name);
    if (ftype === "vec2") {
      return { __vec2: true, x: arr[cell.i * 2], y: arr[cell.i * 2 + 1] };
    }
    return arr[cell.i] ?? 0;
  }
  // Geo-position builtins. The renderer pre-fills these into
  // cell.fields when sampling — but here we're called through the
  // colorer signature `(i, fields)` which doesn't carry them. For
  // now, default to 0 — recipes that need lon/lat in views should
  // promote them to derived fields.
  return 0;
}

function evalViewCall(ast, cell, fieldTypes) {
  const name = ast.callee?.name;
  const args = (ast.args ?? []).map((a) => evalViewExpr(a, cell, fieldTypes));
  switch (name) {
    case "clamp":     return Math.min(Math.max(args[0], args[1]), args[2]);
    case "min":       return Math.min(...args);
    case "max":       return Math.max(...args);
    case "abs":       return Math.abs(args[0]);
    case "sin":       return Math.sin(args[0]);
    case "cos":       return Math.cos(args[0]);
    case "asin":      return Math.asin(args[0]);
    case "atan2":     return Math.atan2(args[0], args[1]);
    case "exp":       return Math.exp(args[0]);
    case "sqrt":      return Math.sqrt(args[0]);
    case "pow":       return Math.pow(args[0], args[1]);
    case "hypot":     return Math.hypot(...args);
    case "wrapAngle": return Math.atan2(Math.sin(args[0]), Math.cos(args[0]));
    case "smoothstep": {
      const [e0, e1, x] = args;
      const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
      return t * t * (3 - 2 * t);
    }
    case "length": {
      const v = args[0];
      if (v && typeof v === "object" && v.__vec2) return Math.hypot(v.x, v.y);
      return Math.abs(Number(v));
    }
    default:
      throw new Error(`view expr: unsupported call "${name}"`);
  }
}

function collectFieldRefs(actions, fieldNameSet, out) {
  for (const action of actions ?? []) {
    if (!action) continue;
    if (action.expr) walkAst(action.expr, fieldNameSet, out);
    if (action.condition) walkAst(action.condition, fieldNameSet, out);
    if (action.actions) collectFieldRefs(action.actions, fieldNameSet, out);
  }
}
function walkAst(ast, fieldNameSet, out) {
  if (!ast || typeof ast !== "object") return;
  if (ast.type === "Identifier" && fieldNameSet.has(ast.name)) out.add(ast.name);
  for (const k of Object.keys(ast)) {
    const v = ast[k];
    if (Array.isArray(v)) v.forEach((c) => walkAst(c, fieldNameSet, out));
    else if (v && typeof v === "object") walkAst(v, fieldNameSet, out);
  }
}

// Materialize a single view declaration (from the DSL parser) into a
// `{ id, label, color }` record matching the renderer's existing
// shape. Routes by view kind to the right factory above.
//
// `palettes` is the map of palette-name → palette record so a ramp
// view referencing a named palette can resolve it.
//
// `fieldDecls` / `paramDecls` / `constDecls` flow through to the
// expr-view factory's evaluator.
export function materializeView(view, palettes, fieldDecls = [], paramDecls = [], constDecls = []) {
  // Optional sibling `glyph` clause — passes through verbatim. The
  // renderer reads { kind, rotate, size, length, stride } when
  // populating the per-cell glyph mesh; absence means the view has
  // no glyph overlay.
  const glyph = view.glyph ?? null;
  const particles = view.particles ?? null;
  if (view.kind === "ramp") {
    let stops;
    if (view.paletteName) {
      const palette = palettes.find((p) => p.name === view.paletteName);
      if (!palette) {
        throw new Error(`view "${view.id}": palette "${view.paletteName}" not declared`);
      }
      stops = palette.stops;
    } else {
      stops = view.stops;
    }
    return {
      id: view.id,
      label: view.label,
      color: rampFromStops(view.field, stops, view.range),
      glyph,
      particles,
    };
  }
  if (view.kind === "wheel") {
    return {
      id: view.id,
      label: view.label,
      color: wheelFromRange(view.field, view.range),
      glyph,
      particles,
    };
  }
  if (view.kind === "expr") {
    return {
      id: view.id,
      label: view.label,
      color: exprColorer(view.actions, fieldDecls, paramDecls, constDecls),
      glyph,
      particles,
    };
  }
  throw new Error(`view "${view.id}": unknown kind "${view.kind}"`);
}
