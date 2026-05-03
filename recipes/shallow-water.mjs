// Shallow-water equations on the sphere — depth-averaged fluid flow.
//
// The flagship v2 recipe: uses every new primitive in one place.
//   - `gradient(h)`         pressure-gradient force in the momentum stage
//   - `divergence(m)`       mass flux in the continuity stage
//   - `field@upstream(...)` semi-Lagrangian advection of the dye tracer
//   - `vec2` field type     m carries momentum as a single 2D vector
//   - `metric ... cells`    live mass / max-speed / kinetic-energy
//
// Equations (units are dimensionless — the geodesic substrate has unit
// radius, so `gravity` is not 9.81 m/s² but a tunable wave-speed knob):
//
//   ∂h/∂t = -∇·m                              (continuity)
//   ∂m/∂t = -g·h·∇h - friction·m              (momentum)
//   ∂dye/∂t + (m/h)·∇dye = 0                  (passive tracer)
//
// where h is the water column height, m is the depth-integrated
// horizontal momentum (a vec2 in the local tangent frame), and dye is
// any passive scalar carried by the flow. The wave speed is c = √(gh);
// at h≈1, g≈0.05 the speed is ~0.22 sphere-radians/sim-second, so
// a tsunami crosses a hemisphere in ~14 sim-seconds.
//
// The dye field is the secret sauce: water on its own is hard to see —
// you can stare at a height field and miss the flow. A colored tracer
// painted onto the surface makes the otherwise-invisible currents
// readable. Click "PAINT DYE" and dab a few blobs on the equator
// while a wave is running and you'll see them stretch and fold along
// the flow lines.
//
// Numerical scheme: explicit forward Euler on momentum, then forward
// Euler on height (using the just-updated momentum), then semi-
// Lagrangian on dye. Stable for sub-CFL timesteps; the per-tick `rate`
// substepping lets the user crank the visible wave speed without
// blowing up the integrator.

import { ramp, diverge } from "../prims/colorers.mjs";
import { compileV2 } from "../dsl/compile-v2.mjs";

export const views = [
  // Height anomaly: rest depth is 1; show ±0.5 around it as red↔blue.
  // The diagnostics stage emits `dh = h - 1`, so diverge() reads the
  // signed deviation directly.
  { id: "dh",    label: "Height anomaly", color: diverge("dh", 1.5) },
  // Raw absolute height — bare-seabed brown to deep-water blue.
  { id: "h",     label: "Height (h)",     color: ramp("h", [70, 35, 25], [60, 160, 230], 0.5) },
  // Speed magnitude — calm to hot.
  { id: "speed", label: "Speed |m|",      color: ramp("speed", [12, 14, 30], [255, 200, 50], 4) },
  // Dye tracer — black background, bright cyan accumulation.
  { id: "dye",   label: "Dye tracer",     color: ramp("dye", [8, 10, 14], [80, 240, 255], 1.0) },
  // Divergence diagnostic — sources red, sinks blue. Useful for
  // debugging mass conservation drift.
  { id: "divM",  label: "div(m)",         color: diverge("divM", 8) },
];

export const overlays = [];

export const metrics = [
  { id: "mass",   label: "MASS",   source: "dsl:mass",   spark: true, precision: 3 },
  { id: "ke",     label: "KE",     source: "dsl:ke",     spark: true, precision: 4 },
  { id: "maxSpd", label: "MAX |m|", source: "dsl:maxSpd", spark: true, precision: 3 },
  { id: "meanH",  label: "MEAN h", source: "dsl:meanH",  mini: true,  precision: 3 },
  { id: "active", label: "ACTIVE", source: "dsl:active", mini: true,  precision: 3 },
  { id: "fps",    label: "FPS",    source: "fps",        mini: true },
];

// Regime classifier reads `maxSpd` (the dsl metric, surfaced as
// `metrics[id="maxSpd"]`). Thresholds tuned so a single bulge release
// reads as "active" until the waves disperse, then settles to
// "intermittent" before fading to "silent".
export const regime = {
  silent:       { maxSpd: 0 },
  intermittent: { maxSpd: 0.05 },
  active:       { maxSpd: 0.4 },
  runaway:      { maxSpd: 6 },
};

export const pipelineDsl = `
recipe "Shallow water (sphere)"
summary "Depth-averaged fluid on a sphere — gradient(h) drives momentum, divergence(m) drives continuity, dye rides @upstream of the velocity. Drop a height bulge with the BULGE stamp and watch the wave race around the planet, hit the antipode, and refocus. Paint colored dye with PAINT DYE to see the otherwise-invisible flow lines."
recommendedPreset bulge

substrate geodesic frequency 48

field h: f32                  // water column height
field m: vec2                 // depth-integrated horizontal momentum
field dye: f32                // passive scalar tracer
field dh: f32 derived         // h - 1 (signed anomaly for rendering)
field speed: f32 derived      // length(m) for rendering
field divM: f32 derived       // divergence(m) — diagnostic only

param gravity   slider 0..0.5    step 0.005   default 0.05  label "GRAVITY g"
param friction  slider 0..0.5    step 0.005   default 0.02  label "FRICTION"
param hMin      slider 0.05..1   step 0.01    default 0.1   label "MIN DEPTH"
param dyeFade   slider 0..0.05   step 0.0005  default 0.005 label "DYE FADE"
param flowScale slider 0..0.05   step 0.0005  default 0.005 label "DYE FLOW"
param simRateHz slider 0..360    step 1       default 60    label "SIM RATE"
param rate      slider 1..200    step 1       default 80    label "RATE"

stamp bulge "Bulge (drop wave)" {
  spot h at brush.pos, radius=brush.r, amount=1.0
}

stamp dimple "Dimple (suck wave)" {
  spot h at brush.pos, radius=brush.r, amount=-0.5
}

stamp paintDye "Paint dye" {
  spot dye at brush.pos, radius=brush.r, amount=1
}

stamp clearDye "Erase dye" {
  spot dye at brush.pos, radius=brush.r, amount=-1
}

scenario bulge "Single bulge at the equator" {
  // Pre-paint dye stripes so the flow is visible from the first
  // tick — without this the user has to hand-paint dye AND wait for
  // the wave to reach it before the flow shows up. Stripes get
  // stretched and folded along the wavefronts as it propagates.
  set h = 1
  set m = vec2(0, 0)
  for each cell {
    set dye = sin(lat * 12) * 0.5 + 0.5
  }
  spot h at lon=0, lat=0, radius=0.2, amount=1.2
}

scenario tsunami "Tsunami line source" {
  // A long strip of elevated water — collapses into a north/south-
  // running wave train. Useful for testing dispersion.
  set h = 1
  set m = vec2(0, 0)
  set dye = 0
  ellipse h at lon=-1.2, lat=0, rx=0.12, ry=0.7, amount=1.5, angle=0
}

scenario stripes "Painted dye stripes" {
  // Pre-paint zonal dye stripes; bulges then drag them into the flow
  // pattern. Use BULGE stamp on top to see the dye stretch.
  set h = 1
  set m = vec2(0, 0)
  for each cell {
    set dye = sin(lat * 8) * 0.5 + 0.5
  }
}

scenario dipole "Bulge + dimple dipole" {
  // Asymmetric initial condition — drives a circulating flow rather
  // than a symmetric expanding ring. The dye stripes make the rotation
  // visible.
  set h = 1
  set m = vec2(0, 0)
  for each cell {
    set dye = sin(lon * 6) * 0.5 + 0.5
  }
  spot h at lon=-0.4, lat=0, radius=0.18, amount=0.9
  spot h at lon=0.4,  lat=0, radius=0.18, amount=-0.5
}

step {
  // Stage 1 — Momentum.
  //
  // ∂m/∂t = -g·h·∇h - friction·m
  //
  // gradient(h) returns the height gradient as a vec2 in the cell's
  // tangent frame (east in .x, north in .y). Multiplying by h gives
  // the pressure-gradient force per unit area; the negative sign
  // means flow goes downhill. Linear friction damps the momentum
  // toward zero — small values (~0.02) just shave off the highest
  // frequencies; larger values bleed energy fast and the waves stop
  // ringing.
  stage momentum "Momentum step" {
    reads h, m
    writes m
    cell {
      let grad = gradient(h)
      // -g·h·∇h, expanded so the type checker sees vec2 - vec2 cleanly.
      let pressure = vec2(-gravity * h * grad.x, -gravity * h * grad.y)
      add m = (pressure - m * friction) * dt * rate
    }
  }

  // Stage 2 — Continuity.
  //
  // ∂h/∂t = -∇·m
  //
  // divergence(m) returns the scalar divergence of the vec2 field on
  // the tangent frame. Negative divergence = inflow = water piling up
  // = h grows. Positive divergence = outflow = water leaving = h
  // shrinks. Mass is exactly conserved at the operator level on a
  // closed sphere; numerical drift comes from the explicit Euler
  // step. The hMin floor prevents h from going negative when waves
  // crash hard, which would NaN the velocity in stage 3.
  stage continuity "Continuity step" {
    reads h, m
    writes h
    cell {
      add h = -divergence(m) * dt * rate
      set h = max(h, hMin)
    }
  }

  // Stage 3 — Tracer advection.
  //
  // ∂dye/∂t + u·∇dye = 0     where u = m / h
  //
  // Semi-Lagrangian: instead of differencing the gradient of dye, we
  // walk backward along the velocity for one timestep and sample the
  // dye field at the upstream position. The CoordRead @upstream
  // operator does exactly this, with inverse-distance interpolation
  // over the cell's neighbors so the result varies smoothly between
  // grid points. Shock-stable and free of the dispersion errors that
  // plague centered-difference advection.
  //
  // Dye fade keeps long-running scenarios from saturating into a
  // uniform color — set to 0 to turn off.
  stage advectDye "Advect dye" {
    reads dye, m, h
    writes dye
    cell {
      // Velocity = m / h. The flowScale factor compensates for the
      // internal *15 calibration in the @upstream WGSL helper (which
      // was tuned for v1-era recipes that fed it dt-on-the-order-of-
      // 0.001). Without it the effective walk is velocity*20 sphere
      // radians per tick — the dye samples from random points across
      // the planet and averages to a uniform color.
      let invH = 1.0 / max(h, hMin)
      let vx = m.x * invH
      let vy = m.y * invH
      set dye = dye@upstream(vx, vy, dt * rate * flowScale) * (1 - dyeFade * dt * rate)
    }
  }

  // Stage 4 — Diagnostics.
  //
  // Pure rendering / metric helpers. None of these feed back into
  // the dynamics; they exist so the renderer can ramp |m| or color
  // by signed height anomaly, and so the regime classifier has a
  // scalar speed value to threshold on.
  stage diagnostics "Compute diagnostics" {
    reads h, m
    writes dh, speed, divM
    cell {
      set dh = h - 1
      set speed = length(m)
      set divM = divergence(m)
    }
  }
}

// Live observables. These are the v2 metric headline: every quantity
// here used to need a hand-rolled CPU readback or a kernel-hardcoded
// summary; now they're one-line declarations the GPU reduces every
// tick.
metric mass    = sum  cells { h }                      // should be ~constant
metric meanH   = mean cells { h }
metric ke      = sum  cells { h * speed * speed }      // proxy for kinetic energy
metric maxSpd  = max  cells { speed }
metric active  = count cells where speed > 0.05        // share of cells in motion
`;

export const pipeline = compileV2(pipelineDsl);
