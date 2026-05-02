import {
  DEFAULT_METRIC_DECLS,
  DEFAULT_REGIME_SPEC,
  deriveMetricValues,
  evaluateMetricSource,
  normalizeMetricDecls,
  normalizeRegimeSpec,
} from "../kernel/metric-specs.mjs";

const SPARK_LEN = 60;

// Canvas backing-store size for sparklines. CSS doesn't size the canvas;
// these attributes set both the bitmap dimensions and the intrinsic
// layout size, so the metric cell's grid `1fr` spark column lands on a
// stable rectangle. `setupSparklines()` later upsizes the bitmap by
// `dpr` for HiDPI sharpness, but never below this minimum — so no width
// attribute = canvas defaults to 300×150 and the strip blows out into a
// horizontal scroll. Don't ask how I learned that.
const SPARK_INTRINSIC_W = 80;
const SPARK_INTRINSIC_H = 20;

const DEFAULT_SPARK_COLOR = "rgba(124, 249, 157, 0.85)";
const SPARK_COLORS = {
  cloud: "rgba(124, 249, 157, 0.85)",
  cloudVariance: "rgba(124, 249, 157, 0.85)",
  variance: "rgba(124, 249, 157, 0.85)",
  events: "rgba(255, 180, 84, 0.85)",
  activeArea: "rgba(94, 201, 255, 0.85)",
  active: "rgba(94, 201, 255, 0.85)",
  wind: "rgba(94, 201, 255, 0.85)",
  pressure: "rgba(94, 201, 255, 0.85)",
  moisture: "rgba(124, 249, 157, 0.85)",
  exhaustion: "rgba(255, 180, 84, 0.85)",
  reaction: "rgba(255, 140, 92, 0.85)",
  temperature: "rgba(255, 80, 80, 0.85)",
  catalyst: "rgba(182, 156, 255, 0.85)",
  growth: "rgba(255, 140, 92, 0.85)",
  fps: "rgba(151, 146, 138, 0.85)",
  activity: "rgba(151, 146, 138, 0.85)",
};

const FPS_WINDOW = 30;
const FPS_DOM_INTERVAL = 15;

// Regime LED-strip segments rendered inside the regime indicator div.
// Lives here so renderMetricStrip can rebuild the indicator alongside
// the cells when a recipe swap wipes the whole strip. `bucket` is the
// key under `regimeSpec` (e.g. `regimeSpec.intermittent`); `silent` is
// the fallthrough — no spec bucket, lit when no other condition fires.
const REGIME_SEGMENTS = [
  { mod: "silent", label: "SILENT", bucket: "silent" },
  { mod: "inter", label: "INTRMT", bucket: "intermittent" },
  { mod: "active", label: "ACTIVE", bucket: "active" },
  { mod: "runaway", label: "RUNAWY", bucket: "runaway" },
];

const REGIME_TITLE = "Phase-boundary classifier. Buckets are checked runaway → active → intermittent → silent; a bucket matches if any of its declared metric values exceeds its threshold. Recipes can override thresholds via `regime: { ... }`; missing means today's weather defaults.";

export function createMetrics({ ui }) {
  const varianceHistory = [];
  const fpsHistory = [];
  const metricEls = new Map();
  const sparkCanvases = new Map();
  let metricDecls = DEFAULT_METRIC_DECLS;
  let regimeSpec = DEFAULT_REGIME_SPEC;
  let sparkBuffers = Object.create(null);
  let lastValues = {};
  let fpsFrame = 0;
  let lastSparkDpr = 0;

  function applySpec(recipe) {
    metricDecls = normalizeMetricDecls(recipe);
    regimeSpec = normalizeRegimeSpec(recipe);
    renderMetricStrip();
    resetActivityHistory();
  }

  function renderMetricStrip() {
    if (!ui.metricsStrip) return;
    metricEls.clear();
    sparkCanvases.clear();
    sparkBuffers = Object.create(null);
    ui.metricsStrip.innerHTML = "";

    for (const decl of metricDecls) {
      const cell = document.createElement("div");
      cell.className = `metric-cell${decl.mini ? " metric-cell--mini" : ""}${decl.hidden ? " metric-cell--hidden" : ""}`;
      cell.dataset.metricId = decl.id;
      cell.dataset.metricSource = decl.source;
      // Hover affordance: name + decoded source. Cheap, no layout cost,
      // saves the user from cracking open the recipe JSON to remember
      // what `coverage:reaction:0.4` meant on a given cell. The cell's
      // visual identity stays clean — color signal lives in the
      // sparkline trace itself.
      cell.title = `${decl.label} — ${describeMetricSource(decl.source)}`;

      const label = document.createElement("span");
      label.className = "metric-cell__label";
      label.textContent = decl.label;
      cell.appendChild(label);

      let canvas = null;
      if (decl.spark) {
        canvas = document.createElement("canvas");
        canvas.className = "metric-cell__spark";
        canvas.dataset.spark = decl.id;
        // See SPARK_INTRINSIC_W comment: width/height attributes set
        // both the bitmap and the layout-intrinsic size. Skip these
        // and the canvas claims 300×150 by default, ballooning the
        // metrics strip into a horizontal scroll.
        canvas.width = SPARK_INTRINSIC_W;
        canvas.height = SPARK_INTRINSIC_H;
        cell.appendChild(canvas);
        sparkBuffers[decl.id] = [];
      }

      const value = document.createElement("span");
      value.className = "metric-cell__num";
      value.textContent = "—";
      cell.appendChild(value);

      ui.metricsStrip.appendChild(cell);
      metricEls.set(decl.id, { cell, value, canvas, decl });
    }

    ui.metricsStrip.appendChild(buildRegimeIndicator());
    setupSparklines();
  }

  function buildRegimeIndicator() {
    const regime = document.createElement("div");
    regime.className = "regime";
    regime.id = "regimeIndicator";
    regime.dataset.regime = "silent";
    regime.title = REGIME_TITLE;

    const legend = document.createElement("span");
    legend.className = "regime__legend";
    legend.textContent = "REGIME";
    regime.appendChild(legend);

    for (const seg of REGIME_SEGMENTS) {
      const span = document.createElement("span");
      span.className = `regime__seg regime__seg--${seg.mod}`;
      span.textContent = seg.label;
      regime.appendChild(span);
    }

    ui.regimeIndicator = regime;
    return regime;
  }

  function setupSparklines() {
    // Bitmap is hardcoded to the CSS-locked render size × dpr. Reading
    // `canvas.clientWidth` would re-couple bitmap to layout — and since
    // the canvas has no CSS sizing without the `.metric-cell__spark`
    // width/height rules, that read returns the canvas's own previous
    // bitmap size (in CSS px), so any HiDPI scale (×dpr) feeds back into
    // the next read and the cells grow without bound.
    const root = ui.metricsStrip ?? document;
    sparkCanvases.clear();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    lastSparkDpr = dpr;
    for (const canvas of root.querySelectorAll(".metric-cell__spark")) {
      const metric = canvas.dataset.spark;
      if (!metric) continue;
      canvas.width = SPARK_INTRINSIC_W * dpr;
      canvas.height = SPARK_INTRINSIC_H * dpr;
      sparkCanvases.set(metric, { canvas, dpr });
    }
  }

  function resetActivityHistory() {
    varianceHistory.length = 0;
  }

  function updateStrip({ state, fields, events }) {
    // Newer callers pass `state` directly; older callers pass
    // `fields, events` and we synthesize a state-shaped wrapper.
    // windU/windV no longer live at the top level of state — they're
    // declared fields like everything else.
    const metricState = state ?? {
      fields,
      events: {
        totalThisTick: events?.totalThisTick ?? 0,
        byLabel: events?.byLabel ?? {},
      },
    };
    const baseValues = deriveMetricValues(metricState);
    const variance = baseValues.cloudVariance ?? 0;
    varianceHistory.push(variance);
    if (varianceHistory.length > 45) varianceHistory.shift();
    const activity = varianceHistory.length > 1
      ? Math.max(...varianceHistory) - Math.min(...varianceHistory)
      : 0;
    const values = {
      ...baseValues,
      activity,
      events: events?.totalThisTick ?? baseValues.events ?? 0,
      eventsByLabel: events?.byLabel ?? baseValues.eventsByLabel ?? {},
    };
    lastValues = values;

    for (const decl of metricDecls) {
      const el = metricEls.get(decl.id);
      if (!el) continue;
      // FPS is browser-only, written by updateFpsMetric on a slower DOM
      // cadence (every FPS_DOM_INTERVAL frames) and includes the
      // "(sim)/(view)" suffix. Letting updateStrip touch it makes the
      // cell flicker between the real reading and "—" every tick — that
      // suffix and the moving-average value are owned by updateFpsMetric.
      if (decl.source === "fps") continue;
      const value = evaluateMetricSource(metricState, decl.source, values);
      el.value.textContent = formatMetricValue(value, decl, values);
      if (decl.spark && Number.isFinite(value)) pushSparkSample(decl.id, value);
    }

    drawSparklines();
    setRegime(classifyRegime(values, regimeSpec), values);
  }

  function updateFpsMetric(frameMs, { paused }) {
    fpsHistory.push(frameMs);
    if (fpsHistory.length > FPS_WINDOW) fpsHistory.shift();
    fpsFrame++;
    if (fpsFrame % FPS_DOM_INTERVAL !== 0) return;
    let total = 0;
    for (const ms of fpsHistory) total += ms;
    const meanMs = total / fpsHistory.length;
    const fps = meanMs > 0 ? 1000 / meanMs : 0;
    lastValues.fps = fps;
    const el = metricEls.get("fps");
    if (el) el.value.textContent = `${fps.toFixed(0)} ${paused ? "(view)" : "(sim)"}`;
  }

  function pushSparkSample(metric, value) {
    const buf = sparkBuffers[metric];
    if (!buf) return;
    buf.push(value);
    if (buf.length > SPARK_LEN) buf.shift();
  }

  function drawSparklines() {
    // The canvas's CSS render size is locked (.metric-cell__spark sets
    // width/height in style.css), so layout shifts can't desync the
    // bitmap. The one thing that CAN drift is `devicePixelRatio` —
    // dragging the window to a non-Retina monitor or zooming the page
    // changes it. Re-run setup once when we notice, so the strip stays
    // crisp across that case without per-frame layout work.
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (dpr !== lastSparkDpr) setupSparklines();
    for (const [metric, { canvas }] of sparkCanvases) {
      const buf = sparkBuffers[metric];
      if (!buf || buf.length < 2) continue;
      const ctx = canvas.getContext("2d");
      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);
      let min = Infinity;
      let max = -Infinity;
      for (const v of buf) {
        if (v < min) min = v;
        if (v > max) max = v;
      }
      const span = Math.max(max - min, 1e-9);
      const color = sparkColor(metric);
      ctx.strokeStyle = "rgba(53, 65, 86, 0.6)";
      ctx.lineWidth = 1 * dpr;
      ctx.beginPath();
      ctx.moveTo(0, h - 0.5 * dpr);
      ctx.lineTo(w, h - 0.5 * dpr);
      ctx.stroke();
      ctx.fillStyle = color.replace("0.85", "0.12");
      ctx.beginPath();
      ctx.moveTo(0, h);
      for (let i = 0; i < buf.length; i++) {
        const x = (i / (SPARK_LEN - 1)) * w;
        const y = h - ((buf[i] - min) / span) * (h - 2 * dpr) - dpr;
        ctx.lineTo(x, y);
      }
      ctx.lineTo(((buf.length - 1) / (SPARK_LEN - 1)) * w, h);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.25 * dpr;
      ctx.lineJoin = "round";
      ctx.beginPath();
      for (let i = 0; i < buf.length; i++) {
        const x = (i / (SPARK_LEN - 1)) * w;
        const y = h - ((buf[i] - min) / span) * (h - 2 * dpr) - dpr;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  }

  function sparkColor(metric) {
    const decl = metricEls.get(metric)?.decl;
    return decl ? metricColor(decl) : (SPARK_COLORS[metric] ?? DEFAULT_SPARK_COLOR);
  }

  function setRegime(regime, values) {
    const el = ui.regimeIndicator;
    if (!el) return;
    el.hidden = regime === "hidden";
    if (el.dataset.regime !== regime) el.dataset.regime = regime;
    if (values) updateRegimeTooltips(el, values, regimeSpec);
  }

  // Annotate each segment of the LED-strip with its bucket's threshold
  // breakdown + the live measured values, so hovering reveals "what
  // would it take to flip to ACTIVE right now". Per-segment `title`
  // means the OS tooltip resolves to whichever bucket the cursor is
  // actually over; the parent div's title still covers the legend +
  // gaps with the generic classifier explanation. Refreshed every
  // updateStrip tick so the numbers in the tooltip are current at the
  // moment of hover.
  function updateRegimeTooltips(el, values, spec) {
    for (const seg of REGIME_SEGMENTS) {
      const node = el.querySelector(`.regime__seg--${seg.mod}`);
      if (!node) continue;
      node.title = describeRegimeBucket(seg.bucket, spec, values);
    }
  }

  applySpec(null);

  return {
    applySpec,
    resetActivityHistory,
    setupSparklines,
    updateFpsMetric,
    updateStrip,
  };
}

function formatMetricValue(value, decl, values) {
  if (decl.source === "events") {
    const labels = Object.entries(values.eventsByLabel ?? {});
    if (labels.length > 1) {
      const breakdown = labels.map(([k, v]) => `${k}=${v}`).join(" ");
      return `${value ?? 0} (${breakdown})`;
    }
    return `${value ?? 0}`;
  }
  if (!Number.isFinite(value)) return "—";
  if (Number.isFinite(decl.precision)) return value.toFixed(decl.precision);
  if (decl.source === "fps") return value.toFixed(0);
  if (decl.source === "events" || decl.source?.startsWith("event:")) return `${Math.round(value)}`;
  if (decl.source === "cloudVariance" || decl.source === "variance") return value.toFixed(4);
  return value.toFixed(3);
}

// Pick the strongest accent for a metric: explicit `decl.color` from the
// recipe wins, then a per-source palette entry (so derived sources like
// `field:pressure` follow `pressure` if no explicit color), then a per-id
// fallback, then the default phosphor green.
function metricColor(decl) {
  if (decl.color) return decl.color;
  const source = String(decl.source ?? "");
  if (SPARK_COLORS[source]) return SPARK_COLORS[source];
  // `field:pressure` / `max:cloud` / `coverage:cloud:0.5` / `event:foo` —
  // peel off the prefix and look up the body, so derived metrics still
  // get the underlying field's color without recipes having to specify.
  const colon = source.indexOf(":");
  if (colon !== -1) {
    const body = source.slice(colon + 1).split(":")[0];
    if (SPARK_COLORS[body]) return SPARK_COLORS[body];
  }
  if (SPARK_COLORS[decl.id]) return SPARK_COLORS[decl.id];
  return DEFAULT_SPARK_COLOR;
}

// Human-readable expansion of a metric source string. Title-attribute
// only — show on hover, no docs panel. Matches the source forms
// recognised by `evaluateMetricSource` in kernel/metric-specs.mjs;
// keep this in sync if new prefixes land there.
function describeMetricSource(source) {
  if (typeof source !== "string" || source.length === 0) return "(unknown source)";
  switch (source) {
    case "cloud": return "Mean cloud across grid";
    case "cloudVariance":
    case "variance": return "Variance σ² of cloud across grid";
    case "events": return "Total events fired this tick";
    case "activeArea":
    case "active": return "Fraction of cells with cloud > 0.5";
    case "wind": return "Mean wind-vector magnitude";
    case "growth": return "Mean cloud growth rate";
    case "fps": return "Frames/sec (sim while running, view while paused)";
    case "activity": return "max−min of cloud variance over last 45 ticks";
  }
  if (source.startsWith("field:")) {
    return `Mean of field "${source.slice("field:".length)}" across grid`;
  }
  if (source.startsWith("max:")) {
    return `Max of field "${source.slice("max:".length)}" across grid`;
  }
  if (source.startsWith("coverage:")) {
    const [, fieldName, threshold] = source.split(":");
    return `Fraction of cells with ${fieldName} > ${threshold}`;
  }
  if (source.startsWith("event:")) {
    return `Events fired this tick with label "${source.slice("event:".length)}"`;
  }
  // Bare field name — `evaluateMetricSource` falls through to the field
  // mean for these, matching `deriveMetricValues`'s auto-population.
  return `Mean of field "${source}" across grid`;
}

function classifyRegime(values, spec) {
  if (spec?.hidden) return "hidden";
  if (matchesThresholds(values, spec?.runaway)) return "runaway";
  if (matchesThresholds(values, spec?.active)) return "active";
  if (matchesThresholds(values, spec?.intermittent)) return "intermittent";
  return "silent";
}

// Human-readable threshold breakdown for one bucket. Each line shows
// `<key> > <threshold>` and the current measured value, with `✓` if the
// condition is firing right now. SILENT has no thresholds — it's the
// fallthrough — so its tooltip just explains that. Buckets are matched
// runaway → active → intermittent in classifyRegime, so a runaway-firing
// row will also fire the active row; both ✓s are accurate. Used by the
// regime LED-strip's per-segment hover tooltip.
function describeRegimeBucket(bucket, spec, values) {
  if (bucket === "silent") {
    return "SILENT — fallthrough; lit when no other bucket's thresholds are crossed.";
  }
  const thresholds = spec?.[bucket];
  if (!thresholds || Object.keys(thresholds).length === 0) {
    return `${bucket.toUpperCase()} — no thresholds declared on this recipe.`;
  }
  const lines = [`${bucket.toUpperCase()} fires if any of:`];
  for (const [key, threshold] of Object.entries(thresholds)) {
    const value = values[key] ?? values[aliasKey(key)];
    const numeric = Number.isFinite(value);
    const hit = numeric && value > threshold;
    const formatted = numeric ? formatThresholdValue(value) : "—";
    lines.push(`  ${hit ? "✓" : " "} ${key} > ${formatThresholdValue(threshold)}  (now: ${formatted})`);
  }
  return lines.join("\n");
}

// Numbers in the threshold tooltip want enough precision to be useful
// for tuning but not so much they look like sensor noise. Big values
// (event counts) lose the decimal; tiny ones (variance ~1e-3) keep four.
function formatThresholdValue(v) {
  const abs = Math.abs(v);
  if (abs >= 100 || (Number.isInteger(v) && abs >= 1)) return v.toFixed(0);
  if (abs >= 1) return v.toFixed(2);
  if (abs >= 0.01) return v.toFixed(3);
  return v.toFixed(4);
}

function matchesThresholds(values, thresholds) {
  if (!thresholds || Object.keys(thresholds).length === 0) return false;
  for (const [key, threshold] of Object.entries(thresholds)) {
    const value = values[key] ?? values[aliasKey(key)];
    if (Number.isFinite(value) && value > threshold) return true;
  }
  return false;
}

function aliasKey(key) {
  if (key === "variance") return "cloudVariance";
  if (key === "active") return "activeArea";
  return key;
}
