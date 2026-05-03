// Smoke test for the WGSL harness. Drives the v2 compile pipeline
// through to actual GPU execution via dawn-node and asserts numeric
// outputs.
//
// Skips cleanly on machines where `webgpu` (dawn-node) isn't
// installed — fresh-clone path, CI without GPU, etc. Run
// `npm install` once and the tests pick up automatically.

import test from "node:test";
import assert from "node:assert/strict";
import { harnessAvailable, makeHarness, closeTo } from "./wgsl-harness.mjs";

const FREQUENCY = 8;  // ~640-cell mesh; small enough for fast tests

// Bracket every test that needs GPU access in a top-level skip-guard
// so a fresh clone still passes `node --test`.
test("WGSL harness", { skip: !(await harnessAvailable()) && "dawn-node not installed (run `npm install`)" }, async (t) => {

  // -- Test 1: identity stage ------------------------------------------------
  await t.test("identity stage preserves uniform field", async () => {
    const recipe = `
recipe "Identity"
substrate geodesic frequency 8
field u: f32
step {
  stage hold {
    reads u
    writes u
    cell { set u = u }
  }
}
metric m = mean cells { u }
views {
  palette MONO {
    stop 0 color [0, 0, 0]
    stop 1 color [255, 255, 255]
  }
  view u "U" {
    color ramp u range [0, 1] palette MONO
  }
}
scenarios { scenario blank "Blank" { set u = 0 } }
`;
    const h = await makeHarness({ recipeDsl: recipe, frequency: FREQUENCY });
    try {
      const initial = new Float32Array(h.cellCount).fill(0.42);
      h.uploadField("u", initial);
      await h.tick();
      const out = await h.readField("u");
      for (let i = 0; i < out.length; i++) {
        assert.ok(closeTo(out[i], 0.42), `cell ${i}: got ${out[i]}, want 0.42`);
      }
    } finally {
      h.dispose();
    }
  });

  // -- Test 2: diffusion smooths a hot cell ---------------------------------
  await t.test("diffusion bleeds hot cell into neighbors", async () => {
    const recipe = `
recipe "Diffuse"
substrate geodesic frequency 8
field u: f32
param diff slider 0..1 step 0.01 default 0.5 label "DIFF"
step {
  stage diffuse {
    reads u
    writes u
    cell {
      add u = (mean n in neighbors { u@n } - u) * diff
    }
  }
}
metric m = mean cells { u }
views {
  palette MONO {
    stop 0 color [0, 0, 0]
    stop 1 color [255, 255, 255]
  }
  view u "U" {
    color ramp u range [0, 1] palette MONO
  }
}
scenarios { scenario blank "Blank" { set u = 0 } }
`;
    const h = await makeHarness({ recipeDsl: recipe, frequency: FREQUENCY });
    try {
      // One cell is hot at value 1.0, all others zero.
      const initial = new Float32Array(h.cellCount);
      initial[0] = 1.0;
      h.uploadField("u", initial);

      await h.tick({ params: { diff: 0.5 } });

      const out = await h.readField("u");
      // Hot cell decreased.
      assert.ok(out[0] < 1.0, `hot cell didn't drop: got ${out[0]}`);
      assert.ok(out[0] > 0.4, `hot cell over-diffused in one tick: got ${out[0]}`);
      // Some neighbor cells received nonzero values — the WGSL really
      // dispatched and read neighbor topology. (Strict mass
      // conservation doesn't hold on the geodesic mesh because the 12
      // pentagonal cells have degree 5 while the rest have degree 6,
      // so `mean - self` is not a self-adjoint Laplacian. Per-mesh
      // topology, not a kernel bug.)
      let nonzeroNeighbors = 0;
      for (let i = 1; i < out.length; i++) {
        if (out[i] > 0.001) nonzeroNeighbors++;
      }
      assert.ok(nonzeroNeighbors >= 5, `expected ≥5 neighbors to pick up signal, got ${nonzeroNeighbors}`);
    } finally {
      h.dispose();
    }
  });

  // -- Test 3: param-driven kinetics ----------------------------------------
  await t.test("param sliders flow through to WGSL uniforms", async () => {
    const recipe = `
recipe "Decay"
substrate geodesic frequency 8
field u: f32
param k slider 0..2 step 0.01 default 1.0 label "K"
step {
  stage decay {
    reads u
    writes u
    cell { set u = u * (1 - k * dt) }
  }
}
metric m = mean cells { u }
views {
  palette MONO {
    stop 0 color [0, 0, 0]
    stop 1 color [255, 255, 255]
  }
  view u "U" {
    color ramp u range [0, 1] palette MONO
  }
}
scenarios { scenario blank "Blank" { set u = 1 } }
`;
    const h = await makeHarness({ recipeDsl: recipe, frequency: FREQUENCY });
    try {
      h.uploadField("u", new Float32Array(h.cellCount).fill(1.0));
      // dt = 1, k = 0.25 → u *= 0.75 across the board.
      await h.tick({ dt: 1, params: { k: 0.25 } });
      const out = await h.readField("u");
      for (let i = 0; i < out.length; i++) {
        assert.ok(closeTo(out[i], 0.75, 1e-4), `cell ${i}: got ${out[i]}, want 0.75`);
      }
    } finally {
      h.dispose();
    }
  });

  // -- Test 4: clamp emits expected envelope --------------------------------
  await t.test("clamp(...) caps the value at the WGSL boundary", async () => {
    const recipe = `
recipe "Clamp"
substrate geodesic frequency 8
field u: f32
step {
  stage cap {
    reads u
    writes u
    cell { set u = clamp(u * 10, -1, 1) }
  }
}
metric m = max cells { u }
views {
  palette MONO {
    stop 0 color [0, 0, 0]
    stop 1 color [255, 255, 255]
  }
  view u "U" {
    color ramp u range [-1, 1] palette MONO
  }
}
scenarios { scenario blank "Blank" { set u = 0 } }
`;
    const h = await makeHarness({ recipeDsl: recipe, frequency: FREQUENCY });
    try {
      const initial = new Float32Array(h.cellCount);
      initial[0] = 0.5;   // -> 5 -> clamp -> 1
      initial[1] = -0.5;  // -> -5 -> clamp -> -1
      initial[2] = 0.05;  // -> 0.5 -> clamp -> 0.5
      h.uploadField("u", initial);
      await h.tick();
      const out = await h.readField("u");
      assert.ok(closeTo(out[0], 1.0), `cell 0: got ${out[0]}, want 1.0`);
      assert.ok(closeTo(out[1], -1.0), `cell 1: got ${out[1]}, want -1.0`);
      assert.ok(closeTo(out[2], 0.5), `cell 2: got ${out[2]}, want 0.5`);
    } finally {
      h.dispose();
    }
  });

  // -- Test 5: explicit stateful RNG ----------------------------------------
  await t.test("stateful RNG advances u32 state and emits bounded draws", async () => {
    const recipe = `
recipe "RNG"
substrate geodesic frequency 8
field draw: f32
field rng: u32
step {
  stage sample {
    reads rng
    writes draw, rng
    cell {
      set draw = rand01(rng)
      set rng = rngNext(rng)
    }
  }
}
metric m = mean cells { draw }
views {
  palette MONO {
    stop 0 color [0, 0, 0]
    stop 1 color [255, 255, 255]
  }
  view draw "Draw" {
    color ramp draw range [0, 1] palette MONO
  }
}
scenarios {
  scenario blank "Blank" {
    set draw = 0
    set rng = 1
  }
}
`;
    const h = await makeHarness({ recipeDsl: recipe, frequency: FREQUENCY });
    try {
      const initial = new Uint32Array(h.cellCount);
      for (let i = 0; i < initial.length; i++) initial[i] = i + 1;
      h.uploadField("rng", initial);

      await h.tick();

      const draw = await h.readField("draw");
      const next = await h.readField("rng");
      for (let i = 0; i < Math.min(16, h.cellCount); i++) {
        assert.ok(draw[i] >= 0 && draw[i] <= 1, `cell ${i}: draw out of range: ${draw[i]}`);
        const expected = (Math.imul(1664525, initial[i] & 0x00ffffff) + 1013904223) & 0x00ffffff;
        assert.equal(next[i], expected, `cell ${i}: rng advanced incorrectly`);
      }
      assert.notEqual(draw[0], draw[1], "adjacent RNG states should not draw the same sample");
    } finally {
      h.dispose();
    }
  });
});
