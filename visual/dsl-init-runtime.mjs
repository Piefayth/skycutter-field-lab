import { TAU, clamp, hashNoise, smoothstep, spatialNoise } from "../kernel/kernel.mjs";
import { evalExpression } from "../dsl/expression-runtime.mjs";
import { MATH_FUNCTIONS } from "../dsl/dsl-spec.mjs";

// Number of components per cell for FIELD in STATE. f32 fields hold one
// scalar per cell; vec2 fields hold two. Derived from the typed-array
// length / grid cell count — avoids needing a separate type registry.
function fieldComponents(state, fieldName) {
  const arr = state.fields?.[fieldName];
  const cells = state.grid?.cells ?? 0;
  if (!arr || cells === 0) return 1;
  const components = arr.length / cells;
  return components === 2 ? 2 : 1;
}

// Tagged vec2 value used inside the JS-side init evaluator. evalInitCall
// returns this for `vec2(x, y)`; member access (`.x` / `.y`) reads the
// components. Stays runtime-only — when written to a field, it's
// expanded into two consecutive Float32 slots.
function makeVec2(x, y) {
  return { __vec2: true, x: Number(x), y: Number(y) };
}
function isVec2(v) {
  return v && typeof v === "object" && v.__vec2 === true;
}

export function buildDslPresetDecls(presets, dsl, getParam, setParam = null) {
  return presets.map((preset) => ({
    id: preset.id,
    label: preset.label ?? preset.id,
    run: (state) => runDslPreset(state, preset, dsl, getParam, setParam),
  }));
}

export function buildDslStampDecls(stamps, dsl, getParam) {
  return stamps.map((stamp) => ({
    id: stamp.id,
    label: stamp.label ?? stamp.id,
    run: (state, x, y, r, hit = null) => runDslStamp(state, stamp, x, y, r, dsl, hit, getParam),
  }));
}

function runDslPreset(state, preset, dsl, getParam, setParam) {
  // Apply param overrides BEFORE running init actions, so any action
  // that reads a param value (e.g. `set state = numStates * cellRand`)
  // sees the scenario's choice rather than the previous slider state.
  // Refresh the snapshot after writing so initContext below picks up
  // the new values too.
  if (typeof setParam === "function" && preset.paramOverrides) {
    for (const [name, value] of Object.entries(preset.paramOverrides)) {
      setParam(name, value);
    }
  }
  const context = initContext(dsl, getParam);
  for (const action of preset.actions ?? []) runPresetAction(state, action, context);
}

function runDslStamp(state, stamp, x, y, r, dsl, hit = null, getParam) {
  const cell = {
    x, y, r,
    ...(hit ?? {}),
    locals: Object.create(null),
    field: Object.create(null),
    ...initContext(dsl, getParam),
  };
  for (const action of stamp.actions ?? []) runPresetAction(state, action, cell);
}

function initContext(dsl, getParam) {
  // Snapshot param values once at preset-apply time. Each call to
  // applyPreset re-builds this, so reset-after-slider-change picks up
  // the new value. Falls back to the declared default when the runtime
  // hasn't installed a controls reader (tests, materializeRecipe).
  const params = {};
  for (const decl of dsl?.parameters ?? []) {
    const live = typeof getParam === "function" ? getParam(decl.name) : undefined;
    params[decl.name] = live !== undefined && live !== null ? live : (decl.default ?? 0);
  }
  return {
    consts: Object.fromEntries((dsl?.constants ?? []).map((decl) => [decl.name, decl.value])),
    planet: { ...(dsl?.planet ?? {}) },
    params,
  };
}

function runPresetAction(state, action, cell) {
  if (action.type === "fill") {
    fillField(state, action.field, evalInitExpr(action.value, state, cell));
    return;
  }
  if (action.type === "spot") {
    addGeodesicSpot(
      state,
      action.field,
      evalInitExpr(action.lon, state, cell),
      evalInitExpr(action.lat, state, cell),
      evalInitExpr(action.radius, state, cell),
      evalInitExpr(action.amount, state, cell),
    );
    return;
  }
  if (action.type === "ellipse") {
    addGeodesicEllipseAtLonLat(
      state,
      action.field,
      evalInitExpr(action.lon, state, cell),
      evalInitExpr(action.lat, state, cell),
      evalInitExpr(action.rx, state, cell),
      evalInitExpr(action.ry, state, cell),
      evalInitExpr(action.amount, state, cell),
      evalInitExpr(action.angle, state, cell),
    );
    return;
  }
  if (action.type === "region") {
    setGeodesicRegion(
      state,
      action.field,
      evalInitExpr(action.lonMin, state, cell),
      evalInitExpr(action.lonMax, state, cell),
      evalInitExpr(action.latMin, state, cell),
      evalInitExpr(action.latMax, state, cell),
      evalInitExpr(action.amount, state, cell),
    );
    return;
  }
  if (action.type === "eachCell") {
    const grid = geodesicGrid(state, "eachCell");
    for (let i = 0; i < grid.cellCount; i++) {
      const coords = geodesicAuthorCoords(grid, i);
      // Build the per-cell field map using component-aware reads so
      // vec2 fields surface as tagged `{ __vec2: true, x, y }` values
      // the expression runtime understands. The naive
      // `state.fields[name][i]` indexing only works for scalar fields
      // (vec2 storage is interleaved, so index `i` yielded the wrong
      // component or wrong cell entirely).
      const field = {};
      for (const name of Object.keys(state.fields)) {
        const components = fieldComponents(state, name);
        field[name] = readCellComponents(state.fields[name], i, components);
      }
      const cellCtx = {
        ...coords, i,
        locals: Object.create(null),
        field,
        consts: cell?.consts ?? {},
        planet: cell?.planet ?? {},
        params: cell?.params ?? {},
      };
      // Optional `where PRED` filter on the iteration. PRED is
      // evaluated against the cell's coords / field reads / params /
      // consts; truthy result lets the body run, falsy skips the cell
      // entirely (no field state changes). Without this, recipes had
      // to wrap the body in a `when` block at the cost of one indent
      // level for every conditional init.
      if (action.predicate) {
        if (!evalInitExpr(action.predicate, state, cellCtx)) continue;
      }
      runPresetCellActions(state, action.actions ?? [], cellCtx);
    }
    return;
  }
  throw new Error(`unknown preset action ${action.type}`);
}

function runPresetCellActions(state, actions, cell) {
  for (const action of actions) {
    if (action.type === "let") {
      cell.locals[action.name] = evalInitExpr(action.expr, state, cell);
    } else if (action.type === "add") {
      const arr = fieldArray(state, action.field, "add");
      const value = evalInitExpr(action.expr, state, cell);
      const components = fieldComponents(state, action.field);
      writeCellComponents(arr, cell.i, value, action.field, "add", components, "add");
      cell.field[action.field] = readCellComponents(arr, cell.i, components);
    } else if (action.type === "set") {
      const arr = fieldArray(state, action.field, "set");
      const value = evalInitExpr(action.expr, state, cell);
      const components = fieldComponents(state, action.field);
      writeCellComponents(arr, cell.i, value, action.field, "set", components, "set");
      cell.field[action.field] = readCellComponents(arr, cell.i, components);
    } else if (action.type === "when") {
      if (evalInitExpr(action.condition, state, cell)) {
        runPresetCellActions(state, action.actions ?? [], {
          ...cell,
          locals: { ...cell.locals },
        });
      }
    } else {
      throw new Error(`unknown preset cell action ${action.type}`);
    }
  }
}

// Write a value into the cell's slot of a typed field.
//   components === 1 (f32):
//     value must be a number; arr[cellIdx] is set/added.
//   components === 2 (vec2):
//     value must be a vec2 (from `vec2(x, y)`); arr[cellIdx*2 ... +1]
//     are set/added per-component.
// `mode` is "set" or "add".
function writeCellComponents(arr, cellIdx, value, fieldName, label, components, mode) {
  if (components === 1) {
    if (isVec2(value)) {
      throw new Error(`${label} ${fieldName}: scalar field can't be assigned a vec2`);
    }
    if (mode === "add") arr[cellIdx] += Number(value);
    else arr[cellIdx] = Number(value);
    return;
  }
  // vec2
  if (!isVec2(value)) {
    throw new Error(`${label} ${fieldName}: vec2 field requires a vec2 value (use \`vec2(x, y)\`)`);
  }
  const base = cellIdx * 2;
  if (mode === "add") {
    arr[base + 0] += value.x;
    arr[base + 1] += value.y;
  } else {
    arr[base + 0] = value.x;
    arr[base + 1] = value.y;
  }
}

function readCellComponents(arr, cellIdx, components) {
  if (components === 1) return arr[cellIdx];
  return makeVec2(arr[cellIdx * 2], arr[cellIdx * 2 + 1]);
}

// Fill every cell of FIELD with VALUE. Scalar / vec2 dispatch on the
// field's actual width.
function fillField(state, fieldName, value) {
  const arr = fieldArray(state, fieldName, "fill");
  const components = fieldComponents(state, fieldName);
  if (components === 1) {
    if (isVec2(value)) throw new Error(`fill ${fieldName}: scalar field can't be filled with a vec2`);
    arr.fill(Number(value));
    return;
  }
  if (!isVec2(value)) {
    throw new Error(`fill ${fieldName}: vec2 field requires \`vec2(x, y)\` (got scalar)`);
  }
  const x = value.x;
  const y = value.y;
  for (let i = 0; i < arr.length; i += 2) {
    arr[i + 0] = x;
    arr[i + 1] = y;
  }
}

function evalInitExpr(ast, state, cell) {
  return evalExpression(ast, {
    resolveIdentifier: (name) => evalInitIdentifier(name, state, cell),
    callFunction: (name, args) => evalInitCall(name, args, cell),
  });
}

function evalInitIdentifier(name, state, cell) {
  if (name === "true") return true;
  if (name === "false") return false;
  if (name === "null") return null;
  if (name === "undefined") return undefined;
  if (name === "N") return state?.grid?.cells ?? 0;
  if (name === "TAU") return TAU;
  if (name === "PI") return Math.PI;
  if (cell?.locals && Object.hasOwn(cell.locals, name)) return cell.locals[name];
  if (name === "x") return cell?.x ?? 0;
  if (name === "y") return cell?.y ?? 0;
  if (name === "lon") return cell?.lon ?? 0;
  if (name === "lat") return cell?.lat ?? 0;
  if (name === "u") return cell?.u ?? 0;
  if (name === "v") return cell?.v ?? 0;
  if (name === "px") return cell?.px ?? 0;
  if (name === "py") return cell?.py ?? 0;
  if (name === "pz") return cell?.pz ?? 0;
  if (name === "r") return cell?.r ?? 0;
  if (name === "i") return cell?.i ?? 0;
  if (cell?.consts && Object.hasOwn(cell.consts, name)) return cell.consts[name];
  if (cell?.planet && Object.hasOwn(cell.planet, name)) return cell.planet[name];
  if (cell?.params && Object.hasOwn(cell.params, name)) return cell.params[name];
  if (cell?.field && Object.hasOwn(cell.field, name)) return cell.field[name];
  const arr = state.fields?.[name];
  if (arr && cell) {
    const components = fieldComponents(state, name);
    return components === 2
      ? makeVec2(arr[cell.i * 2], arr[cell.i * 2 + 1])
      : arr[cell.i];
  }
  throw new Error(`unknown init identifier ${name}`);
}

// Registry-backed math-fn dispatch. Each MATH_FUNCTIONS entry's `js`
// callback evaluates the call here; helpers (clamp / smoothstep /
// hashNoise / spatialNoise / makeVec2 / isVec2) are passed in so the
// callback doesn't need to import them — adding a new fn touches one
// dsl-spec.mjs entry, no edit here.
const INIT_HELPERS = {
  clamp, smoothstep, spatialNoise, hashNoise, makeVec2, isVec2,
};
const MATH_BY_NAME = new Map(MATH_FUNCTIONS.map((fn) => [fn.name, fn]));

function evalInitCall(name, args, cell) {
  const fn = MATH_BY_NAME.get(name);
  if (!fn) throw new Error(`unknown init function ${name ?? "call"}`);
  if (!fn.js) {
    // gradient / divergence / future stencil-only ops — no JS analogue.
    throw new Error(`${name}(...) only works inside a stage cell, not in scenario / stamp init`);
  }
  if (fn.arity && !fn.arity.includes(args.length)) {
    throw new Error(`${name} expects ${fn.arity.join(" or ")} args; got ${args.length}`);
  }
  return fn.js(args, cell, INIT_HELPERS);
}

function geodesicAuthorCoords(grid, cell) {
  const offset = cell * 3;
  const px = grid.positions[offset + 0];
  const py = grid.positions[offset + 1];
  const pz = grid.positions[offset + 2];
  const lon = Math.atan2(pz, px);
  const lat = Math.asin(clamp(py, -1, 1));
  const u = euclideanModulo(lon / TAU + 0.5, 1);
  const v = clamp(lat / Math.PI + 0.5, 0, 1);
  return {
    x: u,
    y: v,
    lon,
    lat,
    u,
    v,
    px,
    py,
    pz,
  };
}

function addGeodesicSpot(state, fieldName, lon, lat, radius, amount) {
  const c = Math.cos(lat);
  addGeodesicBlobAtVector(
    state,
    fieldName,
    [Math.cos(lon) * c, Math.sin(lat), Math.sin(lon) * c],
    radius,
    amount,
  );
}

function addGeodesicBlobAtVector(state, fieldName, center, radius, amount) {
  const field = fieldArray(state, fieldName, "spot");
  const components = fieldComponents(state, fieldName);
  if (components === 1 && isVec2(amount)) {
    throw new Error(`spot ${fieldName}: scalar field can't take a vec2 amount`);
  }
  if (components === 2 && !isVec2(amount)) {
    throw new Error(`spot ${fieldName}: vec2 field requires a vec2 amount (use \`vec2(x, y)\`)`);
  }
  const ax = components === 2 ? amount.x : Number(amount);
  const ay = components === 2 ? amount.y : 0;
  const grid = geodesicGrid(state, "spot");
  const centerCell = nearestGeodesicCell(grid, center);
  const ringRadius = Math.max(0, Math.round(Math.abs(radius) / averageNeighborAngle(grid, centerCell)));
  const visited = new Uint8Array(grid.cellCount);
  const queue = [{ cell: centerCell, depth: 0 }];
  visited[centerCell] = 1;
  for (let head = 0; head < queue.length; head++) {
    const { cell, depth } = queue[head];
    const t = depth / Math.max(1, ringRadius);
    const falloff = Math.max(0, 1 - t * t);
    if (components === 1) {
      field[cell] += ax * falloff;
    } else {
      const base = cell * 2;
      field[base + 0] += ax * falloff;
      field[base + 1] += ay * falloff;
    }
    if (depth >= ringRadius) continue;
    const count = grid.neighborCounts[cell] ?? 0;
    for (let slot = 0; slot < count; slot++) {
      const next = grid.neighbors[cell * grid.maxNeighbors + slot];
      if (next < 0 || visited[next]) continue;
      visited[next] = 1;
      queue.push({ cell: next, depth: depth + 1 });
    }
  }
}

function nearestGeodesicCell(grid, point) {
  let bestCell = 0;
  let bestDot = -Infinity;
  for (let cell = 0; cell < grid.cellCount; cell++) {
    const offset = cell * 3;
    const dot = point[0] * grid.positions[offset + 0]
      + point[1] * grid.positions[offset + 1]
      + point[2] * grid.positions[offset + 2];
    if (dot > bestDot) {
      bestDot = dot;
      bestCell = cell;
    }
  }
  return bestCell;
}

function averageNeighborAngle(grid, cell) {
  const base = cell * 3;
  const px = grid.positions[base + 0];
  const py = grid.positions[base + 1];
  const pz = grid.positions[base + 2];
  const count = grid.neighborCounts[cell] ?? 0;
  let total = 0;
  for (let slot = 0; slot < count; slot++) {
    const n = grid.neighbors[cell * grid.maxNeighbors + slot] * 3;
    const dot = clamp(px * grid.positions[n + 0] + py * grid.positions[n + 1] + pz * grid.positions[n + 2], -1, 1);
    total += Math.acos(dot);
  }
  return count > 0 ? total / count : Math.PI / Math.max(1, grid.frequency * 2);
}

function addGeodesicEllipseAtLonLat(state, fieldName, lon, lat, rx, ry, amount, angle = 0) {
  const c = Math.cos(lat);
  addGeodesicEllipseAtVector(
    state,
    fieldName,
    [Math.cos(lon) * c, Math.sin(lat), Math.sin(lon) * c],
    rx,
    ry,
    amount,
    angle,
  );
}

function addGeodesicEllipseAtVector(state, fieldName, center, rx, ry, amount, angle = 0) {
  const field = fieldArray(state, fieldName, "ellipse");
  const components = fieldComponents(state, fieldName);
  if (components === 1 && isVec2(amount)) {
    throw new Error(`ellipse ${fieldName}: scalar field can't take a vec2 amount`);
  }
  if (components === 2 && !isVec2(amount)) {
    throw new Error(`ellipse ${fieldName}: vec2 field requires a vec2 amount`);
  }
  const ax = components === 2 ? amount.x : Number(amount);
  const ay = components === 2 ? amount.y : 0;
  const grid = geodesicGrid(state, "ellipse");
  const basis = tangentBasis(center);
  const sx = Math.max(0.0001, Math.abs(rx));
  const sy = Math.max(0.0001, Math.abs(ry));
  const ca = Math.cos(angle);
  const sa = Math.sin(angle);
  const maxReach = Math.max(sx, sy) * 3;
  for (let cell = 0; cell < grid.cellCount; cell++) {
    const offset = cell * 3;
    const px = grid.positions[offset + 0];
    const py = grid.positions[offset + 1];
    const pz = grid.positions[offset + 2];
    const dot = clamp(center[0] * px + center[1] * py + center[2] * pz, -1, 1);
    const arc = Math.acos(dot);
    if (arc > maxReach) continue;
    const tangentLen = Math.max(1e-6, Math.sin(arc));
    const tx = (px - center[0] * dot) / tangentLen;
    const ty = (py - center[1] * dot) / tangentLen;
    const tz = (pz - center[2] * dot) / tangentLen;
    const east = (tx * basis.east[0] + ty * basis.east[1] + tz * basis.east[2]) * arc;
    const south = -(tx * basis.north[0] + ty * basis.north[1] + tz * basis.north[2]) * arc;
    const u = (east * ca + south * sa) / sx;
    const v = (-east * sa + south * ca) / sy;
    const g = Math.exp(-(u * u + v * v));
    if (g < 0.0001) continue;
    if (components === 1) {
      field[cell] += ax * g;
    } else {
      const base = cell * 2;
      field[base + 0] += ax * g;
      field[base + 1] += ay * g;
    }
  }
}

function setGeodesicRegion(state, fieldName, lonMin, lonMax, latMin, latMax, amount) {
  const field = fieldArray(state, fieldName, "region");
  const components = fieldComponents(state, fieldName);
  if (components === 1 && isVec2(amount)) {
    throw new Error(`region ${fieldName}: scalar field can't take a vec2 amount`);
  }
  if (components === 2 && !isVec2(amount)) {
    throw new Error(`region ${fieldName}: vec2 field requires a vec2 amount`);
  }
  const ax = components === 2 ? amount.x : Number(amount);
  const ay = components === 2 ? amount.y : 0;
  const grid = geodesicGrid(state, "region");
  const loLat = Math.min(latMin, latMax);
  const hiLat = Math.max(latMin, latMax);
  for (let cell = 0; cell < grid.cellCount; cell++) {
    const { lon, lat } = geodesicAuthorCoords(grid, cell);
    if (lat < loLat || lat > hiLat) continue;
    const inLon = lonMin <= lonMax
      ? lon >= lonMin && lon <= lonMax
      : lon >= lonMin || lon <= lonMax;
    if (!inLon) continue;
    if (components === 1) {
      field[cell] = ax;
    } else {
      const base = cell * 2;
      field[base + 0] = ax;
      field[base + 1] = ay;
    }
  }
}

function tangentBasis(center) {
  let east = [-center[2], 0, center[0]];
  let len = Math.hypot(east[0], east[1], east[2]);
  if (len < 1e-6) {
    east = [1, 0, 0];
    len = 1;
  }
  east = [east[0] / len, east[1] / len, east[2] / len];
  const north = [
    east[1] * center[2] - east[2] * center[1],
    east[2] * center[0] - east[0] * center[2],
    east[0] * center[1] - east[1] * center[0],
  ];
  return { east, north };
}

function fieldArray(state, fieldName, label) {
  const field = state.fields?.[fieldName];
  if (!field) throw new Error(`${label}: field ${fieldName} is not allocated`);
  return field;
}

function geodesicGrid(state, label) {
  const grid = state.grid?.topology;
  if (!grid) throw new Error(`${label}: geodesic topology is not available`);
  return grid;
}

function euclideanModulo(n, m) {
  return ((n % m) + m) % m;
}
