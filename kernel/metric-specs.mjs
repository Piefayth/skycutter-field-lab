// Fallback declarations used when a recipe doesn't ship its own
// `metrics: [...]` array. Every shipped v2 recipe declares its own
// metrics — this fallback exists for the "load a half-written recipe"
// editor case. FPS is the only universally-meaningful default.
export const DEFAULT_METRIC_DECLS = [
  { id: "fps", label: "FPS", source: "fps", mini: true },
];

// Fallback regime thresholds. Recipe-supplied `regime: { ... }` overrides
// these — and every shipped recipe does. Keys here use generic
// per-tick activity proxies (`activeArea`, the share of cells above a
// per-recipe coverage threshold) rather than the v1 weather-specific
// `cloud` / `cloudVariance` / `events` keys.
export const DEFAULT_REGIME_SPEC = {
  hidden: false,
  runaway:      { activeArea: 0.6 },
  active:       { activeArea: 0.06 },
  intermittent: { activeArea: 0.0008 },
};

export function normalizeMetricDecls(recipe) {
  if (!recipe || !Array.isArray(recipe.metrics)) return DEFAULT_METRIC_DECLS;
  return recipe.metrics
    .filter((decl) => decl && typeof decl.id === "string")
    .map((decl) => ({
      id: decl.id,
      label: decl.label ?? decl.id.toUpperCase(),
      source: decl.source ?? decl.id,
      spark: Boolean(decl.spark),
      mini: Boolean(decl.mini),
      hidden: Boolean(decl.hidden),
      color: typeof decl.color === "string" ? decl.color : null,
      precision: Number.isFinite(Number(decl.precision)) ? Number(decl.precision) : null,
    }));
}

export function normalizeRegimeSpec(recipe) {
  if (!recipe || recipe.regime === undefined) return DEFAULT_REGIME_SPEC;
  const src = recipe.regime ?? {};
  return {
    hidden: Boolean(src.hidden),
    runaway: normalizeThresholds(src.runaway),
    active: normalizeThresholds(src.active),
    intermittent: normalizeThresholds(src.intermittent),
  };
}

export function deriveMetricValues(state, extras = {}) {
  // Per-field mean/max are NOT pre-computed here. They cost O(N) each
  // and the for-loop scaled linearly with the number of declared
  // fields — fine at 5-10 fields, painful when a recipe declares 15+.
  // Instead, evaluateMetricSource computes them lazily when (and only
  // when) a metric declaration actually references the field name.
  // updateStrip runs on every paint event, so this hot path matters.
  return { ...extras };
}

export function evaluateMetricDecls(state, decls, extras = {}) {
  const values = deriveMetricValues(state, extras);
  return normalizeMetricDecls({ metrics: decls }).map((decl) => ({
    id: decl.id,
    label: decl.label,
    source: decl.source,
    value: evaluateMetricSource(state, decl.source, values),
  }));
}

export function evaluateMetricSource(state, source, values = deriveMetricValues(state)) {
  if (source in values) return values[source];
  if (typeof source !== "string") return NaN;

  if (source.startsWith("field:")) {
    return meanOf(state.fields?.[source.slice("field:".length)]);
  }

  if (source.startsWith("max:")) {
    return maxOf(state.fields?.[source.slice("max:".length)]);
  }

  if (source.startsWith("coverage:")) {
    const [, fieldName, thresholdRaw] = source.split(":");
    return coverageOf(state.fields?.[fieldName], Number(thresholdRaw ?? 0.5));
  }

  // v2 DSL `metric <id> = <reduction> cells [where pred] { expr }` —
  // the GPU metric runtime populates state.dslMetrics[id] each tick
  // (async readback; null until first readback completes). The
  // metrics panel renders null/NaN as "—".
  if (source.startsWith("dsl:")) {
    const id = source.slice("dsl:".length);
    const v = state.dslMetrics?.[id];
    return v == null ? NaN : v;
  }

  // Bare field name → mean. Matches the prior pre-populated behavior
  // (a metric `source: "u"` reads the mean of fields.u) but only does
  // the O(N) scan when something actually asks for it.
  if (state.fields?.[source]) return meanOf(state.fields[source]);

  return NaN;
}

function normalizeThresholds(src) {
  if (!src || typeof src !== "object") return {};
  const out = {};
  for (const [key, value] of Object.entries(src)) {
    const n = Number(value);
    if (Number.isFinite(n)) out[key] = n;
  }
  return out;
}

function meanOf(field) {
  if (!field || field.length === 0) return NaN;
  let sum = 0;
  for (let i = 0; i < field.length; i++) sum += field[i];
  return sum / field.length;
}

function maxOf(field) {
  if (!field || field.length === 0) return NaN;
  let max = -Infinity;
  for (let i = 0; i < field.length; i++) if (field[i] > max) max = field[i];
  return max;
}

function coverageOf(field, threshold) {
  if (!field || field.length === 0) return NaN;
  let n = 0;
  for (let i = 0; i < field.length; i++) if (field[i] > threshold) n++;
  return n / field.length;
}
