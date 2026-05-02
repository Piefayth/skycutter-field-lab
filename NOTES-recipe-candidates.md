# Recipe candidates — prior art & DSL roadmap

Running reference for "what could become a field-lab recipe." Combines a brainstorm pass and an academic prior-art survey (May 2026). Each candidate carries notes on which DSL features it needs; the DSL-gap roadmap at the bottom rolls these up so you can pick a recipe and see what unblocks it (or pick a feature and see which recipes it unlocks).

## What's already shipped

- **Weather** — forcing-driven multi-field baseline. Pressure → wind → advect → reaction → clamp.
- **Gray-Scott** — 2-field R-D walking Pearson's f/k diagram.
- **FitzHugh-Nagumo** — 2-field cubic excitable medium with rotating spirals.
- **Belousov-Zhabotinsky** — 3-field oscillator, nested target rings & spirals.
- **Discharge cascade** — excitable medium with discrete `event` discharges.
- **Inverter front** — wave-spread CA + state-swap events.
- **Blank** — minimal scaffold for new recipes.

---

# Part I — Academic prior-art survey

15 published simulations beyond the brainstorm list. Each entry has paper, equations, canonical parameter set, visual outcome, and DSL-fit notes.

## 1. Kobayashi Dendritic Solidification

**Paper**: Kobayashi, R. (1993). "Modeling and numerical simulations of dendritic crystal growth." *Physica D*, 63(3-4), 410–423.

**Equations**: Phase-field `p` and temperature `T`:
- `tau * dp/dt = div(eps² * grad p) + p(1-p)(p - 1/2 + m(T))` with anisotropic `eps(theta)` depending on the angle of `grad p`.
- `dT/dt = laplacian(T) + K * dp/dt`

**Canonical parameters**: `tau=3e-4`, `eps_bar=0.01`, anisotropy strength `delta=0.04`, mode `j=6` (six-fold), `K=1.8`, `alpha=0.9`, `gamma=10.0`.

**What you see**: Six-armed snowflakes growing outward from a seed, with side-branch instabilities forming fractal dendrites.

**DSL-fit notes**: Wants the gradient direction of `p` to compute anisotropic `eps(theta)`. With `each { neighbor reads }` you can build a finite-difference gradient locally. Requires storing two scalar fields plus a derived gradient angle. The anisotropic Laplacian is the only awkward bit — expressible as a stage that reads neighbors.

**Variants**: Karma-Rappel phase-field (1996, more thermodynamically clean); Warren-Boettinger alloy phase-field with composition.

**RECOMMEND: would make a beautiful recipe.** Snowflakes on a sphere are an iconic visual.

## 2. Klausmeier Semi-Arid Vegetation Bands

**Paper**: Klausmeier, C. A. (1999). "Regular and irregular patterns in semiarid vegetation." *Science*, 284(5421), 1826–1828.

**Equations** (biomass `n`, water `w`):
- `dw/dt = a - w - w*n² + v * dw/dx` (downhill water advection)
- `dn/dt = w*n² - m*n + laplacian(n)`

**Canonical parameters**: `a=2`, `m=0.45`, `v=182.5` (steep slope) or `v=0` (flat — gives Turing spots).

**What you see**: Stripes of vegetation perpendicular to slope, slowly migrating uphill ("tiger bush" pattern visible from satellites in the Sahel).

**DSL-fit notes**: Fits cleanly. The advective `v * dw/dx` term maps directly onto the existing `advect` primitive with a fixed flow field. Requires the ability to set a constant gradient/flow direction over the sphere — interesting on a sphere because there's no global "downhill" so you'd want a synthesized topography field.

**Variants**: Rietkerk model (3-field with surface water + soil water); HilleRisLambers banded vegetation; Gilad et al. mussel-bed analog.

## 3. Kuramoto Coupled Oscillators (Spatial Lattice Form)

**Paper**: Kuramoto, Y. (1984). *Chemical Oscillations, Waves, and Turbulence*. Springer. Spatial lattice: Sakaguchi & Kuramoto (1986).

**Equations**: Each cell has phase `theta`:
- `dtheta_i/dt = omega_i + K * sum_j sin(theta_j - theta_i)` over neighbors `j`.

**Canonical parameters**: `K=1.0` (just above critical for sync onset); natural frequencies `omega_i ~ N(0, 0.1)` random per cell.

**What you see**: Initial chaos collapses into rotating phase-locked patches; at intermediate `K`, **chimera states** — coexisting synchronized and desynchronized regions on the same lattice.

**DSL-fit notes**: Fits as-is. Phase as a single Float32 per cell; `each` block reads neighbor `theta` and accumulates `sin(theta_j - theta_i)`. The wraparound is a `mod 2*pi` after each step — a `clamp`-like primitive or a custom `cell` line.

**Variants**: Sakaguchi-Kuramoto (with phase lag `alpha`), Abrams-Strogatz chimera (1997 paper), Kuramoto-Battogtokh (2002 — original chimera observation on a ring).

**RECOMMEND: would make a beautiful recipe.** Chimeras on a sphere are a published-but-rare visual.

## 4. Olami-Feder-Christensen Earthquake Model

**Paper**: Olami, Z., Feder, H. J. S., & Christensen, K. (1992). "Self-organized criticality in a continuous, nonconservative cellular automaton modeling earthquakes." *PRL*, 68(8), 1244.

**Rules**: Each cell has stress `f`. Drive: `f += df/dt` uniformly. When `f >= f_th`, the cell topples: `f = 0`, neighbors get `f += alpha * f_old`. Cascades may trigger more topples.

**Canonical parameters**: `f_th=1.0`, `alpha=0.20` (non-conservative; conservative case is `alpha=0.25` on a 4-neighbor lattice).

**What you see**: Rare large avalanches punctuating long quiet periods; power-law avalanche size distribution. Visually: sudden cascading bright regions on a slowly-brightening background.

**DSL-fit notes**: Fits the `event when expr {}` primitive perfectly — exactly the pattern that motivated discrete events. Needs cascade-resolution semantics (re-triggering within one step). Discharge-cascade is a relative — OFC is the canonical SOC version.

**Variants**: Bak-Tang-Wiesenfeld original sandpile; Manna stochastic sandpile; Burridge-Knopoff spring-block.

## 5. 2D XY Model (Kosterlitz-Thouless Vortices)

**Paper**: Kosterlitz, J. M. & Thouless, D. J. (1973). "Ordering, metastability and phase transitions in two-dimensional systems." *J. Phys. C*, 6, 1181. (Nobel 2016.)

**Rules** (Glauber/Metropolis Monte Carlo): Each cell holds spin angle `theta`. Energy: `H = -J * sum_neighbors cos(theta_i - theta_j)`. Propose `theta_new` uniformly; accept with `min(1, exp(-dE/T))`.

**Canonical parameters**: `J=1`, `T_KT ~ 0.893` (Kosterlitz-Thouless transition temperature for square lattice). Run at `T=0.7` (ordered with vortices) or `T=1.1` (disordered).

**What you see**: Quantized topological vortex-antivortex pairs that unbind above `T_KT`; visually striking pinwheel singularities.

**DSL-fit notes**: Stochastic Metropolis acceptance is the hard part — needs per-cell PRNG state. Could be approximated by a Langevin/TDGL relaxation: `dtheta/dt = -dH/dtheta + noise`. The deterministic noisy form fits existing primitives if you add a per-cell random-noise stage.

**Variants**: Ising (Z2 instead of XY); Heisenberg (3-component spin, no KT transition); clock model (q-state discrete XY).

## 6. Diffusion-Limited Aggregation (DLA, Witten-Sander)

**Paper**: Witten, T. A. & Sander, L. M. (1981). "Diffusion-limited aggregation, a kinetic critical phenomenon." *PRL*, 47(19), 1400.

**Rules**: Density field `rho` of random walkers + sticky aggregate field `s`. Walker `rho` diffuses; where `rho > 0` and a neighbor has `s=1`, the cell becomes `s=1` (aggregate) and its `rho` is removed.

**Canonical parameters**: Continuous-density form: `D=1.0`, sticking probability `p=1.0`, source `rho` injected at boundary at rate `k=1e-3`. Seed: single `s=1` cell at center.

**What you see**: Fractal Brownian-tree dendrites; fractal dimension `~1.71` in 2D.

**DSL-fit notes**: The agent-based original needs particles, but the **Brady-Ball / Witten-Sander continuous limit** (Laplacian growth) maps to fields: `rho` solves `laplacian(rho)=0` with `rho=1` at infinity, `rho=0` on aggregate; aggregate grows at rate proportional to `|grad rho|`. Fits with `diffuse` + an event that converts cells based on a flux threshold.

**Variants**: Eden growth (uniform sticking, no diffusion); ballistic aggregation; dielectric breakdown model (Niemeyer-Pietronello, eta-parameter family).

**RECOMMEND: would make a beautiful recipe** — DLA on a sphere is rare and topologically interesting.

## 7. Saffman-Taylor / Hele-Shaw Viscous Fingering

**Paper**: Saffman, P. G. & Taylor, G. I. (1958). "The penetration of a fluid into a porous medium or Hele-Shaw cell containing a more viscous liquid." *Proc. Roy. Soc. A*, 245(1242), 312–329.

**Equations**: Pressure `p` solves `laplacian(p) = 0` (or with permeability `k`); interface velocity `v = -k*grad p / mu`. Concentration `c` of less-viscous fluid is advected by `v`, with diffusion `D` and capillary smoothing.

**Canonical parameters**: Viscosity ratio `M = mu_2/mu_1 = 100` (highly unstable), capillary number `Ca = 1e-3`, source-pressure boundary.

**What you see**: Branching, splitting fingers as the less-viscous fluid invades; in radial geometry, dense dendritic plumes.

**DSL-fit notes**: Needs a Poisson solve for `p` each step (the existing `wind` primitive already does pressure→velocity, so this might fit). Then `advect` for `c`. The fingering instability arises from the viscosity contrast — encode `mu(c)` as a per-cell function.

**Variants**: Darcy / Buckley-Leverett oil reservoir; chaotic mixing; Paterson radial fingering.

## 8. Held-Suarez Idealized Atmosphere

**Paper**: Held, I. M. & Suarez, M. J. (1994). "A proposal for the intercomparison of the dynamical cores of atmospheric general circulation models." *BAMS*, 75(10), 1825–1830.

**Equations** (drastically reduced 2D form on sphere): A potential temperature field `theta` with Newtonian relaxation to `theta_eq(latitude)`, a streamfunction `psi` solving `laplacian(psi) = -zeta` (vorticity), and `dzeta/dt = -J(psi, zeta) - beta * dpsi/dx + nu*laplacian(zeta)`.

**Canonical parameters**: `theta_eq` profile peaked at equator; relaxation time `tau_T = 40 days`; Rayleigh friction `tau_f = 1 day` near surface; `beta`-plane approximation if not running on the sphere directly.

**What you see**: Hadley-cell-like overturning, midlatitude baroclinic eddies, jet streams.

**DSL-fit notes**: Needs a streamfunction inversion (Poisson solve) and a Jacobian operator `J(psi, zeta) = dpsi/dx * dzeta/dy - dpsi/dy * dzeta/dx`. The Jacobian fits an `each` block with neighbor reads. Sphere geometry means `beta` falls out automatically from local rotation rate `f = 2*Omega*sin(lat)`.

**Variants**: Charney-DeVore (low-order chaos); Lorenz-Krishnamurti minimal climate; Phillips two-layer baroclinic.

**RECOMMEND**: jet streams emerging on the geodesic sphere is the canonical "you built an Earth" visual.

## 9. Active Nematic Liquid Crystal (Q-tensor Hydrodynamics)

**Paper**: Marchetti et al. (2013). "Hydrodynamics of soft active matter." *Rev. Mod. Phys.*, 85, 1143. Original active-nematic theory: Simha & Ramaswamy (2002).

**Equations** (scalar order parameter `S`, director angle `theta`):
- `dS/dt = -gamma * dF/dS + ...` where `F = (S² - S0²)² + K|grad theta|²`
- `dtheta/dt = K * laplacian(theta) + alpha * (active stress term)`

**Canonical parameters**: Activity `alpha=0.1` (extensile, e.g. microtubule-kinesin); elastic constant `K=1.0`; equilibrium `S0=1`. Above an activity threshold: spontaneous flow.

**What you see**: Topological `+1/2` and `-1/2` defects nucleate, dance, annihilate; "active turbulence" — chaotic mixing without inertia.

**DSL-fit notes**: Two scalars per cell (`S` and `theta`) suffices for a reduced model. The angle field requires careful neighbor differences (`theta_j - theta_i` mod `pi` for nematic, not `2*pi`). Hard part is the active flow coupling — to do justice to Marchetti, you need a velocity field; without it you've effectively got the dry-nematic Lebwohl-Lasher model, which is still beautiful.

**Variants**: Lebwohl-Lasher (purely passive on lattice); Toner-Tu (polar active fluid).

## 10. Toner-Tu Continuous Flocking

**Paper**: Toner, J. & Tu, Y. (1995). "Long-range order in a two-dimensional dynamical XY model: how birds fly together." *PRL*, 75(23), 4326.

**Equations** (density `rho`, velocity `v`):
- `drho/dt + div(rho * v) = 0`
- `dv/dt + (v.grad)v = (alpha - beta|v|²)v - grad P(rho) + D*laplacian(v) + noise`

**Canonical parameters**: `alpha=1`, `beta=1` (so `|v|=1` at preferred state), `D=0.1`, pressure `P=c²*rho`, noise amplitude `eta=0.1`.

**What you see**: A polarized flock spontaneously forms with long-range orientational order; density bands ("giant number fluctuations") form perpendicular to flow.

**DSL-fit notes**: This is a **continuous-density alternative to Vicsek**. Needs a vector velocity field. If the DSL has `wind` (a vector primitive), this nearly fits — you'd want the cubic self-propulsion `(alpha - beta|v|²)v` as a `cell` block writing into `v`.

**Variants**: Vicsek; active Brownian particles (continuum limit).

## 11. SIR Epidemic with Spatial Diffusion (Kendall / Murray)

**Paper**: Kendall, D. G. (1957). Spatial PDE form popularized by Murray, J. D. *Mathematical Biology II* (2003), Chapter 13.

**Equations**:
- `dS/dt = -beta*S*I + D_S*laplacian(S)`
- `dI/dt = beta*S*I - gamma*I + D_I*laplacian(I)`
- `dR/dt = gamma*I + D_R*laplacian(R)`

**Canonical parameters**: `beta=1.0`, `gamma=0.3` (`R0 = beta/gamma ~ 3.3`), `D_I = 1e-3`, `D_S = D_R = 0`.

**What you see**: Traveling epidemic waves expanding from a seed point; a single "burnout ring" propagates outward leaving recovered population behind — the canonical 1665 Black Death-rabies-style ring.

**DSL-fit notes**: Fits as-is with `diffuse` + `cell { ... }` reaction terms. The classic Murray rabies-fox model adds a fox-density compartment.

**Variants**: SEIR (with exposed compartment); SIRS (waning immunity → oscillations); host-pathogen with logistic host growth.

## 12. Double-Diffusive Convection (Salt Fingers)

**Paper**: Stern, M. E. (1960). "The 'salt-fountain' and thermohaline convection." *Tellus*, 12(2), 172–175. Review: Schmitt, R. W. (1994). *Annu. Rev. Fluid Mech.*, 26, 255.

**Equations**: Boussinesq with two diffusing fields (`T` warm/salty above, `S` cold/fresh below):
- `dT/dt + v.grad T = kappa_T * laplacian(T)`
- `dS/dt + v.grad S = kappa_S * laplacian(S)`
- Streamfunction satisfies a Poisson equation forced by `g*(alpha*dT/dx - beta*dS/dx)`.

**Canonical parameters**: Lewis number `Le = kappa_T/kappa_S = 100` (heat diffuses 100× faster than salt); density ratio `R_rho = alpha*dT / (beta*dS) = 2`; Prandtl `Pr = 7` (water).

**What you see**: Vertical "salt fingers" — long thin plumes alternating up/down — distinct from convection rolls.

**DSL-fit notes**: Needs streamfunction (Poisson solve); same machinery as Held-Suarez. Two scalar fields plus velocity.

**Variants**: Diffusive convection regime (`R_rho < 1`); thermohaline staircase formation.

## 13. Bak-Sneppen Coevolution

**Paper**: Bak, P. & Sneppen, K. (1993). "Punctuated equilibrium and criticality in a simple model of evolution." *PRL*, 71(24), 4083.

**Rules**: Each cell holds a fitness `f` in `[0,1]`. Each step: find the global minimum `f`, replace it and its neighbors with new uniform random `[0,1]` values.

**Canonical parameters**: None — parameter-free. On 2D lattice: avalanche threshold `f_c ~ 0.328`.

**What you see**: Long stasis punctuated by avalanches of fitness-replacement; spatial waves of "extinction events."

**DSL-fit notes**: The "global minimum" step is annoying for a cellular DSL — you need a global reduction. Can be approximated by a **threshold-based local rule**: replace `f < f_c` cells, which gives the same critical behavior. Then it fits `event when f < f_c { }`. Reductions on geodesic aren't yet wired — this is one of the simulations that motivates them.

**Variants**: Bak-Sneppen with quenched fitness; extremal optimization; Sneppen interface depinning.

## 14. Gierer-Meinhardt Activator-Inhibitor (Seashell Patterns)

**Paper**: Gierer, A. & Meinhardt, H. (1972). "A theory of biological pattern formation." *Kybernetik*, 12(1), 30–39. Visualizations: Meinhardt, H. *The Algorithmic Beauty of Sea Shells* (1995).

**Equations**:
- `da/dt = rho * a²/h - mu_a*a + D_a*laplacian(a) + rho_0`
- `dh/dt = rho * a² - mu_h*h + D_h*laplacian(h)`

**Canonical parameters**: `rho=0.01`, `mu_a=0.01`, `mu_h=0.02`, `D_a=0.005`, `D_h=0.2` (long-range inhibitor, short-range activator — the key inequality `D_h >> D_a`).

**What you see**: Spots, stripes, leopard spots, and — with depletion variants — traveling waves like seashell-pigment patterns.

**DSL-fit notes**: Fits trivially in the existing R-D framework — same shape as Gray-Scott but with **multiplicative** rather than competitive kinetics, giving qualitatively different patterns (sharper spots, stable stripes).

**Variants**: Gierer-Meinhardt with substrate depletion; Meinhardt's 5-equation seashell model (extends to spatiotemporal pigment).

## 15. Burgers' Equation (Shock Formation)

**Paper**: Burgers, J. M. (1948). "A mathematical model illustrating the theory of turbulence." *Adv. Appl. Mech.*, 1, 171–199.

**Equations** (viscous Burgers):
- `du/dt + u * du/dx = nu * laplacian(u)`

In 2D vector form: `du/dt + (u.grad)u = nu * laplacian(u)` — Navier-Stokes minus pressure.

**Canonical parameters**: `nu=0.01` (low viscosity, sharp shocks); initial condition: random Gaussian or sinusoidal.

**What you see**: Smooth initial conditions steepen into shock fronts that merge over time — "Burgers turbulence" in 2D.

**DSL-fit notes**: Pure `advect` + `diffuse` — fits existing primitives directly with one vector or scalar field. The simplicity is the point: a lab-quality demo of nonlinear steepening.

**Variants**: KPZ equation (Kardar-Parisi-Zhang, surface growth — shares Burgers nonlinearity); inviscid Burgers (entropy solutions, Riemann problems); stochastic Burgers.

---

# Part II — Brainstorm overflow

Candidates from the original brainstorm (less detailed; full equations are in textbooks). Many are touched on in the survey above; listed here for completeness.

**Reaction-diffusion family**:
- **Lengyel-Epstein CIMA** — chlorite-iodide-malonic acid; canonical 2D Turing experiment with mass conservation. Two-species R-D.
- **Brusselator** — synthetic R-D; classic Turing instability demo.
- **Predator-prey with diffusion** — Lotka-Volterra in 2D; oscillating populations with spatial waves.

**Excitable media**:
- **Aliev-Panfilov** — cardiac variant of FitzHugh-Nagumo with µ-dependence on `u`.
- **Wilson-Cowan neural fields** — population-averaged neural activity with kernel interaction; bumps, traveling waves, hallucination patterns.

**Higher-order PDE**:
- **Kuramoto-Sivashinsky** — `∂u/∂t = -∇²u - ∇⁴u - u·∇u`. Famously chaotic flame-front equation.
- **Cahn-Hilliard** — `∂c/∂t = ∇²(c³ - c - ε∇²c)`. Spinodal decomposition; coalescing-droplet patterns.

**Cellular automata**:
- **Conway's Game of Life** — 2-state, neighbor-count threshold rules. Closed-surface (sphere) variant unique.
- **Brian's Brain** — 3-state spiral CA. Excitable, sharp visuals.
- **Rock-Paper-Scissors** (cyclic dominance) — 3-species CA; nested spirals.
- **Sandpile (BTW)** — accumulator + threshold redistribute. Self-organized criticality.
- **Forest fire (Drossel-Schwabl)** — tree/ignite/burn/regrow.

**Climate / atmosphere**:
- **Ice-albedo feedback** — bistable; snowball-Earth ↔ runaway warming.

**Hydrodynamics**:
- **Shallow-water equations** — ∂_t u + (u·∇)u = -g∇h, ∂_t h + ∇·(hu) = 0. Tsunamis, Rossby waves.
- **Vicsek model** — discrete-time flock alignment.
- **MHD** — magnetohydrodynamics; sun-spot-flavored.

**Integral kernels / non-local**:
- **SmoothLife** — continuous-state Game of Life with kernel-based neighborhoods.
- **Lenia** — continuous-time/space/state GoL; many published "lifeforms."

**Particles** (substrate change):
- **Boids** — three-rule flocking.
- **Schelling segregation** — agent-based social model.
- **Slime mold (Physarum)** — agent + pheromone field.

**Wave / second-order time**:
- **Wave equation** — `∂²u/∂t² = c²∇²u`. Surface waves on sphere.
- **Telegraph equation** — wave + diffusion.

---

# Part III — DSL gap roadmap

Recipes grouped by what DSL feature they need. Picking a feature unlocks every recipe in its row.

## Tier 0 — fits current DSL, no work needed

- **Burgers** — `advect` + `diffuse` only.
- **SIR spatial epidemic** — `diffuse` + `cell` reaction.
- **Gierer-Meinhardt** — same shape as Gray-Scott.
- **Predator-prey with diffusion** — same shape.
- **Klausmeier vegetation** — needs a one-time-set "downhill flow" source field, otherwise just R-D + advect.
- **Aliev-Panfilov** — same shape as FN with one extra term.
- **Brusselator** — same shape as Gray-Scott.
- **Lengyel-Epstein** — fits existing R-D family.

## Tier 1 — bounded DSL extensions (one new feature each)

### Mod-2π (or mod-π) angle handling for neighbor differences
Just a `wrapAngle` helper or a recipe-side modular subtraction.
- **Kuramoto coupled oscillators / chimera states** ← strong recommend
- **Active nematic** (mod-π)
- **XY model** (deterministic Langevin form)
- **2D Heisenberg** (vector field on sphere)

### Per-cell PRNG / stochastic state
Persistent random-state-per-cell, or a `noise(cellId, frame)` that's actually properly random per cell-frame.
- **Glauber Ising / XY**
- **Stochastic SIR with binomial events**

### `neighborSum` / `neighborCount` primitive
Counts/sums over neighbors; we have `neighborMax` only.
- **Conway's Game of Life**
- **Brian's Brain**
- **Rock-paper-scissors CA**
- **Sandpile / BTW** (combined with neighbor write)

### Cascade events (re-trigger within one tick)
Events that retroactively invalidate other cells in the same tick.
- **Olami-Feder-Christensen earthquakes** ← strong recommend
- **Sandpile (proper avalanche semantics)**
- **Bak-Sneppen** (if approximated as threshold-event)

### History fields (`field u history N`)
Retain previous-frame values for second-order-time integration.
- **Wave equation** ← strong recommend
- **Telegraph equation**
- **Predictor-corrector improvements** to existing recipes (BZ, gray-scott stability)

### Higher-order PDE primitives (`laplacian`, or composable diffuse)
Direct support for `∇²u` and `∇⁴u`.
- **Kuramoto-Sivashinsky**
- **Cahn-Hilliard** (spinodal decomposition)
- **Phase-field models** (Kobayashi snowflake — also needs gradient angle; see below)

### Per-cell gradient angle / direction reads
Expose `atan2(grad_u_y, grad_u_x)` as a builtin or via `each`.
- **Kobayashi dendritic snowflake** ← strong recommend
- **Anisotropic phase-field**
- **Active nematic (defect tracking)**

### Geodesic reductions (sum, mean, max over the whole grid)
Currently `normalize` throws on geodesic.
- **Bak-Sneppen** (needs global min)
- **Mass-conserving R-D variants** (any sim wanting strict conservation)
- **Mean-pressure normalization** (already wanted in weather)

### Poisson solve (∇²p = source)
Iterative or multigrid; one new compute primitive.
- **Held-Suarez idealized atmosphere** ← strong recommend
- **Saffman-Taylor viscous fingering**
- **Salt fingers (double-diffusive convection)**
- **DLA (continuous Laplacian growth)**

### Constant/synthesized topography field
Recipe-author-specified scalar landscape that doesn't mutate.
- **Klausmeier vegetation** (downhill water flow)

## Tier 2 — substrate change required

### True vector fields (vec2 first-class)
Currently 2D vectors are stored as paired scalar fields. Vec2 ops (`a + b`, `a · b`, `|a|`) would make velocity-driven sims cleaner.
- **Toner-Tu flocking**
- **Burgers' equation in vector form**
- **Active nematic (with hydrodynamics)**
- **Shallow water**

### Convolution / non-local kernels
Integral kernel applied at every cell. Big extension.
- **SmoothLife**
- **Lenia**
- **Wilson-Cowan neural fields** (proper integral form)

### Particles / agents
First-class population concept alongside `field`. Biggest extension.
- **Boids**
- **Slime mold (Physarum)**
- **Schelling segregation**
- **Discrete Vicsek**
- **DLA (agent-based original)**

---

# Part IV — Picking what to ship next

**Highest payoff per unit work** (subjective ranking):

1. **Kuramoto chimera** — needs only mod-2π angle handling, surfaces a famous published phenomenon, visually distinctive.
2. **Wave equation** — needs history fields (one bounded compiler extension), unblocks an entire family (waves, second-order time integrators).
3. **Olami-Feder-Christensen earthquakes** — exercises the events layer in a new way, connects to SOC literature.
4. **Kobayashi snowflake** — needs gradient-angle access, produces an iconic visual (snowflakes on the sphere).
5. **Held-Suarez atmosphere** — needs Poisson solve, but unlocks three other recipes simultaneously (Saffman-Taylor, salt fingers, DLA continuous), and produces "you built an Earth" jet-stream visuals.

**Cheapest** (Tier 0, fits current DSL with no work): Burgers, SIR, Gierer-Meinhardt — all could ship as recipes in a single afternoon each.

**Aspirational** (substrate change): particles family. Defer until the field-on-grid surface is fully explored; revisit when boredom with field-only recipes sets in.
