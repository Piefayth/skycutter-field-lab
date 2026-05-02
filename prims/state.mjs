// =============================================================================
// State helpers (PROTOTYPE).
//
// Presets and stamps need to mutate kernel state outside the per-tick
// pipeline — seed initial conditions, paint blobs from a click, etc.
// They use these helpers, not the sim prims.
//
// Re-exports from `kernel.mjs` so recipe authors only ever import from
// `prims/*` and never reach into the kernel directly.
// =============================================================================

export {
  N, W, H, TAU, idx, sample, hashNoise, noise2,
  clamp, lerp, smoothstep,
  addBlob, addEllipse,
  resetState,
} from "../kernel/kernel.mjs";
