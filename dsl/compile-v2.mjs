// Field Lab DSL v2 compiler facade.
//
// Pipeline:
//   1. parse-v2 produces a v2 AST (CoordRead, NeighborReduce with
//      coord binding, scenario / stamp / metric, etc.)
//   2. validateV2 owns ALL v2-specific semantics — flat import
//      constraints, derived-field rules, metric expression
//      validation, explicit-previous-reads, etc.
//   3. The v1 validator functions (validateNameUniqueness /
//      validatePresets / validateStamps / validateStages) are reused
//      as shape validators only. Their namespaced import gating is
//      bypassed via a `permitAll` sentinel — v2 doesn't need v1's
//      `use sim cell` machinery.
//   4. webgpu-geodesic-compiler emits WGSL directly from the v2 AST
//      (CoordRead is a first-class node; NeighborReduce.coord drives
//      binding derivation in emitReduction).
//
// The remaining v1 dependency is the shape-validator code path. That
// reuse is acceptable because those validators check structural rules
// (reads/writes wiring, name uniqueness, history-field
// single-writer-per-step) that are the same in v1 and v2. The v1
// import-namespace concept doesn't escape this module.

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

export function compileV2(source) {
  const schema = parseV2(source);
  // V2 doesn't use v1's namespaced `use NS name` import gating. The
  // permitAll sentinel tells v1's requireImport to short-circuit; the
  // v2 validator (validateV2 below) owns the actual flat-import
  // constraint check. The historyFields side-channel still piggybacks
  // on this object — validateStages writes it for the validateCall /
  // validateCoordRead branches that need to know which fields have
  // @prev usage anywhere in the recipe.
  schema.imports = { permitAll: true };

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
