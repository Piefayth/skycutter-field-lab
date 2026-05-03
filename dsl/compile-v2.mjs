// Field Lab DSL v2 compiler facade.
//
// Pipeline:
//   1. front-end-v2 parses source into a tolerant CST, then strictly projects
//      it into a v2 AST (CoordRead, NeighborReduce with coord binding,
//      scenario / stamp / metric, etc.)
//   2. validateV2 owns the v2-specific semantics — flat import
//      constraints, derived-field rules, metric expression
//      validation, explicit-previous-reads, type checking.
//   3. validate.mjs supplies shape-only validators (reads/writes
//      wiring, name uniqueness, scenario / stamp / metric structural
//      shape). These rules are independent of v1 vs v2 surface
//      syntax and are reused here.
//   4. webgpu-geodesic-compiler emits WGSL directly from the v2 AST
//      (CoordRead is a first-class node; NeighborReduce.coord drives
//      binding derivation in emitReduction).

import { parseRecipeSource } from "./front-end-v2.mjs";
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
  const schema = parseRecipeSource(source, { tolerant: false, includeAst: true }).ast;
  // The shape validators (validate.mjs) carry a `historyFields`
  // side-channel on the schema's `imports` object that downstream
  // expression validators read for @prev / history checks. Initialise
  // an empty bag here; validateStages populates `historyFields` once
  // it has walked the recipe.
  schema.imports = {};

  const presets = schema.presets;
  const stamps = schema.stamps;
  const stages = schema.stages;
  const metrics = schema.metrics;

  // Infer history depth from @prev usage. v2 doesn't declare `field u
  // history 1` — every `field@prev` (depth 1) or `field@prev(N)` (depth
  // N) implicitly requires N ticks of buffered history. Walk all cell
  // bodies and metric expressions, collect the max depth per field, and
  // promote each field's `history` count.
  const historyDepths = collectHistoryFields(stages, metrics);
  for (const field of schema.fields) {
    const depth = historyDepths.get(field.name);
    if (depth) field.history = Math.max(field.history ?? 0, depth);
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
      // Render-side declarations from v2's `palette` / `view` /
      // `overlay` keywords. visual/recipes.mjs::materializeRecipe
      // consumes these to build colorers + the overlay panel; falls
      // back to the legacy JS-export `views[]` if these are empty.
      palettes: schema.palettes ?? [],
      views: schema.views ?? [],
      overlays: schema.overlays ?? [],
    },
  };
}

// Walk every cell-action expression and metric expression for v2
// CoordRead nodes with `coord.kind === "prev"`. Returns a Map of
// fieldName → max depth of @prev(N) reads against that field.
// `coord.depth` defaults to 1 for the unary `field@prev` form. Legacy
// `Call(prev, ...)` shape is recognized as depth=1 too.
function collectHistoryFields(stages, metrics) {
  const out = new Map();
  function bump(name, depth) {
    out.set(name, Math.max(out.get(name) ?? 0, depth));
  }
  function walk(ast) {
    if (!ast || typeof ast !== "object") return;
    if (ast.type === "CoordRead" && ast.coord?.kind === "prev") {
      bump(ast.field, ast.coord.depth ?? 1);
    }
    if (ast.type === "Call" && ast.callee?.type === "Identifier" && ast.callee.name === "prev") {
      const arg = ast.args?.[0];
      if (arg?.type === "Identifier") bump(arg.name, 1);
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
    return { ok: false, errors: [diagnosticFromError(source, error)], stages: [] };
  }
}

function diagnosticFromError(source, error) {
  const message = error?.message ?? String(error);
  const cst = error?.cst ?? parseRecipeSource(source, { tolerant: true, includeAst: false }).cst;
  const range = locateDiagnosticRange(source, message, cst);
  const position = range ? lineColumnAt(source, range.from) : null;
  return {
    message,
    severity: "error",
    ...(range ?? {}),
    ...(position ?? {}),
  };
}

function locateDiagnosticRange(source, message, cst = null) {
  source = String(source ?? "");
  if (!source) return null;

  const lineMatch = /unexpected line "([^"]+)"/.exec(message);
  if (lineMatch) {
    const trimmed = lineMatch[1].trim();
    const index = source.indexOf(trimmed);
    if (index >= 0) return spanWordOrLine(source, index, trimmed.length);
  }

  const atMatch = /\bat "([^"]+)"/.exec(message);
  if (atMatch) {
    const snippet = atMatch[1].trim();
    const index = source.indexOf(snippet);
    if (index >= 0) return spanWordOrLine(source, index, snippet.length);
  }

  const assignmentMatch = /\bstage "([^"]+)"\s+(set|add)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(message);
  if (assignmentMatch) {
    const [, stageName, action, field] = assignmentMatch;
    const range = findStageActionTarget(cst, source, stageName, action, field);
    if (range) return range;
  }

  const candidates = [
    /unknown identifier "([^"]+)"/,
    /unknown identifier ([A-Za-z_][A-Za-z0-9_]*)/,
    /unknown field "([^"]+)"/,
    /unknown function "([^"]+)"/,
    /unknown function ([A-Za-z_][A-Za-z0-9_]*)/,
    /function "([^"]+)" used but not imported/,
    /field ([A-Za-z_][A-Za-z0-9_]*) is not declared/,
    /writes to undeclared field ([A-Za-z_][A-Za-z0-9_]*)/,
    /field not visible[^;]*; add it to reads/,
    /add ([A-Za-z_][A-Za-z0-9_]*) to the stage's reads/,
    /assigning \w+ to \w+ field "([^"]+)"/,
    /`([A-Za-z_][A-Za-z0-9_]*)` is no longer/,
  ];
  for (const pattern of candidates) {
    const match = pattern.exec(message);
    if (!match) continue;
    const token = match[1];
    if (!token) continue;
    const range = findTokenInCst(cst, token) ?? findToken(source, token);
    if (range) return range;
  }

  const stageMatch = /(?:stage|scenario|stamp|metric) "([^"]+)"/.exec(message)
    ?? /\bstage ([A-Za-z_][A-Za-z0-9_]*)[: ]/.exec(message);
  if (stageMatch) {
    const range = findNamedBlockOrDecl(source, stageMatch[1]);
    if (range) return range;
  }

  const quoted = [...message.matchAll(/"([A-Za-z_][A-Za-z0-9_]*)"/g)]
    .map((m) => m[1])
    .filter((token) => token.length <= 48);
  for (const token of quoted) {
    const range = findTokenInCst(cst, token) ?? findToken(source, token);
    if (range) return range;
  }

  const firstLineEnd = source.indexOf("\n");
  if (firstLineEnd > 0) return { from: 0, to: firstLineEnd };
  const firstWord = /[A-Za-z_][A-Za-z0-9_]*/.exec(source);
  if (firstWord) return { from: firstWord.index, to: firstWord.index + firstWord[0].length };
  return { from: 0, to: Math.min(source.length, 1) };
}

function findTokenInCst(cst, token) {
  if (!cst || !token) return null;
  const reference = (cst.references ?? []).find((ref) => ref.name === token && ref.role !== "binder")
    ?? (cst.references ?? []).find((ref) => ref.name === token);
  if (reference) return { from: reference.from, to: reference.to };
  const symbol = (cst.symbols ?? []).find((sym) => sym.name === token);
  if (symbol) return { from: symbol.from, to: symbol.to };
  return null;
}

function findStageActionTarget(cst, source, stageName, action, field) {
  if (!cst || !stageName || !action || !field) return null;
  const stage = (cst.blocks ?? []).find((block) => {
    if (block.keyword !== "stage") return false;
    if (block.id === stageName) return true;
    const header = source.slice(block.headerFrom, block.headerTo);
    return /"([^"]*)"/.exec(header)?.[1] === stageName;
  });
  if (!stage) return null;
  const stmt = (cst.statements ?? [])
    .filter((candidate) =>
      candidate.keyword === action
      && candidate.parts?.target?.name === field
      && candidate.from >= stage.bodyFrom
      && candidate.to <= stage.bodyTo
    )
    .sort((a, b) => a.from - b.from)[0];
  const target = stmt?.parts?.target;
  return target ? { from: target.from, to: target.to } : null;
}

function findNamedBlockOrDecl(source, id) {
  const block = new RegExp(`\\b(?:stage|scenario|stamp|metric)\\s+${escapeRegExp(id)}\\b`).exec(source);
  if (block) {
    const from = block.index + block[0].lastIndexOf(id);
    return { from, to: from + id.length };
  }
  return findToken(source, id);
}

function findToken(source, token) {
  if (!token) return null;
  const re = new RegExp(`\\b${escapeRegExp(token)}\\b`, "g");
  const match = re.exec(source);
  if (!match) return null;
  return { from: match.index, to: match.index + token.length };
}

function spanWordOrLine(source, from, fallbackLength) {
  const word = /[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(from));
  if (word?.index === 0) return { from, to: from + word[0].length };
  return { from, to: Math.min(source.length, from + Math.max(1, fallbackLength)) };
}

function lineColumnAt(source, pos) {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < pos; i++) {
    if (source.charCodeAt(i) === 10) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: pos - lineStart + 1 };
}

function escapeRegExp(text) {
  return String(text).replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}
