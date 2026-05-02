import { TAU, clamp, hashNoise, smoothstep, spatialNoise } from "../kernel/kernel.mjs";
import { evalExpression } from "../dsl/expression-runtime.mjs";

export function buildDslPresetDecls(presets, dsl, getParam) {
  return presets.map((preset) => ({
    id: preset.id,
    label: preset.label ?? preset.id,
    run: (state) => runDslPreset(state, preset, dsl, getParam),
  }));
}

export function buildDslStampDecls(stamps, dsl, getParam) {
  return stamps.map((stamp) => ({
    id: stamp.id,
    label: stamp.label ?? stamp.id,
    run: (state, x, y, r, hit = null) => runDslStamp(state, stamp, x, y, r, dsl, hit, getParam),
  }));
}

function runDslPreset(state, preset, dsl, getParam) {
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
    fieldArray(state, action.field, "fill").fill(evalInitExpr(action.value, state, cell));
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
      const field = {};
      for (const name of Object.keys(state.fields)) field[name] = state.fields[name][i];
      runPresetCellActions(state, action.actions ?? [], {
        ...coords, i,
        locals: Object.create(null),
        field,
        consts: cell?.consts ?? {},
        planet: cell?.planet ?? {},
        params: cell?.params ?? {},
      });
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
      arr[cell.i] += value;
      cell.field[action.field] = arr[cell.i];
    } else if (action.type === "set") {
      const arr = fieldArray(state, action.field, "set");
      const value = evalInitExpr(action.expr, state, cell);
      arr[cell.i] = value;
      cell.field[action.field] = value;
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
  if (arr && cell) return arr[cell.i];
  throw new Error(`unknown init identifier ${name}`);
}

function evalInitCall(name, args, cell) {
  if (name === "clamp") return clamp(args[0], args[1], args[2]);
  if (name === "smoothstep") return smoothstep(args[0], args[1], args[2]);
  if (name === "max") return Math.max(...args);
  if (name === "min") return Math.min(...args);
  if (name === "abs") return Math.abs(args[0]);
  if (name === "hypot") return Math.hypot(...args);
  if (name === "sin") return Math.sin(args[0]);
  if (name === "asin") return Math.asin(args[0]);
  if (name === "cos") return Math.cos(args[0]);
  if (name === "exp") return Math.exp(args[0]);
  if (name === "sqrt") return Math.sqrt(args[0]);
  if (name === "pow") return Math.pow(args[0], args[1]);
  if (name === "cellNoise") {
    const seed = args[0] ?? 0;
    const scale = args.length >= 2 ? args[1] : 1;
    // Cell context: use the cell's unit-sphere position scaled by `scale`.
    // No cell context (top-level preset spot args): sample at origin —
    // the resulting value is stable per (seed, scale) but identical across
    // any "cells" that would have been involved, which matches the
    // randomize-by-seed pattern presets typically reach for.
    const px = (cell?.px ?? 0) * scale;
    const py = (cell?.py ?? 0) * scale;
    const pz = (cell?.pz ?? 0) * scale;
    return spatialNoise(px, py, pz, seed);
  }
  if (name === "cellRand") return hashNoise(cell?.i ?? 0, args[0] ?? 0);
  if (name === "wrapAngle") return Math.atan2(Math.sin(args[0]), Math.cos(args[0]));
  throw new Error(`unknown init function ${name ?? "call"}`);
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
  const grid = geodesicGrid(state, "spot");
  const centerCell = nearestGeodesicCell(grid, center);
  const ringRadius = Math.max(1, Math.round(Math.abs(radius) / averageNeighborAngle(grid, centerCell)));
  const visited = new Uint8Array(grid.cellCount);
  const queue = [{ cell: centerCell, depth: 0 }];
  visited[centerCell] = 1;
  for (let head = 0; head < queue.length; head++) {
    const { cell, depth } = queue[head];
    const t = depth / Math.max(1, ringRadius);
    field[cell] += amount * Math.max(0, 1 - t * t);
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
    field[cell] += amount * g;
  }
}

function setGeodesicRegion(state, fieldName, lonMin, lonMax, latMin, latMax, amount) {
  const field = fieldArray(state, fieldName, "region");
  const grid = geodesicGrid(state, "region");
  const loLat = Math.min(latMin, latMax);
  const hiLat = Math.max(latMin, latMax);
  for (let cell = 0; cell < grid.cellCount; cell++) {
    const { lon, lat } = geodesicAuthorCoords(grid, cell);
    if (lat < loLat || lat > hiLat) continue;
    const inLon = lonMin <= lonMax
      ? lon >= lonMin && lon <= lonMax
      : lon >= lonMin || lon <= lonMax;
    if (inLon) field[cell] = amount;
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
