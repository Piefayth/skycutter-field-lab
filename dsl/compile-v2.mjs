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
} from "./dsl-spec.mjs";

const V2_SYNTHETIC_IMPORTS = [
  { from: "init",  names: INIT_VERBS.map((v) => v.name) },
  { from: "sim",   names: [...PIPELINE_PRIMITIVES.map((p) => p.name), ...STAGE_BLOCKS.map((b) => b.name)] },
  { from: "clock", names: [...CLOCK_BUILTINS.map((b) => b.name), ...CLOCK_HELPERS.map((b) => b.name)] },
  { from: "geo",   names: [...GEO_BUILTINS.map((b) => b.name), ...GEO_CONSTANTS.map((b) => b.name)] },
  { from: "core",  names: [...MATH_FUNCTIONS.map((m) => m.name), ...STENCIL_HELPERS.map((s) => s.name)] },
];

export function compileV2(source) {
  const schema = parseV2(source);
  // Inject synthetic imports so v1's `requireImport` calls always pass.
  schema.imports = V2_SYNTHETIC_IMPORTS;

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

// Walk every cell-action expression and metric expression for Call nodes
// whose callee is `prev`. Returns the set of field names referenced.
function collectHistoryFields(stages, metrics) {
  const out = new Set();
  function walk(ast) {
    if (!ast || typeof ast !== "object") return;
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
