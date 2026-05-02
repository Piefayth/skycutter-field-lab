// =============================================================================
// Probe overlay + per-cell contribution recorder.
//
// Owns the bottom-left readout: which cell is hovered, the fixed-channel
// list (P / M / C / EX / G / LIFT / SRC), and the recency-sorted list of
// pipeline contributions to that cell. Pipeline execution writes
// contributions through `probe.record(i, step, label, field, value, mode)`
// and snapshots field values via `probe.snapshot(i, names)`; both early-
// out cheaply when no probe target is set, so wiring them through every
// tick is harmless.
//
// Boot order: `initProbe(deps)` runs once from `bootApp()` after
// `initPaint(deps)` so `paint.pointerHit` is available to pass in.
// =============================================================================
import { H, idx, W } from "../kernel/kernel.mjs";
import { fieldCssColor } from "./field-colors.mjs";

// Registry exported as `probe`. Method slots fill in during init; reads
// to them before init throw a TypeError, which is what we want — silent
// fallthrough would hide a boot-order regression.
const registry = {
  updateFromPointer: null,
  render: null,
  renderEmpty: null,
  clearContribs: null,
  record: null,
  snapshot: null,
};

export const probe = registry;

let initialized = false;

// Probe label — short uppercase tag displayed before each field's value.
// 4-char cap keeps rows visually aligned regardless of recipe naming.
function shortLabel(name) {
  return name.length <= 4 ? name.toUpperCase() : name.slice(0, 4).toUpperCase();
}

const CONTRIB_CAPACITY = 24;
const CHANGES_DISPLAY_LIMIT = 8;
const CONTRIB_EPSILON = 1e-7;
const SUMMARIZE_EPSILON = 1e-6;

/**
 * Wire the probe overlay. Idempotency-protected.
 *
 * Required deps:
 *   ui — DOM refs; needs `ui.probe` (the bottom-left container).
 *   state — kernel-owned state object. The probe reads `state.fields[name]`
 *     and `state.sources[name]` at render time, so recipe-driven realloc
 *     (which reassigns these maps) is reflected without re-binding. Held
 *     by reference, not destructured.
 *   pointerHit(event) — pointer→cell raycaster. `paint.pointerHit` is the
 *     visual app's binding; the probe doesn't care which module supplies
 *     it as long as the return shape stays `{ x, y } | null`.
 */
export function initProbe({ ui, state, pointerHit }) {
  if (initialized) throw new Error("probe.mjs: initProbe(deps) called twice");
  initialized = true;

  const contribs = [];
  let target = null;

  // Read-only `probe.target` view. Defined as a getter so callers can
  // do `if (probe.target) { ... probe.target.i ... }` without us having
  // to keep a redundant slot in lockstep.
  Object.defineProperty(registry, "target", {
    get: () => target,
    enumerable: true,
  });

  function updateFromPointer(event) {
    const hit = pointerHit(event);
    if (!hit) {
      target = null;
      renderEmpty();
      return;
    }
    const i = probeIndexForHit(hit);
    const x = Math.floor((hit.u ?? hit.x) * W);
    const y = Math.floor((hit.v ?? hit.y) * H);
    target = { i, x, y };
    render();
  }

  function renderEmpty() {
    ui.probe.replaceChildren();
    const el = document.createElement("div");
    el.className = "probe__empty";
    el.textContent = "probe empty";
    ui.probe.appendChild(el);
  }

  function render() {
    if (!target) return;
    const i = target.i;
    const frag = document.createDocumentFragment();

    const head = document.createElement("div");
    head.className = "probe__head";
    head.textContent = `PROBE ${target.x},${target.y}`;
    frag.appendChild(head);

    // One row per declared field, in declaration order. Recipe-agnostic;
    // the accent is generated from the field name so authored fields like
    // `catalyst` get the same treatment as built-in-looking names.
    //
    // Sources used to be a separate state.sources namespace shown as a
    // single concatenated row; after the v4 collapse they're just
    // fields with `*Source` suffix and render in the loop above.
    for (const [name, arr] of Object.entries(state.fields)) {
      const value = arr?.[i];
      frag.appendChild(makeRow(name, shortLabel(name), Number.isFinite(value) ? value.toFixed(2) : "--"));
    }

    const grouped = summarize(contribs);
    if (grouped.length > 0) {
      const divider = document.createElement("div");
      divider.className = "probe__divider";
      divider.textContent = "CHANGES";
      frag.appendChild(divider);
      for (const item of grouped.slice(0, CHANGES_DISPLAY_LIMIT)) {
        frag.appendChild(makeChangeRow(item));
      }
    }

    ui.probe.replaceChildren(frag);
  }

  // Pipeline-execution callback. Cheap when no target is hovered (the
  // hot path during normal sim ticks); records an entry only when the
  // mutation lands on the probed cell. Bounded ring via shift() — at
  // 24 entries the oldest falls off; small enough that the array
  // reshuffle is negligible.
  function record(i, step, label, field, value, mode) {
    if (!target || i !== target.i || !Number.isFinite(value) || Math.abs(value) < CONTRIB_EPSILON) return;
    contribs.push({
      step: step || "pipeline",
      label: label || "write",
      field,
      value,
      mode,
    });
    if (contribs.length > CONTRIB_CAPACITY) contribs.shift();
  }

  // Reset the contribution buffer at the start of each pipeline tick
  // (and each single-step run) so the changes list reflects only what
  // happened *this* tick. `length = 0` reuses the array — no realloc.
  function clearContribs() {
    contribs.length = 0;
  }

  // Used by pipeline-step wrappers that mutate many fields at once
  // (e.g. `applyForcing`, `where` events) to capture before-values so
  // the post-call delta can be recorded. Returns a plain `{name -> value}`
  // map; allocation cost dominates here, but only fires when a probe
  // target is set.
  function snapshot(i, names) {
    const out = {};
    for (const name of names) {
      const arr = state.fields[name];
      if (arr) out[name] = arr[i];
    }
    return out;
  }

  function probeIndexForHit(hit) {
    if (state.grid?.kind !== "geodesic") return idx(
      Math.floor((hit.u ?? hit.x) * W),
      Math.floor((hit.v ?? hit.y) * H),
    );
    const grid = state.grid.topology;
    if (!grid?.positions?.length) return idx(
      Math.floor((hit.u ?? hit.x) * W),
      Math.floor((hit.v ?? hit.y) * H),
    );

    const p = Number.isFinite(hit.px) && Number.isFinite(hit.py) && Number.isFinite(hit.pz)
      ? [hit.px, hit.py, hit.pz]
      : sphereFromAuthorCoords(hit.u ?? hit.x, hit.v ?? hit.y);
    let bestCell = 0;
    let bestDot = -Infinity;
    for (let cell = 0; cell < grid.cellCount; cell++) {
      const offset = cell * 3;
      const dot =
        p[0] * grid.positions[offset + 0]
        + p[1] * grid.positions[offset + 1]
        + p[2] * grid.positions[offset + 2];
      if (dot > bestDot) {
        bestDot = dot;
        bestCell = cell;
      }
    }
    return bestCell;
  }

  registry.updateFromPointer = updateFromPointer;
  registry.render = render;
  registry.renderEmpty = renderEmpty;
  registry.clearContribs = clearContribs;
  registry.record = record;
  registry.snapshot = snapshot;
}

function sphereFromAuthorCoords(x, y) {
  const lon = (x - 0.5) * Math.PI * 2;
  const lat = (y - 0.5) * Math.PI;
  const c = Math.cos(lat);
  return [Math.cos(lon) * c, Math.sin(lat), Math.sin(lon) * c];
}

function makeRow(fieldKey, label, value) {
  const row = document.createElement("div");
  row.className = `probe__row probe__row--${fieldKey}`;
  row.style.setProperty("--accent", fieldCssColor(fieldKey));
  const lbl = document.createElement("span");
  lbl.className = "probe__row-label";
  lbl.textContent = label;
  const val = document.createElement("span");
  val.className = "probe__row-value";
  val.textContent = value;
  row.append(lbl, val);
  return row;
}

function makeChangeRow(item) {
  const row = document.createElement("div");
  row.className = `probe__change probe__row--${item.field}`;
  row.style.setProperty("--accent", fieldCssColor(item.field));
  const lbl = document.createElement("span");
  lbl.className = "probe__change-field";
  lbl.textContent = item.field;
  const delta = document.createElement("span");
  const sign = item.value >= 0 ? "+" : "";
  delta.className = `probe__change-delta probe__change-delta--${item.value >= 0 ? "pos" : "neg"}`;
  delta.textContent = `${sign}${item.value.toFixed(4)}`;
  const src = document.createElement("span");
  src.className = "probe__change-source";
  src.textContent = `${item.step} · ${item.label}`;
  row.append(lbl, delta, src);
  return row;
}

// Recency-sorted change list. Items collide on (field, step, label) so
// repeated writes from the same source get summed rather than spammed
// as duplicate rows. `lastIdx` is the position of the most recent
// occurrence in the contribs ring; sorting descending by it puts the
// freshly-touched rows at the top, matching "last update" ordering.
function summarize(contribs) {
  const byKey = new Map();
  for (let n = 0; n < contribs.length; n++) {
    const item = contribs[n];
    const key = `${item.field}\0${item.step}\0${item.label}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.value += item.value;
      existing.lastIdx = n;
    } else {
      byKey.set(key, { ...item, value: item.value, lastIdx: n });
    }
  }
  return [...byKey.values()]
    .filter((item) => Math.abs(item.value) > SUMMARIZE_EPSILON)
    .sort((a, b) => b.lastIdx - a.lastIdx);
}
