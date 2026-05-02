import { portKey } from "./pipeline-graph-ports.mjs";

export function computeDepths(ids, edges) {
  const depths = new Map(ids.map((id) => [id, 0]));
  let changed = true;
  let safety = ids.length + 1;
  while (changed && safety-- > 0) {
    changed = false;
    for (const edge of edges) {
      const from = edge.from?.node;
      const to = edge.to?.node;
      if (!depths.has(from) || !depths.has(to) || from === to) continue;
      const candidate = (depths.get(from) ?? 0) + 1;
      if (candidate > (depths.get(to) ?? 0)) {
        depths.set(to, candidate);
        changed = true;
      }
    }
  }
  return depths;
}

export function buildGraphModel(stageItems, baseEdges, paramDecls = [], fieldDecls = []) {
  const items = [...stageItems];
  const edges = [...baseEdges];
  const lastWriter = new Map();
  const inputFields = new Set();
  const inputSources = new Set();
  const inputParams = new Set();
  const outputFields = new Set();
  const inputRailId = "rail:input";
  const outputRailId = "rail:output";
  const paramMeta = new Map(paramDecls.map((decl) => [decl.name, decl]).filter(([name]) => Boolean(name)));
  const paramOrder = new Map(paramDecls.map((decl, index) => [decl.name, index]).filter(([name]) => Boolean(name)));
  const declaredFields = fieldDecls.filter((decl) => decl?.name && decl.kind !== "source" && decl.kind !== "declared");
  const declaredSources = fieldDecls.filter((decl) => decl?.name && decl.kind === "source");
  const sourceNames = new Set(declaredSources.map((decl) => decl.name));
  const fieldOrder = new Map(fieldDecls.map((decl, index) => [decl.name, index]).filter(([name]) => Boolean(name)));

  for (const decl of declaredFields) inputFields.add(decl.name);
  for (const decl of declaredSources) inputSources.add(decl.name);

  for (const item of stageItems) {
    for (const field of item.inputs?.fields ?? []) {
      if (sourceNames.has(field)) {
        inputSources.add(field);
        edges.push({
          from: { node: inputRailId, port: field },
          to: { node: item.id, port: field },
          rail: true,
        });
        continue;
      }
      if (lastWriter.has(field)) continue;
      inputFields.add(field);
      edges.push({
        from: { node: inputRailId, port: field },
        to: { node: item.id, port: field },
        rail: true,
      });
    }
    for (const param of item.inputs?.params ?? []) {
      inputParams.add(param);
      const paramPort = portKey("param", param, paramMeta.get(param));
      edges.push({
        from: { node: inputRailId, port: paramPort },
        to: { node: item.id, port: paramPort },
        rail: true,
      });
    }
    const declared = new Set(item.outputs?.declared ?? []);
    for (const field of item.outputs?.fields ?? []) {
      if (declared.has(field)) {
        lastWriter.set(field, item.id);
      } else if (!sourceNames.has(field)) {
        lastWriter.set(field, item.id);
      }
    }
  }

  for (const [field, writerId] of lastWriter) {
    if (isDeclaredPipelineName(field, stageItems)) continue;
    outputFields.add(field);
    edges.push({
      from: { node: writerId, port: field },
      to: { node: outputRailId, port: field },
      rail: true,
    });
  }

  if (inputFields.size > 0 || inputSources.size > 0 || inputParams.size > 0) {
    items.push({
      id: inputRailId,
      label: "State In",
      kind: "rail",
      railSide: "input",
      inputs: { fields: [] },
      outputs: {
        fields: sortFieldsForRail(inputFields, fieldOrder),
        sources: sortFieldsForRail(inputSources, fieldOrder),
        params: sortParamsForRail(inputParams, paramOrder),
      },
    });
  }
  if (outputFields.size > 0) {
    items.push({
      id: outputRailId,
      label: "State Out",
      kind: "rail",
      railSide: "output",
      inputs: { fields: [...outputFields] },
      outputs: { fields: [] },
    });
  }

  return { items, edges };
}

export function orderColumns(columns, edges) {
  const ordered = new Map([...columns.entries()].sort(([a], [b]) => a - b));
  const idsByDepth = [...ordered.keys()];
  const orderIndex = new Map();
  for (const depth of idsByDepth) {
    const ids = ordered.get(depth);
    ids.forEach((id, index) => orderIndex.set(id, index));
  }
  for (const depth of idsByDepth) {
    if (depth === 0) continue;
    const ids = ordered.get(depth);
    ids.sort((a, b) => predecessorScore(a, edges, orderIndex) - predecessorScore(b, edges, orderIndex));
    ids.forEach((id, index) => orderIndex.set(id, index));
  }
  return ordered;
}

function sortParamsForRail(params, paramOrder) {
  return [...params].sort((a, b) => {
    const ai = paramOrder.has(a) ? paramOrder.get(a) : Number.MAX_SAFE_INTEGER;
    const bi = paramOrder.has(b) ? paramOrder.get(b) : Number.MAX_SAFE_INTEGER;
    if (ai !== bi) return ai - bi;
    return a.localeCompare(b);
  });
}

function sortFieldsForRail(fields, fieldOrder) {
  return [...fields].sort((a, b) => {
    const ai = fieldOrder.has(a) ? fieldOrder.get(a) : Number.MAX_SAFE_INTEGER;
    const bi = fieldOrder.has(b) ? fieldOrder.get(b) : Number.MAX_SAFE_INTEGER;
    if (ai !== bi) return ai - bi;
    return a.localeCompare(b);
  });
}

function isDeclaredPipelineName(name, stageItems) {
  for (const item of stageItems) {
    if ((item.outputs?.declared ?? []).includes(name)) return true;
  }
  return false;
}

function predecessorScore(id, edges, orderIndex) {
  const scores = [];
  for (const edge of edges) {
    if (edge.to?.node !== id) continue;
    if (!orderIndex.has(edge.from?.node)) continue;
    scores.push(orderIndex.get(edge.from.node));
  }
  if (!scores.length) return orderIndex.get(id) ?? 0;
  return scores.reduce((sum, value) => sum + value, 0) / scores.length;
}
