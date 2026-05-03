// Blank recipe. Minimal DSL scaffold to copy from when starting a new
// recipe. Declare fields, params, views, stamps, scenarios, and stages in
// `pipelineDsl` below; the side panel fills in from the DSL.

import { compileV2 } from "../dsl/compile-v2.mjs";

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

step {
  stage hold "No-op hold (replace with real physics)" {
    reads a
    writes a
    cell { set a = clamp(a, 0, 1) }
  }
}

views {
  palette MONO {
    stop 0 color [0, 0, 0]
    stop 1 color [255, 255, 255]
  }

  view a "A" {
    color ramp a range [0, 1] palette MONO
  }
}

stamps {
}

scenarios {
  scenario blank "Blank canvas" {
    set a = 0
  }
}
`;

export const pipeline = compileV2(pipelineDsl);
