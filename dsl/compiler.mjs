// Field Lab DSL compiler facade.
//
// Text is canonical. The graph, generated UI, and WebGPU pipeline are derived
// from parsed declarations plus validated stage/preset/stamp bodies.

import { parsePresets, parseStages, parseStamps, parseTopLevelDeclarations } from "./parse.mjs";
import {
  annotateStageParamRefs,
  buildDeclaredPipelineSummary,
  deriveEdges,
  validateNameUniqueness,
  validatePresets,
  validateStages,
  validateStamps,
} from "./validate.mjs";

export { parsePresets, parseStages, parseStamps, parseTopLevelDeclarations } from "./parse.mjs";

export function compileDsl(source) {
  const schema = parseTopLevelDeclarations(source);
  const presets = parsePresets(source);
  const stamps = parseStamps(source);
  const stages = parseStages(source);
  annotateStageParamRefs(stages, schema);
  validateNameUniqueness(schema, stages);
  validatePresets(presets, schema);
  validateStamps(stamps, schema);
  validateStages(stages, schema);
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
      stages: stages.map(({ id, name, reads, writes, declares, params, body }) => ({ id, name, reads, writes, declares, outputs: [...writes, ...declares], params, body })),
    },
  };
}

export function diagnoseDsl(source) {
  try {
    const schema = parseTopLevelDeclarations(source);
    const presets = parsePresets(source);
    const stamps = parseStamps(source);
    const stages = parseStages(source);
    annotateStageParamRefs(stages, schema);
    validateNameUniqueness(schema, stages);
    validatePresets(presets, schema);
    validateStamps(stamps, schema);
    validateStages(stages, schema);
    const declared = buildDeclaredPipelineSummary(stages);
    return {
      ok: true,
      errors: [],
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
      stages: stages.map(({ id, name, reads, writes, declares, params, body }) => ({ id, name, reads, writes, declares, outputs: [...writes, ...declares], params, body })),
    };
  } catch (error) {
    return {
      ok: false,
      errors: [{
        message: error.message,
      }],
      stages: [],
    };
  }
}
