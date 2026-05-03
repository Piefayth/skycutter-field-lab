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
//   ]
//
// The geodesic renderer calls `view.color(i, fields)` once per cell. The
// factory closes over its config (field name, ramp endpoints, scale) so
// the per-cell call is just a tight read-and-mix.
// =============================================================================

import { clamp, lerp } from "../kernel/kernel.mjs";

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

// Phase colorer — maps any-range angle (radians) to a saturated HSV
// cycle. Smooth across the period boundary, so values that drift
// past ±π still land on the same color as their wrapped equivalent.
// Use for oscillator phase fields (Kuramoto, XY model, active nematics).
export function phase(fieldName) {
  const color = (i, fields) => phaseToRgb(fields[fieldName][i]);
  color.write = (i, fields, data, k) => {
    const [r, g, b] = phaseToRgb(fields[fieldName][i]);
    data[k + 0] = r;
    data[k + 1] = g;
    data[k + 2] = b;
  };
  color.fields = [fieldName];
  return color;
}

function phaseToRgb(theta) {
  // Guard against NaN/±Inf — without this the HSV math collapses to
  // sector 0 (pure red) and an exploded simulation looks deceptively
  // "fine but red," which is exactly the failure mode that surfaces
  // when integration overshoots dt × K stability. Muted gray-purple
  // is meant to read as "debug — values are not finite."
  if (!Number.isFinite(theta)) return [80, 60, 90];
  const TAU_LOCAL = Math.PI * 2;
  const h = ((theta / TAU_LOCAL) % 1 + 1) % 1;   // [0, 1)
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
}

