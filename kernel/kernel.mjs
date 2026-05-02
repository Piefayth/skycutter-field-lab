// =============================================================================
// Kernel — grid constants, state allocation, math helpers.
//
// The kernel ships ONLY field-set-agnostic primitives — anything that
// names a specific field is recipe physics and lives in the recipe.
//
//   * grid constants (W, H, N, TAU, idx)
//   * state-allocation helpers (createState, reallocateState, resetState)
//   * brush helpers (addBlob, addEllipse) used by recipe stamps + presets
//   * field-set-agnostic metrics (metrics) + sanity checks
//   * pure math / hashing helpers (clamp, lerp, smoothstep, sample,
//     hashNoise, noise2, mulberry32)
//
// Stage execution lives in the WebGPU geodesic runtime. Recipe-specific
// physics lives in DSL recipe source (`recipes/*.mjs`) instead of shared
// JS helper globals.
// =============================================================================

export let W = 256;
export let H = 128;
export let N = W * H;
export const TAU = Math.PI * 2;

export function setGridResolution(width = 256, height = 128) {
  const nextW = Number(width);
  const nextH = Number(height);
  if (!Number.isInteger(nextW) || !Number.isInteger(nextH)
    || nextW < 16 || nextH < 16 || nextW > 2048 || nextH > 2048) {
    throw new Error(`grid resolution must be integer 16..2048, got ${width}x${height}`);
  }
  W = nextW;
  H = nextH;
  N = W * H;
}

export function gridResolution() {
  return { width: W, height: H, cells: N };
}

// =========================================================================
// State allocation
// =========================================================================

// Fresh state object. The caller passes the recipe's `fields`
// declaration; the kernel allocates a Float32Array per field plus a
// scratch tmp buffer of the same length. `createState({})` produces
// an empty state — useful when a caller wants to allocate and call
// `reallocateState` separately.
//
// Forcing maps that used to be a separate "sources" namespace are now
// just fields with a name suffix (e.g. `moistureSource`). The
// recipe-author chooses whether to populate them at preset time
// (treat as constant during ticks) or at every tick — that's a
// recipe choice, not a schema construct.
export function createState({ fields } = {}) {
  const state = {
    fields: {},
    tmp: {},
    grid: { kind: "rectangular", width: W, height: H, cells: N },
    rng: mulberry32(4),
    frame: 0,
    // Per-tick event accounting. The runner resets this at the top of
    // every tick; `where` increments totalThisTick + byLabel each time
    // eventFn fires. Surfaced via `metrics(state).events` so recipes
    // that use the events layer get a first-class observable.
    events: { totalThisTick: 0, byLabel: Object.create(null) },
  };
  reallocateState(state, { fields });
  return state;
}

// Reallocate state.fields / state.tmp to match a recipe's declared
// bundle. Existing arrays are dropped (full GC — Float32Array is just
// a buffer, no shared ownership). Called by recipes.mjs's
// `applyRecipe()` immediately after dynamic-importing the recipe.
//
// `fields` is an array of declarations: either bare strings (`"A"`) or
// objects (`{ name: "A", default: 0.2 }`).
export function reallocateState(state, { fields = [] } = {}) {
  const cells = state.grid?.cells ?? N;
  state.fields = {};
  state.tmp = {};
  for (const decl of fields) {
    const name = typeof decl === "string" ? decl : decl?.name;
    if (!name) continue;
    const arr = new Float32Array(cells);
    const dflt = typeof decl === "object" ? Number(decl.default) : 0;
    if (Number.isFinite(dflt) && dflt !== 0) arr.fill(dflt);
    state.fields[name] = arr;
    state.tmp[name] = new Float32Array(cells);
  }
  state.frame = 0;
  if (state.events) {
    state.events.totalThisTick = 0;
    state.events.byLabel = Object.create(null);
  }
}

// Add a single field in place, preserving every other field's data.
// Used by the runtime "+ New field" affordance so adding a field
// mid-run doesn't blow away the simulation. No-op if the name already
// exists.
export function addField(state, decl) {
  const name = typeof decl === "string" ? decl : decl?.name;
  if (!name || state.fields[name]) return;
  const cells = state.grid?.cells ?? N;
  const arr = new Float32Array(cells);
  const dflt = typeof decl === "object" ? Number(decl.default) : 0;
  if (Number.isFinite(dflt) && dflt !== 0) arr.fill(dflt);
  state.fields[name] = arr;
  state.tmp[name] = new Float32Array(cells);
}

export function removeField(state, name) {
  if (!name) return;
  delete state.fields[name];
  delete state.tmp[name];
}

// Wipe values without changing shape. Caller-controlled — recipes' own
// preset.run typically calls this then sets initial values.
export function resetState(state) {
  for (const field of Object.values(state.fields)) field.fill(0);
  for (const field of Object.values(state.tmp)) field.fill(0);
  state.frame = 0;
  if (state.events) {
    state.events.totalThisTick = 0;
    state.events.byLabel = Object.create(null);
  }
}

// =========================================================================
// Brush helpers — used by recipe stamps + presets
// =========================================================================

export function addBlob(state, fieldName, cx, cy, radius, amount) {
  const field = getField(state, fieldName);
  const r2 = radius * radius;
  const xMin = Math.floor(cx - radius * 3);
  const xMax = Math.ceil(cx + radius * 3);
  const yMin = Math.max(0, Math.floor(cy - radius * 3));
  const yMax = Math.min(H - 1, Math.ceil(cy + radius * 3));
  for (let y = yMin; y <= yMax; y++) {
    for (let x = xMin; x <= xMax; x++) {
      let dx = Math.abs(x - cx);
      dx = Math.min(dx, W - dx);
      const dy = y - cy;
      const g = Math.exp(-(dx * dx + dy * dy) / Math.max(r2, 1e-4));
      field[idx(x, y)] += amount * g;
    }
  }
}

export function addEllipse(state, fieldName, cx, cy, rx, ry, amount, angle = 0) {
  const field = getField(state, fieldName);
  const ca = Math.cos(angle);
  const sa = Math.sin(angle);
  const radius = Math.max(rx, ry);
  const xMin = Math.floor(cx - radius * 3);
  const xMax = Math.ceil(cx + radius * 3);
  const yMin = Math.max(0, Math.floor(cy - radius * 3));
  const yMax = Math.min(H - 1, Math.ceil(cy + radius * 3));
  for (let y = yMin; y <= yMax; y++) {
    for (let x = xMin; x <= xMax; x++) {
      let dx = x - cx;
      if (dx > W * 0.5) dx -= W;
      if (dx < -W * 0.5) dx += W;
      const dy = y - cy;
      const u = (dx * ca + dy * sa) / Math.max(rx, 1e-4);
      const v = (-dx * sa + dy * ca) / Math.max(ry, 1e-4);
      const g = Math.exp(-(u * u + v * v));
      field[idx(x, y)] += amount * g;
    }
  }
}

// =========================================================================
// Metrics — kernel-shipped basic summary. Recipes that don't declare a
// "cloud" field (gray-scott's u/v, discharge-cascade's A/B/R, etc.)
// get 0 in those slots — the recipe's own `metrics[]` declarations
// surface meaningful values via `evaluateMetricDecls()` instead.
// =========================================================================
export function metrics(state) {
  const cloudArr = state.fields.cloud ?? null;
  const reactionArr = state.fields.reaction ?? null;
  const moistureArr = state.fields.moisture ?? null;
  const windUArr = state.fields.windU ?? null;
  const windVArr = state.fields.windV ?? null;
  let cloud = 0;
  let cloudSq = 0;
  let growth = 0;
  let wind = 0;
  let moisture = 0;
  let maxCloud = 0;
  let maxWind = 0;
  const count = state.grid?.cells
    ?? cloudArr?.length
    ?? reactionArr?.length
    ?? moistureArr?.length
    ?? windUArr?.length
    ?? N;
  for (let i = 0; i < count; i++) {
    if (cloudArr) {
      const c = cloudArr[i];
      cloud += c;
      cloudSq += c * c;
      if (c > maxCloud) maxCloud = c;
    }
    if (windUArr && windVArr) {
      const w = Math.hypot(windUArr[i], windVArr[i]);
      wind += w;
      if (w > maxWind) maxWind = w;
    }
    if (reactionArr) growth += reactionArr[i];
    if (moistureArr) moisture += moistureArr[i];
  }
  cloud /= count;
  const events = state.events ?? { totalThisTick: 0, byLabel: {} };
  return {
    frame: state.frame,
    cloud,
    cloudVariance: Math.max(0, cloudSq / count - cloud * cloud),
    growth: growth / count,
    wind: wind / count,
    moisture: moisture / count,
    maxCloud,
    maxWind,
    events: events.totalThisTick,
    eventsByLabel: events.byLabel,
  };
}

export function assertFiniteState(state) {
  for (const [name, field] of Object.entries(state.fields)) {
    for (let i = 0; i < field.length; i++) {
      if (!Number.isFinite(field[i])) throw new Error(`${name}[${i}] is not finite: ${field[i]}`);
    }
  }
}

// =========================================================================
// Pure helpers
// =========================================================================

export function idx(x, y) {
  let xx = x % W;
  if (xx < 0) xx += W;
  const yy = Math.max(0, Math.min(H - 1, y));
  return yy * W + xx;
}

export function sample(field, x, y) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = x - x0;
  const ty = y - y0;
  const a = field[idx(x0, y0)];
  const b = field[idx(x0 + 1, y0)];
  const c = field[idx(x0, y0 + 1)];
  const d = field[idx(x0 + 1, y0 + 1)];
  return lerp(lerp(a, b, tx), lerp(c, d, tx), ty);
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

export function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

export function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

export function noise2(x, y) {
  return Math.sin(x * 12.9898 + y * 78.233) * 43758.5453 % 1;
}

export function hashNoise(i, seed = 0) {
  let x = (i + 1) ^ Math.imul(Math.floor(seed) + 1013904223, 1664525);
  x ^= x >>> 16;
  x = Math.imul(x, 2246822519);
  x ^= x >>> 13;
  x = Math.imul(x, 3266489917);
  x ^= x >>> 16;
  return ((x >>> 0) / 4294967295) * 2 - 1;
}

export function mulberry32(seed) {
  return function next() {
    let t = seed += 0x6d2b79f5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function getField(state, name) {
  const field = state.fields[name];
  if (!field) throw new Error(`Unknown field "${name}"`);
  return field;
}
