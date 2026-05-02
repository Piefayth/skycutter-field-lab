// =============================================================================
// Visual-app runtime state.
//
// Tiny module. Owns three values that thread through the animate loop,
// the pause UI, the pipeline-step ctx (`ctx.frame`), and `updateAll`:
//
//   - `paused`   sim-pause flag; the animate loop skips `stepSim` when set.
//   - `frame`    monotonically increasing tick counter; the `frame ${n}`
//                stats line and `ctx.frame` (per-tick) read from this.
//                `initPreset` resets it from `state.frame` so a preset
//                load lines up with the kernel's own counter.
//   - `lastTime` performance.now() snapshot for frame-time deltas.
//
// Exposed as the `runtime` registry plus a small set of mutators so app
// code never has to assign to module-private `let`s. `tickFrame()` is
// the one mildly-clever helper: it computes `frameMs` + a clamped `dt`
// for the animate loop and rotates `lastTime` in one call.
// =============================================================================

const registry = {
  paused: false,
  frame: 0,
  lastTime: 0,
};

export const runtime = registry;

// Call once from boot, before `animate()`. Stamps `lastTime` so the
// very first `tickFrame()` produces a reasonable frameMs instead of
// "the entire epoch" clamped to 50ms.
export function initRuntime() {
  registry.lastTime = performance.now();
}

// Flip the pause flag; returns the new value so callers can update
// chrome (e.g. the Pause button label) without re-reading the registry.
export function togglePaused() {
  registry.paused = !registry.paused;
  return registry.paused;
}

export function advanceFrame() {
  registry.frame++;
}

// Used by `initPreset` to mirror the kernel's own frame counter after
// a hard reset, so `frame ${n}` and `ctx.frame` don't desync.
export function setFrame(n) {
  registry.frame = n;
}

// Animate-loop helper. Returns wall-clock and clamped sim deltas, and
// rotates `lastTime` in place. `dt` is clamped to 50 ms so a backgrounded
// tab resuming doesn't dump a giant timestep into the sim.
export function tickFrame() {
  const now = performance.now();
  const frameMs = now - registry.lastTime;
  registry.lastTime = now;
  const dt = Math.min(0.05, frameMs / 1000);
  return { frameMs, dt };
}
