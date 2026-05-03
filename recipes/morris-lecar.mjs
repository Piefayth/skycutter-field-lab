// Morris-Lecar (1981) — two-variable model of an excitable membrane.
// Originally derived for barnacle muscle but became the canonical
// "minimal Hodgkin-Huxley" used in everything from neuron-network
// papers to cardiac excitability work.
//
// State: V (membrane voltage) and w (slow K+ activation). The dynamics
// are driven by sigmoid-shaped steady-state gating curves:
//
//   m_∞(V) = 0.5 · (1 + tanh((V − V₁) / V₂))    fast Ca²⁺ activation
//   w_∞(V) = 0.5 · (1 + tanh((V − V₃) / V₄))    slow K⁺ activation
//   τ_w(V) = 1 / cosh((V − V₃) / (2·V₄))         w time constant
//
// Currents:
//   I_Ca = g_Ca · m_∞(V) · (V − E_Ca)             instantaneous, no gate dynamics
//   I_K  = g_K  · w      · (V − E_K)
//   I_L  = g_L  · (V − E_L)                        leak
//
// Steady-state v voltage:
//   dV/dt = (I_app − I_Ca − I_K − I_L) / C
//   dw/dt = φ · (w_∞ − w) / τ_w
//
// FitzHugh-Nagumo's relationship to ML is "what if you replace the
// physiologically-derived sigmoid gates with their cubic Taylor
// approximations and merge the two slow variables." ML is FN with
// the gating sharpness explicit — and the tanh-shaped m_∞/w_∞ curves
// give you the saturation that prevents the cubic-FN-style runaway
// at large amplitudes.
//
// Why on a sphere: spiral waves, target patterns, fibrillation —
// same family of phenomena as FN / Aliev-Panfilov / BZ. The ML
// dynamics are cleaner-looking because the saturation is proper, not
// a polynomial approximation.

import { compileV2 } from "../dsl/compile-v2.mjs";

export const overlays = [];

export const metrics = [
  { id: "active",  label: "ACTIVE", source: "dsl:active",  spark: true, precision: 0 },
  { id: "meanV",   label: "MEAN V", source: "dsl:meanV",   spark: true, precision: 3 },
  { id: "fps",     label: "FPS",    source: "fps",         mini: true },
];

export const regime = {
  silent:       { active: 0 },
  intermittent: { active: 5 },
  active:       { active: 100 },
  runaway:      { active: 5000 },
};

export const pipelineDsl = `
recipe "Morris-Lecar excitable medium"
summary "Two-variable excitable membrane (Morris & Lecar 1981). The fast Ca²⁺ activation m∞(V) = ½(1+tanh((V−V₁)/V₂)) and slow K⁺ activation w∞(V) follow physiologically-shaped sigmoid gates rather than FitzHugh-Nagumo's cubic stand-in, which gives clean saturation at large depolarization. With diffusive coupling on V, the sphere supports spiral waves, target patterns, and reentry — same family as FN / Aliev-Panfilov but with proper gating shapes that don't blow up at high amplitude."
recommendedPreset reentry

substrate geodesic frequency 48

field V: f32                  // membrane voltage (-80 ≲ V ≲ 30 mV-scale; we use dimensionless [-1, 1])
field w: f32                  // slow K+ activation in [0, 1]

// Gating shape parameters. V1/V2 set the half-activation and width of
// m∞ (Ca channel); V3/V4 do the same for w∞ (K channel). Default
// values place ML in the canonical "type II" regime — Hopf-like
// excitability with a sharp threshold.
param V1          slider -1..1   step 0.01  default -0.01 label "V₁ (m HALF)"
param V2          slider 0.01..1 step 0.01  default 0.15  label "V₂ (m WIDTH)"
param V3          slider -1..1   step 0.01  default 0.10  label "V₃ (w HALF)"
param V4          slider 0.01..1 step 0.01  default 0.145 label "V₄ (w WIDTH)"
// Conductances (max channel-open currents).
param gCa         slider 0..3    step 0.05  default 1.10  label "g_Ca"
param gK          slider 0..3    step 0.05  default 2.00  label "g_K"
param gL          slider 0..1    step 0.01  default 0.50  label "g_L (LEAK)"
// Reversal potentials.
param ECa         slider -1..1.5 step 0.05  default 1.00  label "E_Ca"
param EK          slider -1..1.5 step 0.05  default -0.70 label "E_K"
param EL          slider -1..1.5 step 0.05  default -0.50 label "E_L"
// Applied current (drives the system into excitability). I_app = 0.10
// puts ML in the threshold-sensitive regime: a small perturbation
// above threshold fires; below threshold it returns to rest.
param Iapp        slider 0..0.4  step 0.005 default 0.080 label "I_app"
// Slow-gate timescale. φ small = w lags V more, longer refractory.
param phi         slider 0.01..0.6 step 0.005 default 0.20 label "φ (w RATE)"
// Spatial diffusion of V — couples neighbors so excitation propagates
// as a travelling wave rather than firing each cell independently.
param Dv          slider 0..0.3  step 0.005 default 0.06  label "D_V (DIFF)"

param simRateHz   slider 0..360  step 1     default 60    label "SIM RATE"
param rate        slider 1..60   step 1     default 8     label "RATE"

step {
  // Stage 1 — Diffuse V across neighbors. K⁺ channel current doesn't
  // diffuse spatially (it's an intracellular dynamic) so w is local.
  stage diffuse "Diffuse membrane voltage" {
    reads V, w
    writes V
    cell {
      add V = (mean n in neighbors { V@n } - V) * clamp(Dv * 0.16 * dt * rate, 0, 0.24)
    }
  }

  // Stage 2 — Local kinetics. Sigmoid gating curves drive both the
  // instantaneous Ca current and the slow w activation; tanh
  // saturates cleanly at the rails so high-amplitude excursions don't
  // produce nonphysical accelerations.
  stage kinetics "Membrane kinetics (V, w)" {
    reads V, w
    writes V, w
    cell {
      // Steady-state activation curves. m∞ is fast (instantaneous) so
      // it appears directly in I_Ca; w∞ is the target for the slow
      // gate's relaxation.
      let mInf = 0.5 * (1 + tanh((V - V1) / V2))
      let wInf = 0.5 * (1 + tanh((V - V3) / V4))
      // Slow-gate timescale (cosh = (e^x + e^-x)/2 = sech^-1).
      // Approximated as 1 / (exp(x) + exp(-x)) * 2 since cosh isn't a
      // first-class fn here.
      let xi    = (V - V3) / (2 * V4)
      let lambda = 2 / (exp(xi) + exp(-xi))
      // Membrane currents.
      let iCa = gCa * mInf * (V - ECa)
      let iK  = gK  * w    * (V - EK)
      let iL  = gL  * (V - EL)
      add V = (Iapp - iCa - iK - iL) * dt * rate
      add w = phi * lambda * (wInf - w) * dt * rate
    }
  }

  stage clampPos "Numerical safety" {
    reads V, w
    writes V, w
    cell {
      set V = clamp(V, -1.5, 1.5)
      set w = clamp(w, 0, 1)
    }
  }
}

// "Active" = cells currently above the firing threshold V > 0.
metric active = count cells where V > 0
metric meanV  = mean cells { V }

views {
  // Cool-to-hot voltage palette. Resting (-0.5) sits in deep blue;
  // firing (V ≈ 0.5–1) glows red.
  palette MEMBRANE {
    stop 0    color [10, 18, 40]
    stop 0.4  color [40, 80, 160]
    stop 0.55 color [200, 200, 200]
    stop 0.7  color [240, 140, 60]
    stop 1    color [255, 240, 200]
  }

  palette GATE {
    stop 0 color [20, 30, 60]
    stop 1 color [220, 230, 255]
  }

  view voltage "Membrane voltage V" {
    color ramp V range [-0.7, 1] palette MEMBRANE
  }

  view gate "K⁺ activation w" {
    color ramp w range [0, 1] palette GATE
  }
}

stamps {
  stamp depolarize "Depolarize cells" {
    spot V at brush.pos, radius=brush.r, amount=0.6
  }

  stamp hyperpolarize "Hyperpolarize cells" {
    spot V at brush.pos, radius=brush.r, amount=-0.5
  }

  stamp resetGate "Reset K⁺ gate to closed" {
    spot w at brush.pos, radius=brush.r, amount=-1
  }
}

scenarios {
  scenario reentry "Spiral rotor seed (default)" {
    // Same broken-plane-wave trick as Aliev-Panfilov: a thin north-
    // south wavefront with a refractory shadow ahead in the northern
    // hemisphere. The torn front bends into the killed region and
    // forms a spiral tip pinned to the boundary singularity.
    set V = -0.5
    set w = 0
    region V at lonMin=-0.4, lonMax=-0.2, latMin=-PI/2, latMax=PI/2, amount=1.0
    region w at lonMin=-0.2, lonMax=0.6,  latMin=0,     latMax=PI/2, amount=0.4
  }

  scenario blank "Resting membrane" {
    set V = -0.5
    set w = 0
  }

  scenario front "Plane wave (no break)" {
    // Clean north-south wavefront — propagates around the sphere and
    // self-collides at the antipode. Same shape as REENTRY without
    // the refractory shadow.
    set V = -0.5
    set w = 0
    region V at lonMin=-0.4, lonMax=-0.2, latMin=-PI/2, latMax=PI/2, amount=1.0
  }

  scenario chaos "Random initial depolarization" {
    // High-noise start — multiple rotors nucleate, drift, and
    // annihilate. Cardiac-fibrillation visual.
    set w = 0
    for each cell {
      let r = cellRand(7)
      set V = -0.5 + r * r * 1.2
    }
  }
}
`;

export const pipeline = compileV2(pipelineDsl);
