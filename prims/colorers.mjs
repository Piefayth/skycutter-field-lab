// =============================================================================
// View colorers (PROTOTYPE).
//
// Each factory returns a per-cell colorer function with the signature
//   (i, fields) → [r, g, b] (0-255 ints).
// Recipes use these inline in their `views[]` declarations:
//
//   views: [
//     { id: "u", label: "U", color: ramp("u", [8,32,60], [60,150,240]) },
//     { id: "v", label: "V", color: gray("v") },
//     { id: "composite", label: "Composite", color: composite() },
//   ]
//
// The geodesic renderer calls `view.color(i, fields)` once per cell. The
// factory closes over its config (field name, ramp endpoints, scale) so
// the per-cell call is just a tight read-and-mix.
// Wind-aware colorers (`windMagnitude`) read `fields.windU` / `fields.windV`
// — they're recipe-declared fields, not a state-shape special case.
// =============================================================================

import { clamp, lerp, smoothstep } from "../kernel/kernel.mjs";

export function gray(fieldName) {
  const color = (i, fields) => {
    const v = clamp(fields[fieldName][i], 0, 1);
    const g = Math.round(v * 255);
    return [g, g, g];
  };
  color.write = (i, fields, data, k) => {
    const v = clamp(fields[fieldName][i], 0, 1);
    const g = Math.round(v * 255);
    data[k + 0] = g;
    data[k + 1] = g;
    data[k + 2] = g;
  };
  color.fields = [fieldName];
  return color;
}

export function ramp(fieldName, lo, hi, scale = 1) {
  const color = (i, fields) => {
    const t = clamp(fields[fieldName][i] * scale, 0, 1);
    return [
      Math.round(lerp(lo[0], hi[0], t)),
      Math.round(lerp(lo[1], hi[1], t)),
      Math.round(lerp(lo[2], hi[2], t)),
    ];
  };
  color.write = (i, fields, data, k) => {
    const t = clamp(fields[fieldName][i] * scale, 0, 1);
    data[k + 0] = Math.round(lerp(lo[0], hi[0], t));
    data[k + 1] = Math.round(lerp(lo[1], hi[1], t));
    data[k + 2] = Math.round(lerp(lo[2], hi[2], t));
  };
  color.fields = [fieldName];
  return color;
}

export function diverge(fieldName, scale = 1) {
  const cool = [40, 100, 240];
  const warm = [235, 76, 70];
  const color = (i, fields) => {
    const t = clamp(fields[fieldName][i] * scale * 0.5 + 0.5, 0, 1);
    return [
      Math.round(lerp(cool[0], warm[0], t)),
      Math.round(lerp(cool[1], warm[1], t)),
      Math.round(lerp(cool[2], warm[2], t)),
    ];
  };
  color.write = (i, fields, data, k) => {
    const t = clamp(fields[fieldName][i] * scale * 0.5 + 0.5, 0, 1);
    data[k + 0] = Math.round(lerp(cool[0], warm[0], t));
    data[k + 1] = Math.round(lerp(cool[1], warm[1], t));
    data[k + 2] = Math.round(lerp(cool[2], warm[2], t));
  };
  color.fields = [fieldName];
  return color;
}

export function heat(fieldName, scale = 1) {
  return ramp(fieldName, [20, 34, 70], [255, 110, 50], scale * 0.7);
}

export function violet(fieldName) {
  return ramp(fieldName, [42, 20, 80], [183, 92, 255]);
}

// Wind magnitude — reads `fields.windU` / `fields.windV` (declared
// fields like everything else). Returns black for cells in recipes that
// don't carry wind.
export function windMagnitude(scale = 1, lo = [10, 20, 28], hi = [90, 190, 255]) {
  const color = (i, fields) => {
    const u = fields.windU;
    const v = fields.windV;
    if (!u || !v) return [0, 0, 0];
    const t = clamp(Math.hypot(u[i], v[i]) * scale, 0, 1);
    return [
      Math.round(lerp(lo[0], hi[0], t)),
      Math.round(lerp(lo[1], hi[1], t)),
      Math.round(lerp(lo[2], hi[2], t)),
    ];
  };
  color.write = (i, fields, data, k) => {
    const u = fields.windU;
    const v = fields.windV;
    if (!u || !v) {
      data[k + 0] = 0;
      data[k + 1] = 0;
      data[k + 2] = 0;
      return;
    }
    const t = clamp(Math.hypot(u[i], v[i]) * scale, 0, 1);
    data[k + 0] = Math.round(lerp(lo[0], hi[0], t));
    data[k + 1] = Math.round(lerp(lo[1], hi[1], t));
    data[k + 2] = Math.round(lerp(lo[2], hi[2], t));
  };
  color.fields = ["windU", "windV"];
  return color;
}

// Forcing visualization — mixes the *Source forcing-map fields so
// authors don't have to write the per-source blend by hand. Reads
// fields directly now that sources collapsed into the fields namespace.
export function forcing() {
  const color = (i, fields) => {
    let color = mix([24, 30, 38], [46, 126, 180], clamp(fields.moistureSource[i], 0, 1));
    color = mix(color, [232, 96, 54], clamp(Math.max(0, fields.heatSource[i]), 0, 1) * 0.58);
    color = mix(color, [83, 132, 190], clamp(Math.max(0, -fields.heatSource[i]), 0, 1) * 0.48);
    color = mix(color, [190, 98, 255], clamp(fields.catalystSource[i], 0, 1) * 0.7);
    color = mix(color, [26, 20, 28], clamp(fields.sinkSource[i], 0, 1) * 0.32);
    return color;
  };
  color.write = (i, fields, data, k) => {
    let r = 24, g = 30, b = 38;
    let t = clamp(fields.moistureSource[i], 0, 1);
    r = mixChannel(r, 46, t); g = mixChannel(g, 126, t); b = mixChannel(b, 180, t);
    t = clamp(Math.max(0, fields.heatSource[i]), 0, 1) * 0.58;
    r = mixChannel(r, 232, t); g = mixChannel(g, 96, t); b = mixChannel(b, 54, t);
    t = clamp(Math.max(0, -fields.heatSource[i]), 0, 1) * 0.48;
    r = mixChannel(r, 83, t); g = mixChannel(g, 132, t); b = mixChannel(b, 190, t);
    t = clamp(fields.catalystSource[i], 0, 1) * 0.7;
    r = mixChannel(r, 190, t); g = mixChannel(g, 98, t); b = mixChannel(b, 255, t);
    t = clamp(fields.sinkSource[i], 0, 1) * 0.32;
    r = mixChannel(r, 26, t); g = mixChannel(g, 20, t); b = mixChannel(b, 28, t);
    data[k + 0] = r;
    data[k + 1] = g;
    data[k + 2] = b;
  };
  color.fields = ["moistureSource", "heatSource", "catalystSource", "sinkSource"];
  return color;
}

// Weather-flavored composite: ocean-base with moisture/temperature/catalyst
// tinting and cloud alpha on top. Bespoke; only weather uses it.
export function composite() {
  const ocean = [16, 35, 48];
  const dry = [38, 52, 44];
  const wet = [28, 73, 84];
  const color = (i, fields) => {
    const moisture = fields.moisture[i];
    const temp = fields.temperature[i];
    const catalyst = fields.catalyst[i];
    const exhaustion = fields.exhaustion[i];
    const cloud = smoothstep(0.08, 0.85, fields.cloud[i]);

    const base = mix(dry, wet, clamp(moisture * 0.8, 0, 1));
    const tempColor = mix([20, 34, 70], [255, 110, 50], clamp(temp * 0.7 + 0.35, 0, 1));
    let color = mix(base, tempColor, 0.18);
    const catalystColor = mix([42, 20, 80], [183, 92, 255], clamp(catalyst, 0, 1));
    color = mix(color, catalystColor, clamp(catalyst * 0.2, 0, 0.32));
    color = mix(color, [107, 92, 60], clamp(exhaustion * 0.12, 0, 0.22));
    color = mix(ocean, color, 0.78);
    color = mix(color, [235, 244, 250], cloud * 0.82);
    return color;
  };
  color.write = (i, fields, data, k) => {
    const moisture = fields.moisture[i];
    const temp = fields.temperature[i];
    const catalyst = fields.catalyst[i];
    const exhaustion = fields.exhaustion[i];
    const cloudRaw = fields.cloud[i];
    const cloudT = clamp((cloudRaw - 0.08) / 0.77, 0, 1);
    const cloud = cloudT * cloudT * (3 - 2 * cloudT);

    let t = clamp(moisture * 0.8, 0, 1);
    let r = mixChannel(dry[0], wet[0], t);
    let g = mixChannel(dry[1], wet[1], t);
    let b = mixChannel(dry[2], wet[2], t);
    const tempT = clamp(temp * 0.7 + 0.35, 0, 1);
    const tr = mixChannel(20, 255, tempT);
    const tg = mixChannel(34, 110, tempT);
    const tb = mixChannel(70, 50, tempT);
    r = mixChannel(r, tr, 0.18); g = mixChannel(g, tg, 0.18); b = mixChannel(b, tb, 0.18);
    const catalystT = clamp(catalyst, 0, 1);
    const mr = mixChannel(42, 183, catalystT);
    const mg = mixChannel(20, 92, catalystT);
    const mb = mixChannel(80, 255, catalystT);
    t = clamp(catalyst * 0.2, 0, 0.32);
    r = mixChannel(r, mr, t); g = mixChannel(g, mg, t); b = mixChannel(b, mb, t);
    t = clamp(exhaustion * 0.12, 0, 0.22);
    r = mixChannel(r, 107, t); g = mixChannel(g, 92, t); b = mixChannel(b, 60, t);
    r = mixChannel(ocean[0], r, 0.78); g = mixChannel(ocean[1], g, 0.78); b = mixChannel(ocean[2], b, 0.78);
    t = cloud * 0.82;
    r = mixChannel(r, 235, t); g = mixChannel(g, 244, t); b = mixChannel(b, 250, t);
    data[k + 0] = r;
    data[k + 1] = g;
    data[k + 2] = b;
  };
  color.fields = ["moisture", "temperature", "catalyst", "exhaustion", "cloud"];
  return color;
}

function mix(a, b, t) {
  return [
    Math.round(lerp(a[0], b[0], t)),
    Math.round(lerp(a[1], b[1], t)),
    Math.round(lerp(a[2], b[2], t)),
  ];
}

function mixChannel(a, b, t) {
  return Math.round(lerp(a, b, t));
}
