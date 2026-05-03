// Field Lab DSL v2 compiler facade.
//
// Pipeline: parse v2 syntax → lower to v1 schema shape → run v1 validators →
// emit the same `{ nodes, edges, dsl }` object that compileDsl() returns.
// The existing webgpu-geodesic-compiler and runtime consume this unchanged.
//
// v2 is import-free; v1's validators expect import metadata to gate primitive
// usage. To bridge: we synthesize a maximal imports list covering every
// primitive + builtin so the v1 import checks always pass. v2's own
// restrictions (one cell per stage, derived field rules, metric grammar) are
// enforced by the v2 parser itself plus the dedicated v2 validator.

import { parseV2 } from "./parse-v2.mjs";
import {
  annotateStageParamRefs,
  buildDeclaredPipelineSummary,
  deriveEdges,
  validateNameUniqueness,
  validatePresets,
  validateStages,
  validateStamps,
} from "./validate.mjs";
import { validateV2 } from "./validate-v2.mjs";
import {
  CLOCK_BUILTINS,
  CLOCK_HELPERS,
  GEO_BUILTINS,
  GEO_CONSTANTS,
  INIT_VERBS,
  MATH_FUNCTIONS,
  PIPELINE_PRIMITIVES,
  STAGE_BLOCKS,
  STENCIL_HELPERS,
  STAMP_EXTRAS,
} from "./dsl-spec.mjs";

// Auto-imported v1 namespaces / names that v2 syntax doesn't expose
// directly but that the v1 validator still checks against under the
// hood. The user never imports these; they're internal routing.
//
// `fill` and `eachCell` aren't in v2's INIT_VERBS catalog (the user
// writes `set f = 0` and `for each cell { ... }`), but the parser
// lowers those to v1-shape `fill` / `eachCell` actions for the v1
// validator. Hardcoded here rather than derived from INIT_VERBS so
// the user-facing catalog can stay clean.
const V2_AUTO_SIM = ["cell"];
const V2_AUTO_INIT = ["fill", "spot", "ellipse", "region", "eachCell"];

// The maximal builtin list, used when a recipe declares no `import`
// lines. Mirrors the union of every v1 namespace's allowed names.
const V2_MAXIMAL_IMPORTS = [
  { from: "init",  names: V2_AUTO_INIT },
  { from: "sim",   names: [...PIPELINE_PRIMITIVES.map((p) => p.name), ...STAGE_BLOCKS.map((b) => b.name)] },
  { from: "clock", names: [...CLOCK_BUILTINS.map((b) => b.name), ...CLOCK_HELPERS.map((b) => b.name)] },
  { from: "geo",   names: [...GEO_BUILTINS.map((b) => b.name), ...GEO_CONSTANTS.map((b) => b.name)] },
  { from: "core",  names: [...MATH_FUNCTIONS.map((m) => m.name), ...STENCIL_HELPERS.map((s) => s.name)] },
];

// Lookup table: builtin name → v1 namespace. Lets us route v2's flat
// import list (e.g. `import sin, cos, neighbor, prev`) into the v1
// validator's namespaced shape.
const NAMESPACE_BY_NAME = (() => {
  const map = new Map();
  for (const m of MATH_FUNCTIONS) map.set(m.name, "core");
  for (const s of STENCIL_HELPERS) map.set(s.name, "core");
  for (const b of CLOCK_BUILTINS) map.set(b.name, "clock");
  for (const b of CLOCK_HELPERS) map.set(b.name, "clock");
  for (const b of GEO_BUILTINS) map.set(b.name, "geo");
  for (const c of GEO_CONSTANTS) map.set(c.name, "geo");
  for (const e of STAMP_EXTRAS) map.set(e.name, "geo"); // brush radius `r`
  for (const p of PIPELINE_PRIMITIVES) map.set(p.name, "sim");
  for (const b of STAGE_BLOCKS) map.set(b.name, "sim");
  for (const v of INIT_VERBS) map.set(v.name, "init");
  return map;
})();

// Build v1-shape imports from a flat list of v2 import names. Every
// listed name is looked up in NAMESPACE_BY_NAME — unknown names are an
// error (the recipe imported something that isn't a real builtin). The
// v2 auto-imports (cell, fill, spot, etc.) are appended unconditionally
// since they're not user-facing in v2 syntax but the v1 validator still
// gates on them.
function buildV1ImportsFromV2(importedNames) {
  if (!importedNames || importedNames.length === 0) {
    return V2_MAXIMAL_IMPORTS;
  }
  const byNs = new Map();
  function add(ns, name) {
    if (!byNs.has(ns)) byNs.set(ns, new Set());
    byNs.get(ns).add(name);
  }
  for (const name of importedNames) {
    const ns = NAMESPACE_BY_NAME.get(name);
    if (!ns) {
      throw new Error(
        `v2 import "${name}" is not a recognized builtin — drop it or check the spelling`,
      );
    }
    add(ns, name);
  }
  // Auto-add the v1 stage-block / init-verb names so v1's validator
  // doesn't complain about their use. Recipe authors don't import
  // these in v2; they're always available.
  for (const name of V2_AUTO_SIM) add("sim", name);
  for (const name of V2_AUTO_INIT) add("init", name);
  return [...byNs.entries()].map(([from, names]) => ({ from, names: [...names] }));
}

export function compileV2(source) {
  const schema = parseV2(source);
  // Translate v2's flat `importedNames` (or null = no imports declared)
  // into v1's namespaced shape that the v1 validator gates on. When the
  // recipe declared explicit imports, only those names are allowed; the
  // v1 validator's requireImport() will reject anything else.
  schema.imports = buildV1ImportsFromV2(schema.importedNames);

  const presets = schema.presets;
  const stamps = schema.stamps;
  const stages = schema.stages;
  const metrics = schema.metrics;

  // Infer history depth from @prev usage. v2 doesn't declare `field u
  // history 1` — every `prev(u)` call (lowered from `u@prev`) implicitly
  // requires u to keep one tick of history. Walk all cell bodies and
  // metric expressions, collect the set of fields read with prev(), and
  // promote their `history` count.
  const historyFields = collectHistoryFields(stages, metrics);
  for (const field of schema.fields) {
    if (historyFields.has(field.name)) field.history = Math.max(field.history ?? 0, 1);
  }

  annotateStageParamRefs(stages, schema);
  validateNameUniqueness(schema, stages);
  validatePresets(presets, schema);
  validateStamps(stamps, schema);
  validateStages(stages, schema);
  validateV2(schema);

  const declared = buildDeclaredPipelineSummary(stages);
  const nodes = {};
  for (const stage of stages) {
    const outputs = [...stage.writes, ...stage.declares];
    nodes[stage.id] = {
      name: stage.name,
      dsl: {
        reads: stage.reads,
        writes: stage.writes,
        declares: stage.declares,
        outputs,
        params: stage.params,
        body: stage.body,
      },
    };
  }
  return {
    nodes,
    edges: deriveEdges(stages),
    dsl: {
      recipe: schema.recipe,
      grid: schema.grid,
      planet: schema.planet,
      constants: schema.constants,
      resolution: schema.resolution,
      imports: schema.imports,
      sources: schema.sources,
      fields: schema.fields,
      declared,
      settings: schema.settings,
      parameters: schema.parameters,
      presets,
      stamps,
      stages: stages.map(({ id, name, reads, writes, declares, params, body, previousReads }) => ({
        id, name, reads, writes, declares,
        outputs: [...writes, ...declares],
        params, body, previousReads,
      })),
      metrics: schema.metrics,
    },
  };
}

// Walk every cell-action expression and metric expression for v2
// CoordRead nodes with `coord.kind === "prev"`. The set of fields
// referenced gates history-buffer allocation. Legacy `Call(prev, ...)`
// shape is still recognized for any leftover non-CoordRead AST.
function collectHistoryFields(stages, metrics) {
  const out = new Set();
  function walk(ast) {
    if (!ast || typeof ast !== "object") return;
    if (ast.type === "CoordRead" && ast.coord?.kind === "prev") {
      out.add(ast.field);
    }
    if (ast.type === "Call" && ast.callee?.type === "Identifier" && ast.callee.name === "prev") {
      const arg = ast.args?.[0];
      if (arg?.type === "Identifier") out.add(arg.name);
    }
    for (const k of Object.keys(ast)) {
      const v = ast[k];
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") walk(v);
    }
  }
  function walkActions(actions = []) {
    for (const a of actions) {
      if (a.expr) walk(a.expr);
      if (a.condition) walk(a.condition);
      if (a.actions) walkActions(a.actions);
    }
  }
  for (const stage of stages) {
    for (const stmt of stage.body?.statements ?? []) {
      walkActions(stmt.actions ?? []);
    }
  }
  for (const m of metrics ?? []) {
    if (m.body) walk(m.body);
    if (m.predicate) walk(m.predicate);
  }
  return out;
}

export function diagnoseV2(source) {
  try {
    const result = compileV2(source);
    return { ok: true, errors: [], ...result.dsl };
  } catch (error) {
    return { ok: false, errors: [{ message: error.message }], stages: [] };
  }
}
