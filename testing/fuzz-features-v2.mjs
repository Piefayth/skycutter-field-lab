// Structural feature extraction for v2 fuzzing.
//
// The fuzzer wants a cheap "what surfaces did this recipe exercise?"
// vector for diversity bucketing. Keep that derived from the compiler
// AST instead of regexing source text, so comments, labels, and future
// formatting changes don't distort coverage diagnostics.

import { parseRecipeSource } from "../dsl/front-end-v2.mjs";

export const FEATURE_NAMES = [
  "vec2Field",
  "u32Field",
  "boolField",
  "derivedField",
  "gradient",
  "divergence",
  "prevRead",
  "upstreamRead",
  "neighborRed",
  "ternary",
  "when",
  "countWhere",
  "meanCells",
  "cellWhere",
  "vec2Construct",
  "memberDotXY",
  "lengthCall",
  "multipleStages",
  "logicalAnd",
  "logicalOr",
  "logicalNot",
  "exprView",
  "rampView",
  "wheelView",
  "inlineStops",
  "stamp",
  "ellipseAction",
  "regionAction",
  "scenarioEachCell",
];

export function emptyFeatureVector() {
  return Object.fromEntries(FEATURE_NAMES.map((name) => [name, 0]));
}

export function featureVectorFromSource(source, { tolerant = false } = {}) {
  const parsed = parseRecipeSource(source, { tolerant, includeAst: true });
  if (!parsed.ast) {
    const first = parsed.errors?.[0];
    throw new Error(first?.message ?? "feature extraction: recipe did not project to AST");
  }
  return featureVectorFromAst(parsed.ast);
}

export function featureVectorFromAst(ast) {
  const vec = emptyFeatureVector();

  for (const field of ast.fields ?? []) {
    if (field.type === "vec2") vec.vec2Field++;
    if (field.type === "u32") vec.u32Field++;
    if (field.type === "bool") vec.boolField++;
    if (field.derived) vec.derivedField++;
  }

  if ((ast.stages ?? []).length > 1) vec.multipleStages = 1;

  for (const stage of ast.stages ?? []) {
    for (const stmt of stage.body?.statements ?? []) {
      visitStageStatement(stmt, vec);
    }
  }

  for (const metric of ast.metrics ?? []) {
    if (metric.op === "mean") vec.meanCells++;
    if (metric.predicate) {
      if (metric.op === "count") vec.countWhere++;
      else vec.cellWhere++;
      visitExpr(metric.predicate, vec);
    }
    visitExpr(metric.body, vec);
  }

  for (const view of ast.views ?? []) {
    if (view.kind === "expr") {
      vec.exprView++;
      for (const action of view.actions ?? []) visitCellAction(action, vec);
    } else if (view.kind === "ramp") {
      vec.rampView++;
      if ((view.stops ?? []).length > 0) vec.inlineStops++;
    } else if (view.kind === "wheel") {
      vec.wheelView++;
    }
  }

  for (const stamp of ast.stamps ?? []) {
    vec.stamp++;
    for (const action of stamp.actions ?? []) visitInitAction(action, vec);
  }

  for (const preset of ast.presets ?? []) {
    for (const action of preset.actions ?? []) visitInitAction(action, vec);
  }

  return vec;
}

export function bucketKey(vec) {
  return FEATURE_NAMES
    .map((name) => `${name}:${(vec?.[name] ?? 0) > 0 ? 1 : 0}`)
    .join("|");
}

function visitStageStatement(stmt, vec) {
  if (stmt?.type === "cell") {
    for (const action of stmt.actions ?? []) visitCellAction(action, vec);
  }
}

function visitCellAction(action, vec) {
  if (!action || typeof action !== "object") return;
  if (action.type === "when") {
    vec.when++;
    visitExpr(action.condition, vec);
    for (const child of action.actions ?? []) visitCellAction(child, vec);
    return;
  }
  visitExpr(action.expr, vec);
}

function visitInitAction(action, vec) {
  if (!action || typeof action !== "object") return;
  if (action.type === "ellipse") vec.ellipseAction++;
  if (action.type === "region") vec.regionAction++;
  if (action.type === "eachCell") {
    vec.scenarioEachCell++;
    visitExpr(action.predicate, vec);
    for (const child of action.actions ?? []) visitCellAction(child, vec);
    return;
  }
  for (const key of ["value", "lon", "lat", "radius", "amount", "rx", "ry"]) {
    visitExpr(action[key], vec);
  }
}

function visitExpr(node, vec) {
  if (!node || typeof node !== "object") return;

  if (node.type === "Conditional") vec.ternary++;
  if (node.type === "Binary") {
    if (node.op === "and" || node.op === "&&") vec.logicalAnd++;
    if (node.op === "or" || node.op === "||") vec.logicalOr++;
  }
  if (node.type === "Unary" && (node.op === "not" || node.op === "!")) vec.logicalNot++;

  if (node.type === "Call") {
    const name = calleeName(node.callee);
    if (name === "gradient") vec.gradient++;
    if (name === "divergence") vec.divergence++;
    if (name === "vec2") vec.vec2Construct++;
    if (name === "length") vec.lengthCall++;
  }

  if (node.type === "Member" && (node.prop === "x" || node.prop === "y")) {
    vec.memberDotXY++;
  }

  if (node.type === "CoordRead") {
    if (node.coord?.kind === "prev") vec.prevRead++;
    if (node.coord?.kind === "upstream") vec.upstreamRead++;
    if (node.coord?.kind === "neighbor") vec.neighborRed++;
  }

  if (node.type === "NeighborReduce") {
    vec.neighborRed++;
  }

  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const item of value) visitExpr(item, vec);
    } else if (value && typeof value === "object") {
      visitExpr(value, vec);
    }
  }
}

function calleeName(callee) {
  if (!callee || typeof callee !== "object") return null;
  if (callee.type === "Identifier") return callee.name;
  return null;
}
