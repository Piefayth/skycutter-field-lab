// Blank recipe. Minimal DSL scaffold to copy from when starting a new
// recipe. Declare fields, params, presets, stamps, and stages in
// `pipelineDsl` below; the side-panel sections fill in as you add them.

import { gray } from "../prims/colorers.mjs";
import { compileV2 } from "../dsl/compile-v2.mjs";

export const views = [
  { id: "a", label: "A", color: gray("a") },
];

export const overlays = [];

export const metrics = [
  { id: "a", label: "A", source: "a", mini: true, precision: 3 },
  { id: "fps", label: "FPS", source: "fps", mini: true },
];

export const regime = {};

export const pipelineDsl = `
recipe "Blank"
summary "Empty starter recipe. Replace step body with your own simulation."
recommendedPreset blank

substrate geodesic frequency 64

field a: f32

scenario blank "Blank canvas" {
  set a = 0
}

step {
  stage hold "No-op hold (replace with real physics)" {
    reads a
    writes a
    cell { set a = clamp(a, 0, 1) }
  }
}
`;

export const pipeline = compileV2(pipelineDsl);
