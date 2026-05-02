import { metrics as kernelMetrics } from "./kernel.mjs";

export const DEFAULT_METRIC_DECLS = [
  { id: "cloud", label: "CLOUD", source: "cloud", spark: true },
  { id: "variance", label: "VAR σ²", source: "cloudVariance", spark: true },
  { id: "events", label: "EVENTS", source: "events", spark: true },
  { id: "active", label: "ACTIVE", source: "activeArea", spark: true },
  { id: "wind", label: "WIND", source: "wind", mini: true },
  { id: "growth", label: "G/T", source: "growth", mini: true },
  { id: "fps", label: "FPS", source: "fps", mini: true },
  { id: "activity", label: "δ45", source: "activity", mini: true, hidden: true },
];

export const DEFAULT_REGIME_SPEC = {
  hidden: false,
  runaway: { events: 5000, activeArea: 0.6 },
  active: { events: 100, cloudVariance: 0.012, activeArea: 0.06 },
  intermittent: { events: 0, cloudVariance: 0.0008, cloud: 0.01 },
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
  const out = { ...kernelMetrics(state), ...extras };
  out.activeArea ??= coverageOf(state.fields.cloud, 0.5);

  // Per-field mean/max are NOT pre-computed here. They cost O(N) each
  // and the for-loop scaled linearly with the number of declared
  // fields — fine at 5-10 fields, painful when a recipe declares 15+.
  // Instead, evaluateMetricSource computes them lazily when (and only
  // when) a metric declaration actually references the field name.
  // updateStrip runs on every paint event, so this hot path matters.

  if (out.eventsByLabel) {
    for (const [label, count] of Object.entries(out.eventsByLabel)) {
      out[`event:${label}`] = count;
    }
  }

  return out;
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

  if (source.startsWith("event:")) {
    return values.eventsByLabel?.[source.slice("event:".length)] ?? 0;
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
