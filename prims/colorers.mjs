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

const COLOR_LUT_SIZE = 2048;
const FALLBACK_RGB = [80, 60, 90];

// Generic stops-based ramp. `stops` is `[{t, color}, ...]` with t in
// [0, 1] in ascending order. `range` is `[a, b]` — input value gets
// remapped to t = clamp((value - a) / (b - a), 0, 1) before
// interpolation. Piecewise-linear between stops.
export function rampFromStops(fieldName, stops, range) {
  const [lo, hi] = range;
  const span = hi - lo;
  const lut = buildRampLut(stops);
  const writeSample = (value, data, k) => {
    if (!Number.isFinite(value)) {
      data[k + 0] = FALLBACK_RGB[0];
      data[k + 1] = FALLBACK_RGB[1];
      data[k + 2] = FALLBACK_RGB[2];
      return;
    }
    const t = clamp((value - lo) / span, 0, 1);
    const src = Math.min(COLOR_LUT_SIZE - 1, Math.max(0, Math.round(t * (COLOR_LUT_SIZE - 1)))) * 3;
    data[k + 0] = lut[src + 0];
    data[k + 1] = lut[src + 1];
    data[k + 2] = lut[src + 2];
  };
  const sample = (value) => {
    const rgb = [0, 0, 0];
    writeSample(value, rgb, 0);
    return rgb;
  };
  const color = (i, fields) => sample(fields[fieldName]?.[i] ?? 0);
  color.write = (i, fields, data, k) => {
    writeSample(fields[fieldName]?.[i] ?? 0, data, k);
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
  const lut = buildWheelLut();
  const writeSample = (value, data, k) => {
    if (!Number.isFinite(value)) {
      data[k + 0] = FALLBACK_RGB[0];
      data[k + 1] = FALLBACK_RGB[1];
      data[k + 2] = FALLBACK_RGB[2];
      return;
    }
    // Wrap into [0, 1) — no clamp, so values outside [a, b] still
    // map to a hue (cyclic data is the whole point).
    const h = ((value - lo) / span % 1 + 1) % 1;
    const src = Math.min(COLOR_LUT_SIZE - 1, Math.max(0, Math.floor(h * COLOR_LUT_SIZE))) * 3;
    data[k + 0] = lut[src + 0];
    data[k + 1] = lut[src + 1];
    data[k + 2] = lut[src + 2];
  };
  const sample = (value) => {
    const rgb = [0, 0, 0];
    writeSample(value, rgb, 0);
    return rgb;
  };
  const color = (i, fields) => sample(fields[fieldName]?.[i] ?? 0);
  color.write = (i, fields, data, k) => {
    writeSample(fields[fieldName]?.[i] ?? 0, data, k);
  };
  color.fields = [fieldName];
  return color;
}

function buildRampLut(stops) {
  const lut = new Uint8ClampedArray(COLOR_LUT_SIZE * 3);
  if (stops.length === 0) {
    for (let i = 0; i < COLOR_LUT_SIZE; i++) lut.set(FALLBACK_RGB, i * 3);
    return lut;
  }
  if (stops.length === 1) {
    const c = stops[0].color;
    for (let i = 0; i < COLOR_LUT_SIZE; i++) {
      const k = i * 3;
      lut[k + 0] = c[0];
      lut[k + 1] = c[1];
      lut[k + 2] = c[2];
    }
    return lut;
  }
  let segment = 0;
  for (let i = 0; i < COLOR_LUT_SIZE; i++) {
    const t = i / (COLOR_LUT_SIZE - 1);
    while (segment < stops.length - 1 && t > stops[segment + 1].t) segment++;
    const a = stops[segment];
    const b = stops[segment + 1] ?? a;
    const segSpan = b.t - a.t;
    const segT = segSpan > 0 ? (t - a.t) / segSpan : 0;
    const k = i * 3;
    lut[k + 0] = Math.round(lerp(a.color[0], b.color[0], segT));
    lut[k + 1] = Math.round(lerp(a.color[1], b.color[1], segT));
    lut[k + 2] = Math.round(lerp(a.color[2], b.color[2], segT));
  }
  return lut;
}

let wheelLut = null;
function buildWheelLut() {
  if (wheelLut) return wheelLut;
  wheelLut = new Uint8ClampedArray(COLOR_LUT_SIZE * 3);
  for (let i = 0; i < COLOR_LUT_SIZE; i++) {
    const h = i / COLOR_LUT_SIZE;
    const sector = Math.floor(h * 6);
    const f = h * 6 - sector;
    const q = Math.round((1 - f) * 255);
    const t = Math.round(f * 255);
    const k = i * 3;
    switch (sector % 6) {
      case 0: wheelLut[k + 0] = 255; wheelLut[k + 1] = t;   wheelLut[k + 2] = 0;   break;
      case 1: wheelLut[k + 0] = q;   wheelLut[k + 1] = 255; wheelLut[k + 2] = 0;   break;
      case 2: wheelLut[k + 0] = 0;   wheelLut[k + 1] = 255; wheelLut[k + 2] = t;   break;
      case 3: wheelLut[k + 0] = 0;   wheelLut[k + 1] = q;   wheelLut[k + 2] = 255; break;
      case 4: wheelLut[k + 0] = t;   wheelLut[k + 1] = 0;   wheelLut[k + 2] = 255; break;
      default: wheelLut[k + 0] = 255; wheelLut[k + 1] = 0;  wheelLut[k + 2] = q;   break;
    }
  }
  return wheelLut;
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
  const compiledWrite = compileViewWriter(actions, {
    fieldTypes,
    fieldNames: new Set(fieldDecls.map((d) => d.name)),
    paramNames: new Set(paramDecls.map((d) => d.name)),
    constNames: new Set(constDecls.map((d) => d.name)),
  });
  const sample = (i, fields, params, consts) => {
    if (compiledWrite) {
      const rgb = [0, 0, 0];
      compiledWrite(i, fields, params, consts, rgb, 0);
      return rgb;
    }
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
    if (compiledWrite) {
      compiledWrite(i, fields, cachedParams, cachedConsts, data, k);
      return;
    }
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

function compileViewWriter(actions, { fieldTypes, fieldNames, paramNames, constNames }) {
  try {
    const locals = new Map();
    let localIndex = 0;
    const lines = [
      `"use strict";`,
      `let red = 0, green = 0, blue = 0;`,
      `const clamp = (x, a, b) => Math.min(Math.max(x, a), b);`,
      `const smoothstep = (e0, e1, x) => { const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1); return t * t * (3 - 2 * t); };`,
      `const wrapAngle = (x) => Math.atan2(Math.sin(x), Math.cos(x));`,
    ];
    emitViewActions(actions, { lines, locals, fieldTypes, fieldNames, paramNames, constNames, nextLocal });
    lines.push(`data[k + 0] = Math.max(0, Math.min(255, Math.round(red)));`);
    lines.push(`data[k + 1] = Math.max(0, Math.min(255, Math.round(green)));`);
    lines.push(`data[k + 2] = Math.max(0, Math.min(255, Math.round(blue)));`);
    return new Function("i", "fields", "params", "consts", "data", "k", lines.join("\n"));

    function nextLocal(name) {
      const safe = `_l${localIndex++}_${String(name).replace(/[^A-Za-z0-9_]/g, "_")}`;
      locals.set(name, safe);
      return safe;
    }
  } catch (_) {
    return null;
  }
}

function emitViewActions(actions, ctx) {
  for (const action of actions ?? []) {
    if (!action) continue;
    if (action.type === "let") {
      const local = ctx.nextLocal(action.name);
      ctx.lines.push(`let ${local} = ${compileViewExpr(action.expr, ctx)};`);
      continue;
    }
    if (action.type === "set") {
      if (action.field === "red" || action.field === "green" || action.field === "blue") {
        ctx.lines.push(`${action.field} = ${compileViewExpr(action.expr, ctx)};`);
      }
      continue;
    }
    if (action.type === "when") {
      ctx.lines.push(`if (${compileViewExpr(action.condition, ctx)}) {`);
      emitViewActions(action.actions ?? [], ctx);
      ctx.lines.push(`}`);
    }
  }
}

function compileViewExpr(ast, ctx) {
  if (!ast) return "0";
  switch (ast.type) {
    case "Number":
      return Number.isFinite(Number(ast.value)) ? String(Number(ast.value)) : "0";
    case "Identifier":
      return compileViewIdentifier(ast.name, ctx);
    case "Member":
      return compileViewMember(ast, ctx);
    case "Unary": {
      const v = compileViewExpr(ast.expr, ctx);
      if (ast.op === "!") return `(!(${v}) ? 1 : 0)`;
      if (ast.op === "-") return `(-(${v}))`;
      if (ast.op === "+") return `(+(${v}))`;
      return v;
    }
    case "Binary": {
      const a = compileViewExpr(ast.left, ctx);
      const b = compileViewExpr(ast.right, ctx);
      const op = ast.op === "and" ? "&&" : ast.op === "or" ? "||" : ast.op;
      if (!["+", "-", "*", "/", "%", "==", "!=", "<", "<=", ">", ">=", "&&", "||", "??"].includes(op)) return "0";
      if (op === "%") return `((${a}) - (${b}) * Math.floor((${a}) / (${b})))`;
      return `((${a}) ${op} (${b}))`;
    }
    case "Conditional":
      return `((${compileViewExpr(ast.test, ctx)}) ? (${compileViewExpr(ast.consequent, ctx)}) : (${compileViewExpr(ast.alternate, ctx)}))`;
    case "Call":
      return compileViewCallExpr(ast, ctx);
    default:
      return "0";
  }
}

function compileViewIdentifier(name, ctx) {
  if (name === "true") return "1";
  if (name === "false") return "0";
  if (name === "PI") return "Math.PI";
  if (name === "TAU") return "(Math.PI * 2)";
  if (ctx.locals.has(name)) return ctx.locals.get(name);
  if (ctx.fieldNames.has(name)) {
    const type = ctx.fieldTypes.get(name);
    if (type === "vec2") return `{ __vec2: true, x: (fields[${JSON.stringify(name)}]?.[i * 2] ?? 0), y: (fields[${JSON.stringify(name)}]?.[i * 2 + 1] ?? 0) }`;
    return `(fields[${JSON.stringify(name)}]?.[i] ?? 0)`;
  }
  if (ctx.paramNames.has(name)) return `(params?.[${JSON.stringify(name)}] ?? 0)`;
  if (ctx.constNames.has(name)) return `(consts?.[${JSON.stringify(name)}] ?? 0)`;
  return "0";
}

function compileViewMember(ast, ctx) {
  if (ast.object?.type === "Identifier" && ctx.fieldTypes.get(ast.object.name) === "vec2") {
    if (ast.prop === "x") return `(fields[${JSON.stringify(ast.object.name)}]?.[i * 2] ?? 0)`;
    if (ast.prop === "y") return `(fields[${JSON.stringify(ast.object.name)}]?.[i * 2 + 1] ?? 0)`;
  }
  const obj = compileViewExpr(ast.object, ctx);
  if (ast.prop === "x" || ast.prop === "y") return `((${obj})?.${ast.prop} ?? 0)`;
  return "0";
}

function compileViewCallExpr(ast, ctx) {
  const name = ast.callee?.name;
  const args = ast.args ?? [];
  const compiled = args.map((arg) => compileViewExpr(arg, ctx));
  switch (name) {
    case "clamp": return `clamp(${compiled[0] ?? 0}, ${compiled[1] ?? 0}, ${compiled[2] ?? 0})`;
    case "min": return `Math.min(${compiled.join(",")})`;
    case "max": return `Math.max(${compiled.join(",")})`;
    case "abs": return `Math.abs(${compiled[0] ?? 0})`;
    case "sin": return `Math.sin(${compiled[0] ?? 0})`;
    case "cos": return `Math.cos(${compiled[0] ?? 0})`;
    case "asin": return `Math.asin(${compiled[0] ?? 0})`;
    case "atan2": return `Math.atan2(${compiled[0] ?? 0}, ${compiled[1] ?? 0})`;
    case "exp": return `Math.exp(${compiled[0] ?? 0})`;
    case "sqrt": return `Math.sqrt(${compiled[0] ?? 0})`;
    case "pow": return `Math.pow(${compiled[0] ?? 0}, ${compiled[1] ?? 0})`;
    case "hypot": return `Math.hypot(${compiled.join(",")})`;
    case "wrapAngle": return `wrapAngle(${compiled[0] ?? 0})`;
    case "smoothstep": return `smoothstep(${compiled[0] ?? 0}, ${compiled[1] ?? 0}, ${compiled[2] ?? 0})`;
    case "length": {
      const arg = args[0];
      if (arg?.type === "Identifier" && ctx.fieldTypes.get(arg.name) === "vec2") {
        const key = JSON.stringify(arg.name);
        return `Math.hypot(fields[${key}]?.[i * 2] ?? 0, fields[${key}]?.[i * 2 + 1] ?? 0)`;
      }
      const v = compiled[0] ?? "0";
      return `((${v})?.__vec2 ? Math.hypot((${v}).x, (${v}).y) : Math.abs(Number(${v})))`;
    }
    default:
      return "0";
  }
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
      gpuColor: { kind: "ramp", field: view.field, stops, range: view.range },
      glyph,
      particles,
    };
  }
  if (view.kind === "wheel") {
    return {
      id: view.id,
      label: view.label,
      color: wheelFromRange(view.field, view.range),
      gpuColor: { kind: "wheel", field: view.field, range: view.range },
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
