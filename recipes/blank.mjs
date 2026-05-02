// Blank recipe. Minimal DSL scaffold to copy from when starting a new
// recipe. Declare fields, params, presets, stamps, and stages in
// `pipelineDsl` below; the side-panel sections fill in as you add them.

import { gray } from "../prims/colorers.mjs";
import { compileDsl } from "../dsl/compiler.mjs";

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
summary "Empty starter recipe. Replace contents of pipelineDsl with your own simulation."
recommendedPreset blank
grid geodesic tiles 64

use clock dt, frame
use geo x, y, i, lon, lat, u, v, px, py, pz, N, PI, TAU
use sim cell, event, each, diffuse, clamp
use init fill, region, eachCell
use core clamp, smoothstep, max, min, abs, hypot, cellNoise

field a

preset blank "Blank canvas" {
  fill a 0
}

stage hold "No-op hold (replace with real physics)" {
  reads a
  writes a
  clamp a 0 1
}
`;

export const pipeline = compileDsl(pipelineDsl);
