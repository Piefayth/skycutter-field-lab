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
summary "Depth-averaged fluid on a rotating sphere. gradient(h) drives momentum, divergence(m) drives continuity, dye rides @upstream of the velocity, and Coriolis rotates the flow with a latitude-dependent twist. Try the CYCLONES scenario — three identical bulges on a north-south line release as ring waves at the equator and tight spirals near the poles. Set ROTATION to 0 to compare against the non-rotating Earth: the polar spiral collapses to a symmetric ring."
recommendedPreset cyclones

// Frequency 32 (~6k cells) is the sweet spot: visibly resolved
// detail without CFL strangling the explicit integrator. Each cell is
// ≈0.02 sphere-radians, which sets the upper bound on the per-tick
// effective-dt times the fastest wave speed. Doubling to 64 looks
// crisper but cuts the stable parameter range to a thin sliver.
substrate geodesic frequency 32

field h: f32                  // water column height
field m: vec2                 // depth-integrated horizontal momentum
field dye: f32                // passive scalar tracer
field dh: f32 derived         // h - 1 (signed anomaly for rendering)
field speed: f32 derived      // length(m) for rendering
field divM: f32 derived       // divergence(m) — diagnostic only

// CFL: the explicit forward-Euler step requires
// effective-dt · sqrt(g · h_max) < cell-size. With cell≈0.02 at
// frequency 32, default g=0.002, h peaking around 3 at the bulge,
// the wave speed c reaches ~0.077 sphere-radians/sec. The
// effective-dt at default rate=12 is (1/60)·12 = 0.2 sim-seconds,
// giving CFL margin ≈ 1.3. Tight but stable. Crank g much past
// 0.005 or rate past 20 and the integrator blows to NaN within a
// tick (visible as the entire screen going black/transparent).
//
// flowScale separately sets the dye's per-tick walk distance — at
// the default 0.3, the wave-front velocity ~0.09 produces walks of
// ~0.005 sphere-radians per tick (≈0.25 cells), which reads as
// dye visibly streaming along the wave fronts. Push it to ~1.0 for
// dramatic streaks at the cost of @upstream sampling accuracy
// (walks > 1 cell start sampling from cells that aren't really
// upstream).
param gravity   slider 0..0.02    step 0.0002  default 0.002  label "GRAVITY g"
param friction  slider 0..0.05    step 0.0005  default 0.005  label "FRICTION"
param viscosity slider 0..0.5     step 0.005   default 0.15   label "VISCOSITY"
// Planet rotation rate Ω. At rotation=0 the planet is non-rotating
// — bulges expand into symmetric ring waves. At rotation=0.02 the
// Coriolis parameter f = 2·Ω·sin(lat) reaches 0.04 at the poles,
// comparable to the wave speed (Rossby number ≈ 1). Now waves
// curve, vortices spin up around bulges with cyclonic
// (counter-clockwise in the northern hemisphere) sense, and a
// painted high/low pressure pair at mid-latitude generates a
// persistent jet rather than dissipating. Set to 0 for the
// non-rotating reference simulation.
param rotation  slider 0..0.2     step 0.001   default 0.02   label "ROTATION Ω"
param hMin      slider 0.05..1    step 0.01    default 0.1    label "MIN DEPTH"
param dyeFade   slider 0..0.05    step 0.0005  default 0.003  label "DYE FADE"
param flowScale slider 0..1       step 0.01    default 0.3    label "DYE FLOW"
param simRateHz slider 0..360     step 1       default 60     label "SIM RATE"
param rate      slider 1..40      step 1       default 12     label "RATE"

stamp bulge "Bulge (drop wave)" {
  spot h at brush.pos, radius=brush.r, amount=1.5
}

stamp dimple "Dimple (suck wave)" {
  spot h at brush.pos, radius=brush.r, amount=-0.6
}

stamp paintDye "Paint dye" {
  spot dye at brush.pos, radius=brush.r, amount=1
}

stamp clearDye "Erase dye" {
  spot dye at brush.pos, radius=brush.r, amount=-1
}

scenario bulge "Single bulge at the equator" {
  // Pre-paint zonal dye stripes so the flow is visible from the
  // first tick — the stripes get stretched and folded along the
  // wavefronts as the bulge releases. A bigger amplitude (h goes
  // from 1 to 3 at center) gives more potential energy and a wave
  // that propagates with substantial momentum, otherwise the dye
  // motion is too subtle to see at default tuning.
  set h = 1
  set m = vec2(0, 0)
  for each cell {
    set dye = sin(lat * 8) * 0.5 + 0.5
  }
  spot h at lon=0, lat=0, radius=0.25, amount=2
}

scenario tsunami "Tsunami line source" {
  // A long strip of elevated water — collapses into a north/south-
  // running wave train. Useful for testing dispersion.
  set h = 1
  set m = vec2(0, 0)
  set dye = 0
  ellipse h at lon=-1.2, lat=0, rx=0.15, ry=0.8, amount=2.5, angle=0
}

scenario stripes "Painted dye stripes" {
  // Pre-paint zonal dye stripes; the BULGE stamp then drops a wave
  // and the stripes show its propagation pattern. Quietest of the
  // scenarios — water is at rest until you click.
  set h = 1
  set m = vec2(0, 0)
  for each cell {
    set dye = sin(lat * 6) * 0.5 + 0.5
  }
}

scenario dipole "Bulge + dimple dipole" {
  // Asymmetric initial condition — drives a circulating flow rather
  // than a symmetric expanding ring. The longitudinal dye stripes
  // make the rotation visible.
  set h = 1
  set m = vec2(0, 0)
  for each cell {
    set dye = sin(lon * 4) * 0.5 + 0.5
  }
  spot h at lon=-0.4, lat=0, radius=0.2, amount=1.5
  spot h at lon=0.4,  lat=0, radius=0.2, amount=-0.7
}

scenario cyclones "Cyclones (rotation comparison)" {
  // Three identical bulges along a north-south axis: equator, mid-
  // latitude, near-pole. With rotation=0 they all release as
  // identical symmetric ring waves. With rotation>0 the equatorial
  // bulge still releases symmetrically (f=0 there), the mid-
  // latitude bulge twists into a cyclonic spiral, and the polar
  // bulge spins up tightly into a localized vortex. Side-by-side
  // demonstration that one parameter changes everything about the
  // dynamics.
  set h = 1
  set m = vec2(0, 0)
  for each cell {
    // Faint background dye so the spirals are visible from frame 1.
    set dye = sin(lon * 5) * 0.4 + 0.5
  }
  spot h at lon=0, lat=-1.2, radius=0.18, amount=2     // near south pole
  spot h at lon=0, lat=0,    radius=0.18, amount=2     // equator
  spot h at lon=0, lat=1.2,  radius=0.18, amount=2     // near north pole
}

step {
  // Stage 1 — Momentum.
  //
  // ∂m/∂t = -g·h·∇h - friction·m + f·k̂×m
  //
  // Three forces:
  //   - pressure gradient: -g·h·∇h drives flow downhill. gradient(h)
  //     returns the height gradient as a vec2 in the cell's tangent
  //     frame (east in .x, north in .y).
  //   - Coriolis: f·k̂×m, where f = 2·Ω·sin(lat) is the Coriolis
  //     parameter and k̂ is the local outward normal. In the
  //     east-north tangent basis this rotates m by 90°, with a
  //     latitude-dependent rate. At the equator (lat=0) f=0 and
  //     the term vanishes — Coriolis only acts on flows away from
  //     the equator. Northern hemisphere f>0 deflects rightward;
  //     southern f<0 deflects leftward. Set rotation=0 to disable.
  //   - linear friction: -friction·m bleeds energy slowly so waves
  //     don't ring forever. Larger values damp faster.
  stage momentum "Momentum step" {
    reads h, m
    writes m
    cell {
      let grad = gradient(h)
      // -g·h·∇h, expanded so the type checker sees vec2 - vec2 cleanly.
      let pressure = vec2(-gravity * h * grad.x, -gravity * h * grad.y)
      // f·k̂×m. With m = (m.x·east + m.y·north), k̂×m rotates 90°
      // around the local vertical: east→north, north→-east. The
      // standard Coriolis force is -2Ω×v, which in this basis
      // becomes (f·m.y, -f·m.x). Northern hemisphere f>0 sends
      // northward flow rightward (eastward) — the cyclonic-spinup
      // signature.
      let f = 2 * rotation * sin(lat)
      let coriolis = vec2(f * m.y, -f * m.x)
      add m = (pressure + coriolis - m * friction) * dt * rate
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

  // Stage 3 — Viscosity (height smoothing).
  //
  // Forward-Euler integration of a hyperbolic system on a coarse
  // mesh has a numerical instability at the cell-scale frequency
  // that no amount of dt-tuning fully suppresses. A single tick of
  // Laplacian smoothing per stage damps that mode without damping
  // the long-wavelength wave physics we actually want to see — the
  // standard trick from CFD on irregular meshes.
  //
  // Mass is preserved: the Laplacian is sum(h@n - h)/count, which
  // averages to zero over the mesh. The clamp on the per-tick
  // factor mirrors klausmeier's diffusion stage — it stops the
  // smoother from over-stepping (and going negative) when
  // viscosity * dt * rate exceeds the diffusion-stability bound.
  stage viscosityStep "Viscosity (height smoothing)" {
    reads h
    writes h
    cell {
      add h = (mean n in neighbors { h@n } - h) * clamp(viscosity * dt * rate, 0, 0.24)
    }
  }

  // Stage 4 — Tracer advection.
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
      // Velocity = m / h. flowScale multiplies the per-tick walk
      // distance — with the field's typical |m|/h around 0.5–3 at
      // wave fronts, flowScale=0.075 yields walks of ~0.04–0.2
      // sphere-radians per tick, which reads as the dye visibly
      // streaming along the wave fronts without smearing across the
      // hemisphere in one frame.
      let invH = 1.0 / max(h, hMin)
      let vx = m.x * invH
      let vy = m.y * invH
      set dye = dye@upstream(vx, vy, dt * rate * flowScale) * (1 - dyeFade * dt * rate)
    }
  }

  // Stage 5 — Diagnostics.
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
