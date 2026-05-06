// =============================================================================
// Pointer + paint flow.
//
// Owns canvas pointer event wiring, paint stamp dispatch, and the
// raycaster used for cell hit-testing. The probe overlay shares the
// hit-tester via `paint.pointerHit(event)`, and the non-painting
// pointermove is forwarded to the caller via `onProbeMove(event)` so
// canvas wiring stays in one place.
//
// Mouse contract: left button paints (drag continues painting), right
// button rotates the camera, no panning. Three.js OrbitControls is
// configured for that mapping in three-setup.mjs (`enablePan = false`,
// LEFT mouseButton unmapped, RIGHT → rotate). No paint-mode toggles, no
// shift modifier — the user always paints with left, always rotates
// with right, always zooms with wheel/middle.
//
// Boot order: `initPaint(deps)` runs once from `bootApp()` after
// `initControls(ui)` (so `controls.brushRadius` exists) and after the
// `state` / `ui` / Three handles are ready. The initialiser populates
// the `paint` registry below so other modules can reach into it.
// =============================================================================

import * as THREE from "three";

const registry = {
  pointerHit: null,
  lastPaintLabel: "no paint yet",
};

export const paint = registry;

let initialized = false;

/**
 * Wire canvas pointer events for the paint flow and raycast-driven
 * cell hit-testing. Idempotency-protected.
 *
 * Required deps:
 *   canvas, camera, globe — Three handles from `three-setup.mjs`.
 *     Camera/globe are needed to project pointer into the sphere's UV
 *     space.
 *   ui — DOM refs needed for paint UI: { autoPausePaint, brushSelect }.
 *   state — kernel state object passed to compiled stamp functions.
 *   controls — controls.mjs registry; reads `brushRadius.value` and
 *     dispatches via the `stamps[id]` map populated at recipe load.
 *   onAfterPaint() — invoked after each stamp so the caller can refresh
 *     the texture / metrics. In the visual app this is `updateAll()`.
 *   onBeforePaint() — invoked before each stamp so GPU-backed callers can
 *     synchronize the CPU field arrays that stamp functions mutate.
 *   onPaintStart() / onPaintEnd() — optional stroke lifecycle hooks.
 *     GPU-backed callers use these to suppress stale background readbacks
 *     while CPU stamp arrays are being edited and uploaded.
 *   onProbeMove(event) — invoked on canvas pointermove when no paint
 *     stroke is in flight. Caller drives the probe overlay from this.
 *   getPaused() / setPaused(bool) — sim-pause state. The
 *     "pause on paint" toggle reads `getPaused()` at stroke start so
 *     it can restore the pre-paint paused state at stroke end.
 */
export function initPaint(deps) {
  if (initialized) throw new Error("paint.mjs: initPaint(deps) called twice");
  initialized = true;

  const { canvas, camera, globe, ui, state, controls } = deps;
  const { onBeforePaint, onAfterPaint, onApplyPaintDelta, onPaintStart, onPaintEnd, onProbeMove, getFrame, getPaused, setPaused } = deps;

  // The visual app's only raycaster + pointer Vec2. Reused across every
  // pointer event; cheaper than allocating per-call.
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const hitLocal = new THREE.Vector3();

  let paintDown = false;
  let paintStrokeId = 0;
  let wasPausedBeforePaint = false;
  let paintPrepared = false;
  let paintPreparePromise = null;
  let paintPreparedFieldsKey = "";
  let paintPreparedFrame = -1;
  let paintDragSeq = 0;

  function pointerHit(event) {
    const rect = canvas.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    globe.updateWorldMatrix(true, false);
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObject(globe, false)[0];
    if (!hit) return null;
    hitLocal.copy(hit.point);
    globe.worldToLocal(hitLocal);
    hitLocal.normalize();
    const u = THREE.MathUtils.euclideanModulo(Math.atan2(hitLocal.z, hitLocal.x) / (Math.PI * 2) + 0.5, 1);
    const lon = Math.atan2(hitLocal.z, hitLocal.x);
    const lat = Math.asin(THREE.MathUtils.clamp(hitLocal.y, -1, 1));
    const v = THREE.MathUtils.clamp(lat / Math.PI + 0.5, 0, 1);
    return {
      x: u,
      y: v,
      lon,
      lat,
      u,
      v,
      px: hitLocal.x,
      py: hitLocal.y,
      pz: hitLocal.z,
    };
  }

  function applyStamp(brush, x, y, r, hit, phase = "drag") {
    // Recipe-declared stamps drive painting. Recipes that ship an
    // empty `stamps: []` array intentionally have no brushes — left
    // click does nothing because the dispatch map is empty.
    const compiled = controls.stamps;
    const fn = compiled && compiled[brush];
    if (!fn) return null;
    fn(state, x, y, r, hit, phase);
    return Array.isArray(fn.writes) ? fn.writes : [];
  }

  function stampWrittenFields(brush) {
    const compiled = controls.stamps;
    const fn = compiled && compiled[brush];
    if (!fn) return null;
    return Array.isArray(fn.writes) ? fn.writes : [];
  }

  function stampCanGpuDelta(brush, writtenFields) {
    const compiled = controls.stamps;
    const fn = compiled && compiled[brush];
    return Boolean(
      fn?.gpuDelta &&
      typeof onApplyPaintDelta === "function" &&
      writtenFields.every((name) => state.fields?.[name] instanceof Float32Array),
    );
  }

  function snapshotFields(fieldNames) {
    const out = Object.create(null);
    for (const name of fieldNames) {
      const arr = state.fields?.[name];
      if (arr instanceof Float32Array) out[name] = new Float32Array(arr);
    }
    return out;
  }

  function diffFields(before, fieldNames) {
    const out = Object.create(null);
    for (const name of fieldNames) {
      const prev = before?.[name];
      const arr = state.fields?.[name];
      if (!(prev instanceof Float32Array) || !(arr instanceof Float32Array) || prev.length !== arr.length) continue;
      const delta = new Float32Array(arr.length);
      for (let i = 0; i < arr.length; i++) delta[i] = arr[i] - prev[i];
      out[name] = delta;
    }
    return out;
  }

  async function ensurePaintPrepared(writtenFields) {
    const fieldsKey = [...writtenFields].sort().join(",");
    const frame = Number(getFrame?.() ?? -1);
    if (paintPrepared && paintPreparedFieldsKey === fieldsKey && paintPreparedFrame === frame) {
      if (paintPreparePromise) await paintPreparePromise;
      return;
    }
    paintPrepared = true;
    paintPreparedFieldsKey = fieldsKey;
    paintPreparedFrame = frame;
    const preparePromise = Promise.resolve(onBeforePaint?.(writtenFields))
      .finally(() => {
        if (paintPreparePromise === preparePromise) {
          paintPreparePromise = null;
        }
      });
    paintPreparePromise = preparePromise;
    await paintPreparePromise;
  }

  async function paintAtPointer(event, phase = "drag", strokeId = paintStrokeId, dragSeq = paintDragSeq) {
    if (strokeId !== paintStrokeId) return;
    const hit = pointerHit(event);
    if (!hit) return;
    const r = controls.brushRadius.value;
    const brush = ui.brushSelect.value;
    const expectedWrites = stampWrittenFields(brush);
    if (!expectedWrites) return;
    if (stampCanGpuDelta(brush, expectedWrites)) {
      const before = snapshotFields(expectedWrites);
      if (!paintDown || strokeId !== paintStrokeId) return;
      if (phase === "drag" && dragSeq !== paintDragSeq) return;
      const writtenFields = applyStamp(brush, hit.x, hit.y, r, hit, phase);
      if (!writtenFields) return;
      const deltas = diffFields(before, writtenFields);
      const applied = onApplyPaintDelta(deltas, writtenFields);
      registry.lastPaintLabel = `${brush} @ lon ${hit.lon.toFixed(2)}, lat ${hit.lat.toFixed(2)}`;
      onAfterPaint(writtenFields, { gpuApplied: applied });
      return;
    }
    await ensurePaintPrepared(expectedWrites);
    if (!paintDown || strokeId !== paintStrokeId) return;
    if (phase === "drag" && dragSeq !== paintDragSeq) return;
    const writtenFields = applyStamp(brush, hit.x, hit.y, r, hit, phase);
    if (!writtenFields) return;
    registry.lastPaintLabel = `${brush} @ lon ${hit.lon.toFixed(2)}, lat ${hit.lat.toFixed(2)}`;
    onAfterPaint(writtenFields);
  }

  function endPaintStroke(event) {
    if (!paintDown) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    paintDown = false;
    paintStrokeId++;
    paintDragSeq++;
    paintPrepared = false;
    paintPreparePromise = null;
    paintPreparedFieldsKey = "";
    paintPreparedFrame = -1;
    if (canvas.hasPointerCapture(event.pointerId)) {
      canvas.releasePointerCapture(event.pointerId);
    }
    if (ui.autoPausePaint.checked) {
      setPaused(wasPausedBeforePaint);
    }
    onPaintEnd?.();
  }

  canvas.addEventListener("pointerdown", (event) => {
    // Left button only. Right button is OrbitControls' rotate; middle
    // is dolly/zoom. Bail before consuming the event so OrbitControls
    // can do its thing on the other buttons.
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    paintDown = true;
    paintStrokeId++;
    paintDragSeq++;
    paintPrepared = false;
    paintPreparePromise = null;
    paintPreparedFieldsKey = "";
    paintPreparedFrame = -1;
    const strokeId = paintStrokeId;
    onPaintStart?.();
    if (ui.autoPausePaint.checked) {
      wasPausedBeforePaint = getPaused();
      setPaused(true);
    }
    if (!canvas.hasPointerCapture(event.pointerId)) {
      canvas.setPointerCapture(event.pointerId);
    }
    void paintAtPointer(event, "press", strokeId);
  }, { capture: true });
  canvas.addEventListener("pointerup", endPaintStroke, { capture: true });
  canvas.addEventListener("pointercancel", endPaintStroke, { capture: true });
  canvas.addEventListener("pointerleave", endPaintStroke, { capture: true });
  canvas.addEventListener("pointermove", (event) => {
    if (!paintDown) return;
    // If the user lifted the left button mid-drag (e.g. the up event
    // landed outside the canvas), stop painting on the next move. The
    // `event.buttons` bitfield: bit 0 = left.
    if (event.buttons !== undefined && (event.buttons & 1) === 0) {
      endPaintStroke(event);
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    const dragSeq = ++paintDragSeq;
    void paintAtPointer(event, "drag", paintStrokeId, dragSeq);
  }, { capture: true });
  canvas.addEventListener("pointermove", (event) => {
    if (!paintDown) onProbeMove(event);
  });

  // Suppress the browser context menu on right-click so the canvas
  // doesn't pop a menu when the user is just dragging to rotate.
  canvas.addEventListener("contextmenu", (event) => event.preventDefault());

  registry.pointerHit = pointerHit;
}
